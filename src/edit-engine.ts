/**
 * The edit-sequence engine shared by `edit` (single-and-multi-edit) and previews:
 * apply-one-edit against in-memory content with served verification, the
 * multi-edit sequencer that drives a whole file's item list against evolving
 * content, the noop-loop guard, and the persist-undo → write → restore
 * transaction both mutating tools run.
 *
 * The model-facing contract lives here unchanged: [E_BATCH_ABORT],
 * [E_NOOP_LOOP], [E_UNDO_UNAVAILABLE] carry byte-identical messages, and
 * reject-and-serve records the same echo serves.
 * @module dsh-hashline-edittool/edit-engine
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FileIO } from "./fs-bridge.js";
import type { HashStore } from "./hash-store.js";
import type { LineEnding } from "./edit-diff.js";
import { restoreEndings } from "./edit-diff.js";
import { normFromText } from "./file-reader.js";
import { scanDrift, loadServed, migrateServedAfterEdit } from "./session-view.js";
import {
	applyEdit,
	resEdit,
	parseHashRef,
	parseText,
	type HEdit,
	type NEdit,
} from "./hashline/anchor-pipeline.js";
import {
	detectRangeConflicts,
	describeEdge,
	type RangeEdge,
} from "./range-conflicts.js";
import { lineHashes } from "./hashline/hash.js";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	recordEchoServes,
	type ResolvedRange,
	type ServeRecordPolicy,
	type ServedRow,
} from "./hashline/anchor-pipeline.js";
import { findSnapshotPathsByHashes } from "./hash-store.js";
import { saveUndo } from "./undo-edit.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { NOOP_LOOP_THRESHOLD } from "./constants.js";
import { abortIf, splitLines } from "./utils.js";
import type { FsSandboxController } from "./sandbox.js";

// ---------------------------------------------------------------------------
// shared types

export interface PreparedItem {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	pathWarning?: string;
	/** Edit semantic (0.3+): "ins" | "del" | "replace". Defaults to "replace". */
	op?: "ins" | "del" | "replace";
}

/**
 * Per-hunk shift information: `delta` is added-minus-removed for the hunk;
 * `firstStableLineNew` is the absolute line number in the **new** file of
 * the first row that did not change (or `originalHashes.length + 1` when the
 * hunk was the last line).
 */
export interface HunkShift {
	/** Index of the hunk in the batch (0-based). */
	index: number;
	/** Added − removed for this hunk. */
	delta: number;
	/**
	 * Absolute line number (1-indexed) in the new file of the first unchanged
	 * row after this hunk. Used to compose the Shift: lines > N shift by +K
	 * block the model reads.
	 */
	firstStableLineNew: number;
	/**
	 * Absolute line number (1-indexed) in the new file of the LAST line of
	 * this hunk (the first replacement row), or the original last-removed line
	 * when the hunk produced no rows. Lets the response label each hunk with
	 * the line range it touched.
	 */
	lastChangedLine: number;
	/** 1-indexed first line of this hunk's range in the ORIGINAL snapshot. */
	originalStartLine: number;
	/** 1-indexed last line of this hunk's range in the ORIGINAL snapshot. */
	originalEndLine: number;
	/** 1-indexed first line of this hunk's replacement in the FINAL file. */
	finalStartLine: number;
	/** 1-indexed last line of this hunk's replacement in the FINAL file. */
	finalEndLine: number;
}

export interface FileEditResult {
	displayPath: string;
	absolutePath: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: LineEnding;
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	originalHashes: string[];
	resultHashes: string[];
	appliedCount: number;
	noopCount: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	driftNotice: string | undefined;
	range: ResolvedRange;
	/** Per-hunk shift info for batch output. */
	hunkShifts: HunkShift[];
	/** Lines around the union range that should be marked as served (echo rows
	 *  for the post-edit serve mirror). Synthesized from the diff hunks by
	 *  `runFileEdits`. */
	servedRows: { position: number; hash: string }[];
	/** First / last changed line in the union range (for `firstChangedLine` /
	 *  `lastChangedLine` in the canonical value). Synthesized by `runFileEdits`. */
	firstChangedLine?: number;
	lastChangedLine?: number;
}

// ---------------------------------------------------------------------------
// request / counting helpers shared by both tool paths

/**
 * Resolve a request's missing `path` from its anchors: the only file whose
 * stored hashes contain both anchors. Returns the path plus an autocorrect
 * warning, or undefined when no resolution is possible.
 */
export async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === "string") return undefined;
	const from = request.remove_from;
	const to = request.remove_to;
	if (typeof from !== "string" || typeof to !== "string") return undefined;
	const hashes: string[] = [];
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash);
		} catch {
			return undefined;
		}
	}
	let matches: string[];
	try {
		matches = await findSnapshotPathsByHashes(hashes);
	} catch {
		return undefined;
	}
	if (matches.length === 1) {
		return {
			path: matches[0]!,
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(', ')}. Include the intended path.`,
		);
	}
	return undefined;
}


/** Added/removed line counts for one resolved edit against a file's original hashes. */
export function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
	removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
	let totalRemovedLines = 0;
	const startLine = edit.hash_bounds[0].line - 1;
	const endLine = edit.hash_bounds[1].line - 1;
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1;
	}
	return {
		totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
		totalRemovedLines,
	};
}

// ---------------------------------------------------------------------------
// apply-one

export interface ApplyOneInput {
	content: string;
	hashes: string[];
	served: (string | null)[];
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	absolutePath: string;
	displayPath: string;
	signal?: AbortSignal;
	/** Shared warnings array; resEdit warnings are pushed here. */
	warnings: string[];
	/**
	 * The hashes to count added/removed lines against. Defaults to `hashes`;
	 * the batch sequencer passes the file's ORIGINAL hashes so later edits in
	 * a sequence still count against the file as first served.
	 */
	countHashes?: string[];
	store?: HashStore;
	persist: boolean;
	/** Pre-resolved edit (single path keeps resEdit before IO for error order). */
	edit?: HEdit;
	/**
	 * Edit semantic (0.3+). `"ins"` inserts `replacementText` AFTER the
	 * `removeFrom` line (the line's own content is preserved and the
	 * replacement is prefixed with it); `"del"` deletes the range;
	 * `"replace"` substitutes the range with `replacementText`
	 * (the pre-0.3 default). Defaults to `"replace"`.
	 */
	op?: "ins" | "del" | "replace";
}

export interface ApplyOneResult {
	result: string;
	/** Stable re-hash after the edit (equals `hashes` for a noop). */
	hashes: string[];
	range: ResolvedRange;
	noop: boolean;
	edit: HEdit;
	noopEdit?: NEdit;
	firstChangedLine?: number;
	lastChangedLine?: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	anchorWarnings: string[] | undefined;
}

/**
 * Resolve an `op: "ins"` edit into the range + replacement it really means.
 * `ins` inserts the given lines AFTER the `anchor_start` line while
 * preserving the `anchor_start` line itself — so the effective edit is a
 * single-line replace of the `anchor_start` line with
 * `[<anchorLineContent>, ...insertedLines]`. `anchor_end` is never accepted
 * for `ins` (validated at the contract layer); `removeTo` here is
 * `anchor_start` again. The anchor line's content is read from `content`
 * via the hash's position.
 * hash's position.
 */
export function resolveIns(
	content: string,
	hashes: string[],
	removeFrom: string,
	replacementText: string,
	warnings: string[],
): { removeTo: string; replacementText: string } {
	// Resolve removeFrom by the ANCHOR (claimed line + hash), never by bare
	// hash lookup: the line identifies the row, the hash only verifies it
	// (identical hashes may legitimately collide — 62^len space). A hash
	// lookup would pick the FIRST row sharing the hash and paste THAT row's
	// content into the insert.
	let fromLine = -1;
	try {
		const ref = parseHashRef(removeFrom);
		if (
			ref.line >= 1 &&
			ref.line <= hashes.length &&
			hashes[ref.line - 1] === ref.hash
		) {
			fromLine = ref.line - 1;
		}
	} catch {
		// Let resEdit surface the anchor error with the right code.
		return { removeTo: removeFrom, replacementText };
	}
	if (fromLine < 0) {
		// Anchor does not verify at the claimed line — let resEdit/applyEdit
		// surface [E_STALE_ANCHOR] / [E_RANGE_UNVERIFIED].
		return { removeTo: removeFrom, replacementText };
	}
	const lines = splitLines(content);
	const fromContent = lines[fromLine] ?? "";
	const insertedLines = parseText(replacementText);
	const effectiveReplacement =
		[fromContent, ...insertedLines].join("\n");
	warnings.push(
		`[E_OP_INS] op:"ins" after line ${fromLine + 1}: preserved the anchor line and inserted ${insertedLines.length} line(s) below it.`,
	);
	return { removeTo: removeFrom, replacementText: effectiveReplacement };
}

/**
 * One edit against in-memory content: resolve (unless a pre-resolved edit was
 * given) → apply with served verification → stable re-hash → line counts.
 *
 * `onReject` owns the reject-and-serve policy: it receives resolve/verify
 * failures (and the edit that failed, when resolved) and MUST throw. The
 * single path rethrows the original anchor error after recording echo serves;
 * the batch path wraps with [E_BATCH_ABORT] plus the current-range echo.
 */
export async function applyOne(
	input: ApplyOneInput,
	onReject: (error: unknown, edit: HEdit | undefined) => Promise<never>,
): Promise<ApplyOneResult> {
	let edit: HEdit;
	if (input.edit) {
		edit = input.edit;
	} else {
		// `op: "ins"` expands to a single-line replace that preserves the
		// anchor line and appends the inserted lines below it.
		let removeTo = input.removeTo;
		let replacementText = input.replacementText;
		if (input.op === "ins") {
			const resolved = resolveIns(
				input.content,
				input.hashes,
				input.removeFrom,
				input.replacementText,
				input.warnings,
			);
			removeTo = resolved.removeTo;
			replacementText = resolved.replacementText;
		} else if (input.op === "del") {
			// `del` is just a replace-with-empty; replacementText should be "".
			replacementText = "";
		}
		try {
			edit = resEdit(
				{
					remove_from: input.removeFrom,
					remove_to: removeTo,
					replacement_text: replacementText,
				},
				input.warnings,
			);
		} catch (error) {
			return onReject(error, undefined);
		}
	}

	let anchorResult: ReturnType<typeof applyEdit>;
	try {
		anchorResult = applyEdit(
			input.content,
			edit,
			input.signal,
			input.hashes,
			input.displayPath,
			input.served,
		);
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError
		) {
			return onReject(error, edit);
		}
		throw error;
	}

	const result = anchorResult.content;
	const noop = result === input.content;
	const resultHashes = noop
		? input.hashes
		: await lineHashes(result, input.absolutePath, input.store, input.persist);
	const { totalAddedLines, totalRemovedLines } = countLineChanges(
		edit,
		input.countHashes ?? input.hashes,
		noop,
		anchorResult.autoFixes?.length ?? 0,
	);

	return {
		result,
		hashes: resultHashes,
		range: anchorResult.range,
		noop,
		edit,
		noopEdit: anchorResult.noopEdit,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		totalAddedLines,
		totalRemovedLines,
		anchorWarnings: anchorResult.warnings,
	};
}

// ---------------------------------------------------------------------------
// noop-loop guard

export interface NoopLoopOptions {
	absolutePath: string;
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	displayPath: string;
	/** Batch item index; undefined = single-edit flavor. */
	index?: number;
	count: number;
	sessionKey: string;
	originalHashes: string[];
	originalNormalized: string;
	/** Single-edit flavor only: the edit's range, for the echo rows. */
	range?: ResolvedRange;
	/** Batch flavor: precomputed echo rows for the failed item (may be absent). */
	echoRows?: ServedRow[];
}


/**
 * The shared noop-loop guard. Returns the "twice in a row" notice for the
 * caller to append to warnings, or throws [E_NOOP_LOOP] (after recording the
 * echo serves) once the payload has been submitted NOOP_LOOP_THRESHOLD times
 * with no change. Messages are byte-identical to the pre-engine tools.
 */
export async function enforceNoopLoop(
	opts: NoopLoopOptions,
): Promise<string | undefined> {
	const {
		absolutePath,
		removeFrom,
		removeTo,
		displayPath,
		index,
		count,
		sessionKey,
		originalHashes,
	} = opts;

	if (index === undefined) {
		if (count >= NOOP_LOOP_THRESHOLD) {
			const echoRows = buildRangeEcho(
				opts.range!.startLine,
				opts.range!.endLine,
				originalHashes,
			);
			const echo = fmtServedRows(
				echoRows,
				splitLines(opts.originalNormalized),
			);
			await recordEchoServes(
				sessionKey,
				absolutePath,
				echoRows,
				"live",
				originalHashes.length,
			);
			throw new Error(
				`[E_NOOP_LOOP] identical edit (${removeFrom} → ${removeTo} in ${displayPath}) submitted ${count}×, no changes each time. Range already contains this text; resend will reject. Current range:\n${echo}`,
			);
		}
		if (count === 2) {
			return `[E_NOOP_LOOP] Notice: identical edit (${removeFrom} → ${removeTo} in ${displayPath}) no-op'd twice; range already has this text. Resend will reject.`;
		}
		return undefined;
	}

	if (count >= NOOP_LOOP_THRESHOLD) {
		const originalLines = splitLines(opts.originalNormalized);
		const echoRows = opts.echoRows;
		if (echoRows) {
			await recordEchoServes(
				sessionKey,
				absolutePath,
				echoRows,
				"live",
				originalHashes.length,
			);
		}
		throw new Error(
			`[E_NOOP_LOOP] edits[${index}] (${displayPath}): identical edit (${removeFrom} → ${removeTo}) submitted ${count}×, no changes each time. Range already has this text; resend will reject the batch.` +
				(echoRows
					? ` Current on-disk range:\n${fmtServedRows(echoRows, originalLines)}`
					: ""),
		);
	}
	if (count === 2) {
		return `[E_NOOP_LOOP] Notice: edits[${index}] (${displayPath}) — identical edit no-op'd twice; range already has this text. Resend will reject the batch.`;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// per-file sequencer (batch)

function echoRowsForItem(
	edit: HEdit,
	originalHashes: string[],
): ServedRow[] | undefined {
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const s = originalHashes.indexOf(startHash);
	const e = originalHashes.indexOf(endHash);
	if (s < 0 || e < 0) return undefined;
	return buildRangeEcho(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes);
}

/**
 * Run a file's item list against freshly-read content with served
 * verification, evolving content/hashes, union range, noop tracking, and a
 * per-file drift notice. All-or-nothing is enforced by the caller's
 * transaction ({@link persistUndoAndWrite}): nothing here writes to disk.
 */
export async function runFileEdits(
	io: FileIO,
	items: PreparedItem[],
	opts: { signal?: AbortSignal; sessionKey: string },
): Promise<FileEditResult> {
	const first = items[0]!;
	abortIf(opts.signal);
	const absolutePath = first.absolutePath;
	const rawText = await io.readText(absolutePath, opts.signal);
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
	} = await normFromText({
		absolutePath,
		rawText,
		displayPath: first.path,
		signal: opts.signal,
	});

	let served = await loadServed(opts.sessionKey, absolutePath);
	const warnings: string[] = [];

	// --- Phase 1: pre-resolve every hunk against the ORIGINAL snapshot. ---
	// op: "ins" expands to a single-line replace that preserves the anchor
	// line and appends the inserted lines below it; "del" is a replace with
	// empty text. All coordinates below are original-file coordinates.
	const resolvedEdits: { item: PreparedItem; edit: HEdit; isIns: boolean }[] = [];
	for (const item of items) {
		abortIf(opts.signal);
		let removeTo = item.remove_to;
		let replacementText = item.replacement_text;
		if (item.op === "ins") {
			const resolved = resolveIns(
				originalNormalized,
				originalHashes,
				item.remove_from,
				item.replacement_text,
				warnings,
			);
			removeTo = resolved.removeTo;
			replacementText = resolved.replacementText;
		} else if (item.op === "del") {
			replacementText = "";
		}
		let edit: HEdit;
		try {
			edit = resEdit(
				{
					remove_from: item.remove_from,
					remove_to: removeTo,
					replacement_text: replacementText,
				},
				warnings,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${message}\n` +
					"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
			);
		}
		resolvedEdits.push({ item, edit, isIns: item.op === "ins" });
	}

	// --- Phase 2: conflict detection on original coordinates. ---
	// Hunks whose anchors do not match the original snapshot are excluded:
	// their true positions are unknown, and applyOne reports them as stale
	// (with the ±3 echo + fresh marker) instead of a misleading overlap.
	const anchorMatchesSnapshot = (edit: HEdit): boolean =>
		edit.hash_bounds.every(
			(b) =>
				b.line >= 1 &&
				b.line <= originalHashes.length &&
				originalHashes[b.line - 1] === b.hash,
		);
	// replace swaps the whole range for `lines` of ANY length (the range
	// count is not constrained) — only the dual-anchor requirement is
	// contractual.
	const edges: RangeEdge[] = resolvedEdits
		.filter(({ edit }) => anchorMatchesSnapshot(edit))
		.map(({ item, edit, isIns }) => ({
			index: item.index,
			startLine: edit.hash_bounds[0].line,
			endLine: edit.hash_bounds[1].line,
			isIns,
		}));
	const conflicting = detectRangeConflicts(edges);
	if (conflicting.length > 0) {
		const detail = conflicting
			.map(([a, b]) => `${describeEdge(a)} and ${describeEdge(b)} overlap`)
			.join("; ");
		throw new Error(
			`[E_BATCH_CONFLICT] in ${first.path}: ${detail} — every hunk is resolved against the same original snapshot, so row ranges must not overlap in one batch. Split into separate edits or merge the ranges. Nothing was written.`
		);
	}

	// Final positions: every hunk's replacement in the FINAL file, computed by
	// walking hunks in ascending original order with an accumulating offset.
	const finalPositions = new Map<number, { finalStart: number; finalEnd: number }>();
	{
		const asc = [...resolvedEdits].sort(
			(a, b) => a.edit.hash_bounds[0].line - b.edit.hash_bounds[0].line,
		);
		let offset = 0;
		for (const entry of asc) {
			const startLine = entry.edit.hash_bounds[0].line;
			const endLine = entry.edit.hash_bounds[1].line;
			const rows = entry.edit.content_lines.length;
			const finalStart = startLine + offset;
			finalPositions.set(entry.item.index, {
				finalStart,
				finalEnd: finalStart + rows - 1,
			});
			offset += rows - (endLine - startLine + 1);
		}
	}

	// --- Phase 3: apply, from the back down (descending original start line). ---
	// Disjoint ranges keep every hunk's original anchors valid: applying a
	// later hunk never moves rows above its start. This is the concurrent
	// (snapshot) semantics — a batch behaves as one atomic edit.
	// Descending by original start line; same anchor line: the ins (gap
	// insert) runs FIRST so a replace on that line still finds its original
	// hash — the ins never rewrites its anchor line.
	const ordered = [...resolvedEdits].sort(
		(a, b) =>
			b.edit.hash_bounds[0].line - a.edit.hash_bounds[0].line ||
			Number(b.isIns) - Number(a.isIns),
	);

	let currentContent = originalNormalized;
	let currentHashes = originalHashes;
	let appliedCount = 0;
	let noopCount = 0;
	let totalAddedLines = 0;
	let totalRemovedLines = 0;
	let unionStartLine = Infinity;
	let unionEndLine = -Infinity;
	let unionStartHash = "";
	let unionEndHash = "";
	let unionFirstChangedLine: number | undefined;
	let unionLastChangedLine: number | undefined;
	let lastApplied:
		| { content: string; hashes: string[] }
		| undefined;
	const hunkShifts: HunkShift[] = [];

	for (const { item, edit } of ordered) {
		abortIf(opts.signal);
		const applied = await applyOne(
			{
				content: currentContent,
				hashes: currentHashes,
				served,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				op: item.op,
				absolutePath,
				displayPath: item.path,
				signal: opts.signal,
				warnings,
				countHashes: originalHashes,
				persist: false,
				edit,
			},
			async (error) => {
				if (
					error instanceof AnchorMismatchError ||
					error instanceof ServedRejectionError
				) {
					// Reject-and-serve: record the error's own echo rows so the fresh
					// marker is directly reusable — but do NOT re-render a second file
					// block. The error message already carries the single ±3 echo;
					// duplicating it produced two file echoes plus an "on-disk" block
					// that was not the disk state.
					if (error.servedRows.length > 0) {
						await recordEchoServes(
							opts.sessionKey,
							absolutePath,
							error.servedRows,
							"live",
							originalHashes.length,
						);
					}
					throw new Error(
						`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${error.message}\n` +
							"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied. Fix the failing edit (and any later edit that depends on it), then resubmit the batch.",
					);
				}
				const message =
					error instanceof Error ? error.message : String(error);
				throw new Error(
					`[E_BATCH_ABORT] edits[${item.index}] (${item.path}) failed: ${message}\n` +
						"The whole batch was rejected and NOTHING was written — no file changed and earlier items in the batch were NOT applied.",
				);
			},
		);

		const range = applied.range;
		if (range.startLine < unionStartLine) {
			unionStartLine = range.startLine;
			unionStartHash = range.startHash;
		}
		if (range.endLine > unionEndLine) {
			unionEndLine = range.endLine;
			unionEndHash = range.endHash;
		}
		if (!applied.noop) {
			if (unionFirstChangedLine === undefined) unionFirstChangedLine = range.startLine;
			unionLastChangedLine = range.endLine;
		}

		if (applied.noop) {
			noopCount += 1;
			const payload = noopPayloadKey(
				absolutePath,
				item.remove_from,
				item.remove_to,
				item.replacement_text,
			);
			const count = trackNoopPayload(absolutePath, payload);
			const notice = await enforceNoopLoop({
				absolutePath,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				displayPath: item.path,
				index: item.index,
				count,
				sessionKey: opts.sessionKey,
				originalHashes,
				originalNormalized,
				echoRows: echoRowsForItem(applied.edit, originalHashes),
			});
			if (notice) warnings.push(notice);
			warnings.push(
				`edits[${item.index}] (${item.path}) was a noop: the range already contains the replacement text.`
			);
			if (applied.anchorWarnings?.length)
				warnings.push(...applied.anchorWarnings);
			continue;
		}

		appliedCount += 1;
		totalAddedLines += applied.totalAddedLines;
		totalRemovedLines += applied.totalRemovedLines;
		const hunkDelta = applied.totalAddedLines - applied.totalRemovedLines;
		const fp = finalPositions.get(item.index)!;
		hunkShifts.push({
			index: item.index,
			delta: hunkDelta,
			firstStableLineNew: fp.finalEnd + 1,
			lastChangedLine: fp.finalEnd,
			originalStartLine: edit.hash_bounds[0].line,
			originalEndLine: edit.hash_bounds[1].line,
			finalStartLine: fp.finalStart,
			finalEndLine: fp.finalEnd,
		});
		lastApplied = {
			content: currentContent,
			hashes: currentHashes,
		};
		currentContent = applied.result;
		currentHashes = applied.hashes;
		// Migrate the in-memory served mirror: applying from the back keeps
		// earlier rows' positions stable, but rows below this hunk shifted.
		served = migrateServedAfterEdit(served, currentHashes, applied.hashes);
		clearNoopLoop(absolutePath);
		if (applied.anchorWarnings?.length)
			warnings.push(...applied.anchorWarnings);
	}
	const result = currentContent;
	let resultHashes = currentHashes;
	if (appliedCount > 0) {
		resultHashes = await lineHashes(result, absolutePath, undefined, true);
	}

	if (hadUtf8DecodeErrors) {
		warnings.push(
			"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
		);
	}
	if (first.pathWarning) warnings.unshift(first.pathWarning);

	let driftNotice: string | undefined;
	if (appliedCount > 0 && unionStartLine !== Infinity) {
		const resultLines = splitLines(result);
		const originalLines = splitLines(originalNormalized);
		try {
			driftNotice = await scanDrift({
				sessionKey: opts.sessionKey,
				served,
				resultHashes,
				resultLines,
				range: {
					startLine: unionStartLine,
					endLine: unionEndLine,
					startHash: unionStartHash,
					endHash: unionEndHash,
					delta: resultLines.length - originalLines.length,
				},
				path: absolutePath,
			});
		} catch (error) {
			console.error("Failed to compute drift notice:", error);
		}
	}

	return {
		displayPath: first.path,
		absolutePath,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		originalHashes,
		resultHashes,
		appliedCount,
		noopCount,
		totalAddedLines,
		totalRemovedLines,
		driftNotice,
		range: {
			startLine: unionStartLine,
			endLine: unionEndLine,
			startHash: unionStartHash,
			endHash: unionEndHash,
			delta: splitLines(result).length - splitLines(originalNormalized).length,
		},
		hunkShifts,
		// Synthesize the served mirror for the post-edit diff window: the
		// diff hunks' new-file rows (position, hash) plus context. This is
		// what `recordServedTruncated` later records so the model's view of
		// the change region is marked served for the next edit.
		servedRows: appliedCount > 0 ? buildServedRowsFromDiff(
			originalNormalized,
			result,
			resultHashes,
		) : [],
		...(unionFirstChangedLine !== undefined ? { firstChangedLine: unionFirstChangedLine } : {}),
		...(unionLastChangedLine !== undefined ? { lastChangedLine: unionLastChangedLine } : {}),
	};
}

/**
 * Build served rows (position, hash) from the diff hunks between `before`
 * and `after`. The new-file rows that participate in a diff hunk (added,
 * removed, or context) are marked served. This is the batch/merge analogue
 * of the single-edit `genDiff().servedRows`.
 */
function buildServedRowsFromDiff(
	before: string,
	after: string,
	resultHashes: string[],
): { position: number; hash: string }[] {
	const rows: { position: number; hash: string }[] = [];
	const seen = new Set<number>();
	const resultLines = splitLines(after);
	const beforeLines = splitLines(before);
	// Simple LCS-free diff-window: a coarse but safe approximation that marks
	// the region around the first and last differing line as served, plus the
	// unchanged lines actually shown in the diff (which the model sees).
	const minLen = Math.min(beforeLines.length, resultLines.length);
	let firstDiff = -1;
	for (let k = 0; k < minLen; k++) {
		if (beforeLines[k] !== resultLines[k]) { firstDiff = k; break; }
	}
	if (firstDiff === -1 && beforeLines.length !== resultLines.length) {
		firstDiff = minLen;
	}
	const push = (pos: number) => {
		if (pos < 0 || pos >= resultHashes.length || seen.has(pos)) return;
		seen.add(pos);
		rows.push({ position: pos, hash: resultHashes[pos]! });
	};
	if (firstDiff === -1) return rows;
	const lastDiff = (() => {
		let k = 0;
		while (
			k < minLen - firstDiff &&
			beforeLines[beforeLines.length - 1 - k] === resultLines[resultLines.length - 1 - k]
		) k++;
		return Math.max(firstDiff, resultLines.length - 1 - k);
	})();
	for (let p = Math.max(0, firstDiff - 2); p <= Math.min(resultHashes.length - 1, lastDiff + 2); p++) {
		push(p);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// the write transaction

export interface UndoWriteFile {
	absolutePath: string;
	displayPath: string;
	originalNormalized: string;
	bom: string;
	originalEnding: LineEnding;
	originalHashes: string[];
	result: string;
}

export interface PersistWriteOptions {
	io: FileIO;
	files: UndoWriteFile[];
	exec: ToolExecution;
	sandbox: FsSandboxController;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
	signal?: AbortSignal;
	/** [E_UNDO_UNAVAILABLE] message builder, per tool flavor. */
	undoUnavailableMessage: (displayPath: string) => string;
	/**
	 * On write failure, also restore undo entries of files that were saved but
	 * never written. The single-edit tool restores its one entry; the batch
	 * tool keeps current behavior and restores only written files.
	 */
	restoreUnwrittenUndos?: boolean;
}

/** Retry once on transient Windows atomic-replace failures before surfacing. */
async function writeWithRetry(
	io: FileIO,
	absolutePath: string,
	content: string,
	signal: AbortSignal | undefined,
	exec: Parameters<FileIO["writeText"]>[3],
	sandboxPolicy: Parameters<FileIO["writeText"]>[4],
): Promise<void> {
	try {
		await io.writeText(absolutePath, content, signal, exec, sandboxPolicy);
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/replacefilew|win32 1175|unable to move replacement/i.test(message)) {
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		await io.writeText(absolutePath, content, signal, exec, sandboxPolicy);
	}
}

/**
 * The persist-undo → write-all → restore-on-failure transaction shared by
 * `edit` (one or more files via the `edits` array). Every file's undo entry is
 * persisted before anything is written; if a write fails, already-written
 * files are restored (original content written back, undo entry restored) and
 * the sandbox-mapped error rethrown.
 */
export async function persistUndoAndWrite(
	opts: PersistWriteOptions,
): Promise<void> {
	const { io, files } = opts;
	const undos: Array<{
		file: UndoWriteFile;
		restore: () => Promise<void>;
	}> = [];
	for (const file of files) {
		const undo = await saveUndo(file.absolutePath, {
			content: file.originalNormalized,
			bom: file.bom,
			originalEnding: file.originalEnding,
			hashes: file.originalHashes,
			resultContent: file.result,
		});
		if (!undo.persisted) {
			for (const u of undos) {
				try {
					await u.restore();
				} catch (error) {
					console.error("Failed to restore undo entry after abort:", error);
				}
			}
			throw new Error(opts.undoUnavailableMessage(file.displayPath));
		}
		undos.push({ file, restore: undo.restore });
	}

	const written: typeof undos = [];
	try {
		for (const u of undos) {
			abortIf(opts.signal);
			// Windows atomic-replace failures are often transient (antivirus
			// scan windows, sync tools reopening the file): retry once before
			// failing the batch.
			await writeWithRetry(
				io,
				u.file.absolutePath,
				u.file.bom + restoreEndings(u.file.result, u.file.originalEnding),
				opts.signal,
				opts.exec,
				opts.sandboxPolicy,
			);
			written.push(u);
		}
	} catch (error) {
		for (const w of written) {
			try {
				await io.writeText(
					w.file.absolutePath,
					w.file.bom +
						restoreEndings(
							w.file.originalNormalized,
							w.file.originalEnding,
						),
					undefined,
					opts.exec,
					opts.sandboxPolicy,
				);
			} catch (restoreError) {
				console.error("Failed to restore file after write failure:", restoreError);
			}
			try {
				await w.restore();
			} catch (restoreError) {
				console.error(
					"Failed to restore undo entry after write failure:",
					restoreError,
				);
			}
		}
		if (opts.restoreUnwrittenUndos) {
			for (const u of undos) {
				if (written.includes(u)) continue;
				try {
					await u.restore();
				} catch (restoreError) {
					console.error(
						"Failed to restore undo entry after write failure:",
						restoreError,
					);
				}
			}
		}
		throw opts.sandbox.mapError(error, opts.sandboxPolicy);
	}
}

// re-exported for the callers that used to import these from the pipeline
export type { ServeRecordPolicy };
