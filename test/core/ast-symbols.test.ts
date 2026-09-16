/**
 * Symbol enumeration, exercised through **real grammars** — the whole point of
 * this layer is that it agrees with what tree-sitter actually produces, so a
 * mocked tree would test nothing. The fixtures below encode the shapes the
 * design was decided against (branch `research/ast-symbol-kinds`):
 * `method_definition` under both `class_body` and `object`, Python's
 * class-vs-module `function_definition`, arrow functions with the double
 * `variable_declarator` shell, and TypeScript overload signatures.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { grammarWasmPath, languageForPath, type LanguageId } from "../../src/ast/language.js";
import {
	enumerateSymbols,
	resolveSymbol,
	type SymbolRecord,
} from "../../src/ast/symbols.js";
import { kindsForLanguage, queryNodeTypes } from "../../src/ast/language.js";

const languages = new Map<string, Language>();

beforeAll(async () => {
	const coreUrl = new URL(import.meta.resolve("web-tree-sitter")).href;
	await Parser.init({
		locateFile: (file: string) => fileURLToPath(new URL(`./${file}`, coreUrl)),
	});
	// `c` is here because it is the language that MOTIVATED descriptor-driven
	// name extraction: its declarations hide the name in a declarator chain.
	for (const id of ["typescript", "javascript", "python", "c"] as const) {
		languages.set(id, await Language.load(readFileSync(grammarWasmPath(id))));
	}
});

function parse(languageId: LanguageId, source: string) {
	const language = languages.get(languageId);
	if (language === undefined) throw new Error(`test setup: ${languageId} not loaded`);
	const parser = new Parser();
	parser.setLanguage(language);
	const tree = parser.parse(source);
	if (tree === null) throw new Error("parse returned null");
	return tree;
}

function symbols(languageId: LanguageId, source: string): SymbolRecord[] {
	const tree = parse(languageId, source);
	return enumerateSymbols(tree.rootNode, languageId);
}

function byName(records: readonly SymbolRecord[], name: string): SymbolRecord[] {
	return records.filter((record) => record.qualifiedName === name);
}

/**
 * Enumerated lazily inside each `describe`'s own `beforeAll`: the outer
 * parser init cannot have run while the collection phase is still walking
 * `describe` bodies, so a top-level `symbols(...)` would race the grammars.
 */
function recordsOf(languageId: LanguageId, source: string) {
	let cached: SymbolRecord[] | undefined;
	beforeAll(() => {
		cached = symbols(languageId, source);
	});
	return () => cached ?? [];
}

const TS_SOURCE = [
	"import { readFile } from 'node:fs';",
	"",
	"export const arrow = (x: number) => x * 2;",
	"",
	"@decorator",
	"export class Box {",
	"\tprivate secret = 1;",
	"\tstatic create(): Box { return new Box(); }",
	"\tmethod(a: number): string {",
	"\t\treturn String(a);",
	"\t}",
	"\toverloaded(a: number): number;",
	"\toverloaded(a: string): string;",
	"\toverloaded(a: unknown): unknown {",
	"\t\treturn a;",
	"\t}",
	"}",
	"",
	"interface Shape {",
	"\tarea(): number;",
	"}",
	"",
	"type Alias = string | number;",
	"",
	"enum Colour { Red, Green }",
	"",
	"namespace Inner {",
	"\texport const nested = 1;",
	"}",
	"",
	"export function topLevel(a: number): number { return a; }",
	"",
	"const objectLiteral = {",
	"\tmethodInObject(): number { return 1; },",
	"\tprop: 2,",
	"};",
].join("\n");

const PY_SOURCE = [
	"import os",
	"from typing import List",
	"",
	"MODULE_CONST = 1",
	"",
	"",
	"def top_level(a):",
	"\treturn a",
	"",
	"",
	"@cache",
	"def decorated(a):",
	"\tdef inner(b):",
	"\t\treturn b",
	"\treturn inner(a)",
	"",
	"",
	"class Widget:",
	"\tclass_attr = 2",
	"",
	"\tdef method(self):",
	"\t\treturn 1",
	"",
	"\tclass Inner:",
	"\t\tdef nested_method(self):",
	"\t\t\treturn 2",
].join("\n");

describe("language registry", () => {
	it("maps the built-in extensions to grammars", () => {
		expect(languageForPath("a.ts")?.id).toBe("typescript");
		expect(languageForPath("a.mts")?.id).toBe("typescript");
		expect(languageForPath("a.tsx")?.id).toBe("tsx");
		expect(languageForPath("a.js")?.id).toBe("javascript");
		expect(languageForPath("a.mjs")?.id).toBe("javascript");
		expect(languageForPath("a.py")?.id).toBe("python");
		expect(languageForPath("a.pyi")?.id).toBe("python");
	});

	it("returns undefined for an unclaimed extension instead of guessing", () => {
		// Deliberately an extension NO grammar claims, rather than a real
		// language that happens not to be supported yet: this test used `.rb`, and
		// broke the day ruby was added. A test about "unclaimed" must not depend on
		// which languages exist.
		expect(languageForPath("a.zzz")).toBeUndefined();
		expect(languageForPath("Makefile")).toBeUndefined();
	});

	it("resolves every built-in grammar asset from a package that ships it", () => {
		for (const id of ["typescript", "tsx", "javascript", "python"] as const) {
			expect(grammarWasmPath(id)).toMatch(new RegExp(`tree-sitter.*\\.wasm$`));
			expect(() => readFileSync(grammarWasmPath(id))).not.toThrow();
		}
	});
});

describe("kind tables", () => {
	it("offers kinds that actually exist in each language", () => {
		expect(kindsForLanguage("typescript")).toContain("interface");
		expect(kindsForLanguage("typescript")).toContain("enum");
		// Python has no interface/type/enum node at all — the filter must not
		// promise kinds the language cannot produce.
		expect(kindsForLanguage("python")).not.toContain("interface");
		expect(kindsForLanguage("python")).not.toContain("enum");
	});

	it("asks for a non-empty node-type list per language", () => {
		for (const id of ["typescript", "tsx", "javascript", "python"]) {
			// The claim is NON-EMPTY, which is what the name says. The old `> 3`
			// was a threshold with nothing behind it, and it broke the moment the
			// `import` kind left — Python has three declaration forms and needs no
			// more; `import_statement` was never one of them.
			expect(queryNodeTypes(id).length).toBeGreaterThan(0);
		}
	});
});

describe("typescript enumeration", () => {
	const getRecords = recordsOf("typescript", TS_SOURCE);
	const records = () => getRecords();

	it("finds declarations with normalized kinds", () => {
		expect(byName(records(), "Box")[0]?.kind).toBe("class");
		expect(byName(records(), "Shape")[0]?.kind).toBe("interface");
		expect(byName(records(), "Alias")[0]?.kind).toBe("type");
		expect(byName(records(), "Colour")[0]?.kind).toBe("enum");
		expect(byName(records(), "Inner")[0]?.kind).toBe("namespace");
		expect(byName(records(), "topLevel")[0]?.kind).toBe("function");
		expect(byName(records(), "arrow")[0]?.kind).toBe("variable");
	});

	it("distinguishes a class method from an object-literal method by parent type", () => {
		expect(byName(records(), "Box.method")[0]?.kind).toBe("method");
		expect(byName(records(), "Box.secret")[0]?.kind).toBe("property");
		expect(byName(records(), "objectLiteral.methodInObject")[0]?.kind).toBe("property");
	});

	it("merges overload signatures with their implementation into one symbol", () => {
		const overloads = byName(records(), "Box.overloaded");
		expect(overloads).toHaveLength(1);
		const span = overloads[0]!;
		expect(span.nodeType).toBe("method_definition");
		// The merged block starts at the FIRST signature and ends at the
		// implementation's closing brace.
		const sourceLines = TS_SOURCE.split("\n");
		expect(sourceLines[span.startLine - 1]).toContain("overloaded(a: number): number;");
		expect(sourceLines[span.endLine - 1]).toContain("}");
		const firstSignatureLine = TS_SOURCE.split("\n").findIndex((l) => l.includes("overloaded(a: number): number;")) + 1;
		expect(span.startLine).toBe(firstSignatureLine);
	});

	it("excludes anonymous nodes that share a name with a keyword", () => {
		// `descendantsOfType` returns anonymous nodes for keyword-ish type
		// names; none may survive into the symbol list.
		expect(records().every((record) => record.nodeType.length > 0)).toBe(true);
		expect(records().some((record) => record.qualifiedName.length === 0)).toBe(false);
	});

	it("records the enclosing export wrapper's line, not the class body's", () => {
		const box = byName(records(), "Box")[0]!;
		const line = TS_SOURCE.split("\n")[box.startLine - 1] ?? "";
		// The decorator sits above `export class Box`; the node itself starts
		// at `export` (column 7 is where `class` starts).
		expect(line).toContain("export class Box");
	});
});

describe("python enumeration", () => {
	const getRecords = recordsOf("python", PY_SOURCE);
	const records = () => getRecords();

	it("splits module-level functions from class methods via the ancestor chain", () => {
		expect(byName(records(), "top_level")[0]?.kind).toBe("function");
		expect(byName(records(), "Widget.method")[0]?.kind).toBe("method");
		expect(byName(records(), "Widget.Inner.nested_method")[0]?.kind).toBe("method");
	});

	it("builds qualified names from name-bearing ancestors only", () => {
		expect(byName(records(), "Widget.Inner.nested_method")).toHaveLength(1);
		expect(byName(records(), "Widget.Inner")[0]?.kind).toBe("class");
	});

	it("keeps nested functions reachable and names a decorated definition once", () => {
		expect(byName(records(), "decorated")[0]?.kind).toBe("function");
		expect(byName(records(), "decorated.inner")[0]?.kind).toBe("function");
	});

	it("does not merge two same-chain definitions", () => {
		const twice = symbols("python", "def dup():\n\treturn 1\n\n\ndef dup():\n\treturn 2\n");
		expect(byName(twice, "dup")).toHaveLength(2);
		expect(resolveSymbol(twice, "dup").kind).toBe("ambiguous");
	});
});

describe("resolution", () => {
	const getRecords = recordsOf("typescript", TS_SOURCE);
	const records = () => getRecords();

	it("finds a unique bare name", () => {
		const result = resolveSymbol(records(), "topLevel");
		expect(result.kind).toBe("found");
		if (result.kind === "found") expect(result.symbol.qualifiedName).toBe("topLevel");
	});

	it("matches a bare name on the last segment when it is unique", () => {
		expect(resolveSymbol(records(), "Box.method").kind).toBe("found");
		// Last-segment matching (spec §5.6): `method` is unique among all
		// symbols, so it resolves to the nested one. Not a suffix match — a
		// partial segment like `eth` never matches.
		const bare = resolveSymbol(records(), "method");
		expect(bare.kind).toBe("found");
		if (bare.kind === "found") expect(bare.symbol.qualifiedName).toBe("Box.method");
		expect(resolveSymbol(records(), "eth").kind).toBe("missing");
	});

	it("reports candidates when one bare name spans several chains", () => {
		const nested = symbols(
			"typescript",
			"class A {\n\tm(): number { return 1; }\n}\n\nclass B {\n\tm(): number { return 2; }\n}\n",
		);
		const result = resolveSymbol(nested, "m");
		expect(result.kind).toBe("ambiguous");
		if (result.kind === "ambiguous") {
			expect(result.candidates.map((c) => c.qualifiedName).sort()).toEqual(["A.m", "B.m"]);
		}
	});

	it("reports candidates instead of guessing on an ambiguous name", () => {
		const twice = symbols("python", "class A:\n\tdef m(self):\n\t\treturn 1\n\n\nclass B:\n\tdef m(self):\n\t\treturn 2\n");
		const result = resolveSymbol(twice, "m");
		expect(result.kind).toBe("ambiguous");
		if (result.kind === "ambiguous") {
			expect(result.candidates.map((c) => c.qualifiedName).sort()).toEqual(["A.m", "B.m"]);
		}
	});

	it("ANDs the kind filter with the name", () => {
		expect(resolveSymbol(records(), "Box", "class").kind).toBe("found");
		expect(resolveSymbol(records(), "Box", "function").kind).toBe("missing");
	});
});

describe("descriptor-driven name extraction", () => {
	// `nameFields` exists because a grammar can hide the name inside a
	// DECLARATOR chain: C's `function_definition` -> `function_declarator` ->
	// `identifier` touches none of the default fields. Measured before the field
	// existed, a C corpus enumerated essentially nothing.
	it("reads a name through a declarator chain when the descriptor says so", () => {
		const records = symbols("c", "int add(int a, int b) { return a + b; }\nint counter = 0;\n");
		expect(records.map((record) => record.name).sort()).toEqual(["add", "counter"]);
	});

	it("does not report one declaration twice when a typedef wraps a specifier", () => {
		// `typedef struct Point {...} Point;` presents BOTH a `struct_specifier`
		// and a `type_definition`, and both name Point. The specifier's rule is
		// narrowed with `ancestorAbsent` — without it the corpus yielded Point
		// twice, which is a bug I hit and this pins.
		const points = symbols("c", "typedef struct Point { int x; } Point;\n").filter((record) => record.name === "Point");
		expect(points).toHaveLength(1);
	});

	it("still reads the default fields for a language that declares none", () => {
		// JavaScript sets no `nameFields`, so this is the untouched path — the
		// new capability must not have moved the old one.
		const records = symbols("javascript", "function alpha() {}\nconst beta = 2;\n");
		expect(records.map((record) => record.name)).toContain("alpha");
	});
});

	it("keeps the default name fields available to a language that adds its own", () => {
		// C declares `declarator` for its functions, but `preproc_def` uses a
		// `name` field. Treating nameFields as a REPLACEMENT made every node type
		// using the defaults unnameable — in C++ that silently deleted whole
		// classes from the symbol list, which is how this was found.
		const records = symbols("c", "#define MAX 10\nint add(int a) { return a; }\n");
		expect(records.map((record) => record.name).sort()).toEqual(["MAX", "add"]);
	});

	it("collapses adjacent duplicate name segments but not separated ones", () => {
		// `typedef struct Point { int x; } Point;` nests two nodes both named
		// Point — the struct specifier and the typedef. The member must read
		// `Point.x`; before collapsing it read `Point.Point.x`.
		const member = symbols("c", "typedef struct Point { int x; } Point;\n").filter((r) => r.name === "x");
		expect(member).toHaveLength(1);
		expect(member[0]?.qualifiedName).toBe("Point.x");
	});

	it("does not turn a nameless node into a symbol named after its container", () => {
		// Found through Haskell: `area :: a -> Double` inside `class Shape` is a
		// `function` node with no name of its own, and it came out as a SECOND
		// symbol called Shape. A qualified name can be assembled from ancestors,
		// so checking only that it is non-empty let a fragment masquerade as its
		// own container — the name has to be the node's own.
		const named = symbols("c", "int counter = 0;\n");
		const types = symbols("c", "struct Point { int x; };\n").filter((r) => r.name === "Point");
		// `struct Point {...};` has no typedef, and the specifier is the only
		// named node — exactly one symbol, not one per fragment inside it.
		expect(types).toHaveLength(1);
		expect(named.map((r) => r.name)).toEqual(["counter"]);
	});
