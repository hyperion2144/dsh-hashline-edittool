/**
 * The vocabulary of the scope detector: what a block was recognised as, how a
 * language is picked from a path, and which declaration table reads it.
 *
 * The types live in their own leaf module so the three families (brace,
 * indent, keyword-end) and the language table can share them without a cycle:
 * `types.ts` depends on nothing, and every other module under
 * `render/scope/` depends on it.
 *
 * @module dsh-hashline-edittool/render/scope/types
 */

/** What a block was recognised as. */
export type ScopeKind = "function" | "method" | "class" | "type" | "control" | "block";

/** One block: its line range, its kind and the name it carries. */
export interface ScopeInfo {
	/** What the block is. */
	kind: ScopeKind;
	/**
	 * The symbol's name — the function / method / class / type name, the
	 * control keyword for control flow, `""` for an anonymous block.
	 */
	name: string;
	/** The declaration line, trimmed. */
	header: string;
	/** First line of the block — 1-indexed, inclusive. */
	startLine: number;
	/** Last line of the block — 1-indexed, inclusive. */
	endLine: number;
}

/**
 * How a language marks the end of a block.
 *
 * - `brace` — the block ends at the closing brace (C, Go, Rust, TS/JS, …).
 * - `indent` — the block ends at the first line that is not indented deeper
 *   than the declaration (Python, Ruby).
 * - `keyword-end` — the block ends at the `end` that closes it (Lua,
 *   Elixir, Julia).
 */
export type ScopeFamily = "brace" | "indent" | "keyword-end";

/**
 * Which declaration table a language is read with.
 *
 * A table is the unit of reuse: a language joins a table, and every language
 * in that table is read by the same rules. Adding a language is one row in
 * the language table plus the name of an existing table — never a new
 * parser.
 */
export type ScopePatternGroup =
	| "js"
	| "rust"
	| "go"
	| "c"
	| "php"
	| "perl"
	| "shell"
	| "python"
	| "ruby"
	| "lua"
	| "elixir"
	| "julia";

/**
 * One language: its id, the way its blocks end and the table that reads it.
 *
 * `id` is the language's own name (`typescript`, `go`, `python`, …); it is
 * what a caller logs or shows, never a key into the rule tables.
 */
export interface ScopeLanguage {
	/** The language's name — `typescript`, `go`, `python`, … */
	id: string;
	/** How the language marks the end of a block. */
	family: ScopeFamily;
	/** The declaration table the language is read with. */
	patterns: ScopePatternGroup;
}
