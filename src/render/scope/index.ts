/**
 * The scope detector: the "作用域名" of a diff segment header.
 *
 * The segment header of a unified diff wants to say "this hunk lives inside
 * `myersRange()`" (docs/diff-presentation-spec.md §3.3). An AST would answer
 * that precisely, but it would also mean a wasm grammar, a warm parser and —
 * decisively — parsing the POST-EDIT text, which by definition is not in any
 * parser's cache. So this module is a small syntactic reader instead.
 *
 * The reader is a set of FAMILIES, one per way a block can end:
 *
 *  - `brace` — the closing brace (TypeScript, Go, Rust, C, Java, PHP, …);
 *  - `indent` — the first line that is not indented deeper (Python, Ruby);
 *  - `keyword-end` — the `end` that closes it (Lua, Elixir, Julia).
 *
 * Which family and which declaration table a file is read with comes from the
 * LANGUAGE TABLE, which picks the language by the file's extension or by its
 * bare name — the way git picks a language. Adding a language is one row in
 * that table plus the name of an existing declaration table.
 *
 * It never guesses: a block it cannot name stays anonymous, and
 * {@link scopeLabelAt} returns `undefined` rather than an invented name. The
 * spec says the name is information only — "检测不到就不写" — so a missing name
 * is the honest answer, and a wrong one would only put a wrong word in a
 * header.
 *
 * @module dsh-hashline-edittool/render/scope
 */
import { detectScopesBrace } from "./brace.js";
import { detectScopesIndent } from "./indent.js";
import { detectScopesKeywordEnd } from "./keyword-end.js";
import { scopeLanguageForPath } from "./language.js";
import type { ScopeInfo, ScopeLanguage } from "./types.js";

export type {
	ScopeFamily,
	ScopeInfo,
	ScopeKind,
	ScopeLanguage,
	ScopePatternGroup,
} from "./types.js";
export { scopeLanguageForPath } from "./language.js";

/**
 * The reading used when the caller names no file.
 *
 * It is the TypeScript reading — the one the detector has always had — and it
 * is deliberately the ONLY reading: a file whose language is unknown is not
 * read as "every language at once", because a union would name a Go function
 * in a file that never said it was Go. A caller that knows the file passes
 * its path and gets the language the table holds for it.
 */
const DEFAULT_LANGUAGE: ScopeLanguage = {
	id: "typescript",
	family: "brace",
	patterns: "js",
};

/**
 * Scan a source text and report every block it contains.
 *
 * The result is a pure function of the text and the language: no file is read,
 * no parser is consulted, no dependency is loaded. A block that cannot be
 * named is still reported — with an empty name and the kind `block`.
 *
 * @param text - the source text.
 * @param language - the language to read the text with; the TypeScript
 *   reading when none is given.
 * @returns the scopes, outermost first (a nested scope follows its parent).
 */
export function detectScopes(text: string, language?: ScopeLanguage): ScopeInfo[] {
	const chosen = language ?? DEFAULT_LANGUAGE;
	switch (chosen.family) {
		case "indent":
			return detectScopesIndent(text, chosen.patterns);
		case "keyword-end":
			return detectScopesKeywordEnd(text, chosen.patterns);
		case "brace":
			return detectScopesBrace(text, chosen.patterns);
	}
}

/**
 * A scan of one text, kept so that the many lines of one file cost one read.
 *
 * A diff asks for the label of every CHANGED line of one file — hundreds of
 * them for a file the size of the response budget. Re-reading the text per line
 * made that quadratic, and a `write` of a large file timed the test suite out.
 * The scan is a pure function of (text, language), so one scan answers every
 * line of that text. Two entries are kept: the file at hand and the one before it.
 */
interface ScopeScan {
	readonly text: string;
	readonly path: string | undefined;
	readonly scopes: ScopeInfo[];
}

const SCAN_CACHE_LIMIT = 2;
const scanCache: ScopeScan[] = [];

/**
 * How many times a text was actually scanned.
 *
 * A guard, not a statistic: the test suite reads it to prove that labelling many
 * lines of one file scans the file once.
 */
let scanCount = 0;

/**
 * The number of scans the detector has performed.
 */
export function scopeScanCount(): number {
	return scanCount;
}

/**
 * The scopes of one text, read with the language its path names.
 *
 * @param text - the source text.
 * @param path - the path the text came from; the language is read from it, and a
 *   path the language table does not know falls back to the TypeScript reading.
 * @returns the scopes, outermost first.
 */
function scanFor(text: string, path: string | undefined): ScopeInfo[] {
	for (let index = 0; index < scanCache.length; index += 1) {
		const entry = scanCache[index];
		if (entry === undefined) continue;
		if (entry.text === text && entry.path === path) {
			scanCache.splice(index, 1);
			scanCache.unshift(entry);
			return entry.scopes;
		}
	}
	const language =
		path === undefined ? DEFAULT_LANGUAGE : (scopeLanguageForPath(path) ?? DEFAULT_LANGUAGE);
	scanCount += 1;
	const scopes = detectScopes(text, language);
	scanCache.unshift({ text, path, scopes });
	if (scanCache.length > SCAN_CACHE_LIMIT) scanCache.pop();
	return scopes;
}

/**
 * The segment-header label of the line — the innermost NAMED symbol around it.
 *
 * A function or a method is labelled `name()`, a class or a type is labelled
 * `name`. Control flow and anonymous blocks are not symbols: a line inside
 * an `if` that sits inside a function is labelled with the function, and a
 * line inside an `if` that sits at the top level has no label at all.
 *
 * @param text - the source text — the POST-EDIT text, so that a symbol the
 *   edit deleted cannot be named.
 * @param line - the 1-indexed line to label.
 * @param path - the path of the file the text came from; the language is read
 *   from it, and a path the language table does not know falls back to the
 *   TypeScript reading.
 * @returns the label, or `undefined` when no named symbol surrounds the line.
 */
export function scopeLabelAt(
	text: string,
	line: number,
	path?: string,
): string | undefined {
	const scopes = scanFor(text, path);
	let best: ScopeInfo | undefined;
	for (const scope of scopes) {
		if (scope.startLine > line || scope.endLine < line) continue;
		if (scope.name === "") continue;
		if (
			scope.kind !== "function" &&
			scope.kind !== "method" &&
			scope.kind !== "class" &&
			scope.kind !== "type"
		) {
			continue;
		}
		if (
			best === undefined ||
			scope.startLine > best.startLine ||
			(scope.startLine === best.startLine && scope.endLine < best.endLine)
		) {
			best = scope;
		}
	}
	if (best === undefined) return undefined;
	return best.kind === "function" || best.kind === "method" ? `${best.name}()` : best.name;
}
