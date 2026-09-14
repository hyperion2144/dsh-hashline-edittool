/**
 * The built-in language registry: which grammars ship in the package, which
 * file extensions map to them, and where each grammar's `.wasm` lives.
 *
 * Grammar sources are the **per-language official npm packages**, never the
 * `tree-sitter-wasms` collection — that collection's ABI does not match
 * `web-tree-sitter` 0.26.13 and `Language.load` throws
 * `Error at failIf/getDylinkMetadata` (`docs/adr/0006` D2). The registry pins
 * the grammar package and the core version as a pair.
 *
 * A descriptor is **self-contained**: it carries the node types its symbols
 * are classified by (`kindRules`) and the wrappers a declaration's block
 * extends over, not just the grammar's location. Those tables used to live in
 * `./kind.ts` keyed by language id, which made a language something this
 * module had to know about in code; with them here, a language is data, and
 * only `builtin: true` marks the four that ship in the package.
 *
 * Runtime-added languages (the settings card's "install" action) extend this
 * same descriptor shape from the plugin home rather than replacing it; this
 * module owns only what ships in the package.
 *
 * @module dsh-hashline-edittool/ast/language
 */
import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYMBOL_KINDS, type KindRule, type KindRules, type SymbolKind } from "./kind.js";

/**
 * A language id.
 *
 * Deliberately **open**, not the closed union of the four built-ins: an
 * installed language is a language, and every consumer here is a lookup or a
 * string comparison — nothing switches on this exhaustively, so widening it
 * cannot silently drop a case. A closed union would instead have made
 * "install a language at runtime" a type error.
 */
export type LanguageId = string;

/** One language — built in, or installed at runtime from the same shape. */
export interface LanguageDescriptor {
	/** Registry id — the key the settings namespace and catalog also use. */
	readonly id: LanguageId;
	/** Human-readable name, for banners and errors. */
	readonly displayName: string;
	/** Lowercase extensions with the leading dot, as `extname` returns them. */
	readonly extensions: readonly string[];
	/** The official grammar package the `.wasm` comes from. */
	readonly grammarPackage: string;
	/** The `.wasm` file name at that package's root. */
	readonly wasmFile: string;
	/**
	 * Ships inside the package, so it works with an empty grammar registry.
	 * Absent is "installed at runtime", which is what makes it removable.
	 */
	readonly builtin?: boolean;
	/**
	 * node type → kind rule, for the node types this grammar produces.
	 *
	 * Travels with the language rather than sitting in `./kind.ts` keyed by
	 * id: `queryNodeTypes` feeds this straight to `descendantsOfType`, so a
	 * table that disagrees with the grammar yields no symbols, not an error.
	 */
	readonly kindRules: KindRules;
	/**
	 * Fields to read a declaration's identifier from, in fallback order.
	 *
	 * Absent means the defaults (`name`/`key`/`left`). C declares `declarator`
	 * here, because its name nests inside a declarator chain and without that a
	 * C grammar enumerates essentially nothing.
	 */
	readonly nameFields?: readonly string[];
	/**
	 * Descendant types that can supply the name when no FIELD does.
	 *
	 * The mechanism Julia and OCaml need: their declarations carry no name field
	 * at all, so the name has to be found in the subtree — `const MAX = 10` keeps
	 * it two levels down, a struct three. Searched BREADTH-FIRST and depth-bound,
	 * because the first identifier in document order is the name while the first
	 * in depth order is usually a field.
	 */
	readonly nameChildTypes?: readonly string[];
	/**
	 * Texts the descendant name search must skip.
	 *
	 * A macro's name is never the symbol's name. Excluding by TEXT keeps Elixir
	 * honest: `def add(a, b)` must not yield `def`, and saying why beats trusting
	 * that the macro always happens to come first.
	 */
	readonly nameChildExclude?: readonly string[];
	/**
	 * The language's symbols live in an EMBEDDED block, not in this tree.
	 *
	 * Svelte is why: its markup tree is a `document` whose `<script>` content is a
	 * leaf `raw_text` STRING — there are no JavaScript nodes in the host tree at
	 * all, so enumeration has to parse that text a second time. The container is
	 * named rather than assumed, and the offset is a single position, because the
	 * block is a contiguous slice of the host file.
	 */
	readonly embedded?: {
		/** The wrapper node to look under, e.g. `script_element`. */
		readonly containerType: string;
		/** The leaf holding the source text, e.g. `raw_text`. */
		readonly textType: string;
		/** The language that text is written in. */
		readonly language: string;
	};
	/**
	 * Import nodes are NOT described here, and the absence is deliberate.
	 *
	 * `import` was a kind no language could produce — an import node carries no
	 * `name` field in any grammar checked — and a per-language path rule only
	 * moved the configuration around: every language that wanted imports needed
	 * another entry, and one that was never written enumerated nothing and said
	 * nothing. `ast_grep` asks the same question by SHAPE instead, with no
	 * descriptor field at all. See `symbols.ts` for the full reasoning.
	 */
	/**
	 * Node types that extend a declaration's block without changing its
	 * identity; absent means `DEFAULT_WRAPPER_NODE_TYPES`.
	 */
	readonly wrapperNodeTypes?: readonly string[];
	/**
	 * Node types that stop the wrapper climb; absent means
	 * `DEFAULT_WRAPPER_STOP_TYPES`.
	 */
	readonly wrapperStopTypes?: readonly string[];
}

/** The built-in languages, in registry order. */
export const LANGUAGES: readonly LanguageDescriptor[] = [
	{
		id: "typescript",
		displayName: "TypeScript",
		extensions: [".ts", ".mts", ".cts"],
		grammarPackage: "tree-sitter-typescript",
		wasmFile: "tree-sitter-typescript.wasm",
		// Measured, not assumed: `import_statement` carries NO name field in any
		// of its four shapes (`{ a, b }` / default / `* as ns` / bare), so the
		// only thing identifying it is the module path on its `source` field.
		// One symbol per statement, because that is the unit a reader names —
		// "what does this file depend on" — and per-name symbols would bury the
		// list under the imports and STILL miss the default and namespace forms.
		builtin: true,
		kindRules: {
			function_declaration: [{ kind: "function" }],
			generator_function_declaration: [{ kind: "function" }],
			function_expression: [{ kind: "function" }],
			function_signature: [{ kind: "function" }],
			generator_function: [{ kind: "function" }],
			method_definition: [
				{ kind: "method", parentType: "class_body" },
				{ kind: "property", parentType: "object" },
				// An object literal nested elsewhere (e.g. inside a call) still
				// yields a property, never a method.
				{ kind: "property" },
			],
			method_signature: [{ kind: "method" }],
			abstract_method_signature: [{ kind: "method" }],
			class_declaration: [{ kind: "class" }],
			abstract_class_declaration: [{ kind: "class" }],
			interface_declaration: [{ kind: "interface" }],
			type_alias_declaration: [{ kind: "type" }],
			enum_declaration: [{ kind: "enum" }],
			internal_module: [{ kind: "namespace" }],
			module: [{ kind: "namespace" }],
			class: [{ kind: "class" }],
			public_field_definition: [{ kind: "property" }],
			field_definition: [{ kind: "property" }],
			pair: [{ kind: "property" }],
			variable_declarator: [{ kind: "variable" }],
		},
	},
	{
		id: "tsx",
		displayName: "TSX",
		extensions: [".tsx"],
		grammarPackage: "tree-sitter-typescript",
		wasmFile: "tree-sitter-tsx.wasm",
		// Same grammar family, same shape — verified rather than assumed.
		builtin: true,
		kindRules: {
			function_declaration: [{ kind: "function" }],
			generator_function_declaration: [{ kind: "function" }],
			function_expression: [{ kind: "function" }],
			function_signature: [{ kind: "function" }],
			generator_function: [{ kind: "function" }],
			method_definition: [
				{ kind: "method", parentType: "class_body" },
				{ kind: "property", parentType: "object" },
				{ kind: "property" },
			],
			method_signature: [{ kind: "method" }],
			abstract_method_signature: [{ kind: "method" }],
			class_declaration: [{ kind: "class" }],
			abstract_class_declaration: [{ kind: "class" }],
			interface_declaration: [{ kind: "interface" }],
			type_alias_declaration: [{ kind: "type" }],
			enum_declaration: [{ kind: "enum" }],
			internal_module: [{ kind: "namespace" }],
			module: [{ kind: "namespace" }],
			class: [{ kind: "class" }],
			public_field_definition: [{ kind: "property" }],
			field_definition: [{ kind: "property" }],
			pair: [{ kind: "property" }],
			variable_declarator: [{ kind: "variable" }],
		},
	},
	{
		id: "javascript",
		displayName: "JavaScript",
		extensions: [".js", ".mjs", ".cjs", ".jsx"],
		grammarPackage: "tree-sitter-javascript",
		wasmFile: "tree-sitter-javascript.wasm",
		builtin: true,
		kindRules: {
			function_declaration: [{ kind: "function" }],
			generator_function_declaration: [{ kind: "function" }],
			function_expression: [{ kind: "function" }],
			generator_function: [{ kind: "function" }],
			method_definition: [
				{ kind: "method", parentType: "class_body" },
				{ kind: "property", parentType: "object" },
				{ kind: "property" },
			],
			class_declaration: [{ kind: "class" }],
			class: [{ kind: "class" }],
			field_definition: [{ kind: "property" }],
			pair: [{ kind: "property" }],
			variable_declarator: [{ kind: "variable" }],
		},
	},
	{
		id: "python",
		displayName: "Python",
		extensions: [".py", ".pyi"],
		grammarPackage: "tree-sitter-python",
		wasmFile: "tree-sitter-python.wasm",
		builtin: true,
		kindRules: {
			function_definition: [
				{ kind: "method", ancestorType: "class_definition" },
				{ kind: "function" },
			],
			class_definition: [{ kind: "class" }],
			assignment: [{ kind: "variable" }],
		},
	},
	{
		id: "go",
		displayName: "Go",
		extensions: [".go"],
		grammarPackage: "tree-sitter-go",
		wasmFile: "tree-sitter-go.wasm",
		// `import_spec`, NOT `import_declaration`: the grouped form
		// (`import ( "fmt"\n "os" )`) hangs a LIST of specs off one declaration,
		// and the spec is the unit a reader would name. Measured on the tree.
		// NOT builtin: this is the catalog's first installable extension, and it
		// exists to prove the descriptor model end to end.
		builtin: false,
		kindRules: {
			function_declaration: [{ kind: "function" }],
			method_declaration: [{ kind: "method" }],
			// The name lives on the `*_spec`, never on the declaration wrapping
			// it: `type_declaration`, `const_declaration` and `var_declaration`
			// have no `name` field at all. Measured on the parse tree, not guessed
			// — the name-based proposal pointed at the wrappers and was wrong,
			// exactly as it was for TypeScript's `variable_declarator`.
			type_spec: [{ kind: "type" }],
			const_spec: [{ kind: "variable" }],
			var_spec: [{ kind: "variable" }],
			package_clause: [{ kind: "namespace" }],
			// A struct field and an interface method are the SAME node type
			// (`field_declaration`); only the ancestor tells them apart, which is
			// the prober's flagged AMBIGUOUS case and why the narrowing fields
			// have to exist.
			field_declaration: [
				{ kind: "method", ancestorType: "interface_type" },
				{ kind: "property" },
			],
		},
	},
	{
		id: "rust",
		displayName: "Rust",
		extensions: [".rs"],
		grammarPackage: "tree-sitter-rust",
		wasmFile: "tree-sitter-rust.wasm",
		builtin: false,
		kindRules: {
			// THE case the ticket was written around: `function_item` is the SAME
			// node type for a free function and for a method; only the enclosing
			// `impl_item` tells them apart. The wider rule comes first because a
			// rule list is ordered.
			function_item: [{ kind: "method", ancestorType: "impl_item" }, { kind: "function" }],
			struct_item: [{ kind: "type" }],
			union_item: [{ kind: "type" }],
			type_item: [{ kind: "type" }],
			enum_item: [{ kind: "enum" }],
			trait_item: [{ kind: "interface" }],
			const_item: [{ kind: "variable" }],
			static_item: [{ kind: "variable" }],
			mod_item: [{ kind: "namespace" }],
			field_declaration: [{ kind: "property" }],
			// `impl_item` is deliberately ABSENT as a symbol: it carries a type,
			// not a `name`, so it is only ever an ancestor. Listing it would
			// enumerate every `impl` block as a nameless entry.
		},
	},
	{
		id: "java",
		displayName: "Java",
		extensions: [".java"],
		grammarPackage: "tree-sitter-java",
		wasmFile: "tree-sitter-java.wasm",
		builtin: false,
		kindRules: {
			method_declaration: [{ kind: "method" }],
			constructor_declaration: [{ kind: "method" }],
			class_declaration: [{ kind: "class" }],
			interface_declaration: [{ kind: "interface" }],
			enum_declaration: [{ kind: "enum" }],
			record_declaration: [{ kind: "class" }],
			annotation_type_declaration: [{ kind: "interface" }],
			// NOT field_declaration or import_declaration: measured, neither
			// carries a `name`/`key`/`left` field — a Java field's identity sits
			// on the `variable_declarator` inside it, and an import's on the
			// `scoped_identifier` below it. Listing them would enumerate nothing.
		},
	},
	{
		id: "c-sharp",
		displayName: "C#",
		extensions: [".cs"],
		grammarPackage: "tree-sitter-c-sharp",
		wasmFile: "tree-sitter-c_sharp.wasm",
		builtin: false,
		kindRules: {
			method_declaration: [{ kind: "method" }],
			constructor_declaration: [{ kind: "method" }],
			class_declaration: [{ kind: "class" }],
			// A C# struct is a value type, not a class: `type` is the honest kind.
			struct_declaration: [{ kind: "type" }],
			record_declaration: [{ kind: "class" }],
			interface_declaration: [{ kind: "interface" }],
			enum_declaration: [{ kind: "enum" }],
			namespace_declaration: [{ kind: "namespace" }],
			property_declaration: [{ kind: "property" }],
			delegate_declaration: [{ kind: "type" }],
			// field_declaration is absent for the same measured reason as Java's.
		},
	},
	{
		id: "c",
		displayName: "C",
		extensions: [".c", ".h"],
		grammarPackage: "tree-sitter-c",
		wasmFile: "tree-sitter-c.wasm",
		builtin: false,
		// The reason this field exists: a C declaration keeps its name inside a
		// DECLARATOR chain (`function_definition` -> `function_declarator` ->
		// `identifier`), so none of the default fields reach it. Measured before
		// this was declared: the C corpus produced essentially no symbols.
		nameFields: ["declarator"],
		kindRules: {
			function_definition: [{ kind: "function" }],
			declaration: [{ kind: "variable" }],
			type_definition: [{ kind: "type" }],
			// `typedef struct Point {...} Point;` presents BOTH a struct_specifier
			// and a type_definition, and both name "Point" — without narrowing the
			// corpus yields the duplicate twice over. The typedef is the declaration
			// that names it, so the specifier only counts when no typedef wraps it.
			struct_specifier: [{ kind: "type", ancestorAbsent: "type_definition" }],
			enum_specifier: [{ kind: "enum", ancestorAbsent: "type_definition" }],
			field_declaration: [{ kind: "property" }],
			preproc_def: [{ kind: "variable" }],
			preproc_function_def: [{ kind: "function" }],
		},
	},
	{
		id: "php",
		displayName: "PHP",
		extensions: [".php", ".phtml"],
		grammarPackage: "tree-sitter-php",
		wasmFile: "tree-sitter-php.wasm",
		builtin: false,
		kindRules: {
			namespace_definition: [{ kind: "namespace" }],
			class_declaration: [{ kind: "class" }],
			interface_declaration: [{ kind: "interface" }],
			// A trait is a reusable behaviour set, not a class you instantiate —
			// `interface` is the honest bucket among our ten kinds.
			trait_declaration: [{ kind: "interface" }],
			method_declaration: [{ kind: "method" }],
			function_definition: [{ kind: "function" }],
		},
	},
	{
		id: "scala",
		displayName: "Scala",
		extensions: [".scala", ".sc"],
		grammarPackage: "tree-sitter-scala",
		wasmFile: "tree-sitter-scala.wasm",
		builtin: false,
		kindRules: {
			package_clause: [{ kind: "namespace" }],
			class_definition: [{ kind: "class" }],
			trait_definition: [{ kind: "interface" }],
			// A Scala `object` is a singleton instance, which among our ten kinds
			// behaves like a namespace: it groups names rather than being a type.
			object_definition: [{ kind: "namespace" }],
			type_definition: [{ kind: "type" }],
			function_declaration: [{ kind: "function" }],
			function_definition: [{ kind: "function" }],
		},
	},
	{
		id: "bash",
		displayName: "Bash",
		extensions: [".sh", ".bash", ".zsh"],
		grammarPackage: "tree-sitter-bash",
		wasmFile: "tree-sitter-bash.wasm",
		builtin: false,
		// Shell has exactly one declaration form. A descriptor that pretends
		// otherwise would enumerate noise.
		kindRules: {
			function_definition: [{ kind: "function" }],
		},
	},
	{
		id: "cpp",
		displayName: "C++",
		extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
		grammarPackage: "tree-sitter-cpp",
		wasmFile: "tree-sitter-cpp.wasm",
		builtin: false,
		nameFields: ["declarator"],
		kindRules: {
			// A member function and a free function share `function_definition`;
			// only the enclosing class tells them apart.
			function_definition: [{ kind: "method", ancestorType: "class_specifier" }, { kind: "function" }],
			// THE reason `childType` exists. C++ puts a data member AND a method
			// declaration in the same `field_declaration`; without looking at what
			// is inside, `area` came out both as a property and as a method.
			field_declaration: [
				{ kind: "method", childType: "function_declarator" },
				{ kind: "property" },
			],
			class_specifier: [{ kind: "class" }],
			struct_specifier: [{ kind: "type" }],
			enum_specifier: [{ kind: "enum" }],
			namespace_definition: [{ kind: "namespace" }],
			alias_declaration: [{ kind: "type" }],
			type_definition: [{ kind: "type" }],
		},
	},
	{
		id: "haskell",
		displayName: "Haskell",
		extensions: [".hs", ".lhs"],
		grammarPackage: "tree-sitter-haskell",
		wasmFile: "tree-sitter-haskell.wasm",
		builtin: false,
		kindRules: {
			function: [{ kind: "function" }],
			class: [{ kind: "class" }],
			data_type: [{ kind: "type" }],
			newtype: [{ kind: "type" }],
			// The grammar really is spelt `type_synomym`; this is not a typo here.
			type_synomym: [{ kind: "type" }],
			// `instance` is deliberately ABSENT. Its `name` field holds the CLASS
			// being instantiated (`instance Shape Circle` names Shape), so listing
			// it enumerated the class a second time and said nothing about the
			// instance — that duplicate is why this language was withdrawn once.
		},
	},
	{
		id: "julia",
		displayName: "Julia",
		extensions: [".jl"],
		grammarPackage: "tree-sitter-julia",
		wasmFile: "tree-sitter-julia.wasm",
		builtin: false,
		// THE reason `nameChildTypes` exists: Julia's declarations carry no name
		// FIELD at all — `const MAX = 10` keeps the name two levels down and a
		// struct three — so the name has to be found in the subtree.
		nameChildTypes: ["identifier"],
		kindRules: {
			module_definition: [{ kind: "namespace" }],
			function_definition: [{ kind: "function" }],
			macro_definition: [{ kind: "function" }],
			abstract_definition: [{ kind: "type" }],
			struct_definition: [{ kind: "type" }],
			const_statement: [{ kind: "variable" }],
		},
	},
	{
		id: "ocaml",
		displayName: "OCaml",
		extensions: [".ml", ".mli"],
		grammarPackage: "tree-sitter-ocaml",
		wasmFile: "tree-sitter-ocaml.wasm",
		builtin: false,
		// No name field anywhere, like Julia. `constructor_name` is in this list
		// because of `exception Bad of string`: without it the first acceptable
		// descendant was `type_constructor` "string" — the PAYLOAD type — and the
		// symbol came out as `string` instead of `Bad`.
		nameChildTypes: [
			"module_name",
			"type_constructor",
			"constructor_name",
			"value_name",
			"instance_variable_name",
			"method_name",
			"class_name",
		],
		kindRules: {
			module_definition: [{ kind: "namespace" }],
			type_definition: [{ kind: "type" }],
			class_definition: [{ kind: "class" }],
			exception_definition: [{ kind: "type" }],
			// `val mutable n = 0` inside an object is an instance variable, not a
			// method; without this rule it was enumerated as one.
			instance_variable_definition: [{ kind: "property" }],
			method_definition: [{ kind: "method" }],
			// `let area p = ...` takes a parameter and is a function; `let origin =
			// ...` does not and is a value. The parameter sits under `let_binding`,
			// one level below, which is why `childType` searches descendants.
			value_definition: [
				{ kind: "function", childType: "parameter" },
				{ kind: "variable" },
			],
		},
	},
	{
		id: "ruby",
		displayName: "Ruby",
		extensions: [".rb", ".rake", ".gemspec"],
		grammarPackage: "tree-sitter-ruby",
		wasmFile: "tree-sitter-ruby.wasm",
		builtin: false,
		// No name field, but the name sits immediately after the keyword, so
		// document order gives it: `def initialize(x, y)` yields `initialize`
		// BEFORE the parameters' identifiers, and `class Point` yields the constant
		// before anything in the body.
		nameChildTypes: ["constant", "identifier"],
		kindRules: {
			method: [{ kind: "method" }],
			// `def self.origin` — a class-level method, still a method.
			singleton_method: [{ kind: "method" }],
			class: [{ kind: "class" }],
			module: [{ kind: "namespace" }],
			// Assignment is deliberately ABSENT: it appears throughout method
			// bodies, so listing it would enumerate every local as a symbol.
		},
	},
	{
		id: "elixir",
		displayName: "Elixir",
		extensions: [".ex", ".exs"],
		grammarPackage: "tree-sitter-elixir",
		wasmFile: "tree-sitter-elixir.wasm",
		builtin: false,
		// `def`, `defp`, `defmodule` and `alias` are ALL the same node type
		// (`call`); only the macro's name tells them apart, which is why the
		// classification tests a child's TEXT. The set is closed and small --
		// measured across every declaration form.
		nameChildTypes: ["identifier", "alias"],
		// ...and the same set is why the name search must skip macro names: the
		// first identifier of `def add(a, b)` is `def`, and the symbol is `add`.
		nameChildExclude: ["def", "defp", "defmacro", "defguard", "defmodule"],
		kindRules: {
			call: [
				{ kind: "namespace", childText: ["defmodule"] },
				{ kind: "function", childText: ["def", "defp", "defmacro", "defguard"] },
			],
		},
	},
	{
		id: "svelte",
		displayName: "Svelte",
		extensions: [".svelte"],
		grammarPackage: "tree-sitter-svelte",
		wasmFile: "tree-sitter-svelte.wasm",
		builtin: false,
		// The markup tree carries no symbols of its own — every declaration lives
		// in the `<script>` block, which the host grammar keeps as an opaque
		// `raw_text` STRING. So this language is described by WHERE its symbols
		// are, and the worker parses that block a second time.
		embedded: { containerType: "script_element", textType: "raw_text", language: "javascript" },
		kindRules: {},
	},
];

/** Look up a descriptor by id. */
export function languageById(id: string): LanguageDescriptor | undefined {
	return LANGUAGES.find((language) => language.id === id);
}

/**
 * Resolve the language for a file path, or `undefined` when no built-in
 * grammar claims its extension.
 *
 * No ambiguity resolution: the built-in extension sets are disjoint, and the
 * registry refuses to guess (a language the caller must name explicitly is a
 * runtime-registry concern, spec §7).
 */
export function languageForPath(path: string): LanguageDescriptor | undefined {
	const ext = extname(path).toLowerCase();
	if (ext.length === 0) return undefined;
	return LANGUAGES.find((language) => language.extensions.includes(ext));
}

/**
 * The three lookups that need a language's kind table, by id.
 *
 * They live here, not in `./kind.ts`, because that module must not reach for
 * the registry: a table belongs to the descriptor that owns the language, and
 * the leaf module holds only the vocabulary. Keeping a second copy of the
 * tables there is exactly the duplication this refactor removes.
 *
 * An unknown id is not an error — it answers with the empty answer (`[]` /
 * `false`), which is what callers see today when no descriptor claims it.
 */

/**
 * The node types worth asking the parser for. One flat list per language, fed
 * to `descendantsOfType` — measured ~3.4× faster than a hand-written walk, and
 * a longer list costs about 10% over a single type (branch
 * `research/ast-symbol-kinds`, §E).
 */
export function queryNodeTypes(languageId: string): string[] {
	const language = languageById(languageId);
	return language === undefined ? [] : Object.keys(language.kindRules);
}

/** The kinds a language can actually produce (used in `kind`-filter errors). */
export function kindsForLanguage(languageId: string): SymbolKind[] {
	const language = languageById(languageId);
	if (language === undefined) return [];
	const seen = new Set<SymbolKind>();
	for (const ruleList of Object.values(language.kindRules)) for (const rule of ruleList) seen.add(rule.kind);
	return SYMBOL_KINDS.filter((kind) => seen.has(kind));
}

/** Node types that carry a symbol name via the `name` field. */
export function hasNameField(nodeType: string, languageId: string): boolean {
	const language = languageById(languageId);
	return language === undefined ? false : language.kindRules[nodeType] !== undefined;
}

/**
 * Absolute path to a language's grammar `.wasm`.
 *
 * Resolved through the grammar package's own `package.json` export rather than
 * its entry point: the entry points live under `bindings/node/`, one to three
 * levels below the `.wasm`, and that layout is not part of any contract.
 *
 * @param id - the language id.
 * @returns the absolute `.wasm` path.
 * @throws when the grammar package is not installed.
 */
export function grammarWasmPath(id: LanguageId): string {
	const language = languageById(id);
	if (language === undefined) throw new Error(`Unknown language: ${id}`);
	let pkgJson: string;
	try {
		pkgJson = fileURLToPath(import.meta.resolve(`${language.grammarPackage}/package.json`));
	} catch {
		throw new Error(
			`Grammar package "${language.grammarPackage}" is not installed — cannot parse ${language.displayName}.`,
		);
	}
	return resolve(dirname(pkgJson), language.wasmFile);
}

/** Whether a language's grammar asset is present on disk. */
export function grammarAvailable(id: LanguageId): boolean {
	try {
		return existsSync(grammarWasmPath(id));
	} catch {
		return false;
	}
}

