/**
 * Grammar prober — the tool that makes language descriptors DATA instead of
 * hand-written guesses.
 *
 * Why this exists: adding a language is not "download a .wasm". Each grammar
 * needs a descriptor saying which of its node types map to our ten normalized
 * kinds (Go's `function_declaration`, Java's `method_declaration`, …). Without
 * it the grammar parses and enumerates NOTHING, so `symbol:` reads and block
 * edits silently do not work.
 *
 * Guessing those mappings per language does not scale and cannot be trusted.
 * But a grammar can be asked: `Language.nodeTypeCount` + `nodeTypeForId(i)`
 * enumerate every node type it defines. This script does that, proposes a
 * first-cut classification, then PARSES A CORPUS and reports what the proposal
 * actually finds — so a descriptor is accepted on evidence, not on vibes.
 *
 * This is a dev tool. It is not shipped and nothing imports it.
 *
 * Usage:
 *   node scripts/probe-grammar.mjs <wasm-path-or-package> [--corpus <file>]
 *   node scripts/probe-grammar.mjs node_modules/tree-sitter-go/tree-sitter-go.wasm
 *   node scripts/probe-grammar.mjs tree-sitter-rust --corpus /tmp/sample.rs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

/** The ten normalized kinds, in the order they are reported. */
const KINDS = ["function", "method", "class", "interface", "type", "enum", "namespace", "variable", "property", "import"];

/**
 * First-cut classification from the node type's NAME alone.
 *
 * Deliberately conservative and ordered: the specific patterns come first, so
 * `method_definition` cannot be swallowed by the broader `definition` rule.
 * A proposal is a starting point to be checked against a corpus — the point of
 * this script is that the CHECK is cheap, not that the guess is good.
 */
const PATTERNS = [
	// Declarations only, matched on their full declaration form. A grammar also
	// exposes the bare keywords (`class`, `function`, `module`, `field`) as NAMED
	// nodes, so `nodeTypeIsNamed` alone does not filter them out — matching a bare
	// `class` would classify the keyword as a class symbol.
	[/^(import_statement|import_declaration|use_declaration|preproc_include|package_import)$/, "import"],
	[/^(method_definition|method_declaration|method_signature)$/, "method"],
	[/^(function_declaration|function_definition|function_signature|arrow_function|function_expression|func_literal)$/, "function"],
	[/^(class_declaration|class_definition|class_specifier|class_statement)$/, "class"],
	[/^(interface_declaration|trait_declaration|trait_item|protocol_declaration)$/, "interface"],
	[/^(type_alias_declaration|type_declaration|type_item|type_definition|struct_item|union_item|typedef_declaration)$/, "type"],
	[/^(enum_declaration|enum_item|enum_specifier|enum_statement)$/, "enum"],
	[/^(namespace_definition|mod_item|module_declaration|impl_item|package_clause)$/, "namespace"],
	[/^(lexical_declaration|variable_declaration|short_var_declaration|const_item|static_item|let_declaration|var_declaration|const_declaration)$/, "variable"],
	[/^(field_declaration|field_definition|property_signature|public_field_definition|field_item)$/, "property"],
];

/**
 * Node types that more than one kind plausibly claims.
 *
 * These are the cases a name alone cannot settle — Rust's `function_item` is a
 * free function at module level and a METHOD inside `impl_item`, which the real
 * descriptor expresses with `ancestorType`. The prober must surface them
 * instead of silently picking whichever pattern happened to come first.
 */
const AMBIGUOUS = [
	[/^function_item$/, "Rust: free function vs method — needs ancestorType: impl_item"],
	[/^(function_definition|class_definition)$/, "Python: module-level vs nested in a class/function — check ancestorType"],
	[/^field_declaration$/, "class/struct field vs interface member — check parentType"],
];

/** Resolve the argument to an existing .wasm path. */
function resolveWasm(arg) {
	if (existsSync(arg)) return arg;
	const guesses = [
		join("node_modules", arg, `${arg}.wasm`),
		join("node_modules", arg, `${arg.replace(/^tree-sitter-/, "tree-sitter-")}.wasm`),
	];
	for (const guess of guesses) if (existsSync(guess)) return guess;
	throw new Error(`cannot find a .wasm for ${arg}`);
}

/** Every node type the grammar defines. */
function nodeTypesOf(language) {
	const names = [];
	const seen = new Set();
	for (let id = 1; id <= language.nodeTypeCount; id += 1) {
		try {
			// Named only: ids also cover anonymous punctuation and keywords.
			if (typeof language.nodeTypeIsNamed === "function" && !language.nodeTypeIsNamed(id)) continue;
			const name = language.nodeTypeForId(id);
			// `_foo` is an internal rule and never appears in a tree.
			if (typeof name !== "string" || name.length === 0 || name.startsWith("_")) continue;
			// A grammar can hand the same name back for several ids; without this
			// the proposal lists `class` twice and looks like a real duplicate.
			if (seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		} catch {
			/* ids are not guaranteed dense */
		}
	}
	return names;
}

/** Propose one kind per node type, first pattern wins. */
function classify(nodeTypes) {
	const proposal = {};
	for (const name of nodeTypes) {
		for (const [pattern, kind] of PATTERNS) {
			if (pattern.test(name)) {
				(proposal[kind] ??= []).push(name);
				break;
			}
		}
	}
	return proposal;
}

/** Parse a corpus and report which node types actually appear. */
function observe(language, corpusPath) {
	if (corpusPath === undefined) return undefined;
	const parser = new Parser();
	parser.setLanguage(language);
	const source = readFileSync(corpusPath, "utf8");
	const tree = parser.parse(source);
	const seen = new Set();
	/**
	 * Node types that ever carried a `name` field in this corpus.
	 *
	 * This is the check that catches the trap the name-based proposal cannot:
	 * a grammar's DECLARATION wrapper (`type_declaration`, `const_declaration`)
	 * has no `name` at all — the name sits on the `*_spec` inside it. Both Go
	 * and TypeScript hit this, so it is reported rather than left to be
	 * discovered three languages later.
	 */
	const named = new Set();
	const walk = (node) => {
		if (node.isNamed) {
			seen.add(node.type);
			if (node.childForFieldName("name") !== null) named.add(node.type);
		}
		for (const child of node.children) walk(child);
	};
	walk(tree.rootNode);
	return { seen, named, hasError: tree.rootNode.hasError };
}

const [, , target, ...rest] = process.argv;
if (target === undefined) {
	console.error("usage: node scripts/probe-grammar.mjs <wasm-path-or-package> [--corpus <file>]");
	process.exit(2);
}
const corpusIndex = rest.indexOf("--corpus");
const corpusPath = corpusIndex === -1 ? undefined : rest[corpusIndex + 1];

const wasmPath = resolveWasm(target);
const core = new URL(import.meta.resolve("web-tree-sitter")).href;
await Parser.init({ locateFile: (file) => fileURLToPath(new URL(`./${file}`, core)) });
const language = await Language.load(readFileSync(wasmPath));

const nodeTypes = nodeTypesOf(language);
const proposal = classify(nodeTypes);
const observation = observe(language, corpusPath);

console.log(`# ${wasmPath}`);
console.log(`# ${nodeTypes.length} named node types, ${Object.values(proposal).reduce((n, l) => n + l.length, 0)} classified by proposal`);
if (observation !== undefined) {
	console.log(`# corpus ${corpusPath}: ${observation.hasError ? "ROOT HAS ERRORS" : "parses cleanly"}`);
}

console.log("\nkindRules: {");
for (const kind of KINDS) {
	const list = proposal[kind];
	if (list === undefined || list.length === 0) continue;
	const hit = observation === undefined ? "" : ` // in corpus: ${list.filter((n) => observation.seen.has(n)).join(", ") || "none"}`;
	console.log(`  // ${kind}${hit}`);
	for (const name of list) {
		// A node type that appears in the corpus but NEVER carries a `name` field
		// cannot be a symbol: it is the wrapper, and its child holds the identity.
		let verdict = "";
		if (observation !== undefined) {
			if (!observation.seen.has(name)) verdict = "  // not in corpus — unverified";
			else if (!observation.named.has(name)) verdict = "  // *** NO `name` FIELD — wrapper? the symbol is probably a child ***";
		}
		console.log(`  ${JSON.stringify(name)}: [{ kind: ${JSON.stringify(kind)} }],${verdict}`);
	}
}
console.log("}");

// A descriptor is only trustworthy if the corpus actually exercised it.
if (observation !== undefined) {
	const exercised = KINDS.filter((kind) => (proposal[kind] ?? []).some((n) => observation.seen.has(n)));
	const dead = KINDS.filter((kind) => (proposal[kind] ?? []).length > 0 && !exercised.includes(kind));
	console.log(`\n# kinds exercised by this corpus: ${exercised.join(", ") || "none"}`);
	if (dead.length > 0) console.log(`# proposed but NEVER seen — unverified: ${dead.join(", ")}`);
}

// The part a name cannot decide. Each of these needs a `parentType` /
// `ancestorType` narrowing in the real descriptor, and each one that is silently
// left alone is a symbol the user will not be able to enumerate.
const flagged = nodeTypes.filter((name) => AMBIGUOUS.some(([pattern]) => pattern.test(name)));
if (flagged.length > 0) {
	console.log("\n# AMBIGUOUS — the proposal above is NOT enough for these:");
	for (const name of flagged) {
		const [, reason] = AMBIGUOUS.find(([pattern]) => pattern.test(name));
		console.log(`#   ${name} — ${reason}`);
	}
}
