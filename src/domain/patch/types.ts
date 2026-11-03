/**
 * The patch vocabulary — what a patch file section is, what a hunk inside one
 * is, and the refusal the parser raises when the input is not a patch.
 *
 * Grammar A′ of `docs/specs/apply-patch-spec.md`: a patch is a sequence of
 * file sections, every content line is `+`-prefixed, and a header is the only
 * thing that may appear un-prefixed. This module owns the names; the parser
 * owns the reading.
 *
 * @module dsh-hashline-edittool/patch/types
 */

/** The four section kinds a patch can open. */
export type PatchSectionKind = "file" | "new" | "move" | "remove";

/** The three hunk kinds a `file` or `move` section can carry. */
export type PatchHunkKind = "replace" | "insert" | "delete";

/**
 * One hunk: a header line plus the `+` content lines that belong to it.
 *
 * The hunk addresses a line of the target file by anchor; the old text is
 * never copied into the patch.
 */
export interface PatchHunk {
	/** The input line the hunk header was written on (1-indexed). */
	lineNumber: number;
	kind: PatchHunkKind;
	/** The addressed anchor — the range start when the header spelled a range. */
	anchorStart: string;
	/** The range end, when the header spelled `start..end`. */
	anchorEnd?: string;
	/**
	 * The content lines, without their `+` prefix and with everything after
	 * the `+` kept verbatim. A `delete` hunk never carries any.
	 */
	lines: string[];
}

/**
 * One file section: a header plus the hunks or the content it carries.
 *
 * A `new` section holds the whole file in `content` and has no hunks; a
 * `file` or `move` section holds hunks; a `remove` section holds neither.
 */
export interface PatchSection {
	kind: PatchSectionKind;
	/** The input line the section header was written on (1-indexed). */
	lineNumber: number;
	/** The section's own path — the source of a `move`. */
	path: string;
	/** The destination of a `move`. */
	destination?: string;
	/** The hunks of a `file` or `move` section; empty for `new` and `remove`. */
	hunks: PatchHunk[];
	/** The whole text of a `new` section, every line LF-terminated. */
	content?: string;
}

/**
 * A syntax refusal: the input is not a patch.
 *
 * The message is the contract's: `Invalid patch at line <n>: <reason>`, where
 * the line number points at the offending input line.
 */
export class PatchParseError extends Error {
	constructor(
		readonly lineNumber: number,
		readonly reason: string,
	) {
		super(`Invalid patch at line ${lineNumber}: ${reason}`);
		this.name = "PatchParseError";
	}
}
