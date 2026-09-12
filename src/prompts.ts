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

/** Edit tool description, generated from the effective config (text/json, declaration mode). */
export function editDescription(cfg: EffectiveHashlineConfig): string {
	const base = cfg.requireLineContent
		? "Apply one or more edits atomically: each item is `{op: ins|del|replace|sed, anchor_after?: {anchor, line}, anchor_start?: {anchor, line}, anchor_end?: {anchor, line}, lines?}` — `ins` takes `anchor_after` (the line to insert BELOW, which is KEPT, so `lines` holds only the new lines), `replace`/`del` take `anchor_start`; `sed` takes `anchor_start` plus `pattern`/`replacement`/`flags?` and rewrites each line of the range in place (no `lines`, no newline in `replacement`). Every anchor is a pair: the anchor PLUS the current full text of its line, verified before applying (mismatch = [E_CONTENT_MISMATCH]). Anchors are variable-length Base62 (`<anchor>` or `<line>:<anchor>`) copied from read/grep/diff rows. Items resolve against one file snapshot — overlapping ranges are rejected (`[E_BATCH_CONFLICT]`)."
		: "Apply one or more edits atomically: each item is `{op: ins|del|replace|sed, anchor_after?, anchor_start?, anchor_end?, lines?, pattern?, replacement?, flags?}` — `op:\"ins\"` takes `anchor_after` ONLY (the line to insert BELOW; it is KEPT, so `lines` holds only what is NEW); `replace` and `del` take `anchor_start` and never `anchor_after`; `op:\"sed\"` takes `anchor_start` (+ optional `anchor_end`) plus `pattern`/`replacement`/`flags?` and rewrites every line of that range with the regular expression (no `lines`; the replacement must not contain a newline). Anchors are variable-length Base62 (`<anchor>` or `<line>:<anchor>`) copied from read/grep/diff rows, never line content. Items resolve against one file snapshot — overlapping ranges are rejected (`[E_BATCH_CONFLICT]`).";
	if (cfg.outputFormat === "json") {
		return base + " JSON output: `{ok, files:[{path, applied, finalLines, noop}], hints, warnings, errors}` — `finalLines` keys are fresh anchors for follow-up edits.";
	}
	return base;
}

/**
 * Edit guidance, generated from the effective config. With
 * `require_line_content` ON the anchor bullets teach the `{ anchor, line }`
 * declaration form; OFF keeps the plain-anchor contract verbatim.
 */
export function editGuidance(cfg: EffectiveHashlineConfig): ToolGuidance {
	if (cfg.requireLineContent) {
		return {
			intro:
				"Edit one or more ranges via `edits:[{op, anchor_after?: {anchor, line}, anchor_start?: {anchor, line}, anchor_end?: {anchor, line}, lines?}]` — `ins` anchors on `anchor_after`, the others on `anchor_start`; every anchor carries a declaration of its line's current text.",
			lines: [
				"`edit`: each item is `{ op, anchor_after?: {anchor, line}, anchor_start?: {anchor, line}, anchor_end?: {anchor, line}, lines? }`. `op` is `ins` (insert BELOW `anchor_after` — that line is KEPT, so `lines` holds only the new lines), `del` (delete the `anchor_start..anchor_end` range — single line when `anchor_end` is omitted), or `replace` (swap the `anchor_start..anchor_end` range with `lines`).",
				"`edit`: the anchor field follows the OP, and mixing them is REFUSED. `ins` + `anchor_start` is `[E_BAD_SHAPE]` — it was the same field name once, and a caller who had just used `replace` carried that reading over, put the anchor's own line into `lines`, and duplicated it. `anchor_after` names a POSITION, not a range start.",
				"`edit`: `line` is your declaration of the line's CURRENT full text, verbatim from your latest read — single line, no newlines; an empty string declares an empty line. Trailing whitespace may be omitted and a copied read-row marker prefix is tolerated; anything else must match exactly.",
				"`edit`: every declared line is verified before the edit applies (after the stale-anchor check) — a mismatch rejects the whole call with `[E_CONTENT_MISMATCH]`, echoing the actual line and where your declared content currently lives. Copy each declaration from the same read the anchors came from.",
				"`edit`: all three ops require declarations; omitting `anchor_end` (single-line range) declares only `anchor_start`; `lines` may have any number of lines. `op:\"ins\"` takes `anchor_after` and ONLY that — the insert lands BELOW that line; do NOT include the anchor line in `lines`.",
				"`edit`: `lines` is required (and must be non-empty) for `ins` and `replace`; forbidden for `del`. To clear a single line to empty, use `replace` with `lines: [\"\"]` — never `del` (which removes the line).",
				"`edit`: anchors are variable-length Base62 markers copied from the leftmost column of a read/grep/diff row; the legacy `<line>#<hash>` form is rejected (`E_BAD_REF`). Identical content lines get DISTINCT anchors — declare the line you mean.",
				"`edit`: ALL anchors (and declarations) in one call come from the same ORIGINAL read. The batch is ATOMIC — any hunk failure rejects the WHOLE batch ([E_BATCH_ABORT]) and nothing is written. Do not issue several `edit` calls in one message — one call, one `edits` array.",
			],
		};
	}
	return {
		intro:
			"Edit one or more ranges via `edits:[{op, anchor_after?, anchor_start?, anchor_end?, lines?, pattern?, replacement?, flags?}]` — `ins` anchors on `anchor_after`, the others on `anchor_start`; `sed` adds `pattern`/`replacement`.",
		lines: [
			"`edit`: each item is `{ op, anchor_after?, anchor_start?, anchor_end?, lines?, pattern?, replacement?, flags? }`. `op` is `ins` (insert BELOW `anchor_after` — that line is KEPT, so `lines` holds only the new lines), `del` (delete the `anchor_start..anchor_end` range — single line when `anchor_end` is omitted), `replace` (swap the `anchor_start..anchor_end` range with `lines`), or `sed` (rewrite every line of the `anchor_start..anchor_end` range with the regular expression in `pattern`, using `replacement` and optional `flags` — `g` replaces every match per line, `i` ignores case, `m` makes `^`/`$` match line boundaries, `s` lets `.` match a newline; without `g` only the FIRST match on each line is replaced, as command-line sed does).",
			"`edit`: `op:\"sed\"` takes `pattern` + `replacement` (and optional `flags`), NOT `lines` — mixing them is `[E_BAD_SHAPE]`. `replacement` accepts both dialects: sed's `\\1` and `&` (whole match) and JavaScript's `$1` and `$&`; an empty `replacement` deletes what the pattern matched. It must not contain a newline: sed substitutes WITHIN a line, so the range's line count never changes — use `op:\"replace\"` when lines must be added or removed.",
			"`edit`: the anchor field follows the OP, and mixing them is REFUSED. `ins` + `anchor_start` is `[E_BAD_SHAPE]` — it was the same field name once, and a caller who had just used `replace` carried that reading over, put the anchor's own line into `lines`, and duplicated it. `anchor_after` names a POSITION, not a range start.",
			"`edit`: `replace` swaps the `anchor_start..anchor_end` range for `lines` (any length). Omit `anchor_end` for a single-line range (anchor_start only) — the replacement may still have multiple lines. `ins` anchors on one line only.",
			"`edit`: op memory: `ins` KEEPS the `anchor_after` line and inserts `lines` below it — do NOT include that line's content in `lines` (it duplicates it); `del` only removes (lines is rejected); `replace` rewrites the range. A `Classification: noop` result means NOTHING was written — if you expected a change, the anchor or content is wrong: re-read and retry with the fresh marker.",
			"`edit`: `anchor_start` is required for `replace` and `del` and anchors the FIRST line of the range; `anchor_end` anchors the LAST line and is OPTIONAL — omitting it defaults to a single-line range; `lines` may have any number of lines. `op:\"ins\"` takes `anchor_after` INSTEAD OF `anchor_start`, and `anchor_end` is rejected on it: one anchor, one position.",
			"`edit`: `lines` is required (and must be non-empty) for `ins` and `replace`; forbidden for `del`. To clear a single line to empty, use `replace` with `lines: [\"\"]` — never `del` (which removes the line).",
			"`edit`: anchors must be variable-length Base62 markers copied from the leftmost column of a read/grep/diff row — never hand-write or paste line content. The legacy `<line>#<hash>` form is rejected (`E_BAD_REF`).",
			"`edit`: identical content lines get DISTINCT anchors — copy the exact marker of the line you mean.",
			"`edit`: ALL anchors in one call come from the same ORIGINAL read — never shift them to positions a previous hunk would produce in sequence (there is no 'after the previous edit' coordinate; the batch applies against the original snapshot). The response's diff rows show the FINAL positions; there is no `Shift:` block — re-read for fresh anchors after an edit.",
			"`edit`: a stale or never-served range is hard-rejected (`[E_STALE]` / `[E_RANGE_UNSERVED]`); the rejection echoes the target line in read format (±context lines) and counts as a fresh serve — copy the fresh marker from the echo and retry without reading.",
			"`edit`: the batch is ATOMIC — any hunk failure rejects the WHOLE batch ([E_BATCH_ABORT]) and nothing is written; already-resolved hunks are not applied, so there is nothing to roll back or undo. Do not issue several `edit` calls in one message — one call, one `edits` array.",
		],
	};
}

/** Read tool description, generated from the effective config (text/json). */
/**
 * What `read` deliberately does NOT do, said plainly.
 *
 * A model that has used the old AST selectors will reach for them; naming their
 * replacement is cheaper than letting it infer one from a rejection, and it is
 * the only way it learns that structure moved rather than disappeared.
 */
const AST_MOVED_NOTE =
 " This tool reads LINES and nothing else. For structure — a symbol's block, an outline, cross-file references — use `ast_grep` (no pattern returns the outline) or `lsp`. Structural selectors here are rejected, not silently ignored.";

export function readDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return (
			"Read a file as pure JSON: pass `file_path`. Returns {path, offset, totalLines, lines: {anchor: content}} inside a `<path>/<type>/<content>` envelope — each 'lines' key is `<anchor>:<line>` (anchor first, its line number trailing; pass `line_numbers: false` for bare anchors); the value is the verbatim file content. Binary/directory rejected; pageable with offset/limit." +
			AST_MOVED_NOTE
		);
	}
	return ("Read a text file: pass `file_path`. Each row is `<anchor>:<line>:content` — the anchor FIRST, its line number trailing (pass `line_numbers: false` for bare `<anchor>:content` rows) — under an `ANCHOR:FILELINE` header inside a `<path>/<type>/<content>` envelope; the anchor is the edit address and is authoritative — the line number is a positional hint only. Binary/directory rejected; pageable with offset/limit." +
		AST_MOVED_NOTE);
}

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		"Use read, not shell commands, to inspect text files and obtain the variable-length anchors the editing tools require.",
	lines: [
		"`read`: call it only for content the tools have not served — a page you never saw, or lines past the post-edit diff.",
		"`read`: each row is `<anchor>:<line>:content` — copy the ANCHOR (the first token); the line number trails it and is a hint only (`line_numbers: false` gives bare `<anchor>:content`). Identical content lines get DISTINCT anchors. The header `ANCHOR:FILELINE` separates marker columns from file content.",
		"`read`: the ANCHOR comes first; the number after it is that line's number, informational only. Either half works as the anchor field (the whole `<anchor>:<line>` marker or the bare anchor both parse — and a bare line number alone is accepted too, resolved to that served line), but the anchor is authoritative. Pass `line_numbers: false` for bare `<anchor>:content` rows.",
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
		return "Search files (JavaScript-flavre regex by default; `regex: false` for literal); `path` defaults to the session workspace, directories recurse the whole tree (hidden and node_modules skipped), optional `include` is a single positive glob. Returns pure JSON {total, files: [{path, matches: {anchor: content}}]} — keys are `<anchor>:<line>` edit markers (the variable-length Base62 anchor first, its line number trailing), values are verbatim file content; matches are served so they can be edited directly.";
	}
	return "Search files (JavaScript-flavre regex by default; `regex: false` for literal): `path` defaults to the session workspace and directories recurse the whole tree (hidden and node_modules skipped); optional `include` is a single positive glob filter. Output mirrors `read` (`<anchor>:<line>:content` rows — anchor first, line number trailing; `line_numbers: false` for bare anchors); matches are served, so they can be edited directly.";
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