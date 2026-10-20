/**
 * Scope detection for diff segment headers (issue #294, #301).
 *
 * The segment header of a unified diff names the symbol a hunk lives in
 * (`@@ -29,7 +29,7 @@ gamma()`). This suite pins the three properties that
 * matter: the NAME is found when it can be, it is NOT invented when it
 * cannot be, and the PATH decides which language the file is read with.
 *
 * @module dsh-hashline-edittool/test/render-scope
 */
import { describe, expect, it } from "vitest";
import {
	detectScopes,
	scopeLabelAt,
	scopeLanguageForPath,
	scopeScanCount,
	type ScopeLanguage,
} from "../../src/render/scope/index.js";
import { isUsableName } from "../../src/render/scope/patterns.js";

/** A top-level function whose signature spans three lines. */
const MULTILINE_FUNCTION = [
	"export function myersRange(",
	"  a: Int32Array,",
	"): Run[] | undefined {",
	"  if (a.length === 0) {",
	"    return undefined;",
	"  }",
	"  return [a];",
	"}",
].join("\n");

/** A class with a method in it. */
const CLASS_AND_METHOD = [
	"export class Widget {",
	"  render(): string {",
	'    return "<";',
	"  }",
	"}",
].join("\n");

/** Control flow at the top level — no named symbol anywhere. */
const TOP_LEVEL_CONTROL_FLOW = [
	"if (flag) {",
	"  doThing();",
	"} else if (other) {",
	"  doOther();",
	"} else {",
	"  doFallback();",
	"}",
	"for (const item of items) {",
	"  use(item);",
	"}",
].join("\n");

describe("detectScopes — blocks and their names", () => {
	it("names a top-level function whose signature spans several lines", () => {
		const scopes = detectScopes(MULTILINE_FUNCTION);
		const fn = scopes.find((scope) => scope.kind === "function");
		expect(fn).toBeDefined();
		expect(fn?.name).toBe("myersRange");
		// The block starts at the DECLARATION line, not at the line that
		// carries the brace — the brace line cannot name the function.
		expect(fn?.startLine).toBe(1);
		expect(fn?.endLine).toBe(8);
		expect(fn?.header).toBe("export function myersRange(");
	});

	it("reports the control-flow block inside the function as control, not function", () => {
		const scopes = detectScopes(MULTILINE_FUNCTION);
		const controls = scopes.filter((scope) => scope.kind === "control");
		expect(controls).toHaveLength(1);
		expect(controls[0]?.name).toBe("if");
		expect(controls[0]?.startLine).toBe(4);
		expect(controls[0]?.endLine).toBe(6);
	});

	it("names a method and the class that holds it", () => {
		const scopes = detectScopes(CLASS_AND_METHOD);
		const method = scopes.find((scope) => scope.kind === "method");
		expect(method?.name).toBe("render");
		expect(method?.startLine).toBe(2);
		expect(method?.endLine).toBe(4);
		const cls = scopes.find((scope) => scope.kind === "class");
		expect(cls?.name).toBe("Widget");
		expect(cls?.startLine).toBe(1);
		expect(cls?.endLine).toBe(5);
	});

	it("names a method whose signature spans several lines", () => {
		const source = [
			"class Runner {",
			"  run(",
			"    steps: number[],",
			"  ): void {",
			"    for (const s of steps) {",
			"      use(s);",
			"    }",
			"  }",
			"}",
		].join("\n");
		const method = detectScopes(source).find((scope) => scope.kind === "method");
		expect(method?.name).toBe("run");
		expect(method?.startLine).toBe(2);
		expect(method?.endLine).toBe(8);
	});

	it("names a type alias and an arrow function", () => {
		const typeSource = ["export type Alias = {", "  id: number;", "};"].join("\n");
		expect(detectScopes(typeSource).find((scope) => scope.kind === "type")?.name).toBe("Alias");
		const arrowSource = [
			"export const handler = (event: Event): void => {",
			"  doIt();",
			"};",
		].join("\n");
		expect(detectScopes(arrowSource).find((scope) => scope.kind === "function")?.name).toBe("handler");
	});

	it("leaves a block it cannot name anonymous", () => {
		const source = ["register({", '  name: "x",', "});"].join("\n");
		const scopes = detectScopes(source);
		expect(scopes).toHaveLength(1);
		expect(scopes[0]?.kind).toBe("block");
		expect(scopes[0]?.name).toBe("");
	});
});

describe("scopeLabelAt — the segment header's scope name", () => {
	it("labels a line inside a top-level function", () => {
		expect(scopeLabelAt(MULTILINE_FUNCTION, 2)).toBe("myersRange()");
		expect(scopeLabelAt(MULTILINE_FUNCTION, 5)).toBe("myersRange()");
		expect(scopeLabelAt(MULTILINE_FUNCTION, 7)).toBe("myersRange()");
	});

	it("labels a line inside a method with the method name", () => {
		expect(scopeLabelAt(CLASS_AND_METHOD, 3)).toBe("render()");
	});

	it("labels the class itself with the class name", () => {
		expect(scopeLabelAt(CLASS_AND_METHOD, 1)).toBe("Widget");
	});

	it("labels a type alias with its bare name", () => {
		const typeSource = ["export type Alias = {", "  id: number;", "};"].join("\n");
		expect(scopeLabelAt(typeSource, 2)).toBe("Alias");
	});

	it("does not name control flow", () => {
		expect(scopeLabelAt(TOP_LEVEL_CONTROL_FLOW, 2)).toBeUndefined();
		expect(scopeLabelAt(TOP_LEVEL_CONTROL_FLOW, 4)).toBeUndefined();
		expect(scopeLabelAt(TOP_LEVEL_CONTROL_FLOW, 6)).toBeUndefined();
		expect(scopeLabelAt(TOP_LEVEL_CONTROL_FLOW, 9)).toBeUndefined();
	});

	it("names the enclosing function, not the control flow inside it", () => {
		const source = ["function outer() {", "  if (flag) {", "    doThing();", "  }", "}"].join("\n");
		expect(scopeLabelAt(source, 3)).toBe("outer()");
	});

	it("names the innermost of two nested functions", () => {
		const source = [
			"function outer() {",
			"  function inner() {",
			"    return 1;",
			"  }",
			"  return inner;",
			"}",
		].join("\n");
		expect(scopeLabelAt(source, 3)).toBe("inner()");
		expect(scopeLabelAt(source, 5)).toBe("outer()");
	});

	it("does not name an object literal passed to a call", () => {
		const source = ["register({", '  name: "x",', "});"].join("\n");
		expect(scopeLabelAt(source, 2)).toBeUndefined();
	});
});

describe("scopeLabelAt — braces that are not blocks", () => {
	it("ignores braces inside strings and comments", () => {
		const source = [
			"function f() {",
			"  const tpl = `a { b`;",
			'  const s = "{";',
			"  // a comment with {",
			"  /* block { comment */",
			"  return tpl;",
			"}",
		].join("\n");
		// Only the function's own braces are blocks.
		expect(detectScopes(source)).toHaveLength(1);
		expect(scopeLabelAt(source, 6)).toBe("f()");
	});

	it("ignores braces inside a multi-line template literal", () => {
		const source = [
			"function f() {",
			"  const tpl = `line {",
			"line }`;",
			"  return tpl;",
			"}",
		].join("\n");
		expect(detectScopes(source)).toHaveLength(1);
		expect(scopeLabelAt(source, 4)).toBe("f()");
	});

	it("ignores braces inside a regular expression", () => {
		const source = ["function f() {", "  const re = /{/;", '  return re.test("x");', "}"].join("\n");
		expect(detectScopes(source)).toHaveLength(1);
		expect(scopeLabelAt(source, 3)).toBe("f()");
	});

	it("does not mistake a division for a regular expression", () => {
		const source = ["function f() {", "  const half = total / 2;", "  return half;", "}"].join("\n");
		expect(detectScopes(source)).toHaveLength(1);
		expect(scopeLabelAt(source, 3)).toBe("f()");
	});
});

describe("scopeLabelAt — a file that ends inside a block", () => {
	it("closes an unclosed block at the end of the file instead of crashing", () => {
		const truncated = ["function f() {", "  const x = 1;"].join("\n");
		const scopes = detectScopes(truncated);
		expect(scopes).toHaveLength(1);
		expect(scopes[0]?.kind).toBe("function");
		expect(scopes[0]?.name).toBe("f");
		expect(scopes[0]?.startLine).toBe(1);
		expect(scopes[0]?.endLine).toBe(2);
		expect(scopeLabelAt(truncated, 2)).toBe("f()");
	});
});

describe("scopeLabelAt — the symbol must still exist after the edit", () => {
	const BEFORE = [
		"function kept() {",
		"  return 1;",
		"}",
		"function removed() {",
		"  return 2;",
		"}",
	].join("\n");
	const AFTER = ["function kept() {", "  return 1;", "}"].join("\n");

	it("names the deleted function in the text before the edit", () => {
		expect(scopeLabelAt(BEFORE, 5)).toBe("removed()");
	});

	it("cannot name the deleted function in the text after the edit", () => {
		// The spec takes the scope name from the POST-EDIT text, so a symbol
		// the edit removed has no name to give — the diff rows carry it.
		expect(scopeLabelAt(AFTER, 5)).toBeUndefined();
		expect(detectScopes(AFTER).some((scope) => scope.name === "removed")).toBe(false);
		expect(scopeLabelAt(AFTER, 2)).toBe("kept()");
	});
});

describe("scopeLabelAt — a declaration that continues the previous block", () => {
	it("names a function whose return type is an object literal", () => {
		// The `{` of the type literal and the `{` of the function body share a
		// line — the body must still carry the function's name.
		const source = [
			"export async function setupTestHome(): Promise<{",
			"  home: string;",
			"}> {",
			"  return { home: homeDir };",
			"}",
		].join("\n");
		expect(scopeLabelAt(source, 1)).toBe("setupTestHome()");
		expect(scopeLabelAt(source, 4)).toBe("setupTestHome()");
		const body = detectScopes(source).find((scope) => scope.kind === "function");
		expect(body?.name).toBe("setupTestHome");
		expect(body?.startLine).toBe(1);
		expect(body?.endLine).toBe(5);
	});

	it("does not name a block after a reserved word", () => {
		// `return () => {` reads like a method definition; it is not one, and a
		// wrong name is worse than no name.
		const source = [
			"function make() {",
			"  return () => {",
			"    return 1;",
			"  };",
			"}",
		].join("\n");
		expect(detectScopes(source).some((scope) => scope.name === "return")).toBe(false);
		expect(scopeLabelAt(source, 3)).toBe("make()");
	});
});

describe("scopeLabelAt — a language this module does not read", () => {
	it("leaves a Go or Rust function unnamed when the file is not named", () => {
		// `func foo() {` and `fn foo() {` read like a method definition; the
		// default reading is the TypeScript one, so the honest answer is no
		// name — until the path says which language the file is written in.
		const go = ["func foo() {", "  return 1", "}"].join("\n");
		expect(detectScopes(go).every((scope) => scope.name === "")).toBe(true);
		expect(scopeLabelAt(go, 2)).toBeUndefined();
		const rust = ["fn foo() {", "  return 1;", "}"].join("\n");
		expect(detectScopes(rust).every((scope) => scope.name === "")).toBe(true);
		expect(scopeLabelAt(rust, 2)).toBeUndefined();
	});

	it("names a Go or Rust function once the path names the language", () => {
		const go = ["func foo() {", "  return 1", "}"].join("\n");
		expect(scopeLabelAt(go, 2, "main.go")).toBe("foo()");
		const rust = ["fn foo() {", "  return 1;", "}"].join("\n");
		expect(scopeLabelAt(rust, 2, "main.rs")).toBe("foo()");
	});

	it("finds no block at all in an indented language", () => {
		// Python's `def` opens no brace, so there is no block to name.
		const python = ["def foo():", "    return 1"].join("\n");
		expect(detectScopes(python)).toEqual([]);
		expect(scopeLabelAt(python, 2)).toBeUndefined();
	});
});

/** One language: the file, the line inside it, and the name the header carries. */
interface LanguageCase {
	/** The language's name — the test's name. */
	readonly id: string;
	/** The path of the file the text came from. */
	readonly path: string;
	/** The text of the file. */
	readonly source: string;
	/** The 1-indexed line inside the block. */
	readonly line: number;
	/** The name the segment header carries. */
	readonly label: string;
}

/**
 * The language of a path.
 *
 * @param path - the path of the file.
 * @returns the language the table holds for it.
 */
function languageOf(path: string): ScopeLanguage {
	const language = scopeLanguageForPath(path);
	if (language === undefined) throw new Error(`the table does not know ${path}`);
	return language;
}

/** The languages a file can be written in — one case each. */
const LANGUAGE_CASES: LanguageCase[] = [
	{
		id: "JavaScript",
		path: "app.js",
		source: ["function greet(name) {", "  return name;", "}"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "TypeScript",
		path: "app.ts",
		source: [
			"export function myersRange(",
			"  a: number,",
			"): number {",
			"  return a;",
			"}",
		].join("\n"),
		line: 4,
		label: "myersRange()",
	},
	{
		id: "Rust",
		path: "main.rs",
		source: ["fn main() {", "    let x = 1;", "}"].join("\n"),
		line: 2,
		label: "main()",
	},
	{
		id: "Zig",
		path: "main.zig",
		source: ["pub fn main() void {", "    const x = 1;", "}"].join("\n"),
		line: 2,
		label: "main()",
	},
	{
		id: "Go",
		path: "main.go",
		source: ["func foo() int {", "	return 1", "}"].join("\n"),
		line: 2,
		label: "foo()",
	},
	{
		id: "C",
		path: "main.c",
		source: ["int main(void) {", "  return 0;", "}"].join("\n"),
		line: 2,
		label: "main()",
	},
	{
		id: "Java",
		path: "Main.java",
		source: [
			"public class Main {",
			"    public static void main(String[] args) {",
			"        run();",
			"    }",
			"}",
		].join("\n"),
		line: 3,
		label: "main()",
	},
	{
		id: "C#",
		path: "Program.cs",
		source: [
			"class Program",
			"{",
			"    static void Main(string[] args)",
			"    {",
			"        Run();",
			"    }",
			"}",
		].join("\n"),
		line: 5,
		label: "Main()",
	},
	{
		id: "Swift",
		path: "main.swift",
		source: ["func greet(name: String) -> String {", "    return name", "}"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Kotlin",
		path: "Main.kt",
		source: ["fun main() {", "    println(1)", "}"].join("\n"),
		line: 2,
		label: "main()",
	},
	{
		id: "Perl",
		path: "tool.pl",
		source: ["sub greet {", "  return 1;", "}"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Python",
		path: "app.py",
		source: ["def greet(name):", "    return name"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Ruby",
		path: "app.rb",
		source: ["def greet(name)", "  name", "end"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Lua",
		path: "app.lua",
		source: ["function greet(name)", "  return name", "end"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Elixir",
		path: "app.ex",
		source: ["def greet(name) do", "  name", "end"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Julia",
		path: "app.jl",
		source: ["function greet(name)", "    return name", "end"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "Shell",
		path: "run.sh",
		source: ["greet() {", "  echo hi", "}"].join("\n"),
		line: 2,
		label: "greet()",
	},
	{
		id: "PHP",
		path: "index.php",
		source: ["function greet($name) {", "  return $name;", "}"].join("\n"),
		line: 2,
		label: "greet()",
	},
];

describe("scopeLanguageForPath — the language table", () => {
	it("picks the language by extension", () => {
		expect(scopeLanguageForPath("app.ts")?.id).toBe("typescript");
		expect(scopeLanguageForPath("app.tsx")?.id).toBe("typescript");
		expect(scopeLanguageForPath("app.jsx")?.id).toBe("javascript");
		expect(scopeLanguageForPath("app.mjs")?.id).toBe("javascript");
		expect(scopeLanguageForPath("main.go")?.id).toBe("go");
		expect(scopeLanguageForPath("main.rs")?.id).toBe("rust");
		expect(scopeLanguageForPath("Main.java")?.id).toBe("java");
		expect(scopeLanguageForPath("Program.cs")?.id).toBe("csharp");
		expect(scopeLanguageForPath("app.py")?.id).toBe("python");
		expect(scopeLanguageForPath("app.rb")?.id).toBe("ruby");
		expect(scopeLanguageForPath("app.lua")?.id).toBe("lua");
		expect(scopeLanguageForPath("app.ex")?.id).toBe("elixir");
		expect(scopeLanguageForPath("app.jl")?.id).toBe("julia");
		expect(scopeLanguageForPath("run.sh")?.id).toBe("shell");
		expect(scopeLanguageForPath("index.php")?.id).toBe("php");
		expect(scopeLanguageForPath("tool.pl")?.id).toBe("perl");
		expect(scopeLanguageForPath("App.vue")?.id).toBe("vue");
		expect(scopeLanguageForPath("App.svelte")?.id).toBe("svelte");
	});

	it("picks the language by file name when the file has no extension", () => {
		expect(scopeLanguageForPath("Rakefile")?.id).toBe("ruby");
		expect(scopeLanguageForPath("Gemfile")?.id).toBe("ruby");
	});

	it("answers nothing for a language it does not read", () => {
		expect(scopeLanguageForPath("app.erl")).toBeUndefined();
		expect(scopeLanguageForPath("app.ml")).toBeUndefined();
		expect(scopeLanguageForPath("app.hs")).toBeUndefined();
		expect(scopeLanguageForPath("app.clj")).toBeUndefined();
		expect(scopeLanguageForPath("query.sql")).toBeUndefined();
		expect(scopeLanguageForPath("stats.R")).toBeUndefined();
		expect(scopeLanguageForPath("Makefile")).toBeUndefined();
		expect(scopeLanguageForPath("Dockerfile")).toBeUndefined();
		expect(scopeLanguageForPath("CMakeLists.txt")).toBeUndefined();
	});
});

describe("scopeLabelAt — the path decides how the file is read", () => {
	it.each(LANGUAGE_CASES)("names a $id symbol", ({ path, source, line, label }) => {
		expect(scopeLabelAt(source, line, path)).toBe(label);
	});

	it.each(LANGUAGE_CASES)("reads a $id file differently without its path", ({ path, source, line }) => {
		// The default reading is the TypeScript one, so a file written in
		// another language is either nameless or named after something else.
		const withPath = scopeLabelAt(source, line, path);
		const withoutPath = scopeLabelAt(source, line);
		if (path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".php") || path.endsWith(".sh")) {
			// These four are written the way TypeScript is written: the same
			// name is the right answer either way.
			expect(withoutPath).toBe(withPath);
			return;
		}
		expect(withPath).toBeDefined();
		expect(withoutPath).not.toBe(withPath);
	});
});

describe("scopeLabelAt — a file the table does not know", () => {
	it("falls back to the TypeScript reading for an unknown extension", () => {
		const source = ["function greet(name) {", "  return name;", "}"].join("\n");
		expect(scopeLabelAt(source, 2, "notes.unknownext")).toBe("greet()");
	});

	it("names nothing in a language it does not read", () => {
		const erlang = ["greet() -> ok."].join("\n");
		expect(scopeLabelAt(erlang, 1, "app.erl")).toBeUndefined();
		const clojure = ["(defn greet [x] x)"].join("\n");
		expect(scopeLabelAt(clojure, 1, "app.clj")).toBeUndefined();
	});
});

describe("isUsableName — the reserved words of every supported language", () => {
	it("refuses every keyword that could be read as a name", () => {
		const words = [
			"if",
			"for",
			"while",
			"switch",
			"catch",
			"try",
			"finally",
			"do",
			"else",
			"case",
			"default",
			"return",
			"throw",
			"await",
			"new",
			"typeof",
			"void",
			"public",
			"private",
			"protected",
			"static",
			"final",
			"abstract",
			"sealed",
			"override",
			"extends",
			"implements",
			"match",
			"loop",
			"end",
			"then",
			"elsif",
			"when",
			"begin",
			"rescue",
			"ensure",
			"until",
			"repeat",
			"fn",
			"func",
			"def",
			"sub",
			"package",
			"struct",
			"trait",
			"impl",
			"mod",
			"union",
			"typedef",
			"namespace",
			"using",
			"template",
			"typename",
			"operator",
			"lambda",
			"proc",
			"in",
			"is",
			"as",
			"where",
			"select",
			"with",
			"defer",
			"go",
			"chan",
			"map",
			"interface",
			"local",
			"require",
			"include",
			"module",
			"pub",
			"mut",
			"crate",
			"let",
		];
		for (const word of words) {
			expect(isUsableName(word)).toBe(false);
		}
	});

	it("still allows a name a language really uses", () => {
		// A name that comes from an explicit keyword is a real name: `map`
		// is a fine name for a function, and the reserved list only stops a
		// keyword from being READ as one.
		expect(isUsableName("greet")).toBe(true);
		const source = ["function map(x) {", "  return x;", "}"].join("\n");
		expect(scopeLabelAt(source, 2)).toBe("map()");
	});
});

describe("the indent family — where a block ends", () => {
	it("ends a Python block at the next statement of the same level", () => {
		const source = ["def greet(name):", "    return name", "", "x = 1"].join("\n");
		const scope = detectScopes(source, languageOf("app.py")).find((s) => s.name === "greet");
		expect(scope?.startLine).toBe(1);
		expect(scope?.endLine).toBe(3);
	});

	it("ends a Ruby block at its own `end`", () => {
		const source = ["def greet(name)", "  name", "end", "", "x = 1"].join("\n");
		const scope = detectScopes(source, languageOf("app.rb")).find((s) => s.name === "greet");
		expect(scope?.startLine).toBe(1);
		expect(scope?.endLine).toBe(3);
	});

	it("names the innermost of two nested Python functions", () => {
		const source = [
			"def outer():",
			"    def inner():",
			"        return 1",
			"    return inner",
		].join("\n");
		expect(scopeLabelAt(source, 3, "app.py")).toBe("inner()");
		expect(scopeLabelAt(source, 4, "app.py")).toBe("outer()");
	});
});

describe("the keyword-end family — where a block ends", () => {
	it("closes a Lua function at its `end`", () => {
		const source = ["function greet(name)", "  return name", "end"].join("\n");
		const scope = detectScopes(source, languageOf("app.lua"))[0];
		expect(scope?.name).toBe("greet");
		expect(scope?.startLine).toBe(1);
		expect(scope?.endLine).toBe(3);
	});

	it("closes a Lua `repeat` at its `until`", () => {
		const source = ["repeat", "  local x = 1", "until x > 0"].join("\n");
		const scopes = detectScopes(source, languageOf("app.lua"));
		expect(scopes).toHaveLength(1);
		expect(scopes[0]?.kind).toBe("block");
		expect(scopes[0]?.startLine).toBe(1);
		expect(scopes[0]?.endLine).toBe(3);
	});

	it("does not count the `do` of a Lua loop twice", () => {
		const source = [
			"function greet()",
			"  for i = 1, 3 do",
			"    print(i)",
			"  end",
			"end",
		].join("\n");
		const scopes = detectScopes(source, languageOf("app.lua"));
		expect(scopes.map((scope) => `${scope.kind} ${scope.name} ${scope.startLine}-${scope.endLine}`)).toEqual([
			"function greet 1-5",
			"block  2-4",
		]);
	});

	it("closes an Elixir module and the function in it", () => {
		const source = ["defmodule App do", "  def greet(name) do", "    name", "  end", "end"].join("\n");
		const scopes = detectScopes(source, languageOf("app.ex"));
		expect(scopes.map((scope) => `${scope.kind} ${scope.name}`)).toEqual([
			"type App",
			"function greet",
		]);
		expect(scopeLabelAt(source, 1, "app.ex")).toBe("App");
		expect(scopeLabelAt(source, 3, "app.ex")).toBe("greet()");
	});

	it("closes a Julia function at its `end`", () => {
		const source = ["function greet(name)", "    return name", "end"].join("\n");
		expect(scopeLabelAt(source, 2, "app.jl")).toBe("greet()");
	});

	it("names a Julia struct", () => {
		const source = ["struct Widget", "    x::Int", "end"].join("\n");
		expect(scopeLabelAt(source, 2, "app.jl")).toBe("Widget");
	});

	it("does not name a Julia one-line function", () => {
		// `name(args) = expr` is a definition, but telling it apart from an
		// assignment is more than a line of syntax — so it stays unnamed.
		const source = ["greet(name) = name", "function other()", "    1", "end"].join("\n");
		expect(scopeLabelAt(source, 1, "app.jl")).toBeUndefined();
		expect(scopeLabelAt(source, 3, "app.jl")).toBe("other()");
	});

	it("ignores a keyword inside a comment", () => {
		const source = ["function greet(name) -- end end end", "  return name", "end"].join("\n");
		expect(scopeLabelAt(source, 2, "app.lua")).toBe("greet()");
	});

	it("scans a text once however many of its lines are labelled", () => {
		// A diff labels EVERY changed line of one file. Re-reading the file per
		// line was quadratic, and a `write` of a large file timed the suite out.
		const source = ["export function cachedProbe() {", "  return 1;", "}"].join("\n");
		const before = scopeScanCount();
		for (let line = 1; line <= 3; line += 1) {
			scopeLabelAt(source, line, "probe.ts");
		}
		expect(scopeScanCount() - before).toBe(1);
	});

	it("reads the same text with the language its path names", () => {
		// The cache is keyed by the path too: a text read as Python is not the
		// same text read as TypeScript.
		const source = ["def alpha():", "    return 1"].join("\n");
		const before = scopeScanCount();
		expect(scopeLabelAt(source, 2, "probe.py")).toBe("alpha()");
		expect(scopeLabelAt(source, 2, "probe.ts")).toBeUndefined();
		expect(scopeScanCount() - before).toBe(2);
	});

	it("gives up on a block that never closes", () => {
		// A miscount would give a wrong range; a missing name is the honest
		// answer.
		const source = ["function greet(name)", "  return name"].join("\n");
		expect(detectScopes(source, languageOf("app.lua"))).toEqual([]);
	});
});
