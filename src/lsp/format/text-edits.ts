/**
 * Applying a server's TextEdits to document text — with the guards the
 * research (map #275 R1) says a naive implementation lacks.
 *
 * The LSP contract gives formatters freedom this module must survive:
 *
 * - Positions are `{ line, character }` in UTF-16 code units, and a
 *   `character` past the end of its line means "end of line". A `line` past
 *   the end of the DOCUMENT, however, is a malformed response — clangd's
 *   range expansion (R1: a range request may answer with edits spanning the
 *   enclosing declaration) makes slightly-larger-than-asked ranges normal,
 *   but never document-out-of-bounds ones. Those are refused.
 * - Edits may arrive in ANY order and may overlap. Overlapping edits are
 *   malformed (the LSP spec's own clients reject them): applied naively they
 *   silently swallow characters. Refused here.
 * - The plugin edits LF-normalized, BOM-stripped text (the read line space,
 *   ADR-0008) while a server may legitimately delete the BOM and rewrite
 *   line endings (R1 measured TLS doing both). The BOM and the original
 *   ending are restored here, so the file on disk keeps the shape the user
 *   had.
 *
 * @module dsh-hashline-edittool/lsp/format/text-edits
 */
import { restoreEndings, type LineEnding } from "../../render/edit-diff.js";
import { FormatEditError } from "./errors.js";

/** The subset of LSP `TextEdit` this module consumes. */
export interface LspTextEdit {
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
	readonly newText: string;
}

/** How the document text was shaped before formatting (post `stripBOM`/`toLF`). */
export interface TextShape {
	/** The BOM stripped from the raw file text (`""` when there was none). */
	readonly bom: string;
	/** The dominant line ending the raw file text used. */
	readonly eol: LineEnding;
}

interface ResolvedEdit {
	readonly start: number;
	readonly end: number;
	readonly newText: string;
}

/**
 * The offset of a `{ line, character }` inside LF-normalized text.
 *
 * `character` clamps to the line's length (LSP: past-the-end means
 * end-of-line); `line` beyond the document throws — that is a malformed
 * response, not a clamp.
 */
function resolveOffset(
	lineStarts: readonly number[],
	textLength: number,
	position: { line: number; character: number },
	label: string,
): number {
	// One entry per line (`lineStarts[lineCount]` is the END sentinel, never a
	// line start) — so a valid `line` is 0 .. lineCount-1, and a line past the
	// document is a malformed RESPONSE, not a clamp.
	const lineCount = lineStarts.length - 1;
	if (!Number.isInteger(position.line) || position.line < 0 || position.line >= lineCount) {
		throw new FormatEditError(
			`${label} line ${position.line} is outside the document (0–${lineCount - 1}).`,
		);
	}
	const lineStart = lineStarts[position.line]!;
	const lineLength =
		position.line === lineCount - 1
			? textLength - lineStart
			: lineStarts[position.line + 1]! - 1 - lineStart;
	const character = Number.isInteger(position.character)
		? Math.min(Math.max(position.character, 0), lineLength)
		: 0;
	return lineStart + character;
}

/**
 * Apply a server's TextEdits and restore the document's original shape.
 *
 * Edits are applied back-to-front by offset, so earlier offsets stay valid
 * while later ones land. A zero-width insertion at an offset already claimed
 * by another edit's start is allowed (two insertions at one point are
 * well-defined when applied in reverse array order); any TRUE overlap — an
 * edit whose range reaches into text another edit replaces — is refused.
 *
 * @param text - the LF-normalized, BOM-less document text.
 * @param edits - the server's edits, any order.
 * @param shape - the BOM and line ending to restore afterwards.
 * @returns the formatted text in the file's original shape.
 * @throws FormatEditError on a document-out-of-bounds position or an overlap.
 */
export function applyTextEdits(
	text: string,
	edits: readonly LspTextEdit[],
	shape: TextShape,
): string {
	// Line starts for offset math. `split("\n")` + prefix sums: line i starts
	// after the i-th newline; one extra entry marks the end of the last line.
	const lineStarts: number[] = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
		lineStarts.push(at + 1);
	}
	lineStarts.push(text.length + 1);

	const resolved: ResolvedEdit[] = edits.map((edit) => ({
		start: resolveOffset(lineStarts, text.length, edit.range.start, "edit start"),
		end: resolveOffset(lineStarts, text.length, edit.range.end, "edit end"),
		newText: edit.newText,
	}));
	for (const edit of resolved) {
		if (edit.end < edit.start) {
			throw new FormatEditError(`edit end precedes its start (offsets ${edit.start}..${edit.end}).`);
		}
	}
	resolved.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < resolved.length; i++) {
		const prev = resolved[i - 1]!;
		const cur = resolved[i]!;
		if (cur.start < prev.end && !(prev.start === prev.end && cur.start === prev.start)) {
			throw new FormatEditError(
				`edits overlap (offsets ${prev.start}..${prev.end} and ${cur.start}..${cur.end}).`,
			);
		}
	}

	let result = text;
	for (let i = resolved.length - 1; i >= 0; i--) {
		const edit = resolved[i]!;
		result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
	}
	return shape.bom + restoreEndings(result, shape.eol);
}
