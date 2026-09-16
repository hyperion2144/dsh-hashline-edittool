/**
 * The ten normalized symbol kinds, and the shape of one language's kind table.
 *
 * The kind vocabulary is deliberately **normalized, not per-language**: LSP's
 * `SymbolKind` has 26 values and returns different subsets per language
 * server, so exposing it directly would make `kind: "function"` mean
 * different things depending on which backend answered — unacceptable for a
 * filter the model writes once (see `docs/ast-read-edit-spec.md` §8.4 and
 * `docs/adr/0008`). Everything maps into these ten.
 *
 * Two kinds cannot be decided from the node type alone and carry a predicate:
 * `method_definition` is emitted for both class bodies and object literals
 * (measured on this repo: every `method_definition` in `lib/hash-store.js`
 * has an `object` parent), and Python has no distinct method node at all —
 * a `function_definition` is a method exactly when a `class_definition` is
 * among its ancestors.
 *
 * The tables those kinds are read from live on the descriptor that owns the
 * language (`./language.ts`): which node types a grammar produces is as much
 * a part of "this is Python" as its `.wasm` is, so a language installed at
 * runtime must bring its own table. The lookups that need a table live with
 * it, so this module holds only the vocabulary and the defaults — never a
 * copy of a table.
 *
 * @module dsh-hashline-edittool/ast/kind
 */

/** The ten normalized symbol kinds. */
export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "type"
	| "enum"
	| "namespace"
	| "variable"
	| "property";

/** Every kind, in a stable order (used to validate `kind` filters). */
export const SYMBOL_KINDS: readonly SymbolKind[] = [
	"function",
	"method",
	"class",
	"interface",
	"type",
	"enum",
	"namespace",
	"variable",
	"property",
];

/**
 * One node type's classification. `when` narrows a node type that maps to
 * more than one kind; `parentType` is the cheap case (an exact parent node
 * type) and `ancestorType` the walking case.
 */
export interface KindRule {
	readonly kind: SymbolKind;
	/** Exact parent node type that must match (e.g. `class_body`). */
	readonly parentType?: string;
	/** An ancestor node type that must be present (e.g. a Python class). */
	readonly ancestorType?: string;
	/** When true the rule applies only if NO ancestor of `ancestorType` exists. */
	readonly ancestorAbsent?: string;
	/**
	 * A direct child of this type must exist.
	 *
	 * The one level the other predicates miss. C++ shows why it is needed: a
	 * `field_declaration` is a data member AND a method declaration, and only the
	 * presence of a `function_declarator` inside tells them apart — so without
	 * this, `area` came out BOTH as a property and as a method.
	 */
	readonly childType?: string;
	/** A direct child of this type must NOT exist. */
	readonly childAbsent?: string;
	/**
	 * A DIRECT child whose text is one of these.
	 *
	 * The one predicate that tests CONTENT rather than structure, and Elixir is
	 * why it exists: `def`, `defp`, `defmodule` and `alias` are all the same node
	 * type (`call`), differing only in the macro's name. The set is closed and
	 * small — measured across every declaration form, not guessed.
	 */
	readonly childText?: readonly string[];
}

/** node type → kind rule for ONE language. Order inside a list is significant. */
export type KindRules = Readonly<Record<string, readonly KindRule[]>>;

/**
 * Wrapper node types that extend a declaration's identity without changing it.
 * The block is `wrapper ∪ attached prefix ∪ node` (spec §6.2); this list is the
 * wrapper half. `export_statement` matters because `export class Box` starts
 * `class_declaration` at column 7 — the `export` keyword sits outside it, and
 * a block that omitted the wrapper would leave a dangling `export`.
 *
 * These are the defaults. A language whose grammar wraps declarations
 * differently overrides them on its descriptor; absent means this list.
 */
export const DEFAULT_WRAPPER_NODE_TYPES: readonly string[] = [
	"export_statement",
	"ambient_declaration",
	"decorated_definition",
];

/**
 * Node types that stop the wrapper climb.
 *
 * The defaults, like the wrapper list above: a per-language override on the
 * descriptor replaces this one.
 */
export const DEFAULT_WRAPPER_STOP_TYPES: readonly string[] = [
	"program",
	"module",
	"statement_block",
	"block",
	"class_body",
];

// `hasNameField`, `kindsForLanguage` and `queryNodeTypes` are `language.ts`'s and
// are imported from there — including by `test/core/ast-symbols.test.ts`.
//
// They used to be re-exported HERE. That re-export was the second half of a
// real import cycle: `language.ts` reads `SYMBOL_KINDS` from this module, so
// re-exporting `language` back closed `kind ⇄ language`. It happened to
// evaluate safely — this statement only created bindings, and `language` reads
// `SYMBOL_KINDS` inside function bodies — but "happens to be safe" is not a
// property a cycle keeps. Deleting the re-export removes the cycle and costs
// one import line in one test.
