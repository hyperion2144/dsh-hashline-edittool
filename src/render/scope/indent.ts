/**
 * The indent family: the blocks of a language that ends a block by DEDENTING.
 *
 * Python and Ruby have no closing brace. A block runs from its `def` / `class`
 * line to the line before the next non-empty line that is not indented deeper
 * than the declaration — Python's own rule for where a suite ends. Blank lines
 * never end a block: they are skipped while the boundary is looked for.
 *
 * The boundary is a rule of the LANGUAGE, not of the detector, so it is
 * spelled out once here and shared by every language of the family.
 *
 * @module dsh-hashline-edittool/render/scope/indent
 */
import { classifyDeclaration } from "./patterns.js";
import type { ScopeInfo, ScopePatternGroup } from "./types.js";

/**
 * The width of a tab, in columns.
 *
 * Python's own rule: a tab advances to the next multiple of eight, so a file
 * indented with tabs and a file indented with four spaces compare the same way.
 */
const TAB_WIDTH = 8;

/**
 * The indentation of a line, in columns.
 *
 * @param line - the source line.
 * @returns the number of leading columns.
 */
function indentWidth(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += TAB_WIDTH - (width % TAB_WIDTH);
		else break;
	}
	return width;
}

/**
 * Is this the `end` that closes a Ruby block?
 *
 * Ruby's block ends with an `end` at the declaration's own indentation, and
 * that `end` belongs to the block — so the block reaches one line further
 * than Python's rule would say.
 *
 * @param line - the source line.
 * @returns whether the line is Ruby's closing `end`.
 */
function isRubyEnd(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "end" || trimmed.startsWith("end ");
}

/**
 * The last line of the block that starts on `startIndex`.
 *
 * @param lines - the source lines.
 * @param startIndex - the 0-indexed line the declaration is on.
 * @param indent - the declaration's indentation.
 * @param group - the declaration table the language is read with.
 * @returns the 1-indexed last line of the block.
 */
function blockEnd(
	lines: readonly string[],
	startIndex: number,
	indent: number,
	group: ScopePatternGroup,
): number {
	for (let index = startIndex + 1; index < lines.length; index++) {
		const line = lines[index]!;
		// A blank line is not a statement: it neither ends a block nor is one.
		if (line.trim() === "") continue;
		// A deeper line is still inside the block.
		if (indentWidth(line) > indent) continue;
		// The boundary line itself is not part of the block — except in Ruby,
		// where the boundary is the `end` that closes it.
		if (group === "ruby" && isRubyEnd(line)) return index + 1;
		return index;
	}
	return lines.length;
}

/**
 * Scan a source text and report every block it contains.
 *
 * A block it cannot name is not reported at all: in an indented language a
 * block IS a declaration, and a block without a name has nothing to say.
 *
 * @param text - the source text.
 * @param group - the declaration table to read the statements with.
 * @returns the scopes, outermost first (a nested scope follows its parent).
 */
export function detectScopesIndent(text: string, group: ScopePatternGroup): ScopeInfo[] {
	const lines = text.split("\n");
	const scopes: ScopeInfo[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const match = classifyDeclaration(trimmed, group);
		if (match === undefined) continue;
		scopes.push({
			kind: match.kind,
			name: match.name,
			header: trimmed,
			startLine: index + 1,
			endLine: blockEnd(lines, index, indentWidth(line), group),
		});
	}
	return scopes.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
