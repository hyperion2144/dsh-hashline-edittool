/**
 * text-input shared lexical core — the line grammar every text-DSL tool
 * payload shares.
 *
 * #53 / spec #85: one grammar-core for all four tools:
 *   - the payload's FIRST significant line is the primary payload
 *     (read=file, grep=pattern, write=file, edit=default file)
 *   - following lines are `key: value` option rows, `#` comment rows,
 *     or heredoc blocks opened/closed by a standalone `<<<END` line
 *   - inside a heredoc block nothing is parsed (no options/comments)
 *   - the DSL never writes the tool name — the tool name is the call
 *     symbol, not a payload prefix
 *
 * Parsing is strict: any malformed construct throws an `E_PARSE_*` error
 * carrying the offending 1-based line, what was expected, and what was
 * found — the model is expected to self-correct from the echo. Callers
 * must abort the whole tool call on any parse error (batch atomicity,
 * mirroring `E_BATCH_ABORT` on the JSON channel).
 *
 * @module dsh-hashline-edittool/text-input/core
 */

/** The one heredoc sentinel shared by every tool (spec #85). */
export const HEREDOC_TOKEN = "<<<END";

/** A parsed `key: value` option row. */
export interface OptionRow {
	key: string;
	value: string;
	/** 1-based line number in the original payload text. */
	line: number;
}

/** A parsed heredoc block (content between the two `<<<END` rows). */
export interface HeredocBlock {
	content: string;
	/** 1-based line of the opening `<<<END`. */
	openLine: number;
	/** 1-based line of the closing `<<<END`. */
	closeLine: number;
}

/** Error type for text-DSL parse failures. `code` is one of the E_PARSE_* set. */
export class DslParseError extends Error {
	readonly code: string;
	/** 1-based line the error points at, when known. */
	readonly line?: number;

	constructor(code: string, message: string, line?: number) {
		super(message);
		this.name = "DslParseError";
		this.code = code;
		if (line !== undefined) this.line = line;
	}
}

/** True when the line is a `#` comment row (leading whitespace tolerated). */
export function isCommentRow(line: string): boolean {
	return line.trimStart().startsWith("#");
}

/** True when the line is a standalone heredoc sentinel row. */
export function isHeredocRow(line: string): boolean {
	return line.trimEnd() === HEREDOC_TOKEN;
}

/** Split payload text into raw lines (no trailing-empty artifact on EOF newline). */
export function splitDslLines(text: string): string[] {
	const raw = text.split("\n");
	if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
	return raw;
}

const OPTION_RE = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/;

/** Parse a `key: value` option row. Returns undefined when not an option row. */
export function parseOptionRow(line: string): { key: string; value: string } | undefined {
	if (isCommentRow(line) || isHeredocRow(line)) return undefined;
	const m = OPTION_RE.exec(line);
	if (!m) return undefined;
	return { key: m[1]!, value: m[2] ?? "" };
}

/**
 * Sequential scanner over split DSL lines. Callers step through rows; the
 * scanner skips blank and comment rows automatically on each advance.
 */
export class DslScanner {
	private readonly lines: string[];
	private pos = 0;

	constructor(text: string) {
		this.lines = splitDslLines(text);
	}

	/** Raw 1-based line number of the current row. */
	get lineNumber(): number {
		return this.pos + 1;
	}

	get done(): boolean {
		return this.pos >= this.lines.length;
	}

	/** Advance to the next non-blank, non-comment row; returns its raw text or undefined at EOF. */
	next(): string | undefined {
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos]!;
			this.pos += 1;
			if (line.trim() === "" || isCommentRow(line)) continue;
			return line;
		}
		return undefined;
	}

	/**
	 * Read the FIRST significant row as the primary payload (required unless
	 * `optional`). Throws `E_PARSE_EMPTY` when no significant row exists.
	 */
	primary(optional = false): string | undefined {
		const line = this.next();
		if (line === undefined && !optional) {
			throw new DslParseError(
				"E_PARSE_EMPTY",
				`[E_PARSE_EMPTY] No payload found: expected a first line holding the primary value (file path, pattern, or default file), then optional \`key: value\` option rows and heredoc blocks.`,
				1,
			);
		}
		return line;
	}

	/**
	 * Read option rows until the first non-option row (or EOF). Unknown keys
	 * are rejected here via `knownKeys` (when given) with
	 * `E_PARSE_UNKNOWN_OPTION`. Returns the option rows and leaves the
	 * scanner positioned at the first non-option row.
	 */
	options(knownKeys?: ReadonlySet<string>): OptionRow[] {
		const out: OptionRow[] = [];
		for (;;) {
			const line = this.next();
			if (line === undefined) return out;
			const opt = parseOptionRow(line);
			if (opt === undefined) {
				// Not an option row — push back for the caller (heredoc/ops).
				this.pos -= 1;
				return out;
			}
			if (knownKeys !== undefined && !knownKeys.has(opt.key)) {
				throw new DslParseError(
					"E_PARSE_UNKNOWN_OPTION",
					`[E_PARSE_UNKNOWN_OPTION] Unknown option "${opt.key}" at line ${this.pos}: supported options: ${[...knownKeys].join(", ")}.`,
					this.pos,
				);
			}
			out.push({ key: opt.key, value: opt.value, line: this.pos });
		}
	}

	/**
	 * Consume a heredoc block when the scanner currently sits on the opening
	 * `<<<END` row. Returns the block, positioned after its closing row.
	 * Throws `E_PARSE_HEREDOC_UNTERMINATED` when no closing row is found.
	 */
	heredoc(): HeredocBlock {
		const openLine = this.pos + 1;
		const first = this.lines[this.pos];
		if (first === undefined || !isHeredocRow(first)) {
			throw new DslParseError(
				"E_PARSE_HEREDOC_EXPECTED",
				`[E_PARSE_HEREDOC_EXPECTED] Line ${openLine} must open a heredoc with a standalone ${HEREDOC_TOKEN} row when a multi-line block is required.`,
				openLine,
			);
		}
		this.pos += 1; // consume opener
		const bodyStart = this.pos;
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos]!;
			if (isHeredocRow(line)) {
				const body = this.lines.slice(bodyStart, this.pos).join("\n");
				this.pos += 1; // consume closer
				return { content: body, openLine, closeLine: this.pos };
			}
			this.pos += 1;
		}
		throw new DslParseError(
			"E_PARSE_HEREDOC_UNTERMINATED",
			`[E_PARSE_HEREDOC_UNTERMINATED] Heredoc opened at line ${openLine} never closes: add a standalone ${HEREDOC_TOKEN} row after the block content.`,
			openLine,
		);
	}

	/** True when the next raw row is a heredoc opener (position kept). */
	get atHeredoc(): boolean {
		const line = this.lines[this.pos];
		return line !== undefined && isHeredocRow(line);
	}

	/** Step back one raw row (the caller re-reads it). Never goes before row 1. */
	pushBack(): void {
		this.pos = Math.max(0, this.pos - 1);
	}

}

/** Convert a raw option value into a typed scalar. Throws `E_PARSE_OPTION_VALUE`. */
export function optionNumber(row: { key: string; value: string; line?: number }): number | undefined {
	if (row.value.trim() === "") return undefined;
	const n = Number(row.value);
	if (!Number.isFinite(n)) {
		throw new DslParseError(
			"E_PARSE_OPTION_VALUE",
			`[E_PARSE_OPTION_VALUE] Option "${row.key}" expects a number, got "${row.value}" (line ${row.line ?? "?"}).`,
			row.line,
		);
	}
	return n;
}

/** Parse a boolean option value; empty = true (flag style `regex:`). */
export function optionBoolean(row: { key: string; value: string; line?: number }): boolean {
	const v = row.value.trim();
	if (v === "" || v === "true") return true;
	if (v === "false") return false;
	throw new DslParseError(
		"E_PARSE_OPTION_VALUE",
		`[E_PARSE_OPTION_VALUE] Option "${row.key}" expects true/false (or bare), got "${row.value}" (line ${row.line ?? "?"}).`,
		row.line,
	);
}

/** Split a heredoc body into lines, mirroring splitLines semantics. */
export function heredocLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}
