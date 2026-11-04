/**
 * The apply-patch grammar parser (Grammar A′).
 *
 * The four section headers, the hunk forms, the `+` content rules, and every
 * syntax refusal — each one asserted with the input line it points at.
 *
 * @module
 */
import { describe, expect, it } from "vitest";

import { parsePatch } from "../../src/domain/patch/parse.js";
import { PatchParseError } from "../../src/domain/patch/types.js";

/**
 * The refusal a patch body produces.
 *
 * The parser throws exactly once per body, so the error is caught here and
 * handed back for the line number to be asserted.
 */
function refuse(body: string): PatchParseError {
	try {
		parsePatch(body);
	} catch (error) {
		expect(error).toBeInstanceOf(PatchParseError);
		return error as PatchParseError;
	}
	throw new Error("expected the patch body to be refused");
}

describe("parsePatch — section headers", () => {
	it("reads a `file` section with a single-anchor replace", () => {
		const sections = parsePatch(
			["file src/greet.ts", "replace Ab", "+  return `hi ${name}`"].join("\n"),
		);

		expect(sections).toStrictEqual([
			{
				kind: "file",
				lineNumber: 1,
				path: "src/greet.ts",
				hunks: [
					{
						lineNumber: 2,
						kind: "replace",
						anchorStart: "Ab",
						lines: ["  return `hi ${name}`"],
					},
				],
			},
		]);
	});

	it("reads a `new` section as the whole file text", () => {
		const sections = parsePatch(
			[
				"new src/hello.ts",
				"+export function hello(name: string) {",
				"+  return `hi ${name}`",
				"+}",
			].join("\n"),
		);

		expect(sections).toStrictEqual([
			{
				kind: "new",
				lineNumber: 1,
				path: "src/hello.ts",
				hunks: [],
				content: "export function hello(name: string) {\n  return `hi ${name}`\n}\n",
			},
		]);
	});

	it("reads a `move` section as a source and a destination", () => {
		const sections = parsePatch(["move src/old.ts -> src/new.ts"].join("\n"));

		expect(sections).toStrictEqual([
			{
				kind: "move",
				lineNumber: 1,
				path: "src/old.ts",
				destination: "src/new.ts",
				hunks: [],
			},
		]);
	});

	it("reads a `remove` section with neither hunks nor content", () => {
		const sections = parsePatch(["remove src/dead.ts"].join("\n"));

		expect(sections).toStrictEqual([
			{
				kind: "remove",
				lineNumber: 1,
				path: "src/dead.ts",
				hunks: [],
			},
		]);
	});

	it("reads the spec's worked example as four sections", () => {
		const sections = parsePatch(
			[
				"file src/greet.ts",
				"replace Ab",
				"+  return `hi ${name}`",
				"replace Ef..Gh",
				"+  if (!name) return \"hi\"",
				"insert Cd",
				"+",
				"+// trailing note",
				"delete Ij",
				"",
				"new src/hello.ts",
				"+export function hello(name: string) {",
				"+  return `hi ${name}`",
				"+}",
				"",
				"move src/old.ts -> src/new.ts",
				"",
				"remove src/dead.ts",
			].join("\n"),
		);

		expect(sections.map((section) => section.kind)).toStrictEqual([
			"file",
			"new",
			"move",
			"remove",
		]);
		expect(sections[0]?.hunks).toHaveLength(4);
		expect(sections[1]?.content).toBe(
			"export function hello(name: string) {\n  return `hi ${name}`\n}\n",
		);
	});
});

describe("parsePatch — hunks", () => {
	it("reads a range replace as a start and an end anchor", () => {
		const sections = parsePatch(
			["file src/greet.ts", "replace Ef..Gh", "+  if (!name) return \"hi\""].join("\n"),
		);

		expect(sections[0]?.hunks[0]).toStrictEqual({
			lineNumber: 2,
			kind: "replace",
			anchorStart: "Ef",
			anchorEnd: "Gh",
			lines: ["  if (!name) return \"hi\""],
		});
	});

	it("reads an insert as a single anchor after that line", () => {
		const sections = parsePatch(
			["file src/greet.ts", "insert Cd", "+", "+// trailing note"].join("\n"),
		);

		expect(sections[0]?.hunks[0]).toStrictEqual({
			lineNumber: 2,
			kind: "insert",
			anchorStart: "Cd",
			lines: ["", "// trailing note"],
		});
	});

	it("reads a delete of one line and of a range", () => {
		const sections = parsePatch(
			["file src/greet.ts", "delete Ij", "delete Ef..Gh"].join("\n"),
		);

		expect(sections[0]?.hunks).toStrictEqual([
			{ lineNumber: 2, kind: "delete", anchorStart: "Ij", lines: [] },
			{ lineNumber: 3, kind: "delete", anchorStart: "Ef", anchorEnd: "Gh", lines: [] },
		]);
	});

	it("drops the line number of a weak `line:anchor` anchor", () => {
		const sections = parsePatch(["file src/greet.ts", "replace 12:Ab", "+x"].join("\n"));

		expect(sections[0]?.hunks[0]?.anchorStart).toBe("Ab");
	});

	it("trims the whitespace around a header and its payload", () => {
		const sections = parsePatch(["file   src/greet.ts   ", "replace   Ab  ", "+x"].join("\n"));

		expect(sections[0]?.path).toBe("src/greet.ts");
		expect(sections[0]?.hunks[0]?.anchorStart).toBe("Ab");
	});
});

describe("parsePatch — content lines", () => {
	it("keeps content that looks like a header behind the `+` prefix", () => {
		const sections = parsePatch(
			[
				"file notes.md",
				"replace Ab",
				"+file: src/other.ts",
				"+replace Cd",
				"+---",
				"+new src/x.ts",
			].join("\n"),
		);

		expect(sections[0]?.hunks[0]?.lines).toStrictEqual([
			"file: src/other.ts",
			"replace Cd",
			"---",
			"new src/x.ts",
		]);
	});

	it("reads a bare `+` as an empty line and keeps the rest verbatim", () => {
		const sections = parsePatch(
			["file src/greet.ts", "replace Ab", "+", "+   indented  "].join("\n"),
		);

		expect(sections[0]?.hunks[0]?.lines).toStrictEqual(["", "   indented  "]);
	});

	it("ignores a blank line between blocks", () => {
		const sections = parsePatch(
			["file src/greet.ts", "replace Ab", "+one", "", "replace Cd", "+two"].join("\n"),
		);

		expect(sections[0]?.hunks).toHaveLength(2);
		expect(sections[0]?.hunks[0]?.lines).toStrictEqual(["one"]);
		expect(sections[0]?.hunks[1]?.lines).toStrictEqual(["two"]);
	});
});

describe("parsePatch — an empty patch", () => {
	it("reads a blank body as no sections", () => {
		expect(parsePatch("")).toStrictEqual([]);
		expect(parsePatch("\n\n")).toStrictEqual([]);
		expect(parsePatch("   \n\t\n")).toStrictEqual([]);
	});
});

describe("parsePatch — refusals", () => {
	it("refuses a hunk header inside a `new` section", () => {
		const error = refuse(["new src/hello.ts", "+ok", "replace Ab"].join("\n"));

		expect(error.lineNumber).toBe(3);
		expect(error.message).toMatch(/^Invalid patch at line 3: /);
	});

	it("refuses a content line that arrives before any hunk header", () => {
		const error = refuse(
			["file src/greet.ts", "+stray", "replace Ab", "+ok"].join("\n"),
		);

		expect(error.lineNumber).toBe(2);
		expect(error.message).toMatch(/^Invalid patch at line 2: /);
	});

	it("refuses a content line after a `delete` hunk", () => {
		const error = refuse(
			["file src/greet.ts", "delete Ab", "+not allowed"].join("\n"),
		);

		expect(error.lineNumber).toBe(3);
		expect(error.message).toMatch(/^Invalid patch at line 3: /);
	});

	it("refuses a `replace` or an `insert` that carries no content line", () => {
		const replace = refuse(["file src/greet.ts", "replace Ab"].join("\n"));
		const insert = refuse(["file src/greet.ts", "insert Ab"].join("\n"));

		expect(replace.lineNumber).toBe(2);
		expect(insert.lineNumber).toBe(2);
	});

	it("refuses a range whose ends are not both anchors", () => {
		const start = refuse(["file src/greet.ts", "replace x..Gh", "+ok"].join("\n"));
		const end = refuse(["file src/greet.ts", "replace Ef..x", "+ok"].join("\n"));
		const single = refuse(["file src/greet.ts", "replace x", "+ok"].join("\n"));

		expect(start.lineNumber).toBe(2);
		expect(end.lineNumber).toBe(2);
		expect(single.lineNumber).toBe(2);
	});

	it("refuses an `insert` that takes a range", () => {
		const error = refuse(["file src/greet.ts", "insert Ab..Cd", "+ok"].join("\n"));

		expect(error.lineNumber).toBe(2);
		expect(error.message).toMatch(/^Invalid patch at line 2: /);
	});

	it("refuses a content line or a hunk header before any section header", () => {
		const content = refuse(["+stray"].join("\n"));
		const hunk = refuse(["replace Ab", "+ok"].join("\n"));

		expect(content.lineNumber).toBe(1);
		expect(hunk.lineNumber).toBe(1);
	});

	it("refuses an unknown header", () => {
		const error = refuse(["file src/greet.ts", "frobnicate Ab"].join("\n"));

		expect(error.lineNumber).toBe(2);
		expect(error.message).toMatch(/^Invalid patch at line 2: /);
	});
});

describe("parsePatch — the `move` header", () => {
	it("refuses a `move` without an arrow or with an empty side", () => {
		const noArrow = refuse(["move src/old.ts"].join("\n"));
		const noSource = refuse(["move  -> src/new.ts"].join("\n"));
		const noDestination = refuse(["move src/old.ts -> "].join("\n"));

		expect(noArrow.lineNumber).toBe(1);
		expect(noSource.lineNumber).toBe(1);
		expect(noDestination.lineNumber).toBe(1);
	});
});
