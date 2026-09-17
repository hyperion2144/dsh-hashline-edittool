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

import type { FileIO } from "../../infra/fs-bridge.js";
import { anchorOf, type EditOp, type EditParams } from "../../contract/contract.js";
import type { HashStore } from "../session/hash-store.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FsSandboxController } from "../../infra/sandbox.js";

import { normFromText } from "../session/file-view.js";
import { fileSnap } from "../../infra/file-snap.js";
import type { LineEnding } from "../../render/edit-diff.js";
import { toCwd } from "../../infra/paths.js";
import { resEdit, type NEdit } from "../../hashline/anchor-pipeline.js";
import type { ResolvedRange } from "../../hashline/anchor-pipeline.js";
import { AnchorMismatchError, ServedRejectionError } from "../../hashline/anchor-pipeline.js";
import { loadServed, sessionKeyFor, recordEchoServes, scanDrift, type ServeRecordPolicy } from "../session/session-view.js";
import { abortIf, splitLines } from "../../infra/utils.js";
import { applyOne } from "./edit-engine.js";
import { updateAnchorsAfterEdit } from "../../hashline/session-anchors.js";
import {
  runFileEdits,
  resolveMissingPath,
  persistUndoAndWrite,
  enforceNoopLoop,
  countLineChanges,
} from "./edit-engine.js";
import type { FileEditResult, PreparedItem } from "./edit-engine.js";
import { buildMetrics, buildNoop, buildChanged, buildBatchResult } from "./edit-response.js";
import type { RMeta, BatchSection } from "./edit-response.js";
import { genDiff, restoreEndings, toLF, stripBOM } from "../../render/edit-diff.js";
import { computeDrift } from "../session/session-view.js";
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
	/** Echo rows carry `<line>:<anchor>` markers unless this is false. */
	lineNumbers?: boolean
	/**
	 * The calling execution. Needed so an echo can emit `fs/observed` for the
	 * rows it just served: an echo the model cannot write with is decorative.
	 */
	exec?: ToolExecution
}

export async function execPipeline(
	io: FileIO,
	params: EditParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path;
	if (typeof path !== "string" || path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] execPipeline (legacy single-edit) requires a non-empty "path". For multi-file edits, use the `edit` tool with per-item `path`.',
		);
	}
	const editWarnings: string[] = []
	// 0.4 contract: `params` now carries `{ path, edits: [...] }`. The single
	// edit path constructs a single-item batch (the tool always routes through
	// `runFileEdits`); this function is kept for backward compat with callers
	// that still use the old `{ path, remove_from, remove_to, replacement_text }`
	// spelling. We normalize the first item (default `op: "replace"`).
	const firstItem = params.edits?.[0]
	// The first item's anchor comes from whichever field ITS op uses — `ins`
	// carries `anchor_after`, the others `anchor_start`. Reading only
	// `anchor_start` here would quietly lose the anchor of an insert.
	const firstAnchor =
		firstItem === undefined
			? undefined
			: firstItem.op === "ins"
				? firstItem.anchor_after
				: firstItem.anchor_start;
	const removeFromRaw =
		(params as { remove_from?: string }).remove_from ??
		(firstAnchor === undefined ? undefined : anchorOf(firstAnchor))
	const removeToRaw =
		(params as { remove_to?: string }).remove_to ??
		(firstItem?.anchor_end !== undefined ? anchorOf(firstItem.anchor_end) : undefined) ??
		(firstAnchor === undefined ? undefined : anchorOf(firstAnchor)) ??
		removeFromRaw
	const replTextRaw =
		(params as { replacement_text?: string }).replacement_text ??
		(firstItem?.lines ?? []).join("\n")
	const op = (firstItem?.op ?? (params as { op?: EditOp }).op ?? "replace")
	const removeFrom = removeFromRaw ?? ""
	const removeTo = removeToRaw ?? removeFrom
	const edit = resEdit(
		{
			remove_from: removeFrom,
			remove_to: removeTo,
			replacement_text: op === "del" ? "" : replTextRaw,
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
			replacementText: op === "del" ? "" : replTextRaw,
			op,
			pattern: firstItem?.pattern,
			replacement: firstItem?.replacement,
			flags: firstItem?.flags,
			absolutePath,
			displayPath: path,
			signal,
			warnings: editWarnings,
			lineNumbers: options?.lineNumbers,
			store: hashStore,
			persist: options?.noPersist !== true,
			edit,
		},
		async (error) => {
			if (
				error instanceof AnchorMismatchError ||
				error instanceof ServedRejectionError
			) {
				try {
					await recordEchoServes(
						sessionKey,
						absolutePath,
						error.servedRows,
						policy,
						originalHashes.length,
					);
				} catch (recordError) {
					// issue #136: loud, but the primary rejection must keep propagating —
					// the echo text is already in the rejection the model will see.
					console.error("[E_SERVED_RECORD] failed to record echo rows:", recordError);
				}
				if (error.servedRows.length > 0) {
					// The echo IS a read: the session has seen these lines, so the dsh
					// observation policy must know it too. Otherwise the echoed rows are
					// servable but not WRITABLE — a retry with a fresh marker from the
					// echo failed [E_NOT_OBSERVED], which made the echo decorative.
					await io.emitObserved(absolutePath, options?.exec, options?.signal)
				}
			}
			throw error
		},
	)
	const result = applied.result
	const isNoop = applied.noop
	const warnings = [...editWarnings, ...(applied.anchorWarnings ?? [])]

let driftNotice: string | undefined


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
			originalStartLine: applied.range.startLine,
			originalEndLine: applied.range.endLine,
			finalStartLine: applied.range.startLine,
			finalEndLine: lastReplacementLineNew,
		});
	}

	// v2.0 incremental anchor update: preserve unchanged lines' anchors
	// (session-internal immutability), release removed, allocate inserted.
	const resultHashes = isNoop
		? applied.hashes
		: updateAnchorsAfterEdit({
				path: absolutePath,
				oldContent: originalNormalized,
				newContent: result,
				oldAnchors: originalHashes,
				hunks: hunkShifts.map((s) => ({
					oldStart1: s.originalStartLine,
					oldEnd1: s.originalEndLine,
					finalStart1: s.finalStartLine,
					finalEnd1: s.finalEndLine,
				})),
			})

	if (options?.noPersist !== true) {
		try {
			driftNotice = await scanDrift({
				sessionKey,
				served,
				resultHashes,
				resultLines: splitLines(result),
				range: applied.range,
				path: absolutePath,
				io,
				exec: options?.exec,
			})
		} catch (error) {
			console.error('Failed to compute drift notice:', error)
		}
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
		resultHashes,
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
  /** The calling execution — an echo emits `fs/observed` through it. */
  exec?: ToolExecution;
 },
): Promise<PipelineResult> {
 return execPipeline(io, params, cwd, opts);
}

/** Apply a per-file sequence (batch's group) — owns the loop + unionRange + counters. */
export async function applySequence(
 io: FileIO,
 items: PreparedItem[],
 ctx: { sessionKey: string; signal?: AbortSignal; exec?: ToolExecution },
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
  originalEnding: import("../../render/edit-diff.js").LineEnding;
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
