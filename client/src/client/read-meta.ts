/**
 * The read card's PURE half — what the card shows and how it folds, decided
 * without React.
 *
 * It lives in its own module for one blunt reason: `read-card.tsx` imports React
 * and the primitives, so anything inside it is unreachable from the client test
 * environment (no bundler, no jsdom). These two rules are the ones worth pinning
 * in tests — which of `lang` and the window count the footer carries, and which
 * rows a capped window shows.
 *
 * @module dsh-hashline-edittool-client/read-meta
 */

import type { ReadCardLabels } from "./labels.js";
import type { ReadCardModel } from "./types.js";

/**
 * The footer's parts, in the order the card has always shown them: the language
 * hint, then the window count. Each is dropped when it has nothing to say (no
 * `lang`, or a read that IS the whole file), and the card draws no footer at all
 * when both are gone — so a full-file read looks exactly as it did.
 * @param model - the derived card model.
 * @param labels - localized chrome (only `window` is read here).
 * @returns the footer's text parts, possibly empty.
 */
export function readCardMeta(model: ReadCardModel, labels: ReadCardLabels): readonly string[] {
	const windowed = model.rows.length < model.totalLines;
	const parts: Array<string | null> = [
		model.lang !== undefined && model.lang !== "" ? model.lang : null,
		windowed ? labels.window(model.rows.length, model.totalLines) : null,
	];
	return parts.filter((part): part is string => part !== null);
}

/**
 * Which rows a capped window shows.
 *
 * Half the cap stays at the head and the REST of the cap at the tail; `tail` is
 * therefore `maxLines - head`, which equals `head` only for an even cap. The
 * card renders its markers and its code from THIS answer, so the two columns
 * cannot disagree — a hand-written copy of this arithmetic is what once put them
 * one row apart.
 *
 * @param total - number of rows the card holds.
 * @param maxLines - the row cap the window folds at.
 * @param expanded - whether the fold is open.
 * @returns the head and tail row indices, and how many rows the fold hides.
 */
export function foldWindow(
	total: number,
	maxLines: number,
	expanded: boolean,
): { readonly head: readonly number[]; readonly tail: readonly number[]; readonly hidden: number } {
	const hidden = Math.max(0, total - maxLines);
	if (hidden === 0 || expanded) {
		return { head: range(0, total), tail: [], hidden };
	}
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	return { head: range(0, headLines), tail: range(total - tailLines, total), hidden };
}

/** `[from, to)` as an index list — the fold window's own helper. */
function range(from: number, to: number): readonly number[] {
	return Array.from({ length: Math.max(0, to - from) }, (_value, index) => from + index);
}

/**
 * The width of a marker column, in `ch`, from the markers it will draw.
 *
 * Shared by EVERY card that has a `行号:锚点` gutter, so the four cannot drift into
 * four different widths for the same content. The card that uses it must also:
 *
 * - declare the monospace code font on the column, because `ch` measures the
 *   font of the element it is set on; and
 * - set `box-sizing: content-box` (or leave it at the initial value), because this
 *   is a TEXT width and the column's own horizontal padding is added outside it.
 *
 * Getting either wrong clips the tail of the marker — which is the anchor.
 *
 * @param markers - the gutter text of every row the card draws.
 * @returns the width in `ch` units.
 */
export function markerColumnCh(markers: readonly string[]): number {
	const widest = markers.reduce((best, marker) => Math.max(best, marker.length), 0);
	// Two characters of head-room, and never narrower than a two-digit number.
	return Math.max(6, widest + 2);
}
