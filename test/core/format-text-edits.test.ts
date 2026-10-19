/**
 * TextEdit application — the guards the research measured as load-bearing.
 *
 * R1's failure modes, each pinned here: an unclamped `character` silently
 * swallowed line tails, an out-of-document `line` silently corrupted the
 * file, overlapping edits ate characters, and a BOM/CRLF file came back
 * reshaped. Every one of those must THROW or restore, never corrupt.
 */
import { describe, expect, it } from "vitest";
import { applyTextEdits, type LspTextEdit } from "../../src/lsp/format/text-edits.js";
import { FormatEditError } from "../../src/lsp/format/errors.js";

const LF = { bom: "", eol: "\n" as const };
const edit = (
	startLine: number,
	startChar: number,
	endLine: number,
	endChar: number,
	newText: string,
): LspTextEdit => ({
	range: {
		start: { line: startLine, character: startChar },
		end: { line: endLine, character: endChar },
	},
	newText,
});

describe("applyTextEdits", () => {
	it("applies a single replacement", () => {
		expect(
			applyTextEdits("alpha\nbeta\ngamma\n", [edit(1, 0, 1, 4, "BETA")], LF),
		).toBe("alpha\nBETA\ngamma\n");
	});

	it("applies several edits regardless of arrival order", () => {
		expect(
			applyTextEdits("a\nb\nc\n", [edit(2, 0, 2, 1, "C"), edit(0, 0, 0, 1, "A")], LF),
		).toBe("A\nb\nC\n");
	});

	it("inserts with a zero-width range", () => {
		expect(applyTextEdits("ab\n", [edit(0, 1, 0, 1, "X")], LF)).toBe("aXb\n");
	});

	it("clamps a character past end-of-line (LSP: end-of-line means it)", () => {
		expect(applyTextEdits("ab\n", [edit(0, 0, 0, 99, "z")], LF)).toBe("z\n");
	});

	it("replaces the whole document with one edit", () => {
		expect(
			applyTextEdits("one\ntwo\n", [edit(0, 0, 1, 3, "everything")], LF),
		).toBe("everything\n");
	});

	it("deletes with an empty newText", () => {
		expect(applyTextEdits("keep\ndrop\nkeep\n", [edit(1, 0, 2, 0, "")], LF)).toBe(
			"keep\nkeep\n",
		);
	});

	it("refuses a line past the end of the document", () => {
		expect(() => applyTextEdits("only\n", [edit(5, 0, 5, 0, "x")], LF)).toThrow(
			FormatEditError,
		);
	});

	it("refuses a negative line", () => {
		expect(() => applyTextEdits("only\n", [edit(-1, 0, 0, 0, "x")], LF)).toThrow(
			FormatEditError,
		);
	});

	it("refuses overlapping edits instead of swallowing characters", () => {
		expect(() =>
			applyTextEdits("abcdef\n", [edit(0, 0, 0, 3, "X"), edit(0, 2, 0, 5, "Y")], LF),
		).toThrow(FormatEditError);
	});

	it("allows an insertion at the same point another edit starts a replacement", () => {
		// Insertion (zero-width) at 0 + replacement [0,3): the insertion is
		// applied after (back-to-front), so both survive at the same offset.
		expect(
			applyTextEdits("abcdef\n", [edit(0, 0, 0, 3, "X"), edit(0, 0, 0, 0, ">")], LF),
		).toBe(">Xdef\n");
	});

	it("restores the BOM the server deleted", () => {
		expect(applyTextEdits("text\n", [edit(0, 0, 0, 4, "TEXT")], { bom: "\uFEFF", eol: "\n" })).toBe(
			"\uFEFFTEXT\n",
		);
	});

	it("restores CRLF endings the server rewrote", () => {
		expect(
			applyTextEdits("a\nb\n", [edit(0, 0, 0, 1, "A")], { bom: "", eol: "\r\n" }),
		).toBe("A\r\nb\r\n");
	});

	it("handles a UTF-16 position in an astral-character line", () => {
		// "𝕏" is 2 UTF-16 units: character 2 is AFTER the glyph, not inside it.
		expect(applyTextEdits("𝕏y\n", [edit(0, 2, 0, 3, "Y")], LF)).toBe("𝕏Y\n");
	});

	it("handles the empty document", () => {
		expect(applyTextEdits("", [edit(0, 0, 0, 0, "first")], LF)).toBe("first");
	});
});
