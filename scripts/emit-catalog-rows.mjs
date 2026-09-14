/**
 * Emit the catalog DATA module from the harvested facts.
 *
 * Why generated: every `sha256` and `size` below came from a real download
 * (scripts/harvest-catalog.mjs). Typing nineteen 64-character hashes by hand is
 * how a catalog ends up with a plausible-looking wrong hash — and #110 already
 * shipped once with a placeholder, which made verification decorative.
 *
 * Regenerate with:
 *   node scripts/harvest-catalog.mjs > .tmp/catalog-facts.json
 *   node scripts/emit-catalog-rows.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Extensions per language id. Hand-written: npm does not publish them. */
const EXTENSIONS = {
	go: [".go"],
	rust: [".rs"],
	java: [".java"],
	c: [".c", ".h"],
	cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
	"c-sharp": [".cs"],
	ruby: [".rb", ".rake", ".gemspec"],
	php: [".php", ".phtml"],
	bash: [".sh", ".bash", ".zsh"],
	scala: [".scala", ".sc"],
	elixir: [".ex", ".exs"],
	haskell: [".hs", ".lhs"],
	ocaml: [".ml", ".mli"],
	julia: [".jl"],
	svelte: [".svelte"],
};

/** Display names where the id is not presentable as-is. */
const DISPLAY = {
	"c-sharp": "C#",
	cpp: "C++",
	html: "HTML",
	css: "CSS",
	json: "JSON",
	ocaml: "OCaml",
};

/**
 * Curated OUT of the catalog, with the reason recorded.
 *
 * The catalog admits only grammars that actually work with the parser we pin.
 * Shipping a row whose binary cannot load would let a user install something
 * that can never parse a file — the row would be a promise we cannot keep.
 */
const EXCLUDED = {
	dart:
		"tree-sitter-dart@1.0.0 ships a .wasm that fails to load under " +
		"web-tree-sitter@0.26.13 (Language.load rejects it with no message while " +
		"every other grammar in this list loads). ABI-incompatible, the same class " +
		"of problem #30 hit with the tree-sitter-wasms collection.",
	// These three parse perfectly well and are still excluded, for a different
	// reason: a language in THIS catalog is offered as "symbol reads and block
	// edits", and these grammars have no declarations to enumerate — their
	// "symbols" are tags and keys. Listing them would promise the feature while
	// quietly delivering none of it. Parse-only support would be a different
	// feature with a different name, not a row here.
	css: "no declarations to enumerate — CSS has rules, not symbols",
	html: "no declarations to enumerate — HTML has elements, not symbols",
	json: "no declarations to enumerate — JSON has keys, not symbols",
};

const facts = JSON.parse(readFileSync(".tmp/catalog-facts.json", "utf8"));
const rows = [];
const skipped = [];

for (const fact of facts.facts) {
	if (EXCLUDED[fact.id] !== undefined) {
		skipped.push(`${fact.id}: ${EXCLUDED[fact.id]}`);
		continue;
	}
	const extensions = EXTENSIONS[fact.id];
	if (extensions === undefined) {
		skipped.push(`${fact.id}: no extension map`);
		continue;
	}
	const display = DISPLAY[fact.id] ?? fact.id.charAt(0).toUpperCase() + fact.id.slice(1);
	rows.push({ ...fact, display, extensions });
}

rows.sort((a, b) => a.id.localeCompare(b.id));

const literal = (list) => `[${list.map((value) => JSON.stringify(value)).join(", ")}]`;

const body = rows
	.map((row) =>
		[
			"\t{",
			`\t\tid: ${JSON.stringify(row.id)},`,
			`\t\tdisplayName: ${JSON.stringify(row.display)},`,
			`\t\tgrammarPackage: ${JSON.stringify(row.grammarPackage)},`,
			`\t\tversion: ${JSON.stringify(row.version)},`,
			`\t\twasmFile: ${JSON.stringify(row.wasmFile)},`,
			`\t\tsha256: ${JSON.stringify(row.sha256)},`,
			`\t\tsize: ${row.size},`,
			`\t\textensions: ${literal(row.extensions)},`,
			"\t},",
		].join("\n"),
	)
	.join("\n");

const source = `/**
 * GENERATED — do not edit by hand.
 *
 * Produced by \`scripts/emit-catalog-rows.mjs\` from \`scripts/harvest-catalog.mjs\`,
 * which downloads each package and hashes the artifact it actually contains.
 * Every sha256 and size here is measured, not transcribed.
 *
 * Regenerate:
 *   node scripts/harvest-catalog.mjs > .tmp/catalog-facts.json
 *   node scripts/emit-catalog-rows.mjs
 *
 * Only packages that PUBLISH a prebuilt .wasm appear here. Eleven candidates
 * (kotlin, swift, lua, zig, perl, nix, vue, yaml, toml, sql, markdown) ship C
 * source plus native bindings and no wasm at all, so supporting them would mean
 * compiling and hosting binaries ourselves — a different supply-chain problem,
 * not a catalog row. \`tree-sitter-r\` and \`tree-sitter-dockerfile\` are absent
 * because both now resolve to a 0.0.1-security placeholder.
 */
export interface HarvestedCatalogRow {
	readonly id: string;
	readonly displayName: string;
	readonly grammarPackage: string;
	readonly version: string;
	readonly wasmFile: string;
	readonly sha256: string;
	/** Size of the .wasm in bytes — the figure a user judges a download by. */
	readonly size: number;
	/** Lowercase extensions with the leading dot. */
	readonly extensions: readonly string[];
}

/** The ${rows.length} grammars that publish a prebuilt wasm, measured. */
export const HARVESTED_CATALOG: readonly HarvestedCatalogRow[] = [
${body}
];
`;

writeFileSync("src/ast/catalog-data.ts", source);
console.log(`wrote ${rows.length} rows to src/ast/catalog-data.ts`);
if (skipped.length > 0) console.error(`skipped: ${skipped.join("; ")}`);
