/**
 * Declared line-content verification (require_line_content mode).
 *
 * When the `hashline.require_line_content` setting is enabled, every
 * `edits[]` anchor is a `{ anchor, line }` pair: besides the anchor the
 * model must DECLARE the current full text of the line that anchor
 * resolves to. The edit applies only when the declaration matches the
 * actual line — the defense against wrong/stale-anchor edits (duplicate
 * lines, wrong-row deletions) that the plugin-side served check cannot
 * see (the served check validates the file did not drift; the declared
 * check validates the MODEL aimed at the row it meant).
 *
 * Matching is two-stage (contract #76):
 *   1. verbatim compare after trailing-whitespace trim;
 *   2. fallback: strip a copied read/diff row marker prefix
 *      (`<line>:<anchor>| ` or `<anchor>| `) and compare again.
 * Leading (content) whitespace is never trimmed — indentation is content.
 * A real line whose text merely LOOKS like a marker row matches at stage
 * 1, so the strip can never mis-fire on marker-shaped content.
 *
 * @module dsh-hashline-edittool/declaration
 */

/** A model-declared anchor + line-content pair (`require_line_content` on). */
export interface AnchorDeclaration {
	/** The anchor (variable-length Base62, `<line>:<anchor>` also accepted). */
	anchor: string;
	/** The model's declaration of the anchor's current line text. */
	line: string;
}

/** Either contract form of an `edits[]` anchor field. */
export type AnchorRef = string | AnchorDeclaration;

/**
 * A copied read/diff row prefix: optional row indent, optional
 * `<line>:` half, a 2-4 char anchor (v2.0 anchors are 2+ chars —
 * "2 位起步"), the `|` separator and ONE optional space before the
 * content. Applied only as the stage-2 fallback; the 2-char floor keeps
 * ordinary short content like `x|b` from being mis-stripped.
 */
const MARKER_PREFIX = /^[ \t]*(?:\d+:)?[A-Za-z0-9]{2,4}\| ?/;

function trimEnd(text: string): string {
	return text.replace(/\s+$/, "");
}

/**
 * Two-stage declared-vs-actual comparison (contract #76). Stage 1 is the
 * verbatim compare after trailing trim — a line whose real content looks
 * like a marker row always matches here, so stage 2 can never mis-strip
 * marker-shaped content. Stage 2 strips a copied read/diff row marker
 * prefix and re-compares (leading whitespace of the CONTENT is preserved).
 */
export function declaredLineMatches(declared: string, actual: string): boolean {
	const d = trimEnd(declared);
	const a = trimEnd(actual);
	if (d === a) return true;
	const stripped = d.replace(MARKER_PREFIX, "");
	return stripped !== d && trimEnd(stripped) === a;
}

/** Which declared field failed (drives the error message). */
export type DeclarationField = "anchor_start" | "anchor_end";

/** Expected declarations for one edit, keyed by boundary. */
export interface ExpectedLines {
	start?: string;
	end?: string;
}

export class ContentMismatchError extends Error {
	readonly field: DeclarationField;

	constructor(field: DeclarationField, message: string) {
		super(message);
		this.name = "ContentMismatchError";
		this.field = field;
	}
}

export function isContentMismatch(error: unknown): error is ContentMismatchError {
	return error instanceof ContentMismatchError;
}

/**
 * Render the [E_CONTENT_MISMATCH] rejection: the offending field, the
 * declared vs actual line verbatim, and — the auto-correction — where the
 * declared content currently lives in the file, so a wrong-anchor edit
 * becomes a one-step fix (use those anchors instead).
 */
function mismatchMessage(
	field: DeclarationField,
	lineNumber: number,
	declared: string,
	actual: string,
	fileLines: string[],
	filePath: string | undefined,
): string {
	const where = filePath ? `${filePath}:${lineNumber}` : `line ${lineNumber}`;
	const lines = [
		`[E_CONTENT_MISMATCH] \`${field}.line\` does not match the actual content of ${where}.`,
		`  declared: ${declared}`,
		`  actual:   ${actual}`,
	];
	const hits: number[] = [];
	for (let i = 0; i < fileLines.length && hits.length < 10; i++) {
		if (i + 1 !== lineNumber && declaredLineMatches(declared, fileLines[i]!)) {
			hits.push(i + 1);
		}
	}
	if (hits.length > 0) {
		lines.push(
			`The content you declared currently appears at line${hits.length > 1 ? "s" : ""} ${hits.join(", ")} — you may be holding the wrong anchor. Use the anchor of that line, or re-read the file.`,
		);
	} else {
		lines.push(
			"Re-read the file for the current line content, then resubmit with the matching `line` declaration.",
		);
	}
	return lines.join("\n");
}

/**
 * Declared-content gate, run INSIDE the anchor pipeline right after the
 * served verification passes (contract timing: anchor resolution → served
 * E_STALE → declared check → apply). Every declared boundary must match
 * its resolved line; the first mismatch throws and the whole call rejects
 * (the edit stays atomic).
 *
 * Both boundaries are checked even when they fold to the same line: an
 * explicit same-anchor pair declares the line twice, and each declaration
 * must be truthful.
 */
export function verifyExpectedLines(opts: {
	startLine: number;
	endLine: number;
	fileLines: string[];
	filePath?: string;
	expected?: ExpectedLines;
}): void {
	const { expected } = opts;
	if (expected === undefined) return;
	if (expected.start !== undefined) {
		const actual = opts.fileLines[opts.startLine - 1] ?? "";
		if (!declaredLineMatches(expected.start, actual)) {
			throw new ContentMismatchError(
				"anchor_start",
				mismatchMessage(
					"anchor_start",
					opts.startLine,
					expected.start,
					actual,
					opts.fileLines,
					opts.filePath,
				),
			);
		}
	}
	if (expected.end !== undefined) {
		const actual = opts.fileLines[opts.endLine - 1] ?? "";
		if (!declaredLineMatches(expected.end, actual)) {
			throw new ContentMismatchError(
				"anchor_end",
				mismatchMessage(
					"anchor_end",
					opts.endLine,
					expected.end,
					actual,
					opts.fileLines,
					opts.filePath,
				),
			);
		}
	}
}
