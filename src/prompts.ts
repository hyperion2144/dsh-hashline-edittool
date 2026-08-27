/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's schema `description` is short;
 * the `tool:*` system-prompt sections carry the brief guidance the model
 * reads when the tools are presented. Guidance is uniform: a one-line opener
 * followed by tight bullets.
 * @module dsh-hashline-edittool/prompts
 */

/**
 * One tool's guidance: a brief opener plus concise bullets. The `intro` is
 * shown above the bullets; it does not duplicate the tool-schema `description`
 * (that already reaches the model through the tool catalog).
 */
export interface ToolGuidance {
	/** One-line lead shown above the bullets. */
	intro: string;
	/** Concise bullets; each is self-contained within its section. */
	lines: readonly string[];
}

import type { EffectiveHashlineConfig } from "./config.js";

/** Edit tool description, generated from the effective config (text/json). */
export function editDescription(cfg: EffectiveHashlineConfig): string {
	const base =
		"Apply one or more edits atomically: each item is `{op: ins|del|replace, anchor_start, anchor_end?, lines?}`; anchors are `<line>#<hash>` copied from read/grep/diff rows, never line content. Items resolve against one file snapshot — overlapping ranges are rejected (`[E_BATCH_CONFLICT]`).";
	if (cfg.outputFormat === "json") {
		return base + " JSON output: `{ok, files:[{path, applied, finalLines, noop}], hints, warnings, errors}` — `finalLines` keys are fresh anchors for follow-up edits.";
	}
	return base;
}

export const EDIT_GUIDANCE: ToolGuidance = {
	intro:
		"Edit one or more ranges via `edits:[{op, anchor_start, anchor_end?, lines?}]` — never by line content.",
	lines: [
		"`edit`: each item is `{ op, anchor_start, anchor_end?, lines? }`. `op` is `ins` (insert after `anchor_start`), `del` (delete the from..to range), or `replace` (swap the from..to range with `lines`).",
		"`edit`: `replace` requires BOTH `anchor_start` and `anchor_end` (a single-line replace passes the same anchor twice); `lines` has ANY length — the whole range is swapped for it. `ins` may anchor on a range's end line, never its start/interior.",
		"`edit`: op memory: `ins` KEEPS the anchor line and inserts after it (using it like replace leaves the old line behind); `del` only removes (lines is rejected); `replace` rewrites the range. A `Classification: noop` result means NOTHING was written — if you expected a change, the anchor or content is wrong: re-read and retry with the fresh marker.",
		"`edit`: `anchor_start` is required and anchors the FIRST line of the range (`12#ve7`); `anchor_end` anchors the LAST line — REQUIRED for `replace` (a single-line replace passes the same anchor twice). `op:\"ins\"` accepts ONLY `anchor_start` — the insert lands AFTER that line; `anchor_end` is rejected.",
		"`edit`: `lines` is required (and must be non-empty) for `ins` and `replace`; forbidden for `del`. To clear a single line to empty, use `replace` with `lines: [\"\"]` — never `del` (which removes the line).",
		"`edit`: anchors must be `<line>#<hash>` copied from the leftmost column of a read/grep/diff row — never hand-write or paste bare hashes or line content.",
		"`edit`: ALL anchors in one call come from the same ORIGINAL read — never shift them to positions a previous hunk would produce in sequence (there is no 'after the previous edit' coordinate; the batch applies against the original snapshot). The response's diff rows and `Shift:` blocks show the FINAL positions.",
		"`edit`: a stale or never-served range is hard-rejected (`[E_STALE_ANCHOR]` / `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); the rejection echoes the target line in read format (±context lines) and counts as a fresh serve — copy the fresh marker from the echo and retry without reading.",
		"`edit`: the batch is ATOMIC — any hunk failure rejects the WHOLE batch ([E_BATCH_ABORT]) and nothing is written; already-resolved hunks are not applied, so there is nothing to roll back or undo. Do not issue several `edit` calls in one message — one call, one `edits` array.",
	],
};

/** Read tool description, generated from the effective config (text/json). */
export function readDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return `Read a file as pure JSON: {path, offset, totalLines, lines: {anchor: content}} — each "lines" key is a "<line>#<hash>" edit anchor; the value is the verbatim file content. Binary/directory rejected; pageable with offset/limit.`;
	}
	return "Read a text file: each line is `<line>#<hash>:content` under a `ANCHOR:FILELINE` header; the left marker is the edit anchor. Binary/directory rejected; pageable with offset/limit.";
}

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		"Use read, not shell commands, to inspect text files and obtain the line#hash anchors the editing tools require.",
	lines: [
		"`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
		"`read`: each row is `<line>#<hash>:content`; the marker is the anchor (line number + 3-char hash). The header `ANCHOR:FILELINE` separates marker columns from file content.",
		"`read`: rejection echoes return fresh read-format rows that count as serves — copy the fresh marker and retry without re-reading.",
		"`read`: binary/directory rejects; page large files with offset/limit.",
	],
};

export const UNDO_DESCRIPTION =
	"Undo the last edit on a file, reverting it to its previous state. Use when an edit produced " +
	"incorrect results (e.g., wrong content, duplicated lines, broken syntax).";

export const UNDO_GUIDANCE: ToolGuidance = {
	intro: "Revert the last edit on a file.",
	lines: [
		"`undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.",
		"`undo_last_edit`: the restored diff's `+line#hash:` and ` line#hash:` rows are fresh anchors for follow-up edits.",
	],
};

/** Grep tool description, generated from the effective config (text/json). */
export function grepDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return "Search files (literal by default, `regex: true` for regex); returns pure JSON {total, files: [{path, matches: [{anchor, text, contextBefore, contextAfter}]}]} — match anchors are edit anchors (line#hash), texts are verbatim file content; matches are served so they can be edited directly.";
	}
	return "Search files (literal by default, `regex: true` for regex); output mirrors `read` (`<line>#<hash>:content` rows); matches are served, so they can be edited directly.";
}

export const GREP_GUIDANCE: ToolGuidance = {
	intro: "Search files and obtain line#hash anchors in one step.",
	lines: [
		"`grep`: defaults to literal substring matching; pass `regex: true` for JavaScript-flavre regex (escape special chars when in doubt).",
		"`grep`: `-C N` (or `--context N`) adds N marker rows above and below each match — use a small N to keep context cheap; the rows still carry markers, so a hit from the context window is editable.",
		"`grep`: one section per file, separated by `--- <path> ---`. Each section opens with `ANCHOR:FILELINE` and lists matches in file order.",
		"`grep`: every file read is recorded as observed, so the matches can be edited without a separate `read` call.",
		"`grep`: use `limit` to cap matches per file when probing a noisy file; the cap applies per file, not globally.",
	],
};