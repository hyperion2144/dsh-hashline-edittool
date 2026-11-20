/**
 * Model-facing prompt text for the hashline tools, embedded so the bundle
 * ships no external prompt files. #447 splits the surface three ways: a
 * tool-schema `description` states the purpose and at most one contract
 * sentence; the schema's per-field descriptions carry the mechanical
 * reference (op shapes, range rules, flags); and the `tool:*` system-prompt
 * sections carry the behavioral discipline — one intro plus at most five
 * bullets, no error-code tables, no format legends.
 *
 * v2.0: anchors are variable-length Base62 (`[A-Za-z0-9]{1,8}`, 2-char
 * first), unique per line, and the legacy `<line>#<hash>` form is rejected
 * (`E_BAD_REF`). Line numbers are the user's switch, off by default: when on,
 * a row's marker carries its 1-indexed line as `<anchor>:<line>` — informational
 * only, never part of the anchor; when off, rows carry the bare anchor.
 * Stale references fail hard via the served-content check.
 * @module dsh-hashline-edittool/prompts
 */

import type { ToolGuidance } from "../../contract/tool-guidance.js";

export type { ToolGuidance };

import type { EffectiveHashlineConfig } from "../../infra/settings.js";

/** Edit tool description: purpose first, one contract sentence — the mechanics live in the schema fields and the guidance section (#447). */
export function editDescription(cfg: EffectiveHashlineConfig): string {
	const declaration = cfg.requireLineContent
		? ", each anchor declared with its line's current text"
		: "";
	return (
		"Apply anchored edits to one or more files: insert, delete, replace or rewrite lines by the anchors a read, grep or diff row of this session carries" +
		declaration +
		". Within one file the edits are one atomic batch — a failure writes nothing for that file, other files are unaffected, and per-item paths let one call span several files."
	);
}

/**
 * Edit guidance, generated from the effective config. With
 * `require_line_content` ON the first bullet teaches the `{ anchor, line }`
 * declaration form; OFF keeps the plain-anchor contract.
 */
export function editGuidance(cfg: EffectiveHashlineConfig): ToolGuidance {
	if (cfg.requireLineContent) {
		return {
			intro:
				"Edit ranges of lines by the anchors — and declared line text — a read, grep or diff of this session returned.",
			lines: [
				"`edit`: every anchor is `{anchor, line}` — the line's current text declared verbatim from the same read the anchor came from; a mismatch rejects that file's batch and writes nothing for that file.",
				"`edit`: anchors and declarations come from one original read — the batch resolves against that snapshot, so never shift them to positions an earlier hunk would produce; re-read for fresh anchors after an edit.",
				"`edit`: serve the whole range first — every line between the range's two anchors must have been read; when the middle is longer than one window, resume or offset through it, or split the edit into smaller ranges.",
				"`edit`: in the returned diff, `+` and unchanged rows carry fresh anchors for the next edit; a `~` row's anchor is dead, and the file/hunk headers are structure, not lines; a `Classification: noop` result means that file was not written — re-read and retry with the fresh marker.",
				"`edit`: one call, one `edits` array — each file's edits are atomic and files are independent; a rejection echoes the target line as a fresh serve, so retry from the echoed marker without re-reading.",
			],
		};
	}
	return {
		intro: "Edit ranges of lines by the anchors a read, grep or diff of this session returned.",
		lines: [
			"`edit`: pick anchors from one original read — the batch resolves against that snapshot, so never shift them to positions an earlier hunk would produce; re-read for fresh anchors after an edit.",
			"`edit`: serve the whole range first — every line between `anchor_start` and `anchor_end` must have been read; when the middle is longer than one window, resume or offset through it, or split the edit into smaller ranges.",
			"`edit`: in the returned diff, `+` and unchanged rows carry fresh anchors for the next edit; a `~` row's anchor is dead, and the file/hunk headers are structure, not lines; a `Classification: noop` result means that file was not written — re-read and retry with the fresh marker.",
			"`edit`: one call, one `edits` array — each file's edits are atomic and files are independent; a rejection echoes the target line as a fresh serve, so retry from the echoed marker without re-reading.",
		],
	};
}

/** Read tool description: purpose first, one contract sentence — the row-format legend lives in the guidance section (#447). */
export function readDescription(cfg: EffectiveHashlineConfig): string {
	const contract =
		cfg.outputFormat === "json"
			? "Each line is keyed by its row marker with the verbatim content as the value; binary and directory paths are refused, and long files page with offset and limit or a resume token."
			: "Each row pairs its anchor with the verbatim line content; binary and directory paths are refused, and long files page with offset and limit or a resume token.";
	return (
		"Read a text file and obtain its lines with the hash anchors the editing tools address — this tool reads lines and nothing else, so for a symbol's block, an outline or cross-file references use ast_grep or lsp. " +
		contract
	);
}

export const READ_GUIDANCE: ToolGuidance = {
	intro:
		"Read a file's lines with their anchors — the one source of line content and anchors for every anchored tool.",
	lines: [
		"`read`: a row is `anchor: content` — copy the anchor (the first token); with the user's line numbers on the marker reads `anchor:line:content` and the number is a hint only. Identical lines have distinct anchors — copy the exact marker of the line you mean.",
		"`read`: call it for content no tool has served yet — a page never seen, or lines past the last post-edit diff — not to re-confirm what a return already showed.",
		'`read`: results over the per-response budget stop mid-file with one window sentence — `[Lines X-Y of N. Omitted K lines. Use read {resume: "TOKEN"} to continue.]` — pass the token back via `resume` to continue; a report token answers with a `[Continued report]` segment, and offset/limit still work.',
	],
};

/**
 * Read guidance, flag-aware: when the user chose `write.preview: confirmation`
 * (map #354) a write serves no rows at all, so the model has to `read` before
 * editing what it just wrote. The section is rebuilt live on a flag flip, the
 * same way the edit guidance already is.
 */
export function readGuidance(cfg: EffectiveHashlineConfig): ToolGuidance {
	if (cfg.writePreview !== "confirmation") return READ_GUIDANCE;
	return {
		...READ_GUIDANCE,
		lines: [
			...READ_GUIDANCE.lines,
			"`read`: a `write` under the user's `confirmation` preview returns only a one-line confirmation — no file content and no anchors were served, so read the file before editing what that write produced.",
		],
	};
}

export const UNDO_DESCRIPTION =
	"Undo the last edit on a file, reverting it to its previous state. Use when an edit produced " +
	"incorrect results (e.g., wrong content, duplicated lines, broken syntax).";

export const UNDO_GUIDANCE: ToolGuidance = {
	intro: "Revert the last edit on a file.",
	lines: [
		"`undo_last_edit`: reverts only the most recent edit — any write clears history, so call it immediately after a bad edit.",
		"`undo_last_edit`: the restored diff's `+<anchor>:` rows are fresh anchors for follow-up edits; a `-` row's `~` anchor is the pre-revert line and is dead.",
	],
};

/** Grep tool description: purpose first, one contract sentence (#447). */
export function grepDescription(cfg: EffectiveHashlineConfig): string {
	if (cfg.outputFormat === "json") {
		return (
			"Locate text across files and obtain the anchors of the matching lines in the same call — the anchored counterpart of a shell search. " +
			"A regex by default (literal via regex false) with an optional include glob; matches are keyed by their row markers and served, so a hit can be edited directly."
		);
	}
	return (
		"Locate text across files and obtain the anchors of the matching lines in the same call — the anchored counterpart of a shell search. " +
		"A regex by default (literal via regex false) with an optional include glob; matches come back in read's row form and are served, so a hit can be edited directly."
	);
}

export const GREP_GUIDANCE: ToolGuidance = {
	intro: "Search file contents and obtain the anchors of the matching lines in one step.",
	lines: [
		"`grep`: reach for it instead of a shell search — its rows are served, so a match (or a context row from a small `-C N`) can be edited directly.",
		"`grep`: a regex by default; pass `regex: false` only when a literal would mis-parse as regex. Use `include` to filter by glob and `limit` to cap a noisy file.",
		"`grep`: one section per file in file order, every match row carrying its anchor.",
		'`grep`: results over the per-response budget spill to a resume file whose footer — `(Omitted N lines (~C chars). Use grep {resume: "TOKEN"} to continue.)` — names the token; pass it via `resume` for the next segment.',
	],
};

/** Delete tool description: purpose first, one contract sentence (#447). */
export const DELETE_DESCRIPTION =
	"Delete regular files and reclaim the hashline state they leave behind. " +
	"Takes 1-32 explicit paths; deletion is permanent with no undelete, a missing path is success, and partial failures are reported per path.";

export const DELETE_GUIDANCE: ToolGuidance = {
	intro: "Delete regular files and reclaim the hashline rows they leave behind.",
	lines: [
		"`delete`: 1-32 explicit paths, duplicates collapsing, relative to the session cwd — no directory, glob or recursive form; use bash for anything not a regular file.",
		"`delete`: permanent, no undelete; a missing path is success and still reclaims residue; one path's failure does not stop the others.",
		"`delete`: on success the path's anchor, served and undo rows are purged — other sessions' old anchors for it are dead and they re-read.",
		"`delete`: under workspace-write the target must sit inside the writable roots; the escalation fields apply only when the schema advertises them.",
	],
};

/** Rename tool description: purpose first, one contract sentence (#447). */
export const RENAME_DESCRIPTION =
	"Rename or move regular files, carrying their hashline state — anchors, served rows, undo history — to the new path. " +
	"Takes 1-32 {from, to} pairs run in request order; nothing is overwritten and partial failures are reported per pair.";

export const RENAME_GUIDANCE: ToolGuidance = {
	intro: "Rename or move regular files and keep their hashline anchors usable.",
	lines: [
		"`rename`: use it instead of `bash mv` — it moves the anchors, served rows and undo history as the same rows under the new path, so no re-read is needed afterwards.",
		"`rename`: 1-32 `{from, to}` pairs run in request order (chains work), relative to the session cwd; no glob or directory form.",
		"`rename`: regular files only and nothing is overwritten — an existing destination refuses unless it is the same file under another spelling, and the destination's parent must already exist.",
		"`rename`: under workspace-write both sides must sit inside the writable roots; the escalation fields apply only when the schema advertises them.",
	],
};

/**
 * `apply_patch` guidance (map #401).
 *
 * The compiled default text of the `tool:apply_patch` prompt section: the
 * grammar in one line, then the five rules the model cannot guess — where the
 * tool belongs, that anchors (not copied text) address the lines, that the
 * whole patch is checked before anything is written, that a stopped commit is
 * not rolled back, and what a completed operation hands back.
 */
export const APPLY_PATCH_GUIDANCE: ToolGuidance = {
	intro:
		"apply_patch applies one change set across files: file sections (file / new / move / remove) with anchor hunks (replace / insert / delete)",
	lines: [
		"Reach for it when a change spans several files or creates, removes or moves a file; a single-file anchored surgery stays `edit`.",
		"Every hunk is addressed by an anchor from this session's read/grep/diff rows — the patch never repeats file content.",
		"The whole patch is checked before anything is written (syntax, shape, paths, anchors); a rejected patch lists every problem at once and changes nothing.",
		"Once applying starts, operations run in order, stop at the first failure and are not rolled back — re-read the affected files before retrying.",
		"A completed add/update/move returns fresh anchors for the changed lines; a created file returns anchors for its own rows too, so it can be edited right away.",
	],
};

/**
 * `apply_patch` tool description (map #401).
 *
 * #447: purpose and one contract sentence here; the full grammar lives
 * on the `patch` field's description, and the failure model on the
 * guidance section. The disable notice stays cfg-driven.
 *
 * @param cfg - the effective settings (only the disable notice reads them).
 * @returns the model-facing schema description.
 */
export function applyPatchDescription(cfg: EffectiveHashlineConfig): string {
	const disabled = cfg.applyPatchEnabled
		? ""
		: " (Disabled by settings: this tool should not be offered at all.)";
	return (
		"Apply one change set across several files in a single call — update, create, move or delete files with anchor-addressed hunks. " +
		"The patch is text (file sections with `+`-prefixed content lines; the full grammar lives on the `patch` field); the whole patch is checked before anything is written, and a refused patch changes nothing." +
		disabled
	);
}