/**
 * The lexer of the brace family: it masks the text a brace cannot live in and
 * collects the braces that survive.
 *
 * A brace inside a string literal, a template literal, a regular expression
 * or a comment is NOT a block. The scanner blanks those runs out — keeping
 * every character's position, so a column in the mask is the same column in
 * the source — and reports the braces it found in code.
 *
 * The masking is deliberately language-blind: line comments, block comments,
 * `"…"`, `'…'` and
 * `` `…` `` are the shapes almost every braced language shares. The one
 * exception is Rust's lifetime (`fn foo<'a>`), where an apostrophe opens
 * neither a string nor a char literal — see {@link ScanOptions.lifetimes}.
 *
 * @module dsh-hashline-edittool/render/scope/scanner
 */

/** One brace that appears in CODE — never inside a string, regex or comment. */
export interface BraceToken {
	/** 1-indexed line the brace sits on. */
	readonly line: number;
	/** 0-indexed column of the brace inside its line. */
	readonly column: number;
	/** `true` for `{`, `false` for `}`. */
	readonly open: boolean;
}

/** How the scanner should read one language. */
export interface ScanOptions {
	/**
	 * An apostrophe may open a LIFETIME (`'a` in Rust) instead of a string.
	 *
	 * Without this, the apostrophe of a lifetime would start a string that
	 * never ends, and the rest of the file would be masked away.
	 */
	readonly lifetimes?: boolean;
}

/** The scanner's output: the masked source and the braces that survived it. */
export interface ScanResult {
	/** The source with every string / regex / comment character blanked out. */
	readonly maskedLines: readonly string[];
	/** Every brace that survived the masking, in source order. */
	readonly braces: readonly BraceToken[];
}

/**
 * The scanner's context stack.
 *
 * The empty stack means "plain code"; every frame is a context the code is
 * nested in, and the frame below it is where the scanner returns to.
 */
type ScanFrame =
	| { kind: "blockComment" }
	| { kind: "string"; quote: '"' | "'" }
	| { kind: "regex" }
	| { kind: "template" }
	| { kind: "templateExpr"; depth: number };

/** The scanner's mutable state, carried from one line to the next. */
interface ScanState {
	/** The context stack. */
	readonly stack: ScanFrame[];
	/** The last significant code character — decides `/` regex vs division. */
	lastSignificant: string;
	/** The last code word (identifier) — a keyword may open a regex too. */
	lastWord: string;
	/** Whether an apostrophe may open a lifetime instead of a string. */
	readonly lifetimes: boolean;
}

/** A keyword after which a `/` opens a regular expression, not a division. */
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"case",
	"in",
	"of",
	"do",
	"else",
	"yield",
	"await",
	"new",
	"delete",
	"void",
	"instanceof",
]);

/** A character after which a `/` opens a regular expression, not a division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";"]);

/**
 * Mask a source text and collect its code braces.
 *
 * @param text - the source text.
 * @param options - how the language should be read.
 * @returns the masked lines and the code braces.
 */
export function scanSource(text: string, options: ScanOptions = {}): ScanResult {
	const sourceLines = text.split("\n");
	const maskedLines: string[] = [];
	const braces: BraceToken[] = [];
	const state: ScanState = {
		stack: [],
		lastSignificant: "",
		lastWord: "",
		lifetimes: options.lifetimes === true,
	};
	for (let index = 0; index < sourceLines.length; index++) {
		maskedLines.push(scanLine(sourceLines[index]!, state, braces, index + 1));
	}
	return { maskedLines, braces };
}

/**
 * Mask one line and collect the braces on it.
 *
 * The context stack carries across lines, so a block comment, a template
 * literal or a multi-line string keeps its state on the next line.
 *
 * @param line - the source line.
 * @param state - the scanner's state, mutated in place.
 * @param braces - the collected braces, mutated in place.
 * @param lineNumber - the 1-indexed line number, for the brace records.
 * @returns the masked line.
 */
function scanLine(
	line: string,
	state: ScanState,
	braces: BraceToken[],
	lineNumber: number,
): string {
	const masked: Array<[number, number]> = [];
	let i = 0;
	const n = line.length;
	// The identifier being read; it becomes the "last word" when the word ends.
	let word = "";

	const mask = (from: number, to: number): void => {
		if (to > from) masked.push([from, to]);
	};

	// The last code character and the last code word decide whether a `/`
	// opens a regular expression or is a division. A masked region (string,
	// regex, comment) is an operand, so it clears both.
	const resetOperands = (): void => {
		state.lastSignificant = "";
		state.lastWord = "";
		word = "";
	};

	while (i < n) {
		const stack = state.stack;
		const top = stack.length > 0 ? stack[stack.length - 1]! : undefined;

		if (top === undefined || top.kind === "templateExpr") {
			const ch = line[i]!;
			const next = line[i + 1];

			if (ch === "/" && next === "/") {
				// A line comment swallows the rest of the line.
				mask(i, n);
				i = n;
				continue;
			}
			if (ch === "/" && next === "*") {
				mask(i, i + 2);
				i += 2;
				stack.push({ kind: "blockComment" });
				resetOperands();
				continue;
			}
			if (ch === '"' || ch === "'") {
				if (ch === "'" && state.lifetimes && !isCharLiteral(line, i)) {
					// A lifetime (`'a`), not a string: the quote is masked
					// alone, so the rest of the line stays readable.
					mask(i, i + 1);
					i += 1;
					state.lastSignificant = ch;
					word = "";
					continue;
				}
				mask(i, i + 1);
				i += 1;
				stack.push({ kind: "string", quote: ch });
				resetOperands();
				continue;
			}
			if (ch === "`") {
				mask(i, i + 1);
				i += 1;
				stack.push({ kind: "template" });
				resetOperands();
				continue;
			}
			if (ch === "/") {
				// A `/` after an operator or a keyword opens a regex; anywhere
				// else it is a division.
				if (
					state.lastSignificant === "" ||
					REGEX_PRECEDERS.has(state.lastSignificant) ||
					REGEX_KEYWORDS.has(state.lastWord)
				) {
					mask(i, i +  1);
					i += 1;
					stack.push({ kind: "regex" });
					resetOperands();
					continue;
				}
				state.lastSignificant = ch;
				word = "";
				i += 1;
				continue;
			}
			if (ch === "{") {
				braces.push({ line: lineNumber, column: i, open: true });
				if (top !== undefined) top.depth += 1;
				state.lastSignificant = ch;
				word = "";
				i += 1;
				continue;
			}
			if (ch === "}") {
				if (top !== undefined && top.depth === 0) {
					// The `}` that closes a `${` — template syntax, not a block.
					mask(i, i + 1);
					i += 1;
					stack.pop();
					state.lastSignificant = ch;
					word = "";
					continue;
				}
				braces.push({ line: lineNumber, column: i, open: false });
				if (top !== undefined) top.depth -= 1;
				state.lastSignificant = ch;
				word = "";
				i += 1;
				continue;
			}
			if (isIdentifierChar(ch)) {
				word += ch;
				state.lastSignificant = ch;
				i += 1;
				continue;
			}
			if (word !== "") {
				state.lastWord = word;
				word = "";
			}
			if (!isSpace(ch)) state.lastSignificant = ch;
			i += 1;
			continue;
		}

		if (top.kind === "blockComment") {
			const end = line.indexOf("*/", i);
			if (end === -1) {
				mask(i, n);
				i = n;
				continue;
			}
			mask(i, end + 2);
			i = end + 2;
			stack.pop();
			continue;
		}

		if (top.kind === "string") {
			const end = findStringEnd(line, i, top.quote);
			if (end === -1) {
				// A string literal cannot span lines in JS. An unterminated one
				// is a syntax error; ending it here keeps the rest of the file
				// readable instead of masking it.
				mask(i, n);
				i = n;
				stack.pop();
				continue;
			}
			mask(i, end + 1);
			i = end + 1;
			stack.pop();
			continue;
		}

		if (top.kind === "regex") {
			const end = findRegexEnd(line, i);
			if (end === -1) {
				mask(i, n);
				i = n;
				stack.pop();
				continue;
			}
			mask(i, end + 1);
			i = end + 1;
			stack.pop();
			continue;
		}

		// A template literal's text.
		const end = findTemplateEnd(line, i);
		if (end === -1) {
			mask(i, n);
			i = n;
			continue;
		}
		if (line[end] === "`") {
			mask(i, end + 1);
			i = end + 1;
			stack.pop();
			continue;
		}
		// `${` — back to code until the matching `}`.
		mask(i, end + 2);
		i = end + 2;
		stack.push({ kind: "templateExpr", depth: 0 });
	}

	// The word survives the line break: `return\n/re/` is still a regex.
	if (word !== "") {
		state.lastWord = word;
		word = "";
	}

	if (masked.length === 0) return line;
	let out = "";
	let pos = 0;
	for (const [from, to] of masked) {
		if (from < pos) continue;
		out += line.slice(pos, from) + " ".repeat(to - from);
		pos = to;
	}
	return out + line.slice(pos);
}

/**
 * Is this apostrophe a char literal rather than a lifetime?
 *
 * A char literal closes on the same line (`'a'`, `'\n'`); a lifetime does not
 * (`'a` in `fn foo<'a>`).
 *
 * @param line - the line being scanned.
 * @param at - the position of the apostrophe.
 * @returns whether the apostrophe opens a char literal.
 */
function isCharLiteral(line: string, at: number): boolean {
	const next = line[at + 1];
	if (next === undefined) return false;
	if (next === "\\") return line[at + 3] === "'" || line[at + 2] === "'";
	return line[at + 2] === "'";
}

/**
 * Find the end of a string literal.
 *
 * @param line - the line being scanned.
 * @param from - the position after the opening quote.
 * @param quote - the quote character that closes the literal.
 * @returns the index of the closing quote, or -1 when the line ends first.
 */
function findStringEnd(line: string, from: number, quote: string): number {
	for (let i = from; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === quote) return i;
	}
	return -1;
}

/**
 * Find the end of a regular expression literal.
 *
 * A `/` inside a character class (`[/]`) does not end the literal.
 *
 * @param line - the line being scanned.
 * @param from - the position after the opening `/`.
 * @returns the index of the closing `/`, or -1 when the line ends first.
 */
function findRegexEnd(line: string, from: number): number {
	let inClass = false;
	for (let i = from; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			continue;
		}
		if (ch === "]") {
			inClass = false;
			continue;
		}
		if (ch === "/" && !inClass) return i;
	}
	return -1;
}

/**
 * Find the end of a template literal's text.
 *
 * @param line - the line being scanned.
 * @param from - the position after the opening backtick.
 * @returns the index of the closing backtick or of a `${`, or -1.
 */
function findTemplateEnd(line: string, from: number): number {
	for (let i = from; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "`") return i;
		if (ch === "$" && line[i + 1] === "{") return i;
	}
	return -1;
}

/**
 * Is a character part of an identifier?
 *
 * @param ch - the character.
 * @returns whether it may appear in an identifier.
 */
function isIdentifierChar(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Is a character whitespace?
 *
 * @param ch - the character.
 * @returns whether it is whitespace.
 */
function isSpace(ch: string): boolean {
	return ch === " " || ch === "\t";
}
