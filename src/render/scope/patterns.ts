/**
 * The declaration tables: how a statement head is read as a named symbol.
 *
 * One table per PATTERN GROUP, and every language in a group is read by the
 * same rules. A group is the unit of reuse — a language joins a group, it
 * never brings a parser of its own.
 *
 * A rule is a pattern plus the two questions a pattern cannot answer by
 * itself:
 *
 * - may this word be a NAME? (`namePolicy`) — a keyword read out of a
 *   generic position (`func foo(`, `int foo(`) is a misreading, and a wrong
 *   name in a diff header is worse than no name;
 * - is this really a DEFINITION? (`balanced`) — `foo({ … })` is a call with
 *   an object literal, not a method definition.
 *
 * The rules are tried IN ORDER against one statement head, and the first
 * match wins.
 *
 * @module dsh-hashline-edittool/render/scope/patterns
 */
import type { ScopeKind, ScopePatternGroup } from "./types.js";

/**
 * What happens when a rule's matched name turns out to be a reserved word.
 *
 * - `any` — the name is used as it was read. A rule whose name comes from an
 *   explicit keyword (`function foo`, `def bar`) reads a REAL name, and a
 *   program may legitimately call a function `map`.
 * - `skip` — this rule does not apply; the next one is tried.
 * - `stop` — the search ends: the head is a keyword that only LOOKS like a
 *   declaration (`func foo(`, `fn foo(`, `return () => {`).
 */
export type NamePolicy = "any" | "skip" | "stop";

/** One declaration rule. */
export interface DeclarationRule {
	/** What the rule recognises. */
	readonly kind: ScopeKind;
	/** The pattern that reads the name out of a statement head. */
	readonly pattern: RegExp;
	/** The capture group that holds the name (the first one by default). */
	readonly group?: number;
	/** The head must contain `=>` — an arrow function's binding. */
	readonly arrowOnly?: boolean;
	/** The head's parentheses must balance — a definition, not a call. */
	readonly balanced?: boolean;
	/** What to do when the name is a reserved word. */
	readonly namePolicy?: NamePolicy;
	/** The kind follows the enclosing block: a method inside a class. */
	readonly methodLike?: boolean;
}

/**
 * Control flow — the keywords that own a block.
 *
 * Control flow is never named: a line inside an `if` that sits inside a
 * function is labelled with the function, and a line inside an `if` at the
 * top level has no label at all.
 */
const CONTROL_RULE: DeclarationRule = {
	kind: "control",
	pattern:
		/^(if|else\s+if|else|for|foreach|while|do|switch|try|catch|finally|using|with|lock|synchronized|fixed|unless|until|match|when|loop|repeat|guard)\b/,
};

/**
 * TypeScript / JavaScript (and the single-file components that embed them).
 *
 * The rules are the ones the detector has always used; they are the
 * backward-compatible reading of a `.ts` / `.js` file.
 */
const JS_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/ },
	{ kind: "class", pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b\s+([A-Za-z_$][\w$]*)/ },
	{
		kind: "type",
		pattern: /^(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace|type)\b\s+([A-Za-z_$][\w$]*)/,
	},
	{
		kind: "function",
		pattern: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
		arrowOnly: true,
		namePolicy: "skip",
	},
	{
		kind: "function",
		pattern:
			/^(?:(?:public|private|protected|static|readonly|abstract|async|override|get|set|\*)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
		balanced: true,
		namePolicy: "stop",
		methodLike: true,
	},
];

/** Rust (and Zig, which shares the `fn` / `struct` / `enum` shapes). */
const RUST_RULES: readonly DeclarationRule[] = [
	{
		kind: "function",
		pattern:
			/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"|[A-Za-z_]\w*)\s+)?fn\s+([A-Za-z_]\w*)/,
	},
	{ kind: "type", pattern: /^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:pub\s+)?union\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^(?:pub\s+)?type\s+([A-Za-z_]\w*)/ },
];

/** Go: `func name(`, `func (recv) name(` and `type Name struct`. */
const GO_RULES: readonly DeclarationRule[] = [
	{ kind: "method", pattern: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/, balanced: true },
	{ kind: "function", pattern: /^func\s+([A-Za-z_]\w*)\s*\(/, balanced: true },
	{ kind: "type", pattern: /^type\s+([A-Za-z_]\w*)\b/ },
];

/**
 * The C family: C, C++, Objective-C, Java, Kotlin, Scala, C#, Swift, Dart,
 * Groovy, Solidity and D.
 *
 * The languages share one table because they share one SHAPE: a return type,
 * a name and a parameter list (`int foo(`, `public static void foo(`,
 * `void Foo::bar(`). The name is read out of a generic position, so it must
 * not be a keyword — `int main(` reads `main`, never `int`.
 */
const C_RULES: readonly DeclarationRule[] = [
	{
		kind: "class",
		pattern:
			/^(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|partial)\s+)*(?:class|actor)\s+([A-Za-z_]\w*)/,
	},
	{
		kind: "type",
		pattern:
			/^(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|partial)\s+)*(?:interface|struct|record|enum|trait|protocol|contract|library|object|namespace|module)\s+([A-Za-z_]\w*)/,
	},
	{
		kind: "function",
		pattern:
			/^(?:[A-Za-z_]\w*(?:<[^>]*>)?[\s*&]+)*(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*\(/,
		balanced: true,
		namePolicy: "stop",
		methodLike: true,
	},
];

/** PHP: `function name(`, `class Name`, `interface Name`, `trait Name`. */
const PHP_RULES: readonly DeclarationRule[] = [
	{
		kind: "function",
		pattern: /^(?:(?:public|private|protected|static|abstract|final)\s+)?function\s+&?([A-Za-z_]\w*)/,
	},
	{
		kind: "class",
		pattern: /^(?:(?:public|private|protected|static|abstract|final|readonly)\s+)*class\s+([A-Za-z_]\w*)/,
	},
	{
		kind: "type",
		pattern:
			/^(?:(?:public|private|protected|static|abstract|final)\s+)*(?:interface|trait|enum)\s+([A-Za-z_]\w*)/,
	},
];

/** Perl: `sub name` and `package Name`. */
const PERL_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^sub\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^package\s+([A-Za-z_]\w*)/ },
];

/**
 * Shell (and PowerShell): `name() {`, `function name {`, `function name()`.
 *
 * The name is read out of a generic position, so it must not be a keyword.
 */
const SHELL_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^([A-Za-z_][\w-]*)\s*\(\s*\)/, balanced: true, namePolicy: "stop" },
	{ kind: "function", pattern: /^function\s+([A-Za-z_][\w-]*)/ },
];

/** Python (and Vyper, which is a subset of it). */
const PYTHON_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
	{ kind: "class", pattern: /^class\s+([A-Za-z_]\w*)/ },
];

/** Ruby: `def name`, `def self.name`, `class Name`, `module Name`. */
const RUBY_RULES: readonly DeclarationRule[] = [
	{ kind: "method", pattern: /^def\s+self\.([A-Za-z_]\w*[?!]?)/ },
	{ kind: "function", pattern: /^def\s+([A-Za-z_]\w*[?!]?)/ },
	{ kind: "class", pattern: /^class\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^module\s+([A-Za-z_]\w*)/ },
];

/**
 * Lua: `function name(`, `local function name(` and `name = function(`.
 *
 * A `function` with no name is an anonymous function and stays anonymous.
 */
const LUA_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^local\s+function\s+([A-Za-z_][\w.]*)/ },
	{ kind: "function", pattern: /^function\s+([A-Za-z_][\w.]*)/ },
	{ kind: "function", pattern: /^([A-Za-z_][\w.]*)\s*=\s*function\b/ },
];

/**
 * Elixir: `def name(`, `defp name(` and `defmodule Name do`.
 *
 * A module is named without parentheses — it is a type, not a function.
 */
const ELIXIR_RULES: readonly DeclarationRule[] = [
	{ kind: "type", pattern: /^defmodule\s+([A-Za-z_]\w*)/ },
	{ kind: "type", pattern: /^defprotocol\s+([A-Za-z_]\w*)/ },
	{ kind: "function", pattern: /^defmacro\s+([A-Za-z_]\w*[?!]?)/ },
	{ kind: "function", pattern: /^defp?\s+([A-Za-z_]\w*[?!]?)/ },
];

/**
 * Julia: `function name(` and `struct Name`.
 *
 * The one-line form `name(args) = expr` is NOT named: telling a definition
 * from an assignment is more than a line of syntax, and a wrong name is
 * worse than none.
 */
const JULIA_RULES: readonly DeclarationRule[] = [
	{ kind: "function", pattern: /^function\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/ },
	{ kind: "type", pattern: /^(?:mutable\s+)?struct\s+([A-Za-z_]\w*)/ },
];

/**
 * Every declaration table, keyed by its group.
 *
 * The control-flow rule is prepended to every table, so it is tried before
 * any language's own rules: `if (x) {` is control flow in every language
 * that uses braces.
 */
const RULES: Readonly<Record<ScopePatternGroup, readonly DeclarationRule[]>> = {
	js: [CONTROL_RULE, ...JS_RULES],
	rust: [CONTROL_RULE, ...RUST_RULES],
	go: [CONTROL_RULE, ...GO_RULES],
	c: [CONTROL_RULE, ...C_RULES],
	php: [CONTROL_RULE, ...PHP_RULES],
	perl: [CONTROL_RULE, ...PERL_RULES],
	shell: [CONTROL_RULE, ...SHELL_RULES],
	python: PYTHON_RULES,
	ruby: RUBY_RULES,
	lua: LUA_RULES,
	elixir: ELIXIR_RULES,
	julia: JULIA_RULES,
};

/**
 * Words that can never be the name of a symbol.
 *
 * The list is the union of the keywords of every supported language. Its
 * job is to catch a MISREADING — a pattern that took a keyword for a name
 * (`func foo(` reads `func`, `fn foo(` reads `fn`, `return () => {` reads
 * `return`). A name that comes from an explicit keyword (`function map`,
 * `def end`) is a real name and is not filtered by this list.
 */
const RESERVED_WORDS = new Set([
	// JavaScript / TypeScript
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"of",
	"package",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	// Rust
	"as",
	"crate",
	"dyn",
	"fn",
	"impl",
	"loop",
	"match",
	"mod",
	"mut",
	"pub",
	"ref",
	"self",
	"struct",
	"trait",
	"type",
	"union",
	"unsafe",
	"where",
	// Go
	"chan",
	"defer",
	"fallthrough",
	"func",
	"go",
	"goto",
	"map",
	"range",
	"select",
	// C and its cousins
	"auto",
	"bool",
	"byte",
	"char",
	"class",
	"const_cast",
	"constexpr",
	"delete",
	"double",
	"explicit",
	"extern",
	"final",
	"float",
	"friend",
	"inline",
	"int",
	"integer",
	"long",
	"mutable",
	"namespace",
	"new",
	"operator",
	"private",
	"protected",
	"public",
	"register",
	"restrict",
	"short",
	"signed",
	"sizeof",
	"static",
	"static_cast",
	"struct",
	"template",
	"typename",
	"typedef",
	"union",
	"unsigned",
	"virtual",
	"volatile",
	// Java / Kotlin / Scala / C#
	"abstract",
	"boolean",
	"catch",
	"class",
	"companion",
	"data",
	"enum",
	"extends",
	"final",
	"fun",
	"implements",
	"init",
	"internal",
	"object",
	"override",
	"package",
	"private",
	"protected",
	"public",
	"record",
	"sealed",
	"static",
	"super",
	"this",
	"throws",
	"trait",
	"val",
	"var",
	// Swift / Dart / Groovy
	"deinit",
	"extension",
	"func",
	"guard",
	"inout",
	"lazy",
	"mutating",
	"nonmutating",
	"open",
	"subscript",
	// PHP
	"and",
	"array",
	"as",
	"callable",
	"clone",
	"const",
	"echo",
	"empty",
	"endif",
	"fn",
	"foreach",
	"global",
	"goto",
	"isset",
	"list",
	"match",
	"namespace",
	"or",
	"print",
	"readonly",
	"require",
	"require_once",
	"trait",
	"use",
	"xor",
	// Perl
	"bless",
	"defined",
	"do",
	"elsif",
	"foreach",
	"last",
	"local",
	"my",
	"next",
	"our",
	"package",
	"redo",
	"ref",
	"require",
	"sub",
	"undef",
	"unless",
	"until",
	"wantarray",
	// Shell / PowerShell
	"declare",
	"done",
	"elif",
	"esac",
	"eval",
	"exec",
	"fi",
	"function",
	"local",
	"readonly",
	"select",
	"set",
	"shift",
	"source",
	"then",
	"time",
	"trap",
	"typeset",
	"until",
	"unset",
	// Python / Ruby
	"assert",
	"begin",
	"class",
	"def",
	"defp",
	"defn",
	"del",
	"elif",
	"elsif",
	"end",
	"ensure",
	"exec",
	"global",
	"lambda",
	"module",
	"nonlocal",
	"proc",
	"raise",
	"redo",
	"rescue",
	"self",
	"super",
	"then",
	"until",
	"when",
	"yield",
	// Lua
	"and",
	"do",
	"else",
	"elseif",
	"end",
	"false",
	"for",
	"function",
	"goto",
	"if",
	"in",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"return",
	"then",
	"true",
	"until",
	"while",
	// Elixir
	"alias",
	"catch",
	"defmodule",
	"defimpl",
	"defmacro",
	"defprotocol",
	"defstruct",
	"do",
	"else",
	"end",
	"fn",
	"import",
	"include",
	"quote",
	"raise",
	"receive",
	"require",
	"rescue",
	"unquote",
	"unless",
	"use",
	"when",
	// Julia
	"abstract",
	"baremodule",
	"begin",
	"break",
	"catch",
	"const",
	"continue",
	"do",
	"else",
	"elseif",
	"end",
	"export",
	"finally",
	"for",
	"function",
	"global",
	"if",
	"import",
	"isa",
	"let",
	"local",
	"macro",
	"module",
	"mutable",
	"primitive",
	"quote",
	"return",
	"struct",
	"try",
	"using",
	"while",
	// Words that are keywords in some language and read like a name
	"abstract",
	"as",
	"begin",
	"case",
	"catch",
	"default",
	"defer",
	"do",
	"else",
	"end",
	"ensure",
	"final",
	"fn",
	"for",
	"func",
	"if",
	"impl",
	"in",
	"is",
	"loop",
	"match",
	"mod",
	"package",
	"proc",
	"require",
	"return",
	"select",
	"sub",
	"template",
	"then",
	"throw",
	"try",
	"until",
	"where",
]);

/**
 * May this word be used as a symbol name?
 *
 * @param name - the name a pattern read out of a statement head.
 * @returns whether the name may be reported.
 */
export function isUsableName(name: string): boolean {
	return !RESERVED_WORDS.has(name);
}

/**
 * Are the parentheses in a statement head balanced?
 *
 * This is what separates a method definition (`foo(a) {`) from a call with
 * an object literal argument (`foo({ a: 1 })`) — the latter's head stops
 * inside the parentheses.
 *
 * @param text - the statement head (already masked, so no string or comment
 *   can contribute a parenthesis).
 * @returns whether every `(` has its `)`.
 */
export function isParenBalanced(text: string): boolean {
	let depth = 0;
	for (const ch of text) {
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/** A recognised declaration: its kind and the name it carries. */
export interface DeclarationMatch {
	readonly kind: ScopeKind;
	readonly name: string;
}

/**
 * Does this head open a control-flow block?
 *
 * Control flow owns its block: a condition that spans several lines is
 * still the control's own block, and the walk that traces a signature back
 * to its declaration needs to know that.
 *
 * @param text - the statement head, already trimmed.
 * @param group - the declaration table the head is read with.
 * @returns whether the head opens a control-flow block.
 */
export function isControlStatement(text: string, group: ScopePatternGroup): boolean {
	return RULES[group].includes(CONTROL_RULE) && CONTROL_RULE.pattern.test(text);
}

/**
 * Classify a statement head.
 *
 * The rules of the group are tried IN ORDER and the first match wins. A
 * rule whose name turns out to be a reserved word either lets the next rule
 * try (`skip`) or ends the search (`stop`) — see {@link NamePolicy}.
 *
 * @param text - the statement head, already trimmed.
 * @param group - the declaration table to read the head with.
 * @param parentKind - the kind of the enclosing block, which decides whether
 *   a method-shaped head is a method or a plain function.
 * @returns the match, or `undefined` when the head is not a declaration.
 */
export function classifyDeclaration(
	text: string,
	group: ScopePatternGroup,
	parentKind?: ScopeKind,
): DeclarationMatch | undefined {
	for (const rule of RULES[group]) {
		const match = rule.pattern.exec(text);
		if (match === null) continue;
		if (rule.arrowOnly === true && !text.includes("=>")) continue;
		if (rule.balanced === true && !isParenBalanced(text)) continue;
		const name = match[rule.group ?? 1] ?? "";
		const policy = rule.namePolicy ?? "any";
		if (policy !== "any" && !isUsableName(name)) {
			if (policy === "stop") return undefined;
			continue;
		}
		const kind =
			rule.methodLike === true
				? parentKind === "class"
					? "method"
					: "function"
				: rule.kind;
		return { kind, name };
	}
	return undefined;
}
