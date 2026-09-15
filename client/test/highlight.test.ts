/**
 * Tests for the cards' own tokenizer.
 *
 * The property that matters most is stated first and swept hardest: whatever
 * the scanner decides, the concatenation of its tokens IS the input line. A
 * highlighter that rewrites one character of source is worse than no
 * highlighter, and no amount of pretty colours buys that back.
 */
import { describe, expect, it } from "vitest";
import { grammarFor, grammarForPath, tokenizeLine, tokenizeLines } from "../src/client/highlight.js";
import type { Token } from "../src/client/highlight.js";

/** Flatten tokens back to text — the invariant every case asserts. */
const flat = (tokens: readonly Token[]): string => tokens.map((token) => token.text).join("");

/** The kinds a line produced, in order. */
const kinds = (line: string, grammar = "typescript", state = {}): readonly string[] =>
	tokenizeLine(line, grammar, state).tokens.map((token) => token.kind);

/** The text of the first token of a kind, or undefined. */
const textOf = (line: string, kind: string, grammar = "typescript"): string | undefined =>
	tokenizeLine(line, grammar, {}).tokens.find((token) => token.kind === kind)?.text;

describe("the scanner never rewrites source", () => {
	const samples = [
		"const a = 1;",
		"  // a comment with `backticks` and $dollars",
		'const s = "text with // slashes";',
		"/* block */ const b = 2; /* tail",
		"a /* inline */ b",
		"if (x) { return /regex-like/i; }",
		"#include <stdio.h>",
		"SELECT * FROM t WHERE a = 'x'",
		"key: 'value' # yaml",
		"<div class=\"x\">text</div>",
		"",
		"   ",
		"\"\"\"doc",
		"@decorator",
		"0x1F + 0b1010 + 1_000.5e3",
	];
	for (const grammar of ["typescript", "python", "shell", "json", "yaml", "markup", "sql", "toml", undefined]) {
		it(`reproduces every sample in ${grammar ?? "plain"} mode`, () => {
			for (const line of samples) {
				for (const state of [{}, { block: "*/" }, { triple: '"""' }]) {
					const { tokens } = tokenizeLine(line, grammar, state);
					expect(flat(tokens)).toBe(line);
				}
			}
		});
	}

	it("reproduces a whole window, state and all", () => {
		const lines = ["/**", " * doc", " */", "const a = 1;", 'const s = """start', "still string", '"""'];
		const window = tokenizeLines(lines, "typescript");
		expect(window).toHaveLength(lines.length);
		window.forEach((tokens, index) => expect(flat(tokens)).toBe(lines[index]));
	});
});

describe("the scanner classifies what it should", () => {
	it("takes a line comment to the end of the line", () => {
		const { tokens } = tokenizeLine("const a = 1; // why", "typescript", {});
		expect(tokens[tokens.length - 1]).toEqual({ kind: "comment", text: "// why" });
		expect(kinds("const a = 1; // why")).toEqual(["keyword", "plain", "punctuation", "plain", "number", "punctuation", "plain", "comment"]);
	});

	it("does not mistake a `//` inside a string for a comment", () => {
		const { tokens } = tokenizeLine('const u = "https://x.dev"; // real', "typescript", {});
		expect(tokens.filter((token) => token.kind === "comment")).toEqual([{ kind: "comment", text: "// real" }]);
		expect(tokens.some((token) => token.kind === "string" && token.text === '"https://x.dev"')).toBe(true);
	});

	it("carries an unclosed block comment into the next line", () => {
		const first = tokenizeLine("a /* open", "typescript", {});
		expect(first.state).toEqual({ block: "*/" });
		const second = tokenizeLine("still comment */ b", "typescript", first.state);
		expect(second.tokens[0]).toEqual({ kind: "comment", text: "still comment */" });
		expect(second.state).toEqual({});
	});

	it("keeps a block comment open across many lines", () => {
		const window = tokenizeLines(["/*", " * a", " * b", " */ const x = 1;"], "typescript");
		expect(window.map((tokens) => tokens.every((token) => token.kind === "comment"))).toEqual([true, true, true, false]);
	});

	it("carries a Python triple quote, and does not close it early", () => {
		const first = tokenizeLine('s = """start', "python", {});
		expect(first.state).toEqual({ triple: '"""' });
		const second = tokenizeLine("middle", "python", first.state);
		expect(second.tokens).toEqual([{ kind: "string", text: "middle" }]);
		const third = tokenizeLine('end""" + x', "python", second.state);
		expect(third.tokens[0]).toEqual({ kind: "string", text: 'end"""' });
		expect(third.state).toEqual({});
	});

	it("classifies keywords, literals, types and calls", () => {
		expect(kinds("return true;")).toEqual(["keyword", "plain", "literal", "punctuation"]);
		expect(kinds("const s: string = 'x'")).toEqual([
			"keyword",
			"plain",
			"punctuation",
			"plain",
			"type",
			"plain",
			"punctuation",
			"plain",
			"string",
		]);
		expect(kinds("parse(value)")).toEqual(["function", "punctuation", "plain", "punctuation"]);
		expect(kinds("new Widget()")).toEqual(["keyword", "plain", "function", "punctuation"]);
	});

	it("classifies numbers, including the prefixed and underscored forms", () => {
		expect(textOf("const n = 1_000;", "number")).toBe("1_000");
		expect(textOf("const n = 0x1F;", "number")).toBe("0x1F");
		expect(textOf("const n = 1.5e3;", "number")).toBe("1.5e3");
	});

	it("marks operators and brackets as punctuation", () => {
		expect(kinds("a === b")).toEqual(["plain", "punctuation", "plain"]);
		expect(kinds("f(x, y)")).toEqual(["function", "punctuation", "plain", "punctuation", "plain", "punctuation"]);
	});

	it("reads SQL case-insensitively for keywords only", () => {
		expect(kinds("SELECT a FROM t", "sql")).toEqual(["keyword", "plain", "keyword", "plain"]);
		expect(textOf("WHERE a = 'x'", "string", "sql")).toBe("'x'");
	});
});

describe("grammarFor / grammarForPath", () => {
	it("maps the language hints the read tool emits", () => {
		expect(grammarFor("typescript")).toBe("typescript");
		expect(grammarFor("shellscript")).toBe("shell");
		expect(grammarFor("Python")).toBe("python");
		expect(grammarFor("jsonc")).toBe("json");
	});

	it("falls back to plain for what it does not know", () => {
		expect(grammarFor(undefined)).toBeUndefined();
		expect(grammarFor("")).toBeUndefined();
		expect(grammarFor("brainfuck")).toBeUndefined();
		expect(grammarForPath("Makefile")).toBeUndefined();
		expect(grammarForPath("a.")).toBeUndefined();
	});

	it("reads the extension out of a path, including nested and dotted names", () => {
		expect(grammarForPath("/w/src/a.ts")).toBe("typescript");
		expect(grammarForPath("a.d.ts")).toBe("typescript");
		expect(grammarForPath("x/y/z.test.py")).toBe("python");
	});

	it("emits one plain run when there is no grammar", () => {
		expect(tokenizeLine("const a = 1;", undefined, {}).tokens).toEqual([{ kind: "plain", text: "const a = 1;" }]);
		expect(tokenizeLine("", undefined, {}).tokens).toEqual([]);
	});

	it("emits nothing for an empty line, in every mode", () => {
		for (const grammar of ["typescript", "python", undefined]) {
			expect(tokenizeLine("", grammar, {}).tokens).toEqual([]);
		}
	});
});
