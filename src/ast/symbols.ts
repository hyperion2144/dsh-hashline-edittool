/**
 * Symbol enumeration over a parsed tree, and reference resolution against the
 * result. Pure with respect to IO — it takes a tree and a language id, so the
 * whole classification/qualification/merging layer is unit-testable without a
 * parser, and the worker owns parsing (spec §3).
 *
 * Three behaviours here are the ones worth reading the code for:
 *
 * 1. **`descendantsOfType` matches anonymous nodes.** Asking for a type name
 *    that also names a keyword or punctuation token returns those too
 *    (measured: `descendantsOfType("{")` → 4 hits). Every result is filtered
 *    through `isNamed`.
 * 2. **Qualified paths use only name-bearing ancestors.** A naive
 *    `type:name` join produces `function_definition:outer.class_definition:
 *    Inner.inner` noise; filtering to ancestors that actually carry a name
 *    yields `outer.Inner.inner`.
 * 3. **TypeScript overloads are one symbol.** A name with two
 *    `method_signature` nodes and one `method_definition` is one block from
 *    the first signature to the implementation's end — not an ambiguity. Two
 *    genuinely distinct definitions that happen to share a chain (Python
 *    redefinition) are **not** merged and do surface as ambiguous.
 *
 * @module dsh-hashline-edittool/ast/symbols
 */
import type { Node } from "web-tree-sitter";
import {
	DEFAULT_WRAPPER_NODE_TYPES,
	DEFAULT_WRAPPER_STOP_TYPES,
	SYMBOL_KINDS,
	type KindRule,
	type KindRules,
	type SymbolKind,
} from "./kind.js";
import { languageById, queryNodeTypes, type LanguageDescriptor } from "./language.js";

/** One addressable symbol, in 1-indexed inclusive line terms. */
export interface SymbolRecord {
	/** Last segment of the qualified name — what a bare `symbol` matches. */
	readonly name: string;
	/** Dotted chain built from name-bearing ancestors, e.g. `Outer.Inner.method`. */
	readonly qualifiedName: string;
	readonly kind: SymbolKind;
	readonly languageId: string;
	/** Tree-sitter node type, kept for diagnostics and tests. */
	readonly nodeType: string;
	/** 1-indexed inclusive first line of the node. */
	readonly startLine: number;
	/** 1-indexed inclusive last line of the node. */
	readonly endLine: number;
	/** 0-indexed UTF-16 column of the node start (matches LSP's convention). */
	readonly startColumn: number;
	/**
	 * 1-indexed inclusive first line of the BLOCK — the node plus any
	 * same-identity wrapper (`export_statement`, `decorated_definition`, …).
	 *
	 * The wrapper matters: `export class Box` starts `class_declaration` at
	 * `class`, so a block beginning there would leave a dangling `export`
	 * behind when replaced. The attached comment/decorator prefix is added on
	 * the main thread, which is where the line text lives.
	 */
	readonly blockStartLine: number;
	/** 1-indexed inclusive last line of the block. */
	readonly blockEndLine: number;
}

/** Resolution outcome for a `symbol` reference. */
export type SymbolResolution =
	| { readonly kind: "found"; readonly symbol: SymbolRecord }
	| { readonly kind: "ambiguous"; readonly candidates: readonly SymbolRecord[] }
	| { readonly kind: "missing" };

/** Node types that are a *declaration without a body*. */
const SIGNATURE_NODE_TYPES = new Set([
	"method_signature",
	"abstract_method_signature",
	"function_signature",
]);

/**
 * Field names that can carry a symbol's identifier, in fallback order.
 *
 * A language whose declarations nest their name under a different field says so
 * in its descriptor (`nameFields`): C puts it under `declarator`, and without
 * that a C grammar yields essentially no symbols at all — measured, not
 * assumed. The knowledge belongs with the language, the same way `kindRules`
 * does, rather than in a global list every grammar is forced through.
 */
const DEFAULT_NAME_FIELDS: readonly string[] = ["name", "key", "left"];

/** Node types whose text is a usable identifier. */
const IDENTIFIER_TYPES = new Set([
	"identifier",
	"type_identifier",
	"property_identifier",
	"private_property_identifier",
	"field_identifier",
	"statement_identifier",
	"constant",
	"word",
]);

/**
 * A node's OWN name, from its own fields — never inherited from an ancestor.
 *
 * The distinction matters: a declaration node with no name of its own is a
 * wrapper or a fragment, and its qualified name would otherwise be built purely
 * from its container, making it look like a duplicate OF that container.
 * Haskell's `area :: a -> Double` inside `class Shape` is exactly that — a
 * nameless `function` node that came out as a second symbol called Shape.
 *
 * @param node - the candidate node.
 * @param rules - the language's kind table, for the arrow-owner fallback.
 * @param nameFields - the fields to try, from the descriptor plus the defaults.
 */
function ownSymbolName(
	node: Node,
	rules: KindRules,
	nameFields: readonly string[],
	nameChildTypes: readonly string[] | undefined,
	nameChildExclude: readonly string[] | undefined,
): string | undefined {
	return (
		ownName(node, nameFields) ??
		// Only when no FIELD worked: a grammar with real name fields must never be
		// second-guessed by a subtree scan, which could pick up a field name.
		(nameChildTypes === undefined ? undefined : ownNameFromChildren(node, nameChildTypes, nameChildExclude)) ??
		ownNameFromArrowOwner(node, rules, nameFields)
	);
}

/**
 * Read a node's own identifier, or `undefined` when it has none.
 *
 * @param node - the declaration node.
 * @param nameFields - the fields to try, from the language descriptor.
 */
function ownName(node: Node, nameFields: readonly string[]): string | undefined {
	for (const field of nameFields) {
		let named = node.childForFieldName(field) ?? null;
		// A declarator NESTS: C's `function_definition.declarator` is a
		// `function_declarator` whose own `declarator` is the identifier, and
		// `type_definition`/`field_declaration` nest the same way. Walk the same
		// field down until something nameable appears, so a language declares
		// "the name is under `declarator`" once instead of per node type.
		for (let depth = 0; depth < 8 && named !== null; depth += 1) {
			if (IDENTIFIER_TYPES.has(named.type) || named.type === "string") break;
			const next = named.childForFieldName(field);
			if (next === null) break;
			named = next;
		}
		if (named === null) continue;
		// `declare module "s" {}` reports a `string` node including its quotes.
		const text = named.text;
		if (typeof text !== "string" || text.length === 0) continue;
		if (named.type === "string") return text.replace(/^["']|["']$/g, "");
		// `left` on an assignment can be a pattern (`a, b = ...`), which is not a
		// single addressable name. A configured field is trusted after the drill
		// above; the default fields still have to land on a real identifier.
		if (!IDENTIFIER_TYPES.has(named.type) && field === "left") continue;
		return text;
	}
	return undefined;
}

/**
 * Find the name in the subtree, in DOCUMENT ORDER (pre-order depth-first).
 *
 * Document order is the whole point, and my first attempt got it backwards by
 * using breadth-first: in Julia's `struct Point <: Shape`, level 1 holds the
 * `binary_expression` whose child carries `Point` — but it ALSO holds the field
 * names from `typed_expression`, and those come first at that level, so
 * breadth-first returned the field `x`. In document order the whole `type_head`
 * subtree precedes the fields, so the first identifier is Point.
 *
 * Depth is bounded only to keep a pathological tree from being walked whole; a
 * name that is not near the head of a declaration is not a name this can trust.
 *
 * @param node - the declaration node.
 * @param types - acceptable descendant types, from the descriptor.
 */
function ownNameFromChildren(
	node: Node,
	types: readonly string[],
	excluded: readonly string[] | undefined,
): string | undefined {
	const allowed = new Set(types);
	const skip = new Set(excluded ?? []);
	const stack: Node[] = [...node.children].reverse();
	let visited = 0;
	while (stack.length > 0 && visited < 256) {
		const current = stack.pop()!;
		visited += 1;
		// A macro's own name is never the symbol's name, and excluding by TEXT
		// rather than by position is what keeps that honest: `def add(a, b)` must
		// not yield `def`, and the rule says why instead of trusting that the macro
		// always happens to come first.
		if (allowed.has(current.type) && !skip.has(current.text)) {
			const text = current.text;
			if (typeof text === "string" && text.length > 0) return text;
		}
		for (let index = current.children.length - 1; index >= 0; index -= 1) {
			stack.push(current.children[index]!);
		}
	}
	return undefined;
}

/**
 * How deep `childType` / `childAbsent` look below the node.
 *
 * A bounded DESCENDANT search, not a direct-children test. OCaml forced the
 * widening: `let area p = ...` puts `parameter` under `let_binding`, one level
 * below the `value_definition` the rule is written on, so a direct-children test
 * saw no parameter and classified a function as a variable. Direct children are
 * descendants, so this is a superset and nothing that worked before changes.
 */
const CHILD_SEARCH_DEPTH = 3;

/** Whether a DIRECT child has one of these texts. */
function hasChildWithText(node: Node, texts: readonly string[]): boolean {
	for (const child of node.children) {
		if (texts.includes(child.text)) return true;
	}
	return false;
}

/** Whether a descendant within the bound has this type. */
function hasChildOfType(node: Node, type: string): boolean {
	let level: Node[] = [...node.children];
	for (let depth = 0; depth < CHILD_SEARCH_DEPTH && level.length > 0; depth += 1) {
		const next: Node[] = [];
		for (const child of level) {
			if (child.type === type) return true;
			next.push(...child.children);
		}
		level = next;
	}
	return false;
}

/** Whether an ancestor chain contains a node type. */
function hasAncestor(node: Node, type: string): boolean {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type === type) return true;
	}
	return false;
}

/** Classify one node, or `undefined` when it is not an addressable symbol. */
function classify(node: Node, rules: KindRules): SymbolKind | undefined {
	const candidates = rules[node.type];
	if (candidates === undefined) return undefined;
	for (const rule of candidates) {
		if (!ruleMatches(rule, node)) continue;
		return rule.kind;
	}
	return undefined;
}

function ruleMatches(rule: KindRule, node: Node): boolean {
	if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) return false;
	if (rule.ancestorType !== undefined && !hasAncestor(node, rule.ancestorType)) return false;
	if (rule.ancestorAbsent !== undefined && hasAncestor(node, rule.ancestorAbsent)) return false;
	if (rule.childType !== undefined && !hasChildOfType(node, rule.childType)) return false;
	if (rule.childText !== undefined && !hasChildWithText(node, rule.childText)) return false;
	if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;
	return true;
}

/**
 * Build the dotted qualified name from name-bearing ancestors only.
 * @param node - the symbol node; its own name is appended last.
 * @param rules - the language's own kind table.
 */
function qualifiedNameOf(
	node: Node,
	rules: KindRules,
	nameFields: readonly string[],
	nameChildTypes: readonly string[] | undefined,
	nameChildExclude: readonly string[] | undefined,
): string {
	const segments: string[] = [];
	const own = ownSymbolName(node, rules, nameFields, nameChildTypes, nameChildExclude);
	if (own !== undefined) segments.push(own);
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		// Only ancestors the language's own table knows carry an identifier
		// count; the rest (`statement_block`, `class_body`, `program`, …) are
		// structure.
		if (rules[parent.type] === undefined) continue;
		// ownSymbolName, not bare ownName: an ancestor whose name lives in its
		// SUBTREE contributes nothing otherwise. Elixir exposed this — its
		// `defmodule Geo` is a `call` with no name field, so `def add` came out as
		// bare `add` instead of `Geo.add` while every namespace around it was
		// correctly enumerated.
		const name = ownSymbolName(parent, rules, nameFields, nameChildTypes, nameChildExclude);
		if (name !== undefined) segments.push(name);
	}
	// Collapse CONSECUTIVE duplicates. `typedef struct Point { int x; } Point;`
	// legitimately nests two nodes both named Point — the struct specifier and
	// the typedef — and the member's qualified name must read `Point.x`, not
	// `Point.Point.x`. Only adjacent repeats collapse, so a genuine
	// `namespace a { class a {} }` keeps both halves.
	const collapsed = segments.reverse().filter((segment, index, all) => segment !== all[index - 1]);
	return collapsed.join(".");
}

/**
 * An arrow function has no `name` field; its identity lives on the nearest
 * `variable_declarator` above it. (`const f = () => {}` is a `variable` by the
 * kind table, so this path is reached when an arrow node is enumerated
 * directly — e.g. as a `pair` value.)
 *
 * The stop condition is the **caller's** table. It used to be a hardcoded
 * `KIND_RULES["typescript"]`, so a Python walk stopped at whatever happened
 * to be a TypeScript node type — a latent cross-language bug, invisible only
 * while every arrow-shaped grammar agreed with TypeScript about those entries.
 *
 * @param node - the nameless node whose owner is being looked for.
 * @param rules - the language's own kind table.
 */
function ownNameFromArrowOwner(node: Node, rules: KindRules, nameFields: readonly string[]): string | undefined {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		if (parent.type === "variable_declarator") return ownName(parent, nameFields);
		if (rules[parent.type] !== undefined) return undefined;
	}
	return undefined;
}

/** Collect the candidate nodes for a language, named-only. */
export function collectSymbolNodes(root: Node, languageId: string): Node[] {
	const types = queryNodeTypes(languageId);
	if (types.length === 0) return [];
	const found = root.descendantsOfType(types) as unknown as Node[];
	return found.filter((node) => node.isNamed && node.type.length > 0);
}

/**
 * Climb to the outermost same-identity wrapper of a declaration.
 *
 * `export class Box` reports `class_declaration` starting at `class` — the
 * `export` keyword lives on the `export_statement` above it. A block that
 * began at the declaration would leave a dangling `export` behind when
 * replaced, so the block starts at the wrapper. The climb stops at any node
 * that is not itself a wrapper, and never crosses a body.
 *
 * @param node - the declaration node.
 * @param language - the descriptor the node was enumerated for; its wrapper
 *   lists override the defaults, and absent means the defaults.
 */
export function blockNodeOf(node: Node, language?: LanguageDescriptor): Node {
	const wrapperNodeTypes = language?.wrapperNodeTypes ?? DEFAULT_WRAPPER_NODE_TYPES;
	const wrapperStopTypes = language?.wrapperStopTypes ?? DEFAULT_WRAPPER_STOP_TYPES;
	let current = node;
	for (;;) {
		const parent = current.parent;
		if (parent === null) return current;
		if (wrapperStopTypes.includes(parent.type)) return current;
		if (!wrapperNodeTypes.includes(parent.type)) return current;
		current = parent;
	}
}

/**
 * Enumerate every addressable symbol in a tree, with TypeScript overload
 * signatures merged into their implementation.
 *
 * @param root - the tree's root node.
 * @param languageId - registry id; the descriptor it resolves to supplies the
 *   kind table and the wrapper lists. An id no descriptor claims yields no
 *   symbols rather than a guess.
 * @returns symbols ordered by start line, then by name.
 */
export function enumerateSymbols(root: Node, languageId: string): SymbolRecord[] {
	const language = languageById(languageId);
	if (language === undefined) return [];
	const rules = language.kindRules;
	// The descriptor's fields come FIRST but do not REPLACE the defaults. C++
	// showed why: declaring `declarator` (for its functions) would otherwise have
	// made `class_specifier` unnameable, because that one uses `name` — and an
	// unnamed class disappears from the symbol list entirely, taking its members'
	// qualified names with it.
	const nameFields = [...new Set([...(language.nameFields ?? []), ...DEFAULT_NAME_FIELDS])];
	const nameChildTypes = language.nameChildTypes;
	const nameChildExclude = language.nameChildExclude;
	const records: SymbolRecord[] = [];
	for (const node of collectSymbolNodes(root, languageId)) {
		const kind = classify(node, rules);
		if (kind === undefined) continue;
		// A symbol must have a name OF ITS OWN. Checking the qualified name alone is
		// Import nodes are deliberately NOT enumerated as symbols.
		//
		// `import` was a kind no language could ever produce: an import node carries
		// no name field in ANY grammar checked, so the rule below — a symbol must
		// have a name of its own — dropped every one of them, silently.
		//
		// The fix is NOT a per-language path rule. `ast_grep` finds imports by
		// SHAPE (`import $$$BODY from "$MODULE"`), with no descriptor field at all,
		// and work that is genuinely semantic belongs to the `lsp` tool, which is
		// universal. Adding a kind here would put a semantic question in the
		// structural layer and charge every language a descriptor field for it.
		// A symbol must have a name OF ITS OWN. Checking the qualified name alone is
		// not enough: it can be assembled from ancestors, so a nameless node passes
		// and then masquerades as its own container.
		if (ownSymbolName(node, rules, nameFields, nameChildTypes, nameChildExclude) === undefined) continue;
		const qualifiedName = qualifiedNameOf(node, rules, nameFields, nameChildTypes, nameChildExclude);
		if (qualifiedName.length === 0) continue;
		const lastDot = qualifiedName.lastIndexOf(".");
		records.push({
			name: qualifiedName.slice(lastDot + 1),
			qualifiedName,
			kind,
			languageId,
			nodeType: node.type,
			startLine: node.startPosition.row + 1,
			endLine: node.endPosition.row + 1,
			startColumn: node.startPosition.column,
			blockStartLine: blockNodeOf(node, language).startPosition.row + 1,
			blockEndLine: blockNodeOf(node, language).endPosition.row + 1,
		});
	}
	return mergeOverloads(records).sort(
		(a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName),
	);
}

/**
 * Merge declaration-without-body / implementation pairs that share a qualified
 * name into one symbol spanning both.
 *
 * Only a signature-plus-implementation group merges. Two implementations that
 * share a chain (Python redefinition) do **not**, so they remain separate and
 * the caller reports them as ambiguous — the spec's rule for genuinely
 * distinct symbols.
 */
function mergeOverloads(records: readonly SymbolRecord[]): SymbolRecord[] {
	const byName = new Map<string, SymbolRecord[]>();
	for (const record of records) {
		const bucket = byName.get(record.qualifiedName);
		if (bucket === undefined) byName.set(record.qualifiedName, [record]);
		else bucket.push(record);
	}
	const merged: SymbolRecord[] = [];
	for (const bucket of byName.values()) {
		if (bucket.length === 1) {
			merged.push(bucket[0]!);
			continue;
		}
		const signatures = bucket.filter((r) => SIGNATURE_NODE_TYPES.has(r.nodeType));
		const implementations = bucket.filter((r) => !SIGNATURE_NODE_TYPES.has(r.nodeType));
		// A signature group with no implementation is itself the symbol (an
		// ambient `declare function` overload set); with one or more
		// implementations it collapses into them.
		if (signatures.length === 0 || implementations.length !== 1) {
			merged.push(...bucket);
			continue;
		}
		const implementation = implementations[0]!;
		merged.push({
			...implementation,
			startLine: Math.min(...bucket.map((r) => r.startLine)),
			startColumn: bucket.reduce((min, r) => (r.startLine < min.startLine ? r : min)).startColumn,
			// The merged block starts where the FIRST signature's block starts
			// (it is the topmost declaration) and ends where the implementation's does.
			blockStartLine: Math.min(...bucket.map((r) => r.blockStartLine)),
			blockEndLine: implementation.blockEndLine,
			nodeType: implementation.nodeType,
		});
	}
	return merged;
}

/**
 * Resolve a `name` / `Outer.Inner` reference against enumerated symbols.
 *
 * Matching is exact on the last segment and, when a dot is present, exact on
 * the whole chain — no suffix matching, no globs, no regex (spec §5.6).
 *
 * @param records - the enumerated symbols.
 * @param reference - the caller's `symbol` string.
 * @param kind - optional kind filter, ANDed with the name.
 */
export function resolveSymbol(
	records: readonly SymbolRecord[],
	reference: string,
	kind?: string,
): SymbolResolution {
	const trimmed = reference.trim();
	const candidates = records.filter((record) => {
		if (kind !== undefined && record.kind !== kind) return false;
		if (trimmed.includes(".")) return record.qualifiedName === trimmed;
		return record.name === trimmed;
	});
	if (candidates.length === 0) return { kind: "missing" };
	if (candidates.length === 1) return { kind: "found", symbol: candidates[0]! };
	return { kind: "ambiguous", candidates };
}

/** Whether a string is one of the ten normalized kinds. */
export function isSymbolKind(value: string): value is SymbolKind {
	return (SYMBOL_KINDS as readonly string[]).includes(value);
}

