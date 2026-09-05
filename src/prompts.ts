/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. Each tool's schema `description` is short;
 * the `tool:*` system-prompt sections carry the brief guidance the model
 * reads when the tools are presented. Guidance is uniform: a one-line opener
 * followed by tight bullets.
 *
 * v2.0: anchors are variable-length Base62 (`[A-Za-z0-9]{1,8}`, 2-char
 * first), unique per line, and the legacy `<line>#<hash>` form is REJECTED
 * (`E_BAD_REF`). Line numbers are an optional output (`line_numbers: true`)
 * rendered as `<line>:<anchor>` — informational only, never part of the
 * anchor. Stale references fail hard via the served-content check.
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
		"Apply one or more edits atomically: each item is `{op: ins|del|replace, anchor_start, anchor_end?, lines?}`; anchors are variable-length Base62 (`<anchor>` or `<line>:<anchor>`) copied from read/grep/diff rows, never line content. Items resolve against one file snapshot — overlapping ranges are rejected (`[E_BATCH_CONFLICT]`).";
	if (cfg.outputFormat === "json") {
		return base + " JSON output: `{ok, files:[{path, applied, finalLines, noop}], hints, warnings, errors}` — `finalLines` keys are fresh anchors for follow-up edits.";
	}
	return base;
}

export const EDIT_GUIDANCE: ToolGuidance = {
	intro:
		"Edit one or more ranges via `edits:[{op, anchor_start, anchor_end?, lines?}]` — never by line content.",
	lines: [
		"`edit`: each item is `{ op, anchor_start, anchor_end?, lines? }`. `op` is `ins` (insert after `anchor_start`), `del` (delete the `anchor_start..anchor_end` range — single line when `anchor_end` is omitted), or `replace` (swap the `anchor_start..anchor_end` range with `lines`).",
		"`edit`: `replace` requires BOTH `anchor_start` and `anchor_end` (a single-line replace passes the same anchor twice); `lines` has ANY length — the whole range is swapped for it. `ins` may anchor on a range's end line, never its start/interior.",
		"`edit`: op memory: `ins` KEEPS the anchor line and inserts after it (using it like replace leaves the old line behind); `del` only removes (lines is rejected); `replace` rewrites the range. A `Classification: noop` result means NOTHING was written — if you expected a change, the anchor or content is wrong: re-read and retry with the fresh marker.",
		"`edit`: `anchor_start` is required and anchors the FIRST line of the range; `anchor_end` anchors the LAST line and is OPTIONAL — omitting it defaults to a single-line replace/delete (range = anchor_start only). A replace with MORE THAN ONE line in `lines` REQUIRES anchor_end (the tool will not guess the range from the replacement length). `op:\"ins\"` accepts ONLY `anchor_start` — the insert lands AFTER that line; `anchor_end` is rejected.",
		"`edit`: `lines` is required (and must be non-empty) for `ins` and `replace`; forbidden for `del`. To clear a single line to empty, use `replace` with `lines: [\"\"]` — never `del` (which removes the line).",
		"`edit`: anchors must be variable-length Base62 markers copied from the leftmost column of a read/grep/diff row — never hand-write or paste line content. The legacy `<line>#<hash>` form is rejected (`E_BAD_REF`).",
		"`edit`: identical content lines get DISTINCT anchors — copy the exact marker of the line you mean.",
		"`edit`: ALL anchors in one call come from the same ORIGINAL read — never shift them to positions a previous hunk would produce in sequence (there is no 'after the previous edit' coordinate; the batch applies against the original snapshot). The response's diff rows show the FINAL positions; there is no `Shift:` block — re-read for fresh anchors after an edit.",
		"`edit`: a stale or never-served range is hard-rejected (`[E_STALE]` / `[E_RANGE_UNSERVED]`); the rejection echoes the target line in read format (±context lines) and counts as a fresh serve — copy the fresh marker from the echo and retry without reading.",
		"`edit`: the batch is ATOMIC — any hunk failure rejects the WHOLE batch ([E_BATCH_ABORT]) and nothing is written; already-resolved hunks are not applied, so there is nothing to roll back or undo. Do not issue several `edit` calls in one message — one call, one `edits` array.",
	],
};

/** Read tool description, generated from the effective config (text/json). */
export function readDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return "Read a file as pure JSON: pass `file_path`. Returns {path, offset, totalLines, lines: {anchor: content}} inside a `<path>/<type>/<content>` envelope — each 'lines' key is `<line>:<anchor>` (line prefix default on; pass `line_numbers: false` for bare anchors); the value is the verbatim file content. Binary/directory rejected; pageable with offset/limit.";
	}
	return "Read a text file: pass `file_path`. Each row is `<line>:<anchor>:content` (line number on by default; pass `line_numbers: false` for bare `<anchor>:content` rows) under an `ANCHOR:FILELINE` header inside a `<path>/<type>/<content>` envelope; the anchor is the edit address and is authoritative — the line number is a positional hint only. Binary/directory rejected; pageable with offset/limit.";
}

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		"Use read, not shell commands, to inspect text files and obtain the variable-length anchors the editing tools require.",
	lines: [
		"`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
		"`read`: each row is `<line>:<anchor>:content` (line number on by default; `line_numbers: false` gives bare `<anchor>:content`); the marker is the anchor (variable-length Base62, shortest-first; identical content lines get DISTINCT anchors). The header `ANCHOR:FILELINE` separates marker columns from file content.",
		"`read`: the `<line>:` prefix is a positional hint — copy only the anchor part (or the whole `<line>:<anchor>`, both accepted) into edit; the anchor is authoritative. Pass `line_numbers: false` for bare `<anchor>:content` rows.",
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
		"`undo_last_edit`: the restored diff's `+<anchor>:` rows are fresh anchors for follow-up edits.",
	],
};

/** Grep tool description, generated from the effective config (text/json). */
export function grepDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return "Search files (JavaScript-flavre regex by default; `regex: false` for literal); `path` defaults to the session workspace, directories recurse the whole tree (hidden and node_modules skipped), optional `include` is a single positive glob. Returns pure JSON {total, files: [{path, matches: {anchor: content}}]} — keys are `<line>:<anchor>` edit anchors (variable-length Base62, line prefix default on), values are verbatim file content; matches are served so they can be edited directly.";
	}
	return "Search files (JavaScript-flavre regex by default; `regex: false` for literal): `path` defaults to the session workspace and directories recurse the whole tree (hidden and node_modules skipped); optional `include` is a single positive glob filter. Output mirrors `read` (`<line>:<anchor>:content` rows, line number on by default; `line_numbers: false` for bare anchors); matches are served, so they can be edited directly.";
}

export const GREP_GUIDANCE: ToolGuidance = {
	intro: "Search files and obtain variable-length anchors in one step.",
	lines: [
		"`grep`: defaults to JavaScript-flavre regex; pass `regex: false` for literal substring matching. Only set the flag when a literal pattern would mis-parse as regex (e.g. it contains (, [, *, +, ?).",
		"`grep`: `-C N` (or `--context N`) adds N marker rows above and below each match — use a small N to keep context cheap; the rows still carry markers, so a hit from the context window is editable.",
		"`grep`: one section per file, separated by `--- <path> ---`. Each section opens with `ANCHOR:FILELINE` and lists matches in file order.",
		"`grep`: every file read is recorded as observed, so the matches can be edited without a separate `read` call.",
		"`grep`: use `limit` to cap matches per file when probing a noisy file; the cap applies per file, not globally.",
	],
};