/**
 * Inferring formatting options from the document itself.
 *
 * LSP formatting requests carry `FormattingOptions` (`insertSpaces`,
 * `tabSize`, …), and a server formats to THEM — hand a tab-indented file's
 * server `{ insertSpaces: true, tabSize: 4 }` and it re-indents the whole
 * file to spaces. A project's `.editorconfig` outranks the file and is on by
 * default (`format.editorconfig`, #336); the file itself is the fallback
 * witness, so this module asks it.
 *
 * The unit is read from the file's structure, not its absolute widths (#336):
 * in a deep 4-space file the most common leading width is 8 — that is the
 * nesting depth, not the unit. Two readings are cross-checked: the most
 * common step between consecutive lines, and the grid the repeated widths
 * share. The larger reading that divides the observed indentation wins, so a
 * single badly indented line cannot redefine the unit (#336 review). Files
 * that clear neither reading keep the old dominant-width snap among 2/4/8;
 * anything unconvincing is the JSON-ish default `{ insertSpaces: true,
 * tabSize: 4 }`.
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

/** Widths the fallback (no usable step) snaps a dominant width to. */
const CANDIDATE_WIDTHS = [2, 4, 8] as const;

/** A step outside this band cannot be a formatter's indentation unit. */
const MIN_UNIT = 2;
const MAX_UNIT = 8;

/**
 * Infer `FormattingOptions` from a document's leading whitespace.
 *
 * A line led by a TAB counts for tabs; a line led by spaces contributes its
 * leading-space run. Mixed lines count for their first character — that is
 * the honest read of a file that mixes, and mixed files are ambiguous for
 * every tool that reads them.
 *
 * @param text - LF-normalized text (the read line space; the line split
 *   here matches `splitLines`).
 */
export function inferIndentOptions(text: string): IndentOptions {
	let tabLines = 0;
	// Leading widths of the space-led, non-blank lines, in document order.
	const widths: number[] = [];
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
		if (width > 0 && width < line.length) widths.push(width);
	}
	if (tabLines > 0 && tabLines >= widths.length) {
		// `tabSize` still travels (servers may use it for alignment math); 4 is
		// the conventional display width and carries no re-indent risk when
		// `insertSpaces` is false.
		return { insertSpaces: false, tabSize: 4 };
	}
	if (widths.length === 0) return DEFAULT_INDENT_OPTIONS;
	// The unit is how far one level indents, never how deep the file nests
	// (#336). Two readings are cross-checked; see inferUnit().
	const unit = inferUnit(widths);
	if (unit !== undefined) return { insertSpaces: true, tabSize: unit };
	// Neither reading clears the grid: a lone 1-space indent, or widths that
	// share no usable grid. Keep the pre-#336 dominant-width snap.
	return { insertSpaces: true, tabSize: snapToCandidate(dominantWidth(widths)) };
}

/**
 * The indentation unit, or `undefined` when no reading is convincing.
 *
 * Two independent readings are taken and screened against the same grid:
 * - `stepUnit` — the most common positive step between consecutive lines;
 * - `gridUnit` — the GCD of the widths that occur more than once.
 *
 * The larger survivor wins. A single line indented at the wrong width is what
 * these readings take turns surviving: it can make a small step look like the
 * unit (so the step reading under-reads, #336 review), and it can join the
 * repeated widths and drag their GCD down (so the grid reading under-reads
 * too) — but it cannot inflate either one. Choosing the larger on-grid
 * reading keeps the file's real grid: a 4-space file with one 6-space line
 * still reads 4, while an 8-space file with one 2-space line reads 8.
 *
 * "On the grid" means the reading divides at least four in five indented
 * widths: a few hand-aligned continuations are tolerated, a mostly off-grid
 * file is not a file this reading can describe.
 */
function inferUnit(widths: readonly number[]): number | undefined {
	let unit = 0;
	for (const candidate of [stepUnit(widths), gridUnit(widths)]) {
		if (candidate === undefined || candidate < MIN_UNIT || candidate > MAX_UNIT) continue;
		if (!onGrid(widths, candidate)) continue;
		if (candidate > unit) unit = candidate;
	}
	return unit === 0 ? undefined : unit;
}

/**
 * The most common positive leading-width step between consecutive lines.
 *
 * A step is the difference in leading width between consecutive non-blank,
 * space-led lines. Only positive steps are evidence: a level boundary moves
 * one unit, while zeros (same level) and negative steps (dedent) say nothing
 * about its size. Ties go to the smaller step: one level is the repeated
 * shape, while a multi-level jump can tie with it without being the unit.
 */
function stepUnit(widths: readonly number[]): number | undefined {
	const steps = new Map<number, number>();
	for (let index = 1; index < widths.length; index += 1) {
		const step = widths[index]! - widths[index - 1]!;
		if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
	}
	let unit = 0;
	let count = 0;
	for (const [step, seen] of steps) {
		if (seen > count || (seen === count && unit > 0 && step < unit)) {
			unit = step;
			count = seen;
		}
	}
	return unit === 0 ? undefined : unit;
}

/**
 * The grid shared by widths that occur more than once, or `undefined` when
 * none does.
 *
 * Repeated widths describe levels the file actually uses; a one-off width is
 * at least as likely to be a hand alignment as a level. Their GCD is the
 * finest grid those levels share — 4 for a 4-space file even when every line
 * sits two or three levels deep.
 */
function gridUnit(widths: readonly number[]): number | undefined {
	const counts = new Map<number, number>();
	for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
	let grid = 0;
	for (const [width, count] of counts) {
		if (count > 1) grid = gcd(grid, width);
	}
	return grid === 0 ? undefined : grid;
}

/** The greatest common divisor of two non-negative integers. */
function gcd(left: number, right: number): number {
	let a = left;
	let b = right;
	while (b !== 0) {
		const next = a % b;
		a = b;
		b = next;
	}
	return a;
}

/** Whether `unit` divides at least four in five of the indented widths. */
function onGrid(widths: readonly number[], unit: number): boolean {
	let off = 0;
	for (const width of widths) {
		if (width % unit !== 0) off += 1;
	}
	return off * 5 <= widths.length;
}

/** The width that appears most often (smallest on a tie). */
function dominantWidth(widths: readonly number[]): number {
	const counts = new Map<number, number>();
	for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1);
	let best = widths[0]!;
	let count = 0;
	for (const [width, seen] of counts) {
		if (seen > count || (seen === count && width < best)) {
			best = width;
			count = seen;
		}
	}
	return best;
}

/**
 * Snap a dominant width to the conventional 2/4/8 set, ties toward 4 — the
 * pre-#336 fallback, kept for files whose steps cannot name a unit.
 */
function snapToCandidate(width: number): number {
	let chosen: number = CANDIDATE_WIDTHS[2];
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of CANDIDATE_WIDTHS) {
		const distance = Math.abs(candidate - width);
		if (distance < bestDistance || (distance === bestDistance && candidate === 4)) {
			chosen = candidate;
			bestDistance = distance;
		}
	}
	return chosen;
}
