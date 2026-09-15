/**
 * The hashline cards' own syntax highlighter — no third party, no shipped
 * primitive, no `--shiki-*` sheet.
 *
 * WHY THIS EXISTS. The shipped `ReadBlock` colours its lines with an internal,
 * unexported shiki instance, and this bundle's externals are only the three
 * platform seed words, so no card of ours could borrow it. The theme is the
 * honest source instead: the DSH sheets define `--dsw-alias-*` tokens for both
 * themes, and every code surface in the product reads its colours from them, so
 * mapping classes onto those tokens renders in the palette the rest of the
 * product uses — light and dark, with no literal colour in this file.
 *
 * HOW IT SCANS. A hand-written delimiter scan, not a pile of regexes. At each
 * position the scanner asks, in a fixed order, whether a COMMENT, a STRING or a
 * NUMBER starts there, then whether the character is a word character, then
 * whether it is a symbol — and takes the first answer. Every branch consumes at
 * least one character, so the scan always terminates, and the text it emits is
 * always a slice of the input, so the tokens always reproduce the line exactly.
 * That last property is the contract the tests sweep hardest: a highlighter that
 * rewrites source is worse than none.
 *
 * Cross-line constructs are carried in a small state: a block comment that
 * opened and did not close, and a Python triple quote.
 *
 * @module dsh-hashline-edittool-client/highlight
 */

/** What a run of characters is, for styling purposes. */
export type TokenKind =
	| "plain"
	| "comment"
	| "string"
	| "number"
	| "keyword"
	| "literal"
	| "type"
	| "function"
	| "property"
	| "tag"
	| "punctuation";

/** One run of source text with its class. */
export interface Token {
	readonly kind: TokenKind;
	readonly text: string;
}

/** The class names the sheet styles, keyed by token kind. */
export const TOKEN_CLASS: Record<TokenKind, string> = {
	plain: "dshl-hl-plain",
	comment: "dshl-hl-comment",
	string: "dshl-hl-string",
	number: "dshl-hl-number",
	keyword: "dshl-hl-keyword",
	literal: "dshl-hl-literal",
	type: "dshl-hl-type",
	function: "dshl-hl-function",
	property: "dshl-hl-property",
	tag: "dshl-hl-tag",
	punctuation: "dshl-hl-punctuation",
};

/** A language's vocabulary and its delimiters. */
interface Grammar {
	/** Markers that comment out the rest of the line. */
	readonly lineComment: readonly string[];
	/** Open/close pairs that span lines. */
	readonly blockComment: readonly (readonly [string, string])[];
	/** Quote pairs; a three-character pair may span lines. */
	readonly quotes: readonly (readonly [string, string])[];
	readonly keywords: ReadonlySet<string>;
	readonly literals: ReadonlySet<string>;
	readonly types: ReadonlySet<string>;
	/** Whether `@name` is a decorator rather than a plain word. */
	readonly decorators: boolean;
}

/** Grammar id per file extension. */
const EXTENSION_GRAMMAR: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "typescript",
	jsx: "typescript",
	mjs: "typescript",
	cjs: "typescript",
	py: "python",
	pyi: "python",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	json: "json",
	jsonc: "json",
	yml: "yaml",
	yaml: "yaml",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	rb: "ruby",
	php: "php",
	html: "markup",
	htm: "markup",
	xml: "markup",
	md: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "css",
	less: "css",
	sql: "sql",
	toml: "toml",
	ini: "toml",
};

/** Language ids (as `langFromPath` emits them) that map to a grammar. */
const LANGUAGE_GRAMMAR: Record<string, string> = {
	typescript: "typescript",
	javascript: "typescript",
	tsx: "typescript",
	jsx: "typescript",
	python: "python",
	shellscript: "shell",
	bash: "shell",
	sh: "shell",
	zsh: "shell",
	json: "json",
	jsonc: "json",
	yaml: "yaml",
	yml: "yaml",
	rust: "rust",
	go: "go",
	java: "java",
	kotlin: "kotlin",
	swift: "swift",
	c: "c",
	cpp: "cpp",
	h: "c",
	csharp: "csharp",
	ruby: "ruby",
	php: "php",
	markup: "markup",
	html: "markup",
	xml: "markup",
	markdown: "markdown",
	css: "css",
	scss: "css",
	less: "css",
	sql: "sql",
	toml: "toml",
	ini: "toml",
};

/** `//` and `/* … *\/`, the C family's delimiters. */
const C_DELIMITERS: Pick<Grammar, "lineComment" | "blockComment" | "quotes"> = {
	lineComment: ["//"],
	blockComment: [["/*", "*/"]],
	quotes: [
		['"', '"'],
		["'", "'"],
		["`", "`"],
	],
};

/** `#` to end of line, and the two ordinary quotes. */
const HASH_DELIMITERS: Pick<Grammar, "lineComment" | "blockComment" | "quotes"> = {
	lineComment: ["#"],
	blockComment: [],
	quotes: [
		['"', '"'],
		["'", "'"],
	],
};

/** The words a grammar gives special meaning, gathered once. */
function words(text: string): ReadonlySet<string> {
	return new Set(text.split(/\s+/).filter((word) => word !== ""));
}

const GRAMMARS: Record<string, Grammar> = {
	typescript: {
		...C_DELIMITERS,
		keywords: words(
			"abstract as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield",
		),
		literals: words("true false null undefined NaN Infinity this super"),
		types: words(
			"any bigint boolean never number object string symbol unknown void Array Boolean Date Error Map Number Object Promise Record Set String WeakMap",
		),
		decorators: false,
	},
	python: {
		lineComment: ["#"],
		blockComment: [],
		// Triples first: the scan takes the longest delimiter that starts here.
		quotes: [
			['"""', '"""'],
			["'''", "'''"],
			['"', '"'],
			["'", "'"],
		],
		keywords: words(
			"and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
		),
		literals: words("True False None self cls"),
		types: words("int float str bool bytes list dict tuple set frozenset object type"),
		decorators: true,
	},
	shell: {
		...HASH_DELIMITERS,
		keywords: words(
			"case do done elif else esac fi for function if in local return select then time until while export readonly declare source alias unset",
		),
		literals: words("true false"),
		types: words(""),
		decorators: false,
	},
	json: {
		lineComment: ["//"],
		blockComment: [["/*", "*/"]],
		quotes: [['"', '"']],
		keywords: words(""),
		literals: words("true false null"),
		types: words(""),
		decorators: false,
	},
	yaml: {
		...HASH_DELIMITERS,
		keywords: words(""),
		literals: words("true false null yes no on off ~"),
		types: words(""),
		decorators: false,
	},
	rust: {
		...C_DELIMITERS,
		keywords: words(
			"as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
		),
		literals: words("true false None Some Ok Err"),
		types: words(
			"bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize String Vec Option Result Box Rc Arc",
		),
		decorators: false,
	},
	go: {
		...C_DELIMITERS,
		keywords: words(
			"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
		),
		literals: words("true false nil iota"),
		types: words(
			"bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any",
		),
		decorators: false,
	},
	java: {
		...C_DELIMITERS,
		keywords: words(
			"abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits yield",
		),
		literals: words("true false null"),
		types: words(
			"boolean byte char double float int long short String Object Integer Long Double Float Boolean List Map Set Optional",
		),
		decorators: true,
	},
	kotlin: {
		...C_DELIMITERS,
		keywords: words(
			"abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias val var vararg when where while",
		),
		literals: words("true false null"),
		types: words("Any Boolean Byte Char Double Float Int Long Short String Unit Nothing"),
		decorators: true,
	},
	swift: {
		...C_DELIMITERS,
		keywords: words(
			"as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var where while",
		),
		literals: words("true false nil"),
		types: words("Any AnyObject Bool Character Double Float Int String Void Array Dictionary Set Optional"),
		decorators: true,
	},
	c: {
		...C_DELIMITERS,
		keywords: words("auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while"),
		literals: words("NULL true false"),
		types: words("char double float int long short signed unsigned void size_t FILE bool"),
		decorators: false,
	},
	cpp: {
		...C_DELIMITERS,
		keywords: words(
			"auto break case const constexpr continue default delete do else enum extern for goto if inline namespace new operator override private protected public register restrict return sizeof static struct switch template this typedef typename union using virtual volatile while class",
		),
		literals: words("NULL true false nullptr"),
		types: words("char double float int long short signed unsigned void size_t FILE bool string vector map set pair"),
		decorators: false,
	},
	csharp: {
		...C_DELIMITERS,
		keywords: words(
			"abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using var virtual void volatile where while yield",
		),
		literals: words("true false null"),
		types: words("bool byte char decimal double float int long object sbyte short string uint ulong ushort void Task List Dictionary"),
		decorators: false,
	},
	ruby: {
		...HASH_DELIMITERS,
		keywords: words(
			"alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield attr_accessor attr_reader attr_writer require require_relative",
		),
		literals: words("true false nil __FILE__"),
		types: words("String Integer Float Array Hash Symbol Proc"),
		decorators: false,
	},
	php: {
		lineComment: ["//", "#"],
		blockComment: [["/*", "*/"]],
		quotes: [
			['"', '"'],
			["'", "'"],
		],
		keywords: words(
			"abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
		),
		literals: words("true false null TRUE FALSE NULL this"),
		types: words("bool int float string array object mixed void never"),
		decorators: false,
	},
	markup: {
		lineComment: [],
		blockComment: [["<!--", "-->"]],
		quotes: [
			['"', '"'],
			["'", "'"],
		],
		keywords: words(""),
		literals: words(""),
		types: words(""),
		decorators: false,
	},
	markdown: {
		lineComment: [],
		blockComment: [],
		quotes: [["`", "`"]],
		keywords: words(""),
		literals: words(""),
		types: words(""),
		decorators: false,
	},
	css: {
		lineComment: [],
		blockComment: [["/*", "*/"]],
		quotes: [
			['"', '"'],
			["'", "'"],
		],
		keywords: words("important media supports keyframes import charset font-face root from to"),
		literals: words(""),
		types: words(""),
		decorators: false,
	},
	sql: {
		lineComment: ["--"],
		blockComment: [["/*", "*/"]],
		quotes: [
			["'", "'"],
			['"', '"'],
		],
		keywords: words(
			"ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS DELETE DESC DISTINCT DROP ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN UNION UNIQUE UPDATE VALUES VIEW WHEN WHERE WITH",
		),
		literals: words("NULL TRUE FALSE"),
		types: words("INT INTEGER BIGINT SMALLINT TEXT VARCHAR CHAR BOOLEAN DATE TIMESTAMP NUMERIC DECIMAL REAL DOUBLE JSON JSONB UUID"),
		decorators: false,
	},
	toml: {
		...HASH_DELIMITERS,
		keywords: words(""),
		literals: words("true false"),
		types: words(""),
		decorators: false,
	},
};

/**
 * The grammar id for a language hint, or `undefined` for "render plain".
 * @param lang - the hint `read`/`grep` carry.
 * @returns the grammar id to tokenize with.
 */
export function grammarFor(lang: string | undefined): string | undefined {
	if (lang === undefined || lang === "") return undefined;
	const lower = lang.toLowerCase();
	return LANGUAGE_GRAMMAR[lower] ?? EXTENSION_GRAMMAR[lower];
}

/**
 * The same answer, from a path — the card has a path even when meta has no `lang`.
 * @param path - the file path as displayed.
 * @returns the grammar id to tokenize with.
 */
export function grammarForPath(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot === -1 || dot === path.length - 1) return undefined;
	return EXTENSION_GRAMMAR[path.slice(dot + 1).toLowerCase()];
}

/** What a scan carries from one line to the next. */
export interface ScanState {
	/** The block-comment terminator still open, if any. */
	readonly block?: string;
	/** The triple quote still open, if any. */
	readonly triple?: string;
}

/** Whether `char` can start or continue a word. */
function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

/** Whether `char` is a symbol worth its own colour. */
function isSymbol(char: string | undefined): boolean {
	return char !== undefined && "{}()[];,.:?=!<>+-*/%&|^~@#".includes(char);
}

/**
 * Classify one line, given and returning the cross-line state.
 *
 * The scan is a fixed-order walk, and every iteration consumes at least one
 * character — the property that makes it impossible for this function to loop
 * forever or to drop a character it skipped over.
 *
 * @param line - the verbatim source line.
 * @param grammar - the grammar id, or `undefined` to emit one plain run.
 * @param state - cross-line state from the previous line.
 * @returns the tokens and the state to carry into the next line.
 */
export function tokenizeLine(
	line: string,
	grammar: string | undefined,
	state: ScanState,
): { readonly tokens: readonly Token[]; readonly state: ScanState } {
	const rules = grammar === undefined ? undefined : GRAMMARS[grammar];
	if (rules === undefined) {
		return { tokens: line === "" ? [] : [{ kind: "plain", text: line }], state: {} };
	}

	const tokens: Token[] = [];
	/** Push `text` as `kind`, merging into the previous run when they match. */
	const push = (kind: TokenKind, text: string): void => {
		if (text === "") return;
		const last = tokens[tokens.length - 1];
		if (last !== undefined && last.kind === kind) {
			tokens[tokens.length - 1] = { kind, text: last.text + text };
			return;
		}
		tokens.push({ kind, text });
	};

	let index = 0;

	// Finish whatever the previous line left open before anything else can claim
	// the text: an unterminated block comment or triple quote owns this line too.
	if (state.block !== undefined) {
		const end = line.indexOf(state.block);
		if (end === -1) {
			return { tokens: line === "" ? [] : [{ kind: "comment", text: line }], state };
		}
		push("comment", line.slice(0, end + state.block.length));
		index = end + state.block.length;
		state = {};
	}
	if (state.triple !== undefined) {
		const end = line.indexOf(state.triple);
		if (end === -1) {
			return { tokens: line === "" ? [] : [{ kind: "string", text: line }], state };
		}
		push("string", line.slice(0, end + state.triple.length));
		index = end + state.triple.length;
		state = {};
	}

	while (index < line.length) {
		// 1. A line comment takes the rest of the line.
		const marker = rules.lineComment.find((candidate) => line.startsWith(candidate, index));
		if (marker !== undefined) {
			push("comment", line.slice(index));
			return { tokens, state };
		}

		// 2. A block comment runs to its terminator, or off the end of the line.
		const block = rules.blockComment.find(([open]) => line.startsWith(open, index));
		if (block !== undefined) {
			const [open, close] = block;
			const end = line.indexOf(close, index + open.length);
			if (end === -1) {
				push("comment", line.slice(index));
				return { tokens, state: { block: close } };
			}
			push("comment", line.slice(index, end + close.length));
			index = end + close.length;
			continue;
		}

		// 3. A quote runs to its own close; a three-character pair may span lines.
		const quote = rules.quotes.find(([open]) => line.startsWith(open, index));
		if (quote !== undefined) {
			const [open, close] = quote;
			const end = findClose(line, index + open.length, close);
			if (end === -1) {
				if (open.length === 3) {
					push("string", line.slice(index));
					return { tokens, state: { triple: open } };
				}
				push("string", line.slice(index));
				return { tokens, state };
			}
			push("string", line.slice(index, end));
			index = end;
			continue;
		}

		const char = line[index] ?? "";

		// 4. A number: a digit run with the usual bases, separators and exponent.
		if (/[0-9]/.test(char) && !isWordChar(line[index - 1])) {
			const end = scanNumber(line, index);
			push("number", line.slice(index, end));
			index = end;
			continue;
		}

		// 5. A word: vocabulary first, then what follows it.
		if (isWordChar(char) && !/[0-9]/.test(char)) {
			const end = scanWord(line, index);
			const word = line.slice(index, end);
			push(classifyWord(word, line.slice(end), rules), word);
			index = end;
			continue;
		}

		// 6. A symbol run, or a single character nothing claimed.
		if (isSymbol(char)) {
			let end = index;
			while (end < line.length && isSymbol(line[end] ?? "")) end += 1;
			push("punctuation", line.slice(index, end));
			index = end;
			continue;
		}

		push("plain", char);
		index += 1;
	}
	return { tokens, state };
}

/** The end of the word starting at `from` (letters, digits, `_`, `$`). */
function scanWord(line: string, from: number): number {
	let index = from;
	while (index < line.length && isWordChar(line[index])) index += 1;
	return index;
}

/** The end of the numeric literal starting at `from`. */
function scanNumber(line: string, from: number): number {
	let index = from;
	const base = line.slice(from, from + 2).toLowerCase();
	if (base === "0x" || base === "0b" || base === "0o") {
		index += 2;
		while (index < line.length && /[0-9a-fA-F_]/.test(line[index] ?? "")) index += 1;
		return index;
	}
	while (index < line.length && /[0-9_]/.test(line[index] ?? "")) index += 1;
	if (line[index] === "." && /[0-9]/.test(line[index + 1] ?? "")) {
		index += 1;
		while (index < line.length && /[0-9_]/.test(line[index] ?? "")) index += 1;
	}
	if ((line[index] ?? "").toLowerCase() === "e") {
		let probe = index + 1;
		if (line[probe] === "+" || line[probe] === "-") probe += 1;
		if (/[0-9]/.test(line[probe] ?? "")) {
			index = probe;
			while (index < line.length && /[0-9_]/.test(line[index] ?? "")) index += 1;
		}
	}
	return index;
}

/** The end of the string that opened before `from`, or -1 when it never closes. */
function findClose(line: string, from: number, close: string): number {
	let index = from;
	while (index < line.length) {
		const char = line[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (line.startsWith(close, index)) return index + close.length;
		index += 1;
	}
	return -1;
}

/** Which class a bare word takes: vocabulary first, then position. */
function classifyWord(word: string, after: string, rules: Grammar): TokenKind {
	if (rules.keywords.has(word)) return "keyword";
	if (rules.literals.has(word)) return "literal";
	if (rules.types.has(word)) return "type";
	if (rules.decorators && word.startsWith("@")) return "function";
	if (/^\s*\(/.test(after)) return "function";
	if (/^[A-Z]/.test(word)) return "type";
	return "plain";
}

/**
 * Classify a whole window of lines, carrying state from one to the next.
 * @param lines - the verbatim lines, in file order.
 * @param grammar - the grammar id, or `undefined` for plain.
 * @returns one token list per input line, in the same order.
 */
export function tokenizeLines(lines: readonly string[], grammar: string | undefined): readonly (readonly Token[])[] {
	const out: Array<readonly Token[]> = [];
	let state: ScanState = {};
	for (const line of lines) {
		const result = tokenizeLine(line, grammar, state);
		out.push(result.tokens);
		state = result.state;
	}
	return out;
}
