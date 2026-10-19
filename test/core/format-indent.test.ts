/**
 * The indent heuristic — the file as its own witness.
 *
 * G1's table: tab majority → tabs; space majority → the dominant width among
 * 2/4/8; anything ambiguous → the JSON-ish default. The earlier fixed
 * `{ tabSize: 4, insertSpaces: true }` re-indented tab files wholesale; the
 * heuristic exists so that cannot happen again.
 */
import { describe, expect, it } from "vitest";
import { inferIndentOptions } from "../../src/lsp/format/indent.js";

describe("inferIndentOptions", () => {
	it("reads a tab-indented file as tabs", () => {
		expect(inferIndentOptions("function f() {\n\treturn 1;\n}\n")).toEqual({
			insertSpaces: false,
			tabSize: 4,
		});
	});

	it("reads a 2-space file", () => {
		expect(inferIndentOptions("const a = {\n  b: 1,\n};\n")).toEqual({
			insertSpaces: true,
			tabSize: 2,
		});
	});

	it("reads a 4-space file", () => {
		expect(inferIndentOptions("def f():\n    return 1\n")).toEqual({
			insertSpaces: true,
			tabSize: 4,
		});
	});

	it("reads an 8-space file", () => {
		expect(
			inferIndentOptions("if cond:\n        deeply_indented()\n        also()\n"),
		).toEqual({ insertSpaces: true, tabSize: 8 });
	});

	it("snaps an off-grid dominant width to the nearest candidate", () => {
		// A 3-space file: nearest candidates are 2 and 4, tie → 4.
		expect(
			inferIndentOptions("const a = {\n   b: 1,\n   c: 2,\n};\n"),
		).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("snaps a lone 1-space indent to the nearest candidate", () => {
		expect(inferIndentOptions("one\n two\n")).toEqual({
			insertSpaces: true,
			tabSize: 2,
		});
	});

	it("falls back to 4 spaces when the file has no indented lines", () => {
		expect(inferIndentOptions("flat\nfile\n")).toEqual({
			insertSpaces: true,
			tabSize: 4,
		});
		expect(inferIndentOptions("")).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("counts only lines that ARE indented as evidence", () => {
		// One 2-space indented line among flat ones: still 2.
		expect(inferIndentOptions("a\n  b\nc\nd\ne\n")).toEqual({
			insertSpaces: true,
			tabSize: 2,
		});
	});
});
