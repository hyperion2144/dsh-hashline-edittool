/**
 * Mutation — deep module owning the full file mutation lifecycle.
 *
 * Previously fragmented: tool-edit → edit-pipeline → edit-engine.applyOne →
 * edit-response/diff/drift, and tool-batch-edit → edit-engine.runFileEdits
 * (loop + unionRange + counters) → persistUndoAndWrite with a boolean flag.
 * Warnings, hadUtf8DecodeErrors, firstChangedLine, driftNotice were threaded
 * by mutation across 5 hops; bugs hid in wiring, not pure helpers.
 *
 * This seam owns: read → normalize → loadServed → applyOne* → stableRehash →
 * drift → persist. Tools become thin adapters: validate → delegate → render.
 * edit-diff, drift, noop-guard are private helpers of this seam.
 *
 * Public surface:
 *   applySingle(io, params, {cwd, sessionKey, signal}) → PipelineResult
 *   applySequence(io, items, {cwd, sessionKey, signal}) → FileEditResult[]
 *   commit(io, files, {exec, sandboxPolicy, signal}) → void
 *
 * Internals (private): verifyServedRange, resToSpan, assemble, scanDrift,
 * boundaryDups, noopGuard. Tested via PipelineResult/FileEditResult, not via split e2e.
 *
 * @module dsh-hashline-edittool/mutation
 */

import type { FileIO } from "./fs-bridge.js";
import type { EditParams } from "./contract.js";
import type { HashStore } from "./hash-store.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "./sandbox.js";

import { normFromText, fileSnap } from "./file-reader.js";
import type { LineEnding } from "./edit-diff.js";
import { toCwd } from "./paths.js";
import { resEdit, type NEdit } from "./hashline/anchor-pipeline.js";
import { MAX_HASH_LINES } from "./hashline/hash-assign.js";
import type { ResolvedRange } from "./hashline/anchor-pipeline.js";
import {
  AnchorMismatchError,
  ServedRejectionError,
  recordEchoServes,
  type ServeRecordPolicy,
} from "./hashline/anchor-pipeline.js";
import { loadServed, sessionKeyFor, scanDrift } from "./session-view.js";
import { abortIf, splitLines } from "./utils.js";
import { applyOne } from "./edit-engine.js";
import {
  runFileEdits,
  resolveMissingPath,
  persistUndoAndWrite,
  enforceNoopLoop,
  collectRemovedHashes,
  countLineChanges,
} from "./edit-engine.js";
import type { FileEditResult, PreparedItem } from "./edit-engine.js";
import { buildMetrics, buildNoop, buildChanged, buildBatchResult } from "./edit-response.js";
import type { RMeta, BatchSection } from "./edit-response.js";
import { genDiff, restoreEndings, toLF, stripBOM } from "./edit-diff.js";
import { computeDrift } from "./drift.js";
import { trackNoopPayload, clearNoopLoop, noopPayloadKey } from "./noop-guard.js";

export interface PipelineResult {
	path: string
	absolutePath: string
	originalNormalized: string
	result: string
	bom: string
	originalEnding: LineEnding
	hadUtf8DecodeErrors: boolean
	warnings: string[]
	noopEdit?: NEdit
	firstChangedLine?: number
	lastChangedLine?: number
	originalHashes: string[]
	resultHashes: string[]
	totalAddedLines: number
	totalRemovedLines: number
	driftNotice?: string
	range: ResolvedRange
	/**
	 * One synthetic shift entry for a single edit (delta = added − removed).
	 * Empty when the edit is a no-op. Lets `buildChanged` reuse the same
	 * Shift-block formatter as the batch path.
	 */
	hunkShifts: import("./edit-engine.js").HunkShift[]
}

export interface ExecPipelineOptions {
	signal?: AbortSignal
	store?: HashStore
	noPersist?: boolean
	sessionKey?: string
}

export async function execPipeline(
	io: FileIO,
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path

	const editWarnings: string[] = []
	// Resolve the edit up front (before IO) so malformed anchors fail before
	// any filesystem work, exactly as the tool always did. `remove_to` is
	// optional at the contract layer; default it to `remove_from` here so the
	// anchor pipeline always sees a fully populated pair.
	const removeFrom = params.remove_from
	const removeTo = params.remove_to ?? removeFrom
	const edit = resEdit(
		{
			remove_from: removeFrom,
			remove_to: removeTo,
			replacement_text: params.replacement_text,
		},
		editWarnings,
	)

	const hashStore = options?.store
	const signal = options?.signal

	abortIf(signal)
	const absolutePath = await io.resolve(path, cwd, signal)
	const rawText = await io.readText(absolutePath, signal)
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
	} = await normFromText({
		absolutePath,
		rawText,
		displayPath: path,
		signal,
		maxLines: MAX_HASH_LINES,
		store: hashStore,
		noPersist: options?.noPersist,
	})

	const sessionKey = options?.sessionKey ?? sessionKeyFor(undefined)
	const served = await loadServed(sessionKey, absolutePath)
	const policy: ServeRecordPolicy =
		options?.noPersist === true ? 'preview' : 'live'

	const applied = await applyOne(
		{
			content: originalNormalized,
			hashes: originalHashes,
			served,
			removeFrom: removeFrom,
			removeTo: removeTo,
			replacementText: params.replacement_text,
			absolutePath,
			displayPath: path,
			signal,
			warnings: editWarnings,
			store: hashStore,
			persist: options?.noPersist !== true,
			edit,
		},
		async (error) => {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				await recordEchoServes(
					sessionKey,
					absolutePath,
					error.servedRows,
					policy,
					originalHashes.length,
				)
			}
			throw error
		},
	)
	const result = applied.result
	const isNoop = applied.noop
	const warnings = [...editWarnings, ...(applied.anchorWarnings ?? [])]

	let driftNotice: string | undefined
	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes: applied.hashes,
				resultLines: splitLines(result),
				range: applied.range,
				path: absolutePath,
			})
		} catch (error) {
			console.error('Failed to compute drift notice:', error)
		}
	}

	// Synthetic single-hunk shift entry — the batch path builds the same shape
	// per hunk, and the response renderer formats them uniformly.
	const hunkShifts: import("./edit-engine.js").HunkShift[] = [];
	if (!isNoop) {
		const delta = applied.totalAddedLines - applied.totalRemovedLines;
		const replacedRows = Math.max(0, applied.totalAddedLines);
		const lastReplacementLineNew = applied.range.startLine + replacedRows - 1;
		hunkShifts.push({
			index: 0,
			delta,
			firstStableLineNew: lastReplacementLineNew + 1,
			lastChangedLine: applied.lastChangedLine ?? applied.range.endLine,
		});
	}

	return {
		path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		noopEdit: applied.noopEdit,
		firstChangedLine: applied.firstChangedLine,
		lastChangedLine: applied.lastChangedLine,
		originalHashes,
		resultHashes: applied.hashes,
		totalAddedLines: applied.totalAddedLines,
		totalRemovedLines: applied.totalRemovedLines,
		driftNotice,
		range: applied.range,
		hunkShifts,
	}
}

/** Resolve the display path a caller names against the session cwd. */
export function resolveDisplayPath(path: string, cwd: string): string {
	return toCwd(path, cwd)
}

/** Snapshot bookkeeping for noop/success results (best-effort). */
export async function snapshotIdFor(
	io: FileIO,
	absolutePath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		return await io.statVersion(absolutePath, signal)
	} catch {
		try {
			return (await fileSnap(absolutePath)).snapshotId
		} catch {
			return undefined
		}
	}
}


export {
 runFileEdits,
 resolveMissingPath,
 persistUndoAndWrite,
 enforceNoopLoop,
 collectRemovedHashes,
 countLineChanges,
};
export type { FileEditResult, PreparedItem };
export { buildMetrics, buildNoop, buildChanged, buildBatchResult };
export type { RMeta, BatchSection };
export { genDiff, restoreEndings, toLF, stripBOM };
export { computeDrift, scanDrift };
export { trackNoopPayload, clearNoopLoop, noopPayloadKey };

// --- Deep seam: unified mutation API (one interface, twoAdapters) ---

/** Apply a single edit — owns read→normalize→loadServed→applyOne→stableRehash→drift. */
export async function applySingle(
 io: FileIO,
 params: EditParams,
 cwd: string,
 opts?: {
  sessionKey?: string;
  signal?: AbortSignal;
  store?: HashStore;
  noPersist?: boolean;
 },
): Promise<PipelineResult> {
 return execPipeline(io, params, cwd, opts);
}

/** Apply a per-file sequence (batch's group) — owns the loop + unionRange + counters. */
export async function applySequence(
 io: FileIO,
 items: PreparedItem[],
 ctx: { sessionKey: string; signal?: AbortSignal },
): Promise<FileEditResult> {
 return runFileEdits(io, items, ctx);
}

/** Commit the transaction — owns persist-undo → write → restore. */
export async function commit(opts: {
 io: FileIO;
 files: Array<{
  absolutePath: string;
  displayPath: string;
  originalNormalized: string;
  bom: string;
  originalEnding: import("./edit-diff.js").LineEnding;
  originalHashes: string[];
  result: string;
 }>;
 exec: ToolExecution;
 sandbox: FsSandboxController;
 sandboxPolicy: SandboxExecutionPolicy | undefined;
 signal?: AbortSignal;
 undoUnavailableMessage: (displayPath: string) => string;
 restoreUnwrittenUndos?: boolean;
}): Promise<void> {
 return persistUndoAndWrite({
  io: opts.io,
  files: opts.files,
  exec: opts.exec,
  sandbox: opts.sandbox,
  sandboxPolicy: opts.sandboxPolicy,
  signal: opts.signal,
  undoUnavailableMessage: opts.undoUnavailableMessage,
  restoreUnwrittenUndos: opts.restoreUnwrittenUndos,
 });
}
