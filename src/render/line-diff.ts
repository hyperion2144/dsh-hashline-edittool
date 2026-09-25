/**
 * Line-level diff with a bounded working set (#190).
 *
 * Why this exists: `genDiff` used jsdiff's `diffLines`, which runs a Myers diff
 * over the whole text and allocates roughly **8× the file's bytes** while it
 * does — measured 376 MB for a 48 MB / 800k-line file, and `edit` calls it on
 * every single edit. Under a constrained heap that is the same fatal-abort
 * family as the alignment DP table that #182 clamped.
 *
 * **Status: NOT wired in — measured worse than jsdiff (#190, 2026-09-25).**
 *
 * `genDiff` takes a `partsFor` seam, and this producer can be swapped in for
 * a field-for-field comparison (see `test/core/line-diff.test.ts`, 13 shapes
 * green). But its COST is not an improvement:
 *
 * ```
 * 200k lines: jsdiff 478 MB / 6.5 s    this 850 MB / 6.1 s
 * 800k lines: jsdiff 1028 MB / 26.4 s  this 639 MB / 23.4 s
 * ```
 *
 * The reason is that {@link alignPreservedBounded} is built for ANCHOR
 * alignment — sparse, two sides highly similar — not for diffing a whole file:
 * after the common prefix/suffix strip, two small changes at opposite ends
 * leave ~800k lines as "the remainder", and the blocked DP then does its
 * block-by-block work over all of them. Localising changes needs an
 * **O(ND) Myers** (tiny D for a typical edit), not a blocked LCS.
 *
 * Kept because the shape is right and the contract is pinned: a bounded Myers
 * can replace {@link diffLinesBounded}'s body without touching the part
 * assembly or the equivalence battery. The second half of #190 —
 * `computeHunkDiffs`'s `structuredPatch` — measured **407 MB / 238 ms** at
 * 800k lines, i.e. also in scope.
 *
 * Contract: the emitted parts match jsdiff's `diffLines` shape (`value` carries
 * the line terminators, `count` the line count, `added`/`removed` flags) so
 * `genDiff`'s row building, context trimming and ellipsis handling stay
 * untouched. Parts are emitted removed-before-added per change block, as jsdiff
 * does.
 *
 * Deliberate difference, stated rather than hidden: this is a diff for
 * RENDERING, not a byte-exact clone. When the alignment degrades (similarity too
 * low to pair any block), the whole remainder is emitted as one removed block
 * plus one added block — a coarser hunk than jsdiff's, still a correct
 * description of the change. `test/core/line-diff.test.ts` pins the equivalence
 * the wired-in producer must keep.
 * @module dsh-hashline-edittool/render/line-diff
 */

import { alignPreservedBounded } from "../hashline/align-bounded.js";

/** One diff block, in jsdiff's `diffLines` shape. */
export interface LineDiffPart {
	/** The block's exact text, line terminators included. */
	value: string;
	/** How many lines the block contains. */
	count: number;
	added?: true;
	removed?: true;
}

/**
 * Hash one LINE UNIT (text plus its terminator) for identity comparison.
 *
 * FNV-1a over UTF-16 code units: cheap, deterministic, and — unlike the anchor
 * layer's `contentKey` — it does NOT fold whitespace or newlines. That matters
 * here: `"a"` and `"a\n"` are different lines to a diff (jsdiff agrees), and a
 * normalising hash would report "no change" for a file whose last line just
 * gained a terminator.
 *
 * @param unit - one line, terminator included.
 * @returns a 32-bit hash as an unsigned number.
 */
function hashUnit(unit: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < unit.length; i++) {
		hash ^= unit.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Split text into line units, each keeping its terminator.
 *
 * `"a\nb\n"` → `["a\n", "b\n"]`, `"a\nb"` → `["a\n", "b"]`, `""` → `[]` — the
 * same line notion jsdiff's `count` reports.
 *
 * @param text - the text to split.
 * @returns one entry per line.
 */
function splitUnits(text: string): string[] {
	if (text === "") return [];
	const units: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			units.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) units.push(text.slice(start));
	return units;
}

/**
 * Diff two texts line by line with a bounded working set.
 *
 * @param oldText - the pre-change text.
 * @param newText - the post-change text.
 * @returns the diff blocks, in order, jsdiff-shaped.
 */
export function diffLinesBounded(oldText: string, newText: string): LineDiffPart[] {
	const oldUnits = splitUnits(oldText);
	const newUnits = splitUnits(newText);
	if (oldUnits.length === 0 && newUnits.length === 0) return [];
	const oldKeys = oldUnits.map(hashUnit);
	const newKeys = newUnits.map(hashUnit);
	// Bounded alignment: prefix/suffix strip + blocked DP, degrading instead of
	// allocating without limit (#182). `pairs` maps new index → old index.
	const { pairs } = alignPreservedBounded(oldKeys, newKeys);

	const parts: LineDiffPart[] = [];
	const append = (units: string[], kind: "equal" | "removed" | "added"): void => {
		if (units.length === 0) return;
		const last = parts[parts.length - 1];
		const sameKind =
			last !== undefined &&
			(kind === "equal" ? !last.added && !last.removed : kind === "added" ? last.added === true : last.removed === true);
		if (sameKind && last !== undefined) {
			last.value += units.join("");
			last.count += units.length;
			return;
		}
		const part: LineDiffPart = { value: units.join(""), count: units.length };
		if (kind === "added") part.added = true;
		if (kind === "removed") part.removed = true;
		parts.push(part);
	};

	let oldIndex = 0;
	let newIndex = 0;
	let pendingRemoved: string[] = [];
	let pendingAdded: string[] = [];
	// Removed lines are emitted before the added lines of the same block, which
	// is the order jsdiff presents a replacement in.
	const flush = (): void => {
		append(pendingRemoved, "removed");
		append(pendingAdded, "added");
		pendingRemoved = [];
		pendingAdded = [];
	};

	while (newIndex < newUnits.length) {
		const matchedOld = pairs.get(newIndex);
		if (matchedOld === undefined) {
			pendingAdded.push(newUnits[newIndex]!);
			newIndex += 1;
			continue;
		}
		while (oldIndex < matchedOld) pendingRemoved.push(oldUnits[oldIndex++]!);
		flush();
		append([newUnits[newIndex]!], "equal");
		newIndex += 1;
		oldIndex = matchedOld + 1;
	}
	while (oldIndex < oldUnits.length) pendingRemoved.push(oldUnits[oldIndex++]!);
	flush();
	return parts;
}
