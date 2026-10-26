/**
 * The indent heuristic — the file as its own witness.
 *
 * The unit is read from the STEPS between consecutive lines, not from the
 * absolute widths: a deep 4-space file's most common width is 8, which is
 * exactly the #336 bug. Tab majority → tabs; a step majority that divides the
 * observed grid names the unit; without a usable step the old dominant-width
 * snap (2/4/8) is the fallback. The earlier fixed `{ tabSize: 4 }` re-indented
 * tab files wholesale; the heuristic exists so that cannot happen again.
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

	it("reads a deep 4-space file as 4, not 8 (#336)", () => {
		// The most common leading width here IS 8; the unit is still 4 because
		// the steps between consecutive lines are 4. Taking the dominant width
		// re-indented this file at 8 spaces before #336.
		const deep = [
			"export class Foo {",
			"    constructor(private readonly x: number) {}",
			"",
			"    bar(y: number): number {",
			"        const z = y + 1;",
			"        if (z > 0) {",
			"            return z * 2;",
			"        }",
			"        return z;",
			"    }",
			"",
			"    baz(): void {",
			"        for (let i = 0; i < 3; i += 1) {",
			"            if (i % 2 === 0) {",
			"                console.log(i);",
			"            }",
			"        }",
			"    }",
			"}",
			"",
		].join("\n");
		expect(inferIndentOptions(deep)).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("reads a 3-space file from its steps instead of snapping to 4", () => {
		expect(
			inferIndentOptions("const a = {\n   b: {\n      c: 2,\n   },\n};\n"),
		).toEqual({ insertSpaces: true, tabSize: 3 });
	});

	it("tolerates off-grid alignment lines without mistaking them for the unit", () => {
		// The 9-space line is a hand-aligned continuation; the steps are still 4.
		// One off-grid line in six must not outvote the unit.
		expect(
			inferIndentOptions(
				"function f() {\n    const a = {\n        b: 1,\n         c: 2,\n        d: 3,\n    };\n    return a;\n}\n",
			),
		).toEqual({ insertSpaces: true, tabSize: 4 });
	});

	it("keeps the unit when one line is wrongly indented (#336 review)", () => {
		// The PR-review matrix: a hand-edited 2-space line (and the line the old
		// inference then wrote back) must not redefine the unit as 2.
		const fourEdited = [
			"function compute(): number {",
			"    let total = 0;",
			"    for (let i = 0; i < 10; i++) {",
			"  total += i;",
			"    }",
			"    return total;",
			"}",
			"",
		].join("\n");
		expect(inferIndentOptions(fourEdited)).toEqual({ insertSpaces: true, tabSize: 4 });
		// What the previous pass wrote back: 4 (parent) + 2 (wrong unit).
		expect(inferIndentOptions(fourEdited.replace("  total += i;", "      total += i;"))).toEqual({
			insertSpaces: true,
			tabSize: 4,
		});

		const sixEdited = [
			"function compute(): number {",
			"      let total = 0;",
			"      for (let i = 0; i < 10; i++) {",
			"  total += i;",
			"      }",
			"      return total;",
			"}",
			"",
		].join("\n");
		expect(inferIndentOptions(sixEdited)).toEqual({ insertSpaces: true, tabSize: 6 });
		expect(inferIndentOptions(sixEdited.replace("  total += i;", "          total += i;"))).toEqual({
			insertSpaces: true,
			tabSize: 6,
		});

		const eightEdited = [
			"function compute(): number {",
			"        let total = 0;",
			"        for (let i = 0; i < 10; i++) {",
			"  total += i;",
			"        }",
			"        return total;",
			"}",
			"",
		].join("\n");
		expect(inferIndentOptions(eightEdited)).toEqual({ insertSpaces: true, tabSize: 8 });
	});

	it("reads a single-level 3-space file as 3 from its own grid", () => {
		// No step to read, but the repeated width itself names the grid; the
		// pre-#336 snap to 4 would fight the file's own style.
		expect(
			inferIndentOptions("const a = {\n   b: 1,\n   c: 2,\n};\n"),
		).toEqual({ insertSpaces: true, tabSize: 3 });
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
