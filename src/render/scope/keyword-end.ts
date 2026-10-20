/**
 * The keyword-end family: the blocks of a language that closes a block with a
 * word.
 *
 * Lua, Elixir and Julia have no braces. A block opens at a keyword and closes
 * at the word that ends it — `end` for all three, `until` for Lua's `repeat`.
 * The detector counts the openers and the closers line by line: the line a
 * block opens on is its first line, and the line the depth returns to zero on
 * is its last line. A block that opens and closes on one line is that line.
 *
 * The counting is only as good as the reading of the line, so the text is
 * masked first: a word inside a string or a comment is not a keyword.
 *
 * Two rules keep the count honest:
 *
 *  - the `do` of a Lua `for … do` / `while … do` belongs to the loop, not to a
 *    block of its own;
 *  - Elixir's `do:` (the keyword form of a one-line `if`) opens nothing.
 *
 * A block that never closes is DROPPED. A miscount would otherwise give a
 * wrong range, and a missing name is the honest answer.
 *
 * @module dsh-hashline-edittool/render/scope/keyword-end
 */
import { classifyDeclaration } from "./patterns.js";
import type { ScopeInfo, ScopeKind, ScopePatternGroup } from "./types.js";

/**
 * How far up the file a multi-line signature may reach.
 *
 * The same ceiling the brace family uses: a signature is a handful of lines,
 * and forty is generous enough without letting a walk scan the whole file.
 */
const MAX_DECLARATION_LINES = 40;

/** The words that open and close the blocks of one language. */
interface KeywordTable {
	/** The words that open a block. */
	readonly open: ReadonlySet<string>;
	/** The word that closes the block each opener opened. */
	readonly closers: ReadonlyMap<string, string>;
}

/** The words that open a block, per language. */
const OPENERS: Readonly<Record<string, ReadonlySet<string>>> = {
	lua: new Set(["function", "if", "for", "while", "do", "repeat"]),
	elixir: new Set(["do", "fn"]),
	julia: new Set([
		"function",
		"if",
		"for",
		"while",
		"let",
		"begin",
		"do",
		"struct",
		"macro",
		"quote",
	]),
};

/** The word that closes the block each opener opened. */
const CLOSERS: Readonly<Record<string, ReadonlyMap<string, string>>> = {
	// Lua's `repeat` is closed by `until`, everything else by `end`.
	lua: new Map([
		["function", "end"],
		["if", "end"],
		["for", "end"],
		["while", "end"],
		["do", "end"],
		["repeat", "until"],
	]),
	elixir: new Map([
		["do", "end"],
		["fn", "end"],
	]),
	julia: new Map([
		["function", "end"],
		["if", "end"],
		["for", "end"],
		["while", "end"],
		["let", "end"],
		["begin", "end"],
		["do", "end"],
		["struct", "end"],
		["macro", "end"],
		["quote", "end"],
	]),
};

/** The comment and string syntax of one language. */
interface SyntaxProfile {
	/** The line comment introducer. */
	readonly lineComment?: string;
	/** The quote characters that open a single-line string. */
	readonly quotes: readonly string[];
	/** The quote character that opens a multi-line string. */
	readonly tripleQuote?: string;
	/** The delimiters of a long-bracket string (Lua's `[[ … ]]`). */
	readonly longString?: [string, string];
}

/** The syntax of every language of the family. */
const PROFILES: Readonly<Record<string, SyntaxProfile>> = {
	lua: { lineComment: "--", quotes: ['"', "'"], longString: ["[[", "]]"] },
	elixir: { lineComment: "#", quotes: ['"', "'"], tripleQuote: '"""' },
	julia: { lineComment: "#", quotes: ['"', "'"], tripleQuote: '"""' },
};

/** A word of a line, with the position it was found at. */
interface Word {
	/** The word itself. */
	readonly text: string;
	/** The index of the word's first character. */
	readonly start: number;
	/** The index just after the word. */
	readonly end: number;
}

/** A block that has been opened but not yet closed. */
interface OpenBlock {
	readonly kind: ScopeKind;
	readonly name: string;
	readonly header: string;
	readonly startLine: number;
	/** The word that closes this block. */
	readonly closer: string;
}

/**
 * The words of a line, in order.
 *
 * @param line - the (masked) line.
 * @returns the words the line holds.
 */
function wordsOf(line: string): Word[] {
	const words: Word[] = [];
	let index = 0;
	while (index < line.length) {
		const ch = line[index]!;
		if (!isWordStart(ch)) {
			index += 1;
			continue;
		}
		const start = index;
		index += 1;
		while (index < line.length && isWordChar(line[index]!)) index += 1;
		words.push({ text: line.slice(start, index), start, end: index });
	}
	return words;
}

/**
 * Is a character the start of a word?
 *
 * @param ch - the character.
 * @returns whether it may start an identifier.
 */
function isWordStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch);
}

/**
 * Is a character part of a word?
 *
 * @param ch - the character.
 * @returns whether it may appear in an identifier.
 */
function isWordChar(ch: string): boolean {
	return /[A-Za-z0-9_]/.test(ch);
}

/**
 * Blank out the comments and the strings of a text.
 *
 * The masked text keeps every position, so a word's index in the mask is its
 * index in the source.
 *
 * @param lines - the source lines.
 * @param profile - the language's comment and string syntax.
 * @returns the masked lines.
 */
function maskLines(lines: readonly string[], profile: SyntaxProfile): string[] {
	const masked: string[] = [];
	// The context the scanner is in, carried from one line to the next.
	let context: "code" | "triple" | "long" = "code";
	let quote = "";

	for (const line of lines) {
		const out: string[] = [];
		let index = 0;
		while (index < line.length) {
			if (context === "triple") {
				const end = line.indexOf(quote, index);
				if (end === -1) {
					pushSpaces(out, index, line.length);
					index = line.length;
					continue;
				}
				pushSpaces(out, index, end + quote.length);
				index = end + quote.length;
				context = "code";
				continue;
			}
			if (context === "long") {
				const close = profile.longString?.[1] ?? "]]";
				const end = line.indexOf(close, index);
				if (end === -1) {
					pushSpaces(out, index, line.length);
					index = line.length;
					continue;
				}
				pushSpaces(out, index, end + close.length);
				index = end + close.length;
				context = "code";
				continue;
			}

			// The scanner is in code.
			if (profile.lineComment !== undefined && line.startsWith(profile.lineComment, index)) {
				pushSpaces(out, index, line.length);
				index = line.length;
				continue;
			}
			if (profile.longString !== undefined && line.startsWith(profile.longString[0], index)) {
				pushSpaces(out, index, line.length);
				index = line.length;
				context = "long";
				continue;
			}
			if (profile.tripleQuote !== undefined && line.startsWith(profile.tripleQuote, index)) {
				pushSpaces(out, index, line.length);
				index = line.length;
				context = "triple";
				quote = profile.tripleQuote;
				continue;
			}
			const single = profile.quotes.find((q) => line.startsWith(q, index));
			if (single !== undefined) {
				const end = findQuoteEnd(line, index + 1, single);
				if (end === -1) {
					pushSpaces(out, index, line.length);
					index = line.length;
					continue;
				}
				pushSpaces(out, index, end + 1);
				index = end + 1;
				continue;
			}
			out.push(line[index]!);
			index += 1;
		}
		masked.push(out.join(""));
	}
	return masked;
}

/**
 * Append blanks to the output, keeping every position.
 *
 * @param out - the output characters.
 * @param from - the first position to blank.
 * @param to - the position after the last one.
 */
function pushSpaces(out: string[], from: number, to: number): void {
	for (let index = from; index < to; index++) out.push(" ");
}

/**
 * Find the end of a single-line string.
 *
 * @param line - the line being masked.
 * @param from - the position after the opening quote.
 * @param quote - the quote character that closes the string.
 * @returns the index of the closing quote, or -1 when the line ends first.
 */
function findQuoteEnd(line: string, from: number, quote: string): number {
	for (let index = from; index < line.length; index++) {
		const ch = line[index]!;
		if (ch === "\\") {
			index += 1;
			continue;
		}
		if (ch === quote) return index;
	}
	return -1;
}

/**
 * Does this line open a block of its own?
 *
 * The walk that traces a signature back to its declaration stops at a line
 * that opens a block: the signature of a block never spans another block.
 *
 * @param line - the (masked) line.
 * @param table - the language's keyword table.
 * @returns whether the line opens a block.
 */
function opensABlock(line: string, table: KeywordTable): boolean {
	return wordsOf(line).some((word) => table.open.has(word.text));
}

/**
 * The declaration a block opens with.
 *
 * The name is usually on the opening line — `function foo(`, `def bar(x) do`.
 * When it is not (a signature that spans several lines, with the `do` of an
 * Elixir function on the last of them), the lines above are walked until one
 * of them reads as a declaration.
 *
 * @param lines - the source lines.
 * @param openerIndex - the 0-indexed line the block opens on.
 * @param group - the declaration table to read the head with.
 * @param table - the language's keyword table.
 * @returns the declaration, or `undefined` when the block has no name.
 */
function findDeclaration(
	lines: readonly string[],
	openerIndex: number,
	group: ScopePatternGroup,
	table: KeywordTable,
): { kind: ScopeKind; name: string; startLine: number } | undefined {
	const head = (lines[openerIndex] ?? "").trim();
	const direct = classifyDeclaration(head, group);
	if (direct !== undefined) return { ...direct, startLine: openerIndex + 1 };

	let accumulated = "";
	for (let index = openerIndex - 1; index >= 0; index--) {
		if (openerIndex - index > MAX_DECLARATION_LINES) break;
		const trimmed = (lines[index] ?? "").trim();
		if (trimmed === "") continue;
		// A new block starts here: the signature is over.
		if (opensABlock(trimmed, table)) break;
		accumulated = `${trimmed} ${accumulated}`;
		const match = classifyDeclaration(accumulated, group);
		if (match !== undefined) return { ...match, startLine: index + 1 };
	}
	return undefined;
}

/**
 * Scan a source text and report every block it contains.
 *
 * @param text - the source text.
 * @param group - the declaration table to read the statements with.
 * @returns the scopes, outermost first (a nested scope follows its parent).
 */
export function detectScopesKeywordEnd(text: string, group: ScopePatternGroup): ScopeInfo[] {
	const profile = PROFILES[group];
	const table: KeywordTable = {
		open: OPENERS[group] ?? new Set<string>(),
		closers: CLOSERS[group] ?? new Map<string, string>(),
	};
	if (profile === undefined) return [];

	const sourceLines = text.split("\n");
	const masked = maskLines(sourceLines, profile);
	const scopes: ScopeInfo[] = [];
	const stack: OpenBlock[] = [];

	for (let index = 0; index < masked.length; index++) {
		const line = masked[index]!;
		const words = wordsOf(line);
		// The `do` of a Lua loop belongs to the loop, not to a block of its own.
		let loopDo = false;
		for (const word of words) {
			if (table.open.has(word.text)) {
				if (group === "lua") {
					if (word.text === "for" || word.text === "while") {
						loopDo = true;
					} else if (word.text === "do" && loopDo) {
						loopDo = false;
						continue;
					}
				}
				if (group === "elixir" && word.text === "do" && line[word.end] === ":") {
					// `if x, do: 1` — the keyword form opens nothing.
					continue;
				}
				const closer = table.closers.get(word.text) ?? "end";
				const declaration = findDeclaration(sourceLines, index, group, table);
				stack.push({
					kind: declaration?.kind ?? "block",
					name: declaration?.name ?? "",
					header: (sourceLines[(declaration?.startLine ?? index + 1) - 1] ?? "").trim(),
					startLine: declaration?.startLine ?? index + 1,
					closer,
				});
				continue;
			}
			const top = stack[stack.length - 1];
			if (top === undefined || top.closer !== word.text) continue;
			stack.pop();
			scopes.push({
				kind: top.kind,
				name: top.name,
				header: top.header,
				startLine: top.startLine,
				endLine: index + 1,
			});
		}
	}

	// A block that never closes is dropped: a miscount would give a wrong
	// range, and a missing name is the honest answer.
	return scopes.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
