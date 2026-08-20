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
	"Edit a range of lines in a text file, targeted by `<line>#<hash>` anchors from read / grep / diff output. " +
	"`remove_from` is required and marks the FIRST line to remove (inclusive); `remove_to` is optional and marks the LAST line to remove (omit to edit only `remove_from`). " +
	"Copy the anchor EXACTLY from the leftmost column of a row — e.g. `12#ve7│function hello() {` means `\"remove_from\": \"12#ve7\"`. " +
	"A bare 3-char hash is accepted only when you are sure the file has not shifted above; otherwise use the full `<line>#<hash>` form to guard against stale line numbers. " +
	"Never pass the line content, a code line, or a paragraph into these fields. " +
	"The post-edit response includes a `Shift:` block describing how absolute line numbers below the edit have moved; use that block to chain the next edit without a fresh read.";

export const EDIT_GUIDANCE: ToolGuidance = {
	intro:
		"Edit a range of lines via a `<line>#<hash>` anchor from read / grep / diff output — never by line content.",
	lines: [
		"`edit`: anchor the exact first and last lines that change by their `<line>#<hash>` markers (e.g. `12#ve7`, not `ve7│function…`). A single line omits `remove_to`. Never anchor a whole function or import block when part of it changes.",
		"`edit`: prefer the full `line#hash` form; a bare hash is accepted only when you are sure the file has not shifted above.",
		"`edit`: replacement_text is byte-exact for the whole range — every line inside it you do not reproduce byte-exact is deleted, and leading whitespace is preserved exactly.",
		"`edit`: `\\n` is a line break, so a range ending on a blank line must end replacement_text with `\\n` and a non-blank last line must not; a blank-line run is one `\\n` per blank line.",
		"`edit`: the post-edit diff rows carry fresh `+line#hash` / `-line#hash` markers plus a `Shift:` block. Read the Shift block before chaining — it tells you that lines below the edit moved by `+K` so you can use `newLine#oldHash` on the next edit instead of calling read.",
		"`edit`: a stale or never-served range is hard-rejected (`[E_STALE_ANCHOR]` / `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`); the rejection echoes the target line in read format (±3 context) and counts as a fresh serve — copy the fresh marker from the echo and retry without reading.",
		"`edit`: for multiple edits to one file, use batch_edit — it validates every item before writing and applies them all-or-nothing, emitting a Shift block per hunk.",
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

export const BATCH_EDIT_DESCRIPTION =
	"Apply several edits in one atomic call. Each item is exactly like the edit tool: " +
	"{ path?, remove_from, remove_to?, replacement_text }, where anchors are `<line>#<hash>` or bare 3-char hash, and remove_to is optional (omit to edit only remove_from). " +
	"Items targeting the same file are applied in order. Every item is verified against what the tool served you before ANYTHING is written: if any item " +
	"fails — stale or ambiguous anchor, changed range interior, never-served line — the whole batch is rejected and no file changes. The failing item's current range is served back as fresh read-format rows so you can retry without a read. " +
	"The response carries one diff section per hunk and a `Shift:` block after each hunk whose `K` is the cumulative added-minus-removed through that hunk — chain the next edit by reading the Shift block, no re-read required. " +
	"Use batch_edit whenever you have multiple edits; do not issue several edit calls in one message.";

export const BATCH_EDIT_GUIDANCE: ToolGuidance = {
	intro: "Apply several edits in one atomic call.",
	lines: [
		"`batch_edit`: each item is edit's shape — { path?, remove_from, remove_to?, replacement_text } — with `<line>#<hash>` anchors; items apply in order, and same-file ranges must not overlap.",
		"`batch_edit`: all-or-nothing — any failing item writes nothing anywhere and echoes its current range as fresh read-format rows that count as serves.",
		"`batch_edit`: each applied hunk emits its own diff plus a `Shift:` block whose `K` is the cumulative added-minus-removed through that hunk; read the Shift block to chain the next edit without re-reading.",
		"`batch_edit`: a no-op item is reported without failing; the result is one combined diff per file with fresh anchors.",
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