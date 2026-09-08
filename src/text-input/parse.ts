/**
 * Per-tool text-DSL parsers — bind the shared lexical core (core.ts) to the
 * four hashline tools and emit the canonical payload each tool's JSON
 * channel already accepts (payload equivalence is the parity contract of
 * spec #85).
 *
 * Primary payload = FIRST significant line (read=file_path, grep=pattern,
 * write=file_path, edit=default file). The DSL never writes the tool name.
 *
 * Two anchor spellings in edit:
 *   - require_line_content OFF: inline tokens `del 12:AbCd` /
 *     `replace 12:AbCd 34:eFgH` (anchors carry no spaces, safe to split);
 *     `lines` follows in a heredoc for ins/replace.
 *   - require_line_content ON: every anchor sits on its OWN line as a
 *     verbatim read row `12:AbCd: <current full line text>` — the read row
 *     order is `line:anchor: content` (2026-09-08 ruling), content may
 *     contain spaces/colons so it cannot share a line with other tokens.
 *
 * All errors are DslParseError (E_PARSE_*). Callers abort the whole call.
 *
 * @module dsh-hashline-edittool/text-input/parse
 */

import {
	DslParseError,
	DslScanner,
	HEREDOC_TOKEN,
	heredocLines,
	optionBoolean,
	optionNumber,
	parseOptionRow,
} from "./core.js";

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const READ_KEYS = new Set(["offset", "limit", "line_numbers"]);

export interface ParsedRead {
	file_path: string;
	offset?: number;
	limit?: number;
	line_numbers?: boolean;
}

/** Parse the read DSL payload → JSON-equivalent args (`file_path` + scalars). */
export function parseReadText(text: string): ParsedRead {
	const s = new DslScanner(text);
	const filePath = s.primary();
	const rows = s.options(READ_KEYS);
	const out: ParsedRead = { file_path: filePath! };
	for (const row of rows) {
		if (row.key === "offset") {
			const n = optionNumber(row);
			if (n !== undefined) out.offset = n;
		} else if (row.key === "limit") {
			const n = optionNumber(row);
			if (n !== undefined) out.limit = n;
		} else if (row.key === "line_numbers") {
			out.line_numbers = optionBoolean(row);
		}
	}
	if (!s.done) {
		throw new DslParseError(
			"E_PARSE_TRAILING",
			`[E_PARSE_TRAILING] Unexpected content after the read options at line ${s.lineNumber}: read accepts only the file path on the first line plus offset/limit/line_numbers option rows.`,
			s.lineNumber,
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GREP_KEYS = new Set(["path", "include", "regex", "context", "limit", "line_numbers"]);

export interface ParsedGrep {
	path?: string;
	include?: string;
	pattern: string;
	regex?: boolean;
	context?: number;
	limit?: number;
	line_numbers?: boolean;
}

/** Parse the grep DSL payload → JSON-equivalent args (pattern + scalars). */
export function parseGrepText(text: string): ParsedGrep {
	const s = new DslScanner(text);
	const pattern = s.primary();
	const rows = s.options(GREP_KEYS);
	const out: ParsedGrep = { pattern: pattern! };
	for (const row of rows) {
		if (row.key === "path") out.path = row.value;
		else if (row.key === "include") out.include = row.value;
		else if (row.key === "regex") out.regex = optionBoolean(row);
		else if (row.key === "context") {
			const n = optionNumber(row);
			if (n !== undefined) out.context = n;
		} else if (row.key === "limit") {
			const n = optionNumber(row);
			if (n !== undefined) out.limit = n;
		} else if (row.key === "line_numbers") {
			out.line_numbers = optionBoolean(row);
		}
	}
	if (!s.done) {
		throw new DslParseError(
			"E_PARSE_TRAILING",
			`[E_PARSE_TRAILING] Unexpected content after the grep options at line ${s.lineNumber}: grep accepts only the pattern on the first line plus path/include/regex/context/limit/line_numbers option rows.`,
			s.lineNumber,
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const WRITE_KEYS = new Set(["sandbox_permissions", "justification"]);

export interface ParsedWrite {
	file_path: string;
	content: string;
	sandbox_permissions?: string;
	justification?: string;
}

/** Parse the write DSL payload → JSON-equivalent args (file_path + heredoc body). */
export function parseWriteText(text: string): ParsedWrite {
	const s = new DslScanner(text);
	const filePath = s.primary();
	const rows = s.options(WRITE_KEYS);
	const out: ParsedWrite = { file_path: filePath!, content: "" };
	for (const row of rows) {
		if (row.key === "sandbox_permissions") out.sandbox_permissions = row.value;
		else if (row.key === "justification") out.justification = row.value;
	}
	if (!s.atHeredoc && !s.done) {
		throw new DslParseError(
			"E_PARSE_HEREDOC_EXPECTED",
			`[E_PARSE_HEREDOC_EXPECTED] Line ${s.lineNumber}: write content must follow inside a heredoc — open it with a standalone ${HEREDOC_TOKEN} row, write the file body, then close with ${HEREDOC_TOKEN}.`,
			s.lineNumber,
		);
	}
	if (s.atHeredoc) {
		const block = s.heredoc();
		out.content = block.content;
	}
	if (!s.done) {
		throw new DslParseError(
			"E_PARSE_TRAILING",
			`[E_PARSE_TRAILING] Unexpected content after the write heredoc at line ${s.lineNumber}.`,
			s.lineNumber,
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

const EDIT_KEYS = new Set(["line_numbers"]);
const OP_SET: ReadonlySet<string> = new Set(["ins", "del", "replace"]);

export interface ParsedEditItem {
	op: "ins" | "del" | "replace";
	anchor_start: string | { anchor: string; line: string };
	anchor_end?: string | { anchor: string; line: string };
	lines?: string[];
	path?: string;
}

export interface ParsedEdit {
	path?: string;
	edits: ParsedEditItem[];
	line_numbers?: boolean;
}

/** OFF-mode anchor token: bare Base62 or `<line>:<anchor>` — no spaces inside. */
const ANCHOR_TOKEN_RE = /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/;

/**
 * ON-mode declaration-row regexp for a configured separator. A verbatim
 * read row renders `<line><sep><anchor><sep> content` with the configured
 * separator (default `:`) plus a single space before the content (issue #83
 * keeps separators dynamic).
 */
function declRowRe(separator: string): RegExp {
	const esc = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*(\\d+)${esc}([A-Za-z0-9]{1,8})${esc} ([\\s\\S]*)$`);
}

function inlineAnchor(token: string): string {
	if (!ANCHOR_TOKEN_RE.test(token)) {
		throw new DslParseError(
			"E_PARSE_BAD_ANCHOR",
			`[E_PARSE_BAD_ANCHOR] Bad anchor "${token}": anchors are variable-length Base62 markers copied from a read/grep/diff row (optional \`<line>:\` prefix).`,
		);
	}
	return token;
}

function declaredAnchor(raw: string, declRe: RegExp): { anchor: string; line: string } {
	const m = declRe.exec(raw);
	if (!m) {
		throw new DslParseError(
			"E_PARSE_BAD_DECLARATION",
			`[E_PARSE_BAD_DECLARATION] Bad declared anchor "${raw}": with require_line_content enabled each anchor must be a verbatim read row \`<line>:<anchor>: <current full line text>\` on its own line.`,
		);
	}
	return { anchor: `${m[1]}:${m[2]}`, line: m[3]! };
}

function readLinesBlock(s: DslScanner): string[] | undefined {
	if (!s.atHeredoc) return undefined;
	const block = s.heredoc();
	return heredocLines(block.content);
}

function unknownOption(key: string, line: number): DslParseError {
	return new DslParseError(
		"E_PARSE_UNKNOWN_OPTION",
		`[E_PARSE_UNKNOWN_OPTION] Unknown option "${key}" at line ${line}: supported options: ${[...EDIT_KEYS].join(", ")}.`,
		line,
	);
}

export interface EditParseOptions {
	requireLineContent: boolean;
	/** Configured hashline separator (default `:`) used to read declaration rows. */
	separator?: string;
}

/**
 * Parse the edit DSL payload → JSON-equivalent args.
 *
 * Layout:
 *   [<default_path>]           optional first line = single-file shorthand
 *   line_numbers: true|false   optional option rows (before any @@ section)
 *   @@ <path>                  switch the target file for subsequent items
 *   <op> <anchor> [<anchor>]   OFF mode: inline anchors on the op line
 *   <<<END ... <<<END          lines block for ins/replace
 *
 * ON mode (require_line_content): op name alone on its line, then one or two
 * verbatim declaration rows (`12:AbCd: current text`) — one = anchor_start,
 * a second = anchor_end.
 *
 * Path folding follows ADR-0002 parity: a first-line default file becomes the
 * top-level `path`; items inside `@@` sections get per-item `path` only when
 * it differs from the top-level default (the JSON normalizer folds equal
 * paths the same way).
 */
export function parseEditText(text: string, opts: EditParseOptions): ParsedEdit {
	const { requireLineContent } = opts;
	const declRe = declRowRe(opts.separator ?? ":");
	const s = new DslScanner(text);
	const out: ParsedEdit = { edits: [] };
	let defaultPath: string | undefined;
	let currentPath: string | undefined;

	// ---- preamble: option rows + optional default file, in any order ----
	for (;;) {
		const row = s.next();
		if (row === undefined) break;
		const opt = parseOptionRow(row);
		if (opt !== undefined) {
			if (opt.key !== "line_numbers") throw unknownOption(opt.key, s.lineNumber);
			if (out.line_numbers !== undefined) {
				throw new DslParseError(
					"E_PARSE_DUP_OPTION",
					`[E_PARSE_DUP_OPTION] Option "${opt.key}" repeats at line ${s.lineNumber}.`,
					s.lineNumber,
				);
			}
			out.line_numbers = optionBoolean(opt);
			continue;
		}
		if (row.trimStart().startsWith("@@")) { s.pushBack(); break; }
		if (looksLikeOpLine(row, requireLineContent)) { s.pushBack(); break; }
		if (defaultPath !== undefined) {
			throw new DslParseError(
				"E_PARSE_BAD_OP",
				`[E_PARSE_BAD_OP] Line ${s.lineNumber}: expected ins/del/replace (or @@ <path>), got "${row.trim().split(/\s+/)[0]}". Each edit item is one op line: \`ins <anchor>\`, \`del <anchor> [<anchor_end>]\`, \`replace <anchor> [<anchor_end>]\`. Only ONE default file line is allowed, as the payload's first line.`,
				s.lineNumber,
			);
		}
		defaultPath = row.trim();
		currentPath = defaultPath;
	}

	// ---- body: @@ sections and items ----
	for (;;) {
		const line = s.next();
		if (line === undefined) break;
		const opt = parseOptionRow(line);
		if (opt !== undefined) {
			throw new DslParseError(
				"E_PARSE_UNKNOWN_OPTION",
				`[E_PARSE_UNKNOWN_OPTION] Option rows must come before the first edit item; unexpected "${opt.key}" at line ${s.lineNumber}.`,
				s.lineNumber,
			);
		}
		if (line.trimStart().startsWith("@@")) {
			const path = line.trimStart().slice(2).trim();
			if (path.length === 0) {
				throw new DslParseError(
					"E_PARSE_BAD_SECTION",
					`[E_PARSE_BAD_SECTION] Line ${s.lineNumber}: "@@" must be followed by a file path.`,
					s.lineNumber,
				);
			}
			currentPath = path;
			continue;
		}
		const item = requireLineContent
			? parseDeclItem(s, line, declRe)
			: parseInlineItem(s, line);
		assignItemPath(s, item, currentPath, defaultPath);
		out.edits.push(item);
	}

	if (out.edits.length === 0) {
		throw new DslParseError(
			"E_PARSE_EMPTY",
			"[E_PARSE_EMPTY] No edit items found: expected an optional default file on the first line, then edit items (`ins`/`del`/`replace` with anchors and optional heredoc lines) and optional `@@ <path>` file sections.",
		);
	}
	if (defaultPath !== undefined) out.path = defaultPath;
	return out;
}


function looksLikeOpLine(line: string, requireLineContent: boolean): boolean {
	const parts = line.trim().split(/\s+/);
	const op = parts[0] ?? "";
	if (!OP_SET.has(op)) return false;
	// A path line never starts with an op keyword; OFF-mode op lines may
	// carry inline anchors, ON-mode op lines are bare.
	if (requireLineContent) return parts.length === 1;
	return parts.length >= 1;
}

/**
 * OFF mode: one op line with inline anchors (token-split; anchors have no
 * spaces), optional heredoc lines block for ins/replace.
 */
function parseInlineItem(s: DslScanner, line: string): ParsedEditItem {
	const parts = line.trim().split(/\s+/);
	const [opRaw, a1, a2] = parts;
	if (!OP_SET.has(opRaw ?? "")) {
		throw new DslParseError(
			"E_PARSE_BAD_OP",
			`[E_PARSE_BAD_OP] Line ${s.lineNumber}: expected ins/del/replace, got "${opRaw}". Each edit item is one op line: \`ins <anchor>\`, \`del <anchor> [<anchor_end>]\`, \`replace <anchor> [<anchor_end>]\`, followed by an optional heredoc block of new lines.`,
			s.lineNumber,
		);
	}
	const op = opRaw as "ins" | "del" | "replace";
	if (a1 === undefined) {
		throw new DslParseError(
			"E_PARSE_MISSING_ANCHOR",
			`[E_PARSE_MISSING_ANCHOR] Line ${s.lineNumber}: ${op} requires an anchor_start token copied from a read row.`,
			s.lineNumber,
		);
	}
	const item: ParsedEditItem = { op, anchor_start: inlineAnchor(a1) };
	if (a2 !== undefined) item.anchor_end = inlineAnchor(a2);
	if (op === "ins" || op === "replace") {
		const lines = readLinesBlock(s);
		if (lines === undefined) {
			throw new DslParseError(
				"E_PARSE_HEREDOC_EXPECTED",
				`[E_PARSE_HEREDOC_EXPECTED] Line ${s.lineNumber}: ${op} requires a heredoc block of replacement lines — open it with a standalone ${HEREDOC_TOKEN} row after the op line.`,
				s.lineNumber,
			);
		}
		item.lines = lines;
	} else if (s.atHeredoc) {
		s.heredoc(); // del: heredoc accepted and ignored (JSON parity)
	}
	return item;
}

/**
 * ON mode: bare op line, then one or two declaration rows (verbatim read
 * rows), then an optional heredoc lines block.
 */
function parseDeclItem(s: DslScanner, line: string, declRe: RegExp): ParsedEditItem {
	const opRaw = line.trim();
	if (!OP_SET.has(opRaw)) {
		throw new DslParseError(
			"E_PARSE_BAD_OP",
			`[E_PARSE_BAD_OP] Line ${s.lineNumber}: expected a bare ins/del/replace op line (anchors follow on their own lines as verbatim read rows).`,
			s.lineNumber,
		);
	}
	const op = opRaw as "ins" | "del" | "replace";
	const firstAnchor = s.next();
	if (firstAnchor === undefined || !declRe.test(firstAnchor)) {
		throw new DslParseError(
			"E_PARSE_MISSING_ANCHOR",
			`[E_PARSE_MISSING_ANCHOR] Line ${s.lineNumber}: ${op} requires an anchor_start declaration row (\`<line>:<anchor>: <current full line text>\`) after the op line.`,
			s.lineNumber,
		);
	}
	// A second declaration row directly after is the anchor_end; anything
	// else (heredoc opener, next op, @@) gets pushed back.
	const lookahead = s.next();
	let second: string | undefined;
	if (lookahead !== undefined && declRe.test(lookahead)) {
		second = lookahead;
	} else if (lookahead !== undefined) {
		s.pushBack();
	}
	const item: ParsedEditItem = { op, anchor_start: declaredAnchor(firstAnchor, declRe) };
	if (second !== undefined) item.anchor_end = declaredAnchor(second, declRe);
	if (op === "ins" || op === "replace") {
		const lines = readLinesBlock(s);
		if (lines === undefined) {
			throw new DslParseError(
				"E_PARSE_HEREDOC_EXPECTED",
				`[E_PARSE_HEREDOC_EXPECTED] Line ${s.lineNumber}: ${op} requires a heredoc block of replacement lines after the anchor declarations.`,
				s.lineNumber,
			);
		}
		item.lines = lines;
	} else if (s.atHeredoc) {
		s.heredoc(); // del: ignored, JSON parity
	}
	return item;
}

/** ADR-0002 parity: item carries per-item path only when it differs from the top-level default. */
function assignItemPath(
	s: DslScanner,
	item: ParsedEditItem,
	currentPath: string | undefined,
	defaultPath: string | undefined,
): void {
	if (currentPath === undefined) {
		throw new DslParseError(
			"E_PARSE_NO_FILE",
			`[E_PARSE_NO_FILE] Line ${s.lineNumber}: an edit item needs a target file — put the default file on the first line or switch with \`@@ <path>\` before this item.`,
			s.lineNumber,
		);
	}
	if (currentPath !== defaultPath) item.path = currentPath;
}
