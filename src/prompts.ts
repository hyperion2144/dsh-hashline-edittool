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

export const EDIT_DESCRIPTION =
	"Apply one or more edits to a text file in a single atomic call. Each item in `edits` carries an `op` (`ins` / `del` / `replace`), a `from` anchor (and optionally a `to` anchor for ranges), and the `lines` to insert or replace with. " +
	"`ins` inserts `lines` AFTER the `from` line (the `from` line itself is preserved); `del` removes the from..to range; `replace` swaps the from..to range with `lines`. " +
	"Pass `<line>#<hash>` (e.g. `12#ve7`) for `from` / `to`, copied EXACTLY from the leftmost column of a read/grep/diff row; a bare 3-char hash is accepted only when you are sure the file has not shifted above. " +
	"Never pass the line content into these anchor fields. " +
	"Edits apply in order against evolving content. The post-edit response includes a `Shift:` block per hunk describing how absolute line numbers below that edit moved; use the block to chain the next edit (`newLine=<N>#<oldHash>` from the next unchanged diff row, or read for fresh anchors).";

export const EDIT_GUIDANCE: ToolGuidance = {
	intro:
		"Edit one or more ranges via `edits:[{op, from, to?, lines?}]` — never by line content.",
	lines: [
		"`edit`: each item is `{ op, from, to?, lines? }`. `op` is `ins` (insert after `from`), `del` (delete the from..to range), or `replace` (swap the from..to range with `lines`).",
		"`edit`: `from` is required and anchors the FIRST line of the range (`12#ve7`); `to` is optional and anchors the LAST line (omit = single-line edit). `op:\"ins\"` accepts ONLY `from` — the insert lands AFTER that line; `to` is rejected.",
		"`edit`: `lines` is required (and must be non-empty) for `ins` and `replace`; forbidden for `del`. To clear a single line to empty, use `replace` with `lines: [\"\"]` — never `del` (which removes the line).",
		"`edit`: prefer the full `line#hash` form; a bare hash is accepted only when you are sure the file has not shifted above.",
		"`edit`: the post-edit diff rows carry fresh `+line#hash` / `-line#hash` markers plus a `Shift:` block. Read the Shift block before chaining — it tells you that lines below the edit moved by `+K` so you can use `newLine#oldHash` on the next edit instead of calling read.",
		"`edit`: a stale or never-served range is hard-rejected (`[E_STALE_ANCHOR]` / `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); the rejection echoes the target line in read format (±3 context) and counts as a fresh serve — copy the fresh marker from the echo and retry without reading.",
		"`edit`: for multiple edits to one file (or across files with per-item `path`), list them in ONE `edits` array — the tool validates every item before writing and applies them all-or-nothing, emitting a Shift block per hunk. Do not issue several `edit` calls in one message.",
	],
};

export const READ_DESCRIPTION =
	"Read a text file; each line is returned as `<line>#<hash>│content` (`line` = absolute 1-indexed line number, `hash` = 3-char content-derived). " +
	"The response opens with a `HASH IDENTIFIER │ FILE LINES` header; everything below the header is the verbatim file line content. " +
	"Use the `line#hash` (or bare `hash`) as the anchor in `edit` calls. Binary/directory → rejected; empty → header only; pageable with offset/limit; BOM stripped; non-UTF-8 shown as U+FFFD.";

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		"Use read, not shell commands, to inspect text files and obtain the line#hash anchors the editing tools require.",
	lines: [
		"`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
		"`read`: each row is `<line>#<hash>│content`; the marker is the anchor (line number + 3-char hash). The header `HASH IDENTIFIER │ FILE LINES` separates marker columns from file content.",
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
		"`undo_last_edit`: the restored diff's `+line#hash│` and ` line#hash│` rows are fresh anchors for follow-up edits.",
	],
};

export const GREP_DESCRIPTION =
	"Search one or more files for a literal string (or, with `regex: true`, a JavaScript-flavre regex). " +
	"Output mirrors `read`: each match is a `<line>#<hash>│content` row under a `HASH IDENTIFIER │ FILE LINES` header, one section per file. " +
	"Context rows (`-C N`) carry markers too. Matches and context rows are recorded as served, so you can edit the hit directly with the grep output's marker — no separate `read` required.";

export const GREP_GUIDANCE: ToolGuidance = {
	intro: "Search files and obtain line#hash anchors in one step.",
	lines: [
		"`grep`: defaults to literal substring matching; pass `regex: true` for JavaScript-flavre regex (escape special chars when in doubt).",
		"`grep`: `-C N` (or `--context N`) adds N marker rows above and below each match — use a small N to keep context cheap; the rows still carry markers, so a hit from the context window is editable.",
		"`grep`: one section per file, separated by `--- <path> ---`. Each section opens with `HASH IDENTIFIER │ FILE LINES` and lists matches in file order.",
		"`grep`: every file read is recorded as observed, so the matches can be edited without a separate `read` call.",
		"`grep`: use `limit` to cap matches per file when probing a noisy file; the cap applies per file, not globally.",
	],
};