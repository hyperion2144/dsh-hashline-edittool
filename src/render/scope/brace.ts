/**
 * The brace family: the blocks a language that opens and closes with braces
 * has.
 *
 * The algorithm is the one the detector has always used:
 *
 *  - the scanner masks out the braces that live inside a string, a template,
 *    a regular expression or a comment, and pairs the rest with a stack;
 *  - every block is classified from the statement in front of its `{`
 *    (function, method, class, type, control flow, or an anonymous block);
 *  - a signature that spans several lines is traced back to the line the
 *    declaration started on, so `function myersRange(\n a: Int32Array,\n)` is
 *    still attributed to `myersRange`.
 *
 * What changed with the language table is the DECLARATION reading: the block
 * boundaries are the same, but the statement in front of the brace is now read
 * with the rules of the language's own group — a Go `func foo()` and a Java
 * `public void foo()` are named, where the TypeScript reading named nothing.
 *
 * @module dsh-hashline-edittool/render/scope/brace
 */
import { classifyDeclaration, isControlStatement, isParenBalanced } from "./patterns.js";
import { scanSource, type BraceToken } from "./scanner.js";
import type { ScopeInfo, ScopeKind, ScopePatternGroup } from "./types.js";

/**
 * How far up the file a multi-line signature may reach.
 *
 * A signature is a handful of lines (parameters, return type); forty is a
 * generous ceiling that still stops a runaway walk from scanning the whole
 * file for every block.
 */
const MAX_DECLARATION_LINES = 40;

/** A block that has been opened but not yet closed. */
interface OpenScope {
	readonly kind: ScopeKind;
	readonly name: string;
	readonly header: string;
	readonly startLine: number;
	/** The text the name was read from — the statement head of the block. */
	readonly headText: string;
}

/**
 * The block that closed on the line a new block opens on.
 *
 * A statement can continue after the previous block closed — a function whose
 * return type is an object literal does exactly that:
 *
 * ```ts
 * export async function load(): Promise<{ home: string }> {
 * ```
 *
 * The `{` of the type literal and the `{` of the function body share a line,
 * and only the first one names the function.
 */
interface ScopePrefix {
	/** The line the previous block closed on. */
	readonly line: number;
	/** The text the previous block's name was read from. */
	readonly text: string;
	/** The previous block's declaration line. */
	readonly header: string;
	/** The line the previous block started on. */
	readonly startLine: number;
}

/** A classified head: the match and the text it was read from. */
interface HeadMatch {
	readonly match: { kind: ScopeKind; name: string };
	readonly text: string;
}

/**
 * The statement head in front of a brace.
 *
 * Two candidates are offered, because a line can hold two braces:
 * `function f() { const o = {` — the second brace belongs to the object
 * literal, not to the function. The `tail` is the text after the last `}`
 * (the previous block's closer), the `full` head is the whole text.
 *
 * @param maskedLine - the masked source line.
 * @param column - the column of the brace.
 * @returns the two head candidates.
 */
function headCandidates(maskedLine: string, column: number): { tail: string; full: string } {
	const before = maskedLine.slice(0, column);
	// A leading `}` closes the PREVIOUS block — the text after it is this
	// block's own statement ("} else {", "} catch (e) {").
	const withoutCloser = before.startsWith("}") ? before.slice(1) : before;
	return { tail: tailOf(withoutCloser), full: withoutCloser.trim() };
}

/**
 * The text after the previous block's closing brace.
 *
 * A line can hold two braces — `function f() { const o = {` — and the second
 * one belongs to the object literal, not to the function. The text after the
 * last `}` is the statement the block belongs to.
 *
 * @param text - the statement head.
 * @returns the tail of the head.
 */
function tailOf(text: string): string {
	const lastCloser = text.lastIndexOf("}");
	return (lastCloser === -1 ? text : text.slice(lastCloser + 1)).trim();
}

/**
 * Classify a head, preferring the text after the previous block's closer.
 *
 * @param tail - the head's tail.
 * @param full - the whole head.
 * @param group - the declaration table to read the head with.
 * @param parentKind - the kind of the enclosing block.
 * @returns the match and the text it came from, or `undefined`.
 */
function classifyHeads(
	tail: string,
	full: string,
	group: ScopePatternGroup,
	parentKind: ScopeKind,
): HeadMatch | undefined {
	const tailMatch = classifyDeclaration(tail, group, parentKind);
	if (tailMatch) return { match: tailMatch, text: tail };
	const fullMatch = classifyDeclaration(full, group, parentKind);
	if (fullMatch) return { match: fullMatch, text: full };
	return undefined;
}

/**
 * The net brace change of every line.
 *
 * @param braces - the code braces.
 * @param lineCount - the number of lines in the file.
 * @returns one delta per line (`{` minus `}`).
 */
function braceDeltas(braces: readonly BraceToken[], lineCount: number): number[] {
	const deltas = new Array<number>(lineCount).fill(0);
	for (const brace of braces) {
		const index = brace.line - 1;
		if (index < 0 || index >= lineCount) continue;
		deltas[index] = (deltas[index] ?? 0) + (brace.open ? 1 : -1);
	}
	return deltas;
}

/**
 * Trace a multi-line signature back to its declaration line.
 *
 * The line that carries the `{` of a multi-line signature cannot name the
 * symbol itself — `): Run[] | undefined {` says nothing about `myersRange`.
 * The declaration is found by walking up over the lines of the signature
 * (which carry no braces of their own) until the accumulated text reads as
 * a declaration.
 *
 * @param head - the statement head in front of the brace.
 * @param braceLine - the 1-indexed line the brace sits on.
 * @param maskedLines - the masked source lines.
 * @param sourceLines - the source lines.
 * @param deltas - the per-line brace deltas.
 * @param group - the declaration table to read the heads with.
 * @param parentKind - the kind of the enclosing block.
 * @param prefix - the block that closed on this very line, if any.
 * @returns the scope's kind, name, header and start line, or `undefined`.
 */
function findDeclaration(
	head: string,
	braceLine: number,
	maskedLines: readonly string[],
	sourceLines: readonly string[],
	deltas: readonly number[],
	group: ScopePatternGroup,
	parentKind: ScopeKind,
	prefix: ScopePrefix | undefined,
): OpenScope | undefined {
	// The statement may continue the block that closed on this very line.
	let accumulated = prefix === undefined ? head : `${prefix.text} ${head}`;
	let startLine = prefix === undefined ? braceLine : prefix.startLine;
	const continuedHeader =
		prefix === undefined ? (sourceLines[braceLine - 1] ?? "").trim() : prefix.header;
	const initial = classifyHeads(tailOf(accumulated), accumulated, group, parentKind);
	if (initial) {
		return {
			kind: initial.match.kind,
			name: initial.match.name,
			header: continuedHeader,
			startLine,
			headText: initial.text,
		};
	}

	const floor = Math.max(1, braceLine - MAX_DECLARATION_LINES);
	for (let line = braceLine - 1; line >= floor; line--) {
		const masked = maskedLines[line - 1] ?? "";
		const trimmed = masked.trim();
		if (trimmed === "") continue;
		// A brace between here and the declaration means the signature is
		// not this block's — it belongs to a nested one.
		if ((deltas[line - 1] ?? 0) !== 0) break;
		// A statement boundary means the signature is over.
		if (trimmed.includes(";")) break;
		// Control flow owns its block. A condition that spans several lines
		// ("if (\n a &&\n b\n) {") is still the control's own block, and it is
		// told apart by the parentheses balancing out; an unbalanced one is a
		// different statement that merely follows the control flow.
		const control = isControlStatement(trimmed, group);
		if (control && !isParenBalanced(`${trimmed} ${accumulated}`)) break;
		accumulated = `${trimmed} ${accumulated}`;
		startLine = line;
		const match = classifyHeads(tailOf(accumulated), accumulated, group, parentKind);
		if (match) {
			return {
				kind: match.match.kind,
				name: match.match.name,
				header: (sourceLines[startLine - 1] ?? "").trim(),
				startLine,
				headText: match.text,
			};
		}
		if (control) break;
	}
	return undefined;
}

/**
 * Scan a source text and report every block it contains.
 *
 * The result is a pure function of the text: no file is read, no parser is
 * consulted, no dependency is loaded. A block that cannot be named is still
 * reported — with an empty name and the kind `block`.
 *
 * @param text - the source text.
 * @param group - the declaration table to read the statements with.
 * @returns the scopes, outermost first (a nested scope follows its parent).
 */
export function detectScopesBrace(text: string, group: ScopePatternGroup): ScopeInfo[] {
	const sourceLines = text.split("\n");
	// Rust's lifetime (`'a`) opens neither a string nor a char literal.
	const { maskedLines, braces } = scanSource(text, { lifetimes: group === "rust" });
	const deltas = braceDeltas(braces, sourceLines.length);
	const scopes: ScopeInfo[] = [];
	const stack: OpenScope[] = [];
	// The block that closed on the line the next block opens on.
	let prefix: ScopePrefix | undefined;

	for (const brace of braces) {
		if (brace.open) {
			const parentKind = stack.length > 0 ? stack[stack.length - 1]!.kind : "block";
			const maskedLine = maskedLines[brace.line - 1] ?? "";
			const { tail, full } = headCandidates(maskedLine, brace.column);
			const header = (sourceLines[brace.line - 1] ?? "").trim();
			const direct = classifyHeads(tail, full, group, parentKind);
			if (direct) {
				stack.push({
					kind: direct.match.kind,
					name: direct.match.name,
					header,
					startLine: brace.line,
					headText: direct.text,
				});
				continue;
			}
			// Not a declaration on this line. The statement may still be
			// continuing the block that closed on this very line (a function
			// whose return type is an object literal), or the signature may
			// start a few lines above.
			const found = findDeclaration(
				full,
				brace.line,
				maskedLines,
				sourceLines,
				deltas,
				group,
				parentKind,
				prefix !== undefined && prefix.line === brace.line ? prefix : undefined,
			);
			stack.push(
				found ?? { kind: "block", name: "", header, startLine: brace.line, headText: full },
			);
			continue;
		}
		const opened = stack.pop();
		if (opened === undefined) continue;
		scopes.push({ ...opened, endLine: brace.line });
		// A block that opens on this line continues this statement.
		prefix = {
			line: brace.line,
			text: opened.headText,
			header: opened.header,
			startLine: opened.startLine,
		};
	}

	// A block that was never closed (a truncated file, a partial edit) runs
	// to the end of the file.
	const lastLine = sourceLines.length;
	while (stack.length > 0) {
		const opened = stack.pop()!;
		scopes.push({ ...opened, endLine: lastLine });
	}

	return scopes.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
