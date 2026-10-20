/**
 * The automatic-format reporting vocabulary (map #275, decision B).
 *
 * The main diff answers "what did the MODEL change"; a format that follows it
 * answers a DIFFERENT question — "what did the FORMATTER change on top". The
 * two never merge: folding formatter churn into the model's diff would
 * misattribute the model's edit and mint anchors on rows the model never
 * produced. So a format result travels beside the main diff as a
 * {@link FormatSection}, rendered as its own block by the web card.
 *
 * Rows reuse {@linkcode EditDiffRow} — the shape the web diff card already
 * renders. Since #312 a row exists only for a formatter-changed line the
 * main diff does NOT already show — a line the main diff carries is counted
 * by `inMainDiffRows` and never duplicated here.
 *
 * @module dsh-hashline-edittool/domain/format/types
 */
import type { EditDiffRow } from "../../render/edit-card.js";

/** What the formatter pass actually did. */
export type FormatStatus =
	/** Formatting produced (or would produce) this file's final content. */
	| "formatted"
	/** The formatter answered, and the text was already conformant. */
	| "noop"
	/** Formatting did not run — no server, no formatter, or a failed attempt. */
	| "skipped";

/** Which request shape the formatter served. */
export type FormatMode = "range" | "full-file";

/**
 * One row of the format section: a formatter-changed final line the model may
 * address — the web diff card's own row shape. The former `alsoInMainDiff`
 * flag is retired (#312): an in-main line is not a row at all any more, only
 * a count on the section.
 */
export type FormatRow = EditDiffRow;

/** One file's formatting report, rendered beside that file's main diff. */
export type FormatSection = {
	status: FormatStatus;
	/** The server that formatted (or was asked to), e.g. `typescript-language-server`. */
	server?: string;
	/** How the request was served — a range of the edit hunks, or the whole file. */
	mode?: FormatMode;
	/** How many ranges were requested (edit hunks; 1 for a whole-file pass). */
	requested?: number;
	/** How many TextEdits the server actually returned and were applied. */
	applied?: number;
	/** Final lines whose text the formatter changed. */
	changedLines?: number;
	/** Formatter-changed lines NOT shown in the main diff and NOT eligible for an anchor. */
	unservedRows?: number;
	/** Formatter-changed lines the main diff already shows — counted, not returned (#312). */
	inMainDiffRows?: number;
	/** Why formatting was skipped (status `skipped` only). */
	reason?: string;
	/** The formatter-changed rows (status `formatted` only). */
	rows?: FormatRow[];
	/** The file the section belongs to (multi-file calls; omitted when redundant). */
	path?: string;
};
