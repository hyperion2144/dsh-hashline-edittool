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
import { containsElisionMarker } from "../../render/read-summary.js";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
// No `isBlockOp`, no `resolveBlockEdit`, no grammar and no dirname: this engine
// rewrites nothing and parses nothing. Structural work arrives already resolved
// as line ops — see the note further down for why that is the right split.
import type { EditOp } from "../../contract/contract.js";
import { notifyDocumentWritten } from "../../lsp/sync.js";
import type { FileIO } from "../../infra/fs-bridge.js";
import type { HashStore } from "../session/hash-store.js";
import type { LineEnding } from "../../render/edit-diff.js";
import { restoreEndings } from "../../render/edit-diff.js";
import { normFromText } from "../session/file-view.js";
import { scanDrift, loadServed, migrateServedAfterEdit, loadServedKeys } from "../session/session-view.js";
import { isContentMismatch } from "../../hashline/declaration.js";
import {
	applyEdit,
	resEdit,
	parseHashRef,
	parseText,
	type Anchor,
	type HEdit,
	type NEdit,
} from "../../hashline/anchor-pipeline.js";
import {
	detectRangeConflicts,
	describeEdge,
	type RangeEdge,
} from "./range-conflicts.js";
import { lineHashes } from "../../hashline/hash.js";
import {
	AnchorMismatchError,
	ServedRejectionError,
	buildRangeEcho,
	fmtServedRows,
	type ResolvedRange,
	type ServedRow,
} from "../../hashline/anchor-pipeline.js";
// Served-state recording lives with the state it writes (`session-view`),
// not in the resolve/apply engine — see the note at that seam.
import { recordEchoServes, type ServeRecordPolicy } from "../session/session-view.js";
import { findSnapshotPathsByHashes } from "../session/hash-store.js";
import { updateAnchorsAfterEdit } from "../../hashline/session-anchors.js";
import { saveUndo } from "./undo-edit.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { NOOP_LOOP_THRESHOLD } from "../../infra/constants.js";
import { abortIf, splitLines } from "../../infra/utils.js";
import type { FsSandboxController } from "../../infra/sandbox.js";

// ---------------------------------------------------------------------------
// shared helpers

/** Resolve each bound's AUTHORITATIVE line by anchor lookup. A supplied
 *  `<line>:<anchor>` hint is informational only (issue #66/B6): an unverified
 *  hint that leaked into the batch hunk bookkeeping desynced the incremental
 *  anchor update (undefined.replace crash on out-of-range rows). The anchor
 *  is authoritative, so the resolved position always wins; a disagreeing
 *  hint is surfaced later as a warning by the resolver. An unknown anchor
 *  keeps line UNDEFINED (no line claim) — applyEdit's mismatch renderer owns
 *  that case ([E_STALE] + echo); a fabricated -1 here reads as a real
 *  out-of-range line claim to valEdit's gate and leaked
 *  "line -1..-1 is out of range" into the error message.
 */
function pinBound(bound: Anchor, fileAnchors: string[]): Anchor {
	const idx = fileAnchors.indexOf(bound.anchor);
	if (idx >= 0) {
		// EXCLUSIVITY: an anchor bound to two live lines means some earlier
		// serve re-allocated a freed anchor while the model still held the old
		// binding. Resolving by first-indexOf would silently relocate the edit
		// (the `2t` double-booking incident): refuse instead — the caller's
		// reject-and-serve path echoes fresh anchors.
		const second = fileAnchors.indexOf(bound.anchor, idx + 1);
		if (second >= 0) {
			throw new Error(
				`[E_ANCHOR_AMBIGUOUS] anchor "${bound.anchor}" is currently live on lines ${idx + 1} and ${second + 1} — the file's anchor state is inconsistent (an external rewrite re-allocated a served anchor). Re-read the file and retry with fresh anchors; nothing was written.`,
			);
		}
	}
	return { anchor: bound.anchor, line: idx >= 0 ? idx + 1 : undefined };
}

/** Returns the pinned edit plus a warning list for hints that
 *  disagreed with the resolved position (#59/#66: mismatch is informational). */
function pinBounds(
	edit: HEdit,
	fileAnchors: string[],
	warnings: string[],
): HEdit {
	const pin = (bound: Anchor): Anchor => {
		const pinned = pinBound(bound, fileAnchors);
		if (
			bound.line !== undefined &&
			pinned.line !== undefined &&
			pinned.line >= 0 &&
			bound.line !== pinned.line
		) {
			warnings.push(
				`[E_LINE_HINT] line hint ${bound.line} does not match anchor ${bound.anchor} (resolved to line ${pinned.line}); anchor is authoritative, edit proceeds.`,
			);
		}
		return pinned;
	};
	return {
		content_lines: edit.content_lines,
		hash_bounds: [pin(edit.hash_bounds[0]), pin(edit.hash_bounds[1])],
	};
}

// ---------------------------------------------------------------------------
// shared types

export interface PreparedItem {
	index: number;
	path: string;
	absolutePath: string;
	remove_from: string;
	remove_to: string;
	replacement_text: string;
	/** `op: "sed"` only: the regex source, its replacement text, and its flags. */
	pattern?: string;
	replacement?: string;
	flags?: string;
	pathWarning?: string;
	/** Edit semantic. Defaults to "replace"; the block ops are resolved to a
	 *  line range before this point (spec §6.3). */
	op?: EditOp;
	/** Declared line content for anchor_start (require_line_content ON). */
	expectedStart?: string;
	/** Declared line content for anchor_end (only when explicitly passed). */
	expectedEnd?: string;
	/**
	 * Whether the caller actually supplied `anchor_end` (rather than it being
	 * folded from `anchor_start`). A block op treats a supplied `anchor_end` as
	 * a **range assertion**, so "omitted" and "asserted equal to the opener"
	 * must not be confused.
	 */
	anchorEndAsserted?: boolean;
	/**
	 * The `<line>` hint the caller wrote in `anchor_start` / `anchor_end`.
	 *
	 * Normalization strips it (the anchor is authoritative), but a block op
	 * needs it: the extent is resolved by finding which construct STARTS at
	 * that line, and an anchor string alone cannot answer that.
	 */
	lineStart?: number;
	lineEnd?: number;
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
servedRows: { position: number; anchor: string }[];
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
			hashes.push(parseHashRef(ref).anchor);
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
	const startLine = (edit.hash_bounds[0].line ?? -1) - 1;
	const endLine = (edit.hash_bounds[1].line ?? -1) - 1;
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
	/** Content keys parallel to `served` — activates the drift gate. */
	servedKeys?: (string | null)[];
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	absolutePath: string;
	displayPath: string;
	signal?: AbortSignal;
	/** Echo rows carry `<line>:<anchor>` markers unless this is false. */
	lineNumbers?: boolean;
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
	 * (the pre-0.3 default); `"sed"` rewrites the range LINE BY LINE with a
	 * regular expression, so `replacementText` is unused and `pattern` /
	 * `replacement` / `flags` are. Defaults to `"replace"`.
	 */
	op?: EditOp;
	/** `op: "sed"` only: the regex source applied to each line of the range. */
	pattern?: string;
	/** `op: "sed"` only: the replacement text (sed's `\1`/`&` also accepted). */
	replacement?: string;
	/** `op: "sed"` only: a subset of `gims`. */
	flags?: string;
	/** Declared line content for anchor_start (require_line_content ON). */
	expectedStart?: string;
	/** Declared line content for anchor_end (only when explicitly passed). */
	expectedEnd?: string;
	/**
	 * Whether the caller actually supplied `anchor_end` (rather than it being
	 * folded from `anchor_start`). A block op treats a supplied `anchor_end` as
	 * a **range assertion**, so "omitted" and "asserted equal to the opener"
	 * must not be confused.
	 */
	anchorEndAsserted?: boolean;
	/**
	 * The `<line>` hint the caller wrote in `anchor_start` / `anchor_end`.
	 *
	 * Normalization strips it (the anchor is authoritative), but a block op
	 * needs it: the extent is resolved by finding which construct STARTS at
	 * that line, and an anchor string alone cannot answer that.
	 */
	lineStart?: number;
	lineEnd?: number;
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
 * Translate a sed replacement into JavaScript's replacement dialect, so both
 * spellings work and neither is a trap:
 *
 *   `\1` … `\9`  →  `$1` … `$9`   (sed's group reference)
 *   `\&`         →  `&`            (a LITERAL ampersand)
 *   `&`          →  `$&`           (the whole match, as sed means it)
 *
 * Everything else passes through unchanged, `$1` / `$&` included — JavaScript's
 * own syntax is already what `String.replace` will read.
 *
 * @param raw - the caller's replacement text.
 * @returns the same replacement in JavaScript's dialect.
 */
export function sedReplacement(raw: string): string {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (ch === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1]!;
			if (next >= "1" && next <= "9") {
				out += `$${next}`;
				i += 1;
				continue;
			}
			if (next === "&") {
				out += "&";
				i += 1;
				continue;
			}
		}
		if (ch === "&") {
			out += "$&";
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Build the per-line rewrite an `op: "sed"` edit applies to its anchor range.
 *
 * Line by line, on purpose: that is what sed does, and it is also what keeps
 * the edit's line COUNT unchanged, so every downstream hunk calculation stays
 * honest (the contract refuses a replacement containing a newline for exactly
 * this reason). Without `g` only the first match on each line is replaced —
 * sed's own default.
 *
 * @param pattern - regular-expression source (already validated).
 * @param replacement - replacement text, either dialect.
 * @param flags - a subset of `gims`, or undefined.
 * @returns a transform over the range's lines.
 */
export function sedTransform(
	pattern: string,
	replacement: string,
	flags?: string,
): (lines: readonly string[]) => string[] {
	const re = new RegExp(pattern, flags ?? "");
	const repl = sedReplacement(replacement);
	return (lines) => lines.map((line) => line.replace(re, repl));
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
	// Resolve removeFrom by its anchor. A bare anchor is globally unique in
	// v2.0 (identical content lines get DISTINCT anchors), so indexOf is
	// unambiguous; a `<line>:<anchor>` hint is verified when present.
	let fromLine = -1;
	try {
		const ref = parseHashRef(removeFrom);
		const hintLine = ref.line;
		const hintValid =
			hintLine !== undefined &&
			hintLine >= 1 &&
			hintLine <= hashes.length &&
			hashes[hintLine - 1] === ref.anchor;
		fromLine = hintValid ? hintLine - 1 : hashes.indexOf(ref.anchor);
	} catch {
		// Let resEdit surface the anchor error with the right code.
		return { removeTo: removeFrom, replacementText };
	}
	if (fromLine < 0) {
		// Anchor does not verify — let resEdit/applyEdit surface
		// [E_STALE] / [E_RANGE_UNVERIFIED].
		return { removeTo: removeFrom, replacementText };
	}
	const lines = splitLines(content);
	const fromContent = lines[fromLine] ?? "";
	const insertedLines = parseText(replacementText);
	// Detect the common mistake of including the anchor line in `lines`:
	// if lines[0] matches the anchor line content, warn (do NOT auto-fix).
	// The edit applies as-is; the warning guides the model to undo + resubmit.
	if (insertedLines.length > 0 && insertedLines[0]!.replace(/\s+$/, "") === fromContent.replace(/\s+$/, "")) {
		warnings.push(
			`[E_INS_ANCHOR_DUP] op:"ins" lines[0] matches the anchor_after line content (line ${fromLine + 1}). ins puts lines BELOW that anchor, which is KEPT automatically — so putting its own line in \`lines\` duplicates it. If unintended: undo_last_edit and resubmit without the anchor line.`,
		);
	}
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
	// `sed` ALWAYS resolves here, even when a pre-resolved edit was supplied:
	// its content is a function of the range's CURRENT lines, and only this
	// path has the file's text in hand to run the substitution over. A
	// pre-resolved `sed` (the batch pre-pass) is therefore ignored on purpose.
	if (input.edit && input.op !== "sed") {
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
			{ start: input.expectedStart, end: input.expectedEnd },
			{
				lineNumbers: input.lineNumbers,
				transform:
					input.op === "sed"
						? sedTransform(input.pattern ?? "", input.replacement ?? "", input.flags)
						: undefined,
			},
		);
	} catch (error) {
		if (
			error instanceof AnchorMismatchError ||
			error instanceof ServedRejectionError ||
			isContentMismatch(error)
		) {
			return onReject(error, edit);
		}
		throw error;
	}

	const result = anchorResult.content;
	const noop = result === input.content;
	if (noop) {
		const { totalAddedLines, totalRemovedLines } = countLineChanges(
			edit,
			input.countHashes ?? input.hashes,
			true,
			0,
		);
		return {
			result,
			hashes: input.hashes,
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

	// issue #131 锚点漂移修复：
	//
	// 这里曾经调 lineHashes(result, path) —— 即 anchorsFor —— 而中间态内容的
	// checksum 永远不会命中会话快照，于是每个 op 之后都触发一次
	// assignAnchors 全量重算。同内容行组（`});` 这类闭合行）按出现顺序重新
	// 排队，后续 op 的锚点（如 `486:TX`）在污染过的数组里 indexOf 命中到
	// 完全无关的行 —— 编辑落在了用户从未引用过的行上。
//
	// 锚点分配的唯二合法时机：某行内容首次被会话看到；某行内容发生变化。
	// batch 中间态两者都不是 —— 这里只做单 hunk 增量迁移：内容不变的行
	// verbatim 保留锚点，删除行释放，插入行新分配。
	// HUNK 行数用实际行数差推导，而非 countLineChanges：sed 在 applyOne 内
	// 重新 resEdit，其 content_lines 是空壳，countLineChanges 的 added 对
	// sed 不实（曾因此让增量迁移丢行）。整份文件的行数差全部来自这一个
	// hunk，所以 added_hunk = 新总行数 - 旧总行数 + hunk 内被替换的行数。
	const removedCount = anchorResult.range.endLine - anchorResult.range.startLine + 1;
	const addedCount =
		splitLines(result).length - splitLines(input.content).length + removedCount;
	const resultHashes = updateAnchorsAfterEdit({
		path: input.absolutePath,
		oldContent: input.content,
		newContent: result,
		oldAnchors: input.hashes,
		hunks: [
			{
				oldStart1: anchorResult.range.startLine,
				oldEnd1: anchorResult.range.endLine,
				finalStart1: anchorResult.range.startLine,
				finalEnd1: anchorResult.range.startLine + addedCount - 1,
			},
		],
	});

	return {
		result,
		hashes: resultHashes,
		range: anchorResult.range,
		noop,
		edit,
		noopEdit: anchorResult.noopEdit,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		totalAddedLines: addedCount,
		totalRemovedLines: removedCount,
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
	/**
	 * The file handle + execution that make an echo OBSERVED as well as served.
	 * An echo the model cannot write with is decorative, so both ride along.
	 */
	io: FileIO;
	exec?: ToolExecution;
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
				splitLines(opts.originalNormalized),
			);
			const echo = fmtServedRows(
				echoRows,
				splitLines(opts.originalNormalized),
			);
			try {
				await recordEchoServes(
					sessionKey,
					absolutePath,
					echoRows,
					"live",
					originalHashes.length,
				);
			} catch (recordError) {
				// issue #136: loud, but the noop-loop guard's own outcome must keep
				// standing — the echo text is already in the model's response.
				console.error("[E_SERVED_RECORD] failed to record echo rows:", recordError);
			}
			await opts.io.emitObserved(absolutePath, opts.exec);
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
			try {
				await recordEchoServes(
					sessionKey,
					absolutePath,
					echoRows,
					"live",
					originalHashes.length,
				);
			} catch (recordError) {
				// issue #136: loud, never silent; the noop-loop error keeps throwing.
				console.error("[E_SERVED_RECORD] failed to record echo rows:", recordError);
			}
			await opts.io.emitObserved(absolutePath, opts.exec);
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
	fileLines: string[],
): ServedRow[] | undefined {
	const startAnchor = edit.hash_bounds[0].anchor;
	const endAnchor = edit.hash_bounds[1].anchor;
	const s = originalHashes.indexOf(startAnchor);
	const e = originalHashes.indexOf(endAnchor);
	if (s < 0 || e < 0) return undefined;
	return buildRangeEcho(Math.min(s, e) + 1, Math.max(s, e) + 1, originalHashes, fileLines);
}

/**
 * Run a file's item list against freshly-read content with served
 * verification, evolving content/hashes, union range, noop tracking, and a
 * per-file drift notice. All-or-nothing is enforced by the caller's
 * transaction ({@link persistUndoAndWrite}): nothing here writes to disk.
 */
// The block-op path is GONE — `resolveBlockItems`, `resolveBlockEdit` and the
// gate below it all existed to turn a symbol-anchored op into a line-range op.
// That was AST folded into `edit`, and `ast_edit` does it better: it finds the
// extent by SHAPE and hands an ordinary line edit to this engine, so the
// conflict detection, application, drift, served migration and undo here never
// needed to know a grammar existed.
//
// The syntax gate went with it. It only ever fired for block ops, and
// `ast_edit` runs its own — because a structural tool leaving unparsable code
// behind is that tool's failure mode, not this engine's.
//

export async function runFileEdits(
	io: FileIO,
	rawItems: PreparedItem[],
	opts: { signal?: AbortSignal; sessionKey: string; lineNumbers?: boolean; exec?: ToolExecution },
): Promise<FileEditResult> {
	const items = [...rawItems];
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
	const servedKeys = await loadServedKeys(opts.sessionKey, absolutePath);
	const warnings: string[] = [];
	// A literal U+2026 in a payload is almost always a pasted `ast_grep` outline
	// row rather than source, and writing one puts the fold marker into the file.
	//
	// A WARNING, not a refusal — which is a correction. It used to be
	// `[E_ELISION_IN_PAYLOAD]` in the request contract, and that was wrong twice
	// over by now: `edit` is a general line editor, so a file that legitimately
	// CONTAINS the character (a UI string, prose, i18n) could not be edited at
	// all — it blocked the very edit that wrote this comment — and the original
	// justification (a pure line-level `replace` ran no syntax check) no longer
	// distinguishes anything, because the block ops are gone. The signal is worth
	// keeping; the veto was not.
	for (const item of items) {
		if (containsElisionMarker(item.replacement_text)) {
			warnings.push(
				`[E_ELISION_IN_PAYLOAD] edits[${item.index}] carries U+2026, which is how an ast_grep outline renders a FOLDED range — not source. If it was meant as literal text the edit is correct as written; if it was pasted from an outline, undo and re-read the lines you meant to change.`
			);
		}
	}

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
		const pinned = pinBounds(edit, originalHashes, warnings);
		if (item.op === "sed") {
			// The substitution is a function of the range's CURRENT text, so the
			// content is produced in `applyOne` (which has the file) — this
			// pre-pass only needs the right LINE COUNT for the shift report, and
			// sed preserves the count by construction.
			const startLine = pinned.hash_bounds[0].line;
			const endLine = pinned.hash_bounds[1].line;
			const rows =
				startLine !== undefined && endLine !== undefined
					? Math.max(1, endLine - startLine + 1)
					: 1;
			pinned.content_lines = new Array<string>(rows).fill("");
		}
		resolvedEdits.push({ item, edit: pinned, isIns: item.op === "ins" });
	}

	// --- Phase 2: conflict detection on original coordinates. ---
	// Hunks whose anchors do not match the original snapshot are excluded:
	// their true positions are unknown, and applyOne reports them as stale
	// (with the ±3 echo + fresh marker) instead of a misleading overlap.
const anchorMatchesSnapshot = (edit: HEdit): boolean =>
		edit.hash_bounds.every(
			(b) =>
				b.line !== undefined &&
				b.line >= 1 &&
				b.line <= originalHashes.length &&
				originalHashes[b.line - 1] === b.anchor,
		);
	// replace swaps the whole range for `lines` of ANY length (the range
	// count is not constrained) — only the dual-anchor requirement is
	// contractual.
const edges: RangeEdge[] = resolvedEdits
		.filter(({ edit }) => anchorMatchesSnapshot(edit))
		.map(({ item, edit, isIns }) => ({
			index: item.index,
			startLine: edit.hash_bounds[0].line!,
			endLine: edit.hash_bounds[1].line!,
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
			(a, b) => a.edit.hash_bounds[0].line! - b.edit.hash_bounds[0].line!,
		);
		let offset = 0;
		for (const entry of asc) {
			const startLine = entry.edit.hash_bounds[0].line!;
			const endLine = entry.edit.hash_bounds[1].line!;
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
			b.edit.hash_bounds[0].line! - a.edit.hash_bounds[0].line! ||
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
				servedKeys,
				removeFrom: item.remove_from,
				removeTo: item.remove_to,
				replacementText: item.replacement_text,
				op: item.op,
				pattern: item.pattern,
				replacement: item.replacement,
				flags: item.flags,
				expectedStart: item.expectedStart,
				expectedEnd: item.expectedEnd,
				absolutePath,
				displayPath: item.path,
				signal: opts.signal,
				warnings,
				lineNumbers: opts.lineNumbers,
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
						try {
							await recordEchoServes(
								opts.sessionKey,
								absolutePath,
								error.servedRows,
								"live",
								originalHashes.length,
							);
						} catch (recordError) {
							// issue #136: loud, but the primary rejection must keep
							// propagating — the echo is already in the rejection text.
							console.error(
								"[E_SERVED_RECORD] failed to record echo rows:",
								recordError,
							);
						}
						// The echo IS a read: the session has now seen these lines, so the
						// dsh observation policy must know it too. Without this the echoed
						// rows are servable but not WRITABLE — a retry with a fresh marker
						// from the echo failed [E_NOT_OBSERVED], which made the echo
						// decorative.
						await io.emitObserved(absolutePath, opts.exec, opts.signal);
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
				echoRows: echoRowsForItem(applied.edit, originalHashes, splitLines(originalNormalized)),
				io,
				exec: opts.exec,
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
			originalStartLine: edit.hash_bounds[0].line!,
			originalEndLine: edit.hash_bounds[1].line!,
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
		// v2.0 incremental anchor update (not a full recompute): unchanged
		// lines keep their anchors across the whole batch.
		resultHashes = updateAnchorsAfterEdit({
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
		});
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
				io,
				exec: opts.exec,
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
): { position: number; anchor: string }[] {
	const rows: { position: number; anchor: string }[] = [];
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
		rows.push({ position: pos, anchor: resultHashes[pos]! });
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
		// The file is on disk; tell the language server, if one is running for
		// it. This never throws and never starts a server (see lsp/sync.ts).
		notifyDocumentWritten(absolutePath, content);
		return;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/replacefilew|win32 1175|unable to move replacement/i.test(message)) {
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		await io.writeText(absolutePath, content, signal, exec, sandboxPolicy);
		notifyDocumentWritten(absolutePath, content);
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
