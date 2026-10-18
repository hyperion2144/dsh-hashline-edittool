/**
 * Inferring formatting options from the document itself.
 *
 * LSP formatting requests carry `FormattingOptions` (`insertSpaces`,
 * `tabSize`, …), and a server formats to THEM — hand a tab-indented file's
 * server `{ insertSpaces: true, tabSize: 4 }` and it re-indents the whole
 * file to spaces. The plugin does not read an editor config by default
 * (`format.editorconfig` is opt-in, G3): the file itself is the cheapest
 * honest witness, so this module asks it.
 *
 * The heuristic is deliberately small (G1): leading whitespace of every
 * non-blank line, tab-led vs space-led. A decisive tab majority says tabs;
 * otherwise the most common leading-space width among 2/4/8 wins; anything
 * ambiguous falls back to the JSON-ish default `{ insertSpaces: true,
 * tabSize: 4 }`. It replaces the fixed `{ tabSize: 4, insertSpaces: true }`
 * the auto-diagnostics path used before map #275 — G1 explicitly superseded
 * that.
 *
 * @module dsh-hashline-edittool/lsp/format/indent
 */

/** The two options every formatter request must carry. */
export interface IndentOptions {
	readonly insertSpaces: boolean;
	readonly tabSize: number;
}

/** The fallback when the file's own whitespace is inconclusive. */
export const DEFAULT_INDENT_OPTIONS: IndentOptions = { insertSpaces: true, tabSize: 4 };

/** The space widths the heuristic is willing to name (editorconfig's usual set). */
const CANDIDATE_WIDTHS = [2, 4, 8] as const;

/**
 * Infer `FormattingOptions` from a document's leading whitespace.
 *
 * A line led by a TAB counts for tabs; a line led by spaces counts its
 * leading-space run. Mixed lines count for their first character — that is
 * the honest read of a file that mixes, and mixed files are ambiguous for
 * every tool that reads them.
 *
 * @param text - LF-normalized text (the read line space; the line split
 *   here matches `splitLines`).
 */
export function inferIndentOptions(text: string): IndentOptions {
	let tabLines = 0;
	const widths = new Map<number, number>();
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		if (line.charCodeAt(0) === 9) {
			tabLines += 1;
			continue;
		}
		let width = 0;
		while (width < line.length && line.charCodeAt(width) === 32) width += 1;
		// Only a line that IS indented is evidence: the unindented majority of
		// most files would otherwise drown the signal out.
		if (width > 0 && width < line.length) {
			widths.set(width, (widths.get(width) ?? 0) + 1);
		}
	}
	const spaceLines = [...widths.values()].reduce((sum, n) => sum + n, 0);
	if (tabLines > 0 && tabLines >= spaceLines) {
		// `tabSize` still travels (servers may use it for alignment math); 4 is
		// the conventional display width and carries no re-indent risk when
		// `insertSpaces` is false.
		return { insertSpaces: false, tabSize: 4 };
	}
	let bestWidth = 0;
	let bestCount = 0;
	for (const [width, count] of widths) {
		if (count > bestCount) {
			bestWidth = width;
			bestCount = count;
		}
	}
	if (bestCount === 0) return DEFAULT_INDENT_OPTIONS;
	// The file's dominant width may fall outside the conventional set (a 3-space
	// file): snap to the nearest candidate, ties toward 4.
	let chosen: number = CANDIDATE_WIDTHS[2];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of CANDIDATE_WIDTHS) {
		const distance = Math.abs(candidate - bestWidth);
		if (distance < bestDistance || (distance === bestDistance && candidate === 4)) {
			chosen = candidate;
			bestDistance = distance;
		}
	}
	return { insertSpaces: true, tabSize: chosen };
}
