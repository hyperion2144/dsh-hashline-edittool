/**
 * The diff card's PURE projection: the structured rows → the rows the card
 * draws, the text the copy button yields, and the head/tail fold window.
 *
 * Split out of `diff-block.tsx` (the renderer) so the three rules that decide
 * what a reader sees are testable without a DOM (issue #295):
 *
 * 1. where a SEGMENT HEADER (`@@ -a,b +c,d @@ scope()`) sits in the drawn
 *    rows — it is a title, not a line of code;
 * 2. what the fold counts — CODE rows only, never a header;
 * 3. what the copy yields — content, never a header.
 *
 * The input is the persisted `presentationMeta.diffRows` and nothing else: the
 * model-facing text is never parsed (the two channels stay independent).
 *
 * @module dsh-hashline-edittool-client/diff-rows
 */

import type { DiffContentRowMeta, DiffRowMeta } from "./types.js";

/** The kinds the card DRAWS — the structured rows' kinds, plus the two the
 * client owns: the `⋯` line-number gap and the segment header. */
export type DisplayRowKind = "del" | "add" | "ctx" | "gap" | "hunk";

/** One drawn row: its gutter cell's text and its code cell's text. */
export interface DisplayRow {
	kind: DisplayRowKind;
	/** The gutter cell's text; `""` for a gap and for a segment header. */
	gutter: string;
	/** The code cell's text (a segment header's full text on a hunk row). */
	text: string;
}

/**
 * Is this row CODE — a line of the file? The fold counts only these: a header
 * is a title and a gap is a hint, and neither is a line the reader can count.
 */
export function isContentRow(row: DisplayRow): boolean {
	return row.kind === "del" || row.kind === "add" || row.kind === "ctx";
}

/**
 * Is this persisted row a CONTENT row — a line of the file? A segment header
 * is not: it carries neither a line number nor an anchor, so a reader that
 * wants those facts narrows with this guard (the union says so at the type
 * level, and a flat shape would have hidden it).
 */
export function isContentRowMeta(row: DiffRowMeta): row is DiffContentRowMeta {
	return row.kind !== "hunk";
}

/**
 * The gutter label of one content row — ONE cell carrying marker + number +
 * anchor: `-21:C7` for removed lines (the pre-edit anchor, stale but
 * informative), `+21:h2` for added lines (the served chained-edit anchor),
 * `20:Cg` for context. The marker never separates from the number:anchor pair.
 */
export function gutterLabel(row: DiffContentRowMeta): string {
	if (row.kind === "-") {
		return row.hash !== "" ? `-${row.lineNumber}:${row.hash}` : `-${row.lineNumber}`;
	}
	if (row.kind === "+") {
		return row.hash !== "" ? `+${row.lineNumber}:${row.hash}` : `+${row.lineNumber}`;
	}
	return row.hash !== "" ? `${row.lineNumber}:${row.hash}` : `${row.lineNumber}`;
}

/**
 * Flatten the structured rows into display rows: gutter labels, segment
 * headers and hunk gaps.
 *
 * There is NO in-body path row any more (issue #96): the tab strip always
 * carries the file identity, so a second copy inside the body was pure
 * repetition — the same call the grep card made in #92.
 *
 * A SEGMENT HEADER (#295) resets the line-number continuity: the `⋯` that
 * used to announce a jump between two segments is redundant under a header
 * that already says "a new segment starts here" (and the model-visible text
 * draws no `...` row there either). A jump INSIDE one segment still shows
 * the `⋯` — that hint is the client's own, and it is still the client's own.
 */
export function buildDisplayRows(rows: readonly DiffRowMeta[]): DisplayRow[] {
	const out: DisplayRow[] = [];
	let prevNew: number | null = null;
	for (const row of rows) {
		if (row.kind === "hunk") {
			out.push({ kind: "hunk", gutter: "", text: row.text });
			prevNew = null;
			continue;
		}
		if (row.kind !== "-" && prevNew !== null && row.lineNumber > prevNew + 1) {
			out.push({ kind: "gap", gutter: "", text: "⋯" });
		}
		if (row.kind === "-") {
			out.push({ kind: "del", gutter: gutterLabel(row), text: row.text });
		} else if (row.kind === "+") {
			out.push({ kind: "add", gutter: gutterLabel(row), text: row.text });
			prevNew = row.lineNumber;
		} else {
			out.push({ kind: "ctx", gutter: gutterLabel(row), text: row.text });
			prevNew = row.lineNumber;
		}
	}
	return out;
}

/**
 * The diff text a reader copies: the shown rows minus the anchor column AND
 * minus the segment headers.
 *
 * A header is structure, not content (#295): what lands in the model's hands
 * must be the file's lines, so a copied diff never carries a `@@` line the
 * model could mistake for code.
 */
export function copyText(rows: readonly DisplayRow[]): string {
	return rows
		.filter((row) => row.kind !== "hunk")
		.map((row) => {
			if (row.kind === "del") return `- ${row.text}`;
			if (row.kind === "add") return `+ ${row.text}`;
			return row.text;
		})
		.join("\n");
}

/** The head/tail window a folded diff is drawn in. */
export interface FoldWindow {
	/** The rows drawn ABOVE the fold control. */
	head: readonly DisplayRow[];
	/** The rows drawn BELOW the fold control. */
	tail: readonly DisplayRow[];
	/** How many CODE rows the closed fold hides. */
	hidden: number;
}

/**
 * The fold window: the head and the tail of the diff, with the middle
 * collapsed.
 *
 * THE COUNTING UNIT IS THE CODE ROW (#295). A segment header is a title and a
 * `⋯` is a hint — neither is a line of the file, so neither is counted and
 * neither can push a code row out of the window. What the fold reports as
 * hidden is therefore the number of file lines behind the control, which is
 * what the reader gets back by expanding it.
 *
 * A SEGMENT HEADER IS DRAWN WITH ITS SECTION, NEVER ALONE: it rides the
 * window of the first VISIBLE code row of the section it opens. A header
 * whose whole section is collapsed is not drawn (a title over nothing reads
 * as a rendering fault), and a header whose section survives in the tail
 * moves down with it (a header pinned to the top would sit above code it no
 * longer describes).
 */
export function foldWindow(display: readonly DisplayRow[], maxLines: number, expanded: boolean): FoldWindow {
	const code: number[] = [];
	for (let index = 0; index < display.length; index += 1) {
		if (isContentRow(display[index]!)) code.push(index);
	}
	const hidden = Math.max(0, code.length - maxLines);
	if (expanded || hidden === 0) {
		return { head: display, tail: [], hidden };
	}
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	// Which window each code row belongs to.
	const windowOf = new Map<number, "head" | "tail">();
	for (const index of code.slice(0, headLines)) windowOf.set(index, "head");
	for (const index of code.slice(code.length - tailLines)) windowOf.set(index, "tail");
	// The segment header each code row belongs to (-1 = before the first one).
	const sectionOf = new Map<number, number>();
	let section = -1;
	for (let index = 0; index < display.length; index += 1) {
		const row = display[index]!;
		if (row.kind === "hunk") {
			section = index;
			continue;
		}
		if (isContentRow(row)) sectionOf.set(index, section);
	}
	// The first VISIBLE code row of a section decides where its header rides.
	const headerWindow = new Map<number, "head" | "tail">();
	for (const [index, owner] of sectionOf) {
		if (headerWindow.has(owner)) continue;
		const win = windowOf.get(index);
		if (win !== undefined) headerWindow.set(owner, win);
	}
	// The next code row at or after each position: a `⋯` introduces the code
	// row that follows it, so it is drawn exactly when that row is.
	const nextCode = new Array<number>(display.length + 1).fill(-1);
	for (let index = display.length - 1; index >= 0; index -= 1) {
		nextCode[index] = isContentRow(display[index]!) ? index : nextCode[index + 1]!;
	}
	const head: DisplayRow[] = [];
	const tail: DisplayRow[] = [];
	for (let index = 0; index < display.length; index += 1) {
		const row = display[index]!;
		let win: "head" | "tail" | undefined;
		if (isContentRow(row)) {
			win = windowOf.get(index);
		} else if (row.kind === "hunk") {
			win = headerWindow.get(index);
		} else {
			const next = nextCode[index] ?? -1;
			win = next === -1 ? undefined : windowOf.get(next);
		}
		if (win === "head") head.push(row);
		else if (win === "tail") tail.push(row);
	}
	return { head, tail, hidden };
}
