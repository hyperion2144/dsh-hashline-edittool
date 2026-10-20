/**
 * The language table: which language a file is written in, and therefore
 * which block syntax and which declaration table read it.
 *
 * The table is the whole extension mechanism — the way git picks a language
 * from a file name. A row is one language: its id, the family that decides
 * where its blocks end, the declaration table that reads its statements, and
 * the file names it answers to. Adding a language is ONE ROW plus the name of
 * an existing declaration table; no parser is written for it.
 *
 * A file is matched by its extension first and by its bare name second
 * (a `Rakefile` has no extension). A file the table does not know is NOT
 * guessed at: {@link scopeLanguageForPath} answers `undefined`, and the
 * caller falls back to the default reading.
 *
 * @module dsh-hashline-edittool/render/scope/language
 */
import type { ScopeFamily, ScopeLanguage, ScopePatternGroup } from "./types.js";

/** One row of the language table. */
interface LanguageRow {
	/** The language's name. */
	readonly id: string;
	/** How the language marks the end of a block. */
	readonly family: ScopeFamily;
	/** The declaration table the language is read with. */
	readonly patterns: ScopePatternGroup;
	/** The extensions the language answers to (lower-case, with the dot). */
	readonly extensions: readonly string[];
	/**
	 * The bare file names the language answers to — the files that have no
	 * extension at all.
	 */
	readonly filenames?: readonly string[];
}

/**
 * The language table.
 *
 * The families are the three ways a block can end:
 *
 * - `brace` — the closing brace (C and its cousins, Go, Rust, TS/JS, …);
 * - `indent` — the first line that is not indented deeper (Python, Ruby);
 * - `keyword-end` — the `end` that closes it (Lua, Elixir, Julia).
 *
 * The languages a table deliberately does NOT cover — Erlang, OCaml,
 * Haskell, Clojure, Lisp, Fortran, Ada, Pascal, Cobol, SQL, R, Makefile,
 * Dockerfile — are not guessed at: their file names simply resolve to
 * `undefined` and the header carries no name.
 */
const LANGUAGE_TABLE: readonly LanguageRow[] = [
	// ── brace family ───────────────────────────────────────────────────────
	{
		id: "typescript",
		family: "brace",
		patterns: "js",
		extensions: [".ts", ".tsx", ".mts", ".cts"],
	},
	{
		id: "javascript",
		family: "brace",
		patterns: "js",
		extensions: [".js", ".jsx", ".mjs", ".cjs"],
	},
	{
		id: "vue",
		family: "brace",
		patterns: "js",
		extensions: [".vue"],
	},
	{
		id: "svelte",
		family: "brace",
		patterns: "js",
		extensions: [".svelte"],
	},
	{
		id: "rust",
		family: "brace",
		patterns: "rust",
		extensions: [".rs"],
	},
	{
		id: "zig",
		family: "brace",
		patterns: "rust",
		extensions: [".zig"],
	},
	{
		id: "go",
		family: "brace",
		patterns: "go",
		extensions: [".go"],
	},
	{
		id: "c",
		family: "brace",
		patterns: "c",
		extensions: [".c", ".h"],
	},
	{
		id: "cpp",
		family: "brace",
		patterns: "c",
		extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
	},
	{
		id: "objective-c",
		family: "brace",
		patterns: "c",
		extensions: [".m", ".mm"],
	},
	{
		id: "java",
		family: "brace",
		patterns: "c",
		extensions: [".java"],
	},
	{
		id: "kotlin",
		family: "brace",
		patterns: "c",
		extensions: [".kt", ".kts"],
	},
	{
		id: "scala",
		family: "brace",
		patterns: "c",
		extensions: [".scala"],
	},
	{
		id: "csharp",
		family: "brace",
		patterns: "c",
		extensions: [".cs"],
	},
	{
		id: "swift",
		family: "brace",
		patterns: "c",
		extensions: [".swift"],
	},
	{
		id: "dart",
		family: "brace",
		patterns: "c",
		extensions: [".dart"],
	},
	{
		id: "groovy",
		family: "brace",
		patterns: "c",
		extensions: [".groovy"],
	},
	{
		id: "solidity",
		family: "brace",
		patterns: "c",
		extensions: [".sol"],
	},
	{
		id: "d",
		family: "brace",
		patterns: "c",
		extensions: [".d"],
	},
	{
		id: "php",
		family: "brace",
		patterns: "php",
		extensions: [".php"],
	},
	{
		id: "perl",
		family: "brace",
		patterns: "perl",
		extensions: [".pl", ".pm"],
	},
	{
		id: "shell",
		family: "brace",
		patterns: "shell",
		extensions: [".sh", ".bash", ".zsh", ".ksh"],
	},
	{
		id: "powershell",
		family: "brace",
		patterns: "shell",
		extensions: [".ps1", ".psm1"],
	},
	// ── indent family ──────────────────────────────────────────────────────
	{
		id: "python",
		family: "indent",
		patterns: "python",
		extensions: [".py", ".pyi"],
	},
	{
		id: "vyper",
		family: "indent",
		patterns: "python",
		extensions: [".vy"],
	},
	{
		id: "ruby",
		family: "indent",
		patterns: "ruby",
		extensions: [".rb"],
		filenames: ["Rakefile", "Gemfile"],
	},
	// ── keyword-end family ─────────────────────────────────────────────────
	{
		id: "lua",
		family: "keyword-end",
		patterns: "lua",
		extensions: [".lua"],
	},
	{
		id: "elixir",
		family: "keyword-end",
		patterns: "elixir",
		extensions: [".ex", ".exs"],
	},
	{
		id: "julia",
		family: "keyword-end",
		patterns: "julia",
		extensions: [".jl"],
	},
];

/** Every language, indexed by its id. */
const BY_ID: ReadonlyMap<string, ScopeLanguage> = new Map(
	LANGUAGE_TABLE.map((row) => [
		row.id,
		{ id: row.id, family: row.family, patterns: row.patterns } satisfies ScopeLanguage,
	]),
);

/** The language that answers to an extension. */
const BY_EXTENSION: ReadonlyMap<string, ScopeLanguage> = new Map(
	LANGUAGE_TABLE.flatMap((row) => {
		const language = BY_ID.get(row.id);
		return language === undefined ? [] : row.extensions.map((ext) => [ext, language] as const);
	}),
);

/** The language that answers to a bare file name. */
const BY_FILENAME: ReadonlyMap<string, ScopeLanguage> = new Map(
	LANGUAGE_TABLE.flatMap((row) => {
		const language = BY_ID.get(row.id);
		return language === undefined
			? []
			: (row.filenames ?? []).map((name) => [name, language] as const);
	}),
);

/**
 * The file name without its directory.
 *
 * Both separators count: the detector is handed whatever path the caller had,
 * and a Windows path must answer the same as a POSIX one.
 *
 * @param path - the path.
 * @returns the bare file name.
 */
function basenameOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The file's extension, lower-cased and with the dot.
 *
 * A name that starts with a dot (`.gitignore`) has no extension, and neither
 * has a name without a dot.
 *
 * @param path - the path.
 * @returns the extension, or `""` when the file has none.
 */
function extensionOf(path: string): string {
	const name = basenameOf(path);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "";
	return name.slice(dot).toLowerCase();
}

/**
 * The language a file is written in.
 *
 * The extension decides; a file with no extension is matched by its bare
 * name (`Rakefile` is Ruby). A file the table does not know is
 * `undefined` — the caller then falls back to the default reading instead
 * of a guess.
 *
 * @param path - the path of the file.
 * @returns the language, or `undefined` when the path names no known language.
 */
export function scopeLanguageForPath(path: string): ScopeLanguage | undefined {
	const byExtension = BY_EXTENSION.get(extensionOf(path));
	if (byExtension !== undefined) return byExtension;
	return BY_FILENAME.get(basenameOf(path));
}
