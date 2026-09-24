/**
 * The pattern matcher, on real grammars — no new dependency, so the tests load
 * the same wasm the plugin does and register it by hand.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { compilePattern, matchPattern, registerPatternLanguage } from "../../src/ast/pattern.js";

const WASM = {
	typescript: "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
	python: "node_modules/tree-sitter-python/tree-sitter-python.wasm",
} as const;

beforeAll(async () => {
	const core = new URL(import.meta.resolve("web-tree-sitter")).href;
	// `fileURLToPath`, NOT `URL.pathname`: on Windows the pathname keeps a
	// leading slash before the drive (`/D:/…/web-tree-sitter.wasm`), which the
	// wasm loader's filesystem layer resolves against the current drive and
	// looks for `D:\D:\…`. The plugin's own worker and the sibling ast test
	// already convert through this helper — this caller was the odd one out.
	await Parser.init({ locateFile: (f: string) => fileURLToPath(new URL(`./${f}`, core)) });
	for (const [id, path] of Object.entries(WASM)) {
		registerPatternLanguage(id, await Language.load(readFileSync(path)));
	}
});

function parse(source: string, languageId: keyof typeof WASM) {
	const parser = new Parser();
	parser.setLanguage(registered(languageId));
	return parser.parse(source)!.rootNode;
}
function registered(languageId: keyof typeof WASM): Language {
	const handle = (globalThis as Record<string, unknown>)[`__${languageId}`] as Language;
	return handle;
}

describe("ast pattern — a self-built matcher, no dependency", () => {
	it("finds an import by SHAPE, with no kind table involved", async () => {
		const { Language: L } = await import("web-tree-sitter");
		const ts = await L.load(readFileSync(WASM.typescript));
		(globalThis as Record<string, unknown>)["__typescript"] = ts;
		registerPatternLanguage("typescript", ts);

		const source = [
			'import { a, b } from "./m";',
			'import Default from "./d";',
			'import * as ns from "./n";',
			"const x = f(1, 2);",
		].join("\n");
		const root = parse(source, "typescript");

		// The whole point: this needs no per-language descriptor field.
		const pattern = compilePattern('import $$$BODY from "$MODULE"', "typescript");
		expect(pattern).toBeDefined();
		const hits = matchPattern(root, pattern!);
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) expect(hit.node.startPosition.row).toBeLessThan(3);
	});

	it("captures one node with $NAME and many with $$$NAME", () => {
		const root = parse("f(1, 2, 3);\ng(9);", "typescript");
		const pattern = compilePattern("f($$$ARGS)", "typescript")!;
		const hits = matchPattern(root, pattern);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.captures.get("ARGS")).toHaveLength(3);
	});

	it("an expression pattern matches inside a declaration, not only as a statement", () => {
		// The statement wrapper (`expression_statement`) is an artifact of a pattern
		// being a whole program. Keeping it as the pattern root meant `entry.install`
		// and `process.platform` matched NOTHING — silently — because they appear
		// inside declarations rather than as statements of their own.
		const root = parse(
			["const plan = entry.install;", "const p = process.platform;"].join("\n"),
			"typescript",
		);
		for (const pat of ["entry.install", "$VALUE.install", "process.platform"]) {
			const pattern = compilePattern(pat, "typescript")!;
			expect(matchPattern(root, pattern), pat).toHaveLength(1);
		}
	});

	it("$_ matches without capturing", () => {
		const root = parse("f(1);", "typescript");
		const hits = matchPattern(root, compilePattern("f($_)", "typescript")!);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.captures.size).toBe(0);
	});

	it("a literal part of the pattern must match exactly", () => {
		const root = parse('f(1);\ng(1);', "typescript");
		// `g` is not `f`, so only the first call matches.
		expect(matchPattern(root, compilePattern("f($_)", "typescript")!)).toHaveLength(1);
	});

	it("refuses a pattern that is not one node, and says why", () => {
		// A bare modifier is not a node; ast-grep's own guidance is to wrap it.
		expect(() => compilePattern("const", "typescript")).toThrow(/E_AST_PATTERN/);
	});

	it("works on a second language with the same matcher", () => {
		const parser = new Parser();
		// Python's grammar is registered in beforeAll; reuse the handle the
		// matcher holds by loading it again here.
		return import("web-tree-sitter").then(async ({ Language: L }) => {
			const py = await L.load(readFileSync(WASM.python));
			registerPatternLanguage("python", py);
			parser.setLanguage(py);
			const tree = parser.parse("print(1)\nprint(2, 3)\nx = 4");
			// `parse` returns null only when no language is attached. It cannot happen
			// here, but a bare `!` would swallow a real null if the grammar ever failed
			// to load, and the failure would then read as a matcher bug.
			if (tree === null) throw new Error("the python grammar did not attach");
			const root = tree.rootNode;
			const hits = matchPattern(root, compilePattern("print($$$A)", "python")!);
			expect(hits).toHaveLength(2);
			expect(hits[1]!.captures.get("A")).toHaveLength(2);
		});
	});
});
