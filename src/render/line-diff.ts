/**
 * Line-level diff with a bounded working set (#190).
 *
 * `genDiff` used jsdiff's `diffLines`, which allocated ~8× the file's bytes in
 * transient token objects (376 MB for a 48 MB / 800k-line file) — and `edit`
 * renders a diff on every call, so on a big file that spike rides every edit.
 *
 * This is Myers' greedy O(ND) algorithm over per-line hashes: one pass with a
 * bounded trace. Time is O(N·D) with D the edit distance — a handful for the
 * edits this plugin renders, so a two-line change in an 800k-line file costs a
 * couple of linear passes — and memory is O(N + M + maxD²), the trace being
 * `maxD + 1` vectors of `2·maxD + 1` ints (~0.5 MB at the default cap).
 *
 * Bounds, stated rather than hidden:
 *  - the common prefix/suffix is matched directly, which is what keeps small
 *    changes local instead of leaving a huge "remainder";
 *  - a range whose distance exceeds {@link DEFAULT_MAX_D} is SPLIT and searched
 *    again (each half has a smaller distance), down to `MAX_SPLIT_DEPTH`;
 *  - past that it becomes one removed block plus one added block, and
 *    `LineDiffResult.degraded` records that it happened. The rendering is still
 *    a correct description of the change, just coarser.
 *
 * The first attempt reused the anchor aligner (`alignPreservedBounded`) and was
 * rejected by measurement — 965 MB / 24.6 s at 800k lines, because that aligner
 * serves sparse, highly-similar sides and cannot localise two small changes at
 * opposite ends of a big file. Recorded so nobody repeats it.
 *
 * Contract: parts match jsdiff's `diffLines` shape (`value` carrying the line
 * terminators, `count`, `added`/`removed`) and blocks come
 * removed-before-added, so `genDiff`'s row building, context trimming and
 * ellipsis handling are untouched.
 * `test/core/line-diff.test.ts` renders 13 shapes through both producers and
 * requires the output to be identical field for field.
 *
 * @module dsh-hashline-edittool/render/line-diff
 */

/** One diff block, in jsdiff's `diffLines` shape. */
export interface LineDiffPart {
	value: string;
	count: number;
	added?: true;
	removed?: true;
}

/** A diff result plus the flag that says a range had to be emitted coarse. */
export interface LineDiffResult {
	parts: LineDiffPart[];
	degraded: boolean;
}

/** Half-diagonals one search may explore before the range is split. */
export const DEFAULT_MAX_D = 256;

/** How deep the split-and-retry fallback may recurse before going coarse. */
export const MAX_SPLIT_DEPTH = 16;

/**
 * Hash one line UNIT (text plus its terminator).
 *
 * FNV-1a, deliberately NOT the anchor layer's `contentKey`: that one folds
 * whitespace, so `"a"` and `"a\n"` would hash alike and a file whose last line
 * merely gained a terminator would diff as unchanged (jsdiff calls it a change).
 *
 * @param unit - one line, terminator included.
 * @returns a 32-bit hash.
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
 * @param text - the text to split.
 * @returns one unit per line.
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

/** One run of the edit script, half-open on both sides, absolute indices. */
interface Run {
	kind: "equal" | "del" | "ins";
	a0: number;
	a1: number;
	b0: number;
	b1: number;
}

/** Coalesces single-line steps into runs, merging contiguous same-kind steps. */
class RunBuilder {
	readonly runs: Run[] = [];

	/** Pushes one step, extending an adjacent run of the same kind when possible. */
	push(kind: Run["kind"], a0: number, a1: number, b0: number, b1: number): void {
		const last = this.runs[this.runs.length - 1];
		if (last !== undefined && last.kind === kind) {
			if (last.a0 === a1 && last.b0 === b1) {
				last.a0 = a0;
				last.b0 = b0;
				return;
			}
			if (last.a1 === a0 && last.b1 === b0) {
				last.a1 = a1;
				last.b1 = b1;
				return;
			}
		}
		this.runs.push({ kind, a0, a1, b0, b1 });
	}
}

/**
 * Myers' greedy search over one range, with a bounded trace.
 *
 * The trace is one `V` snapshot per distance round, which is what makes the
 * script recoverable without the O(D²) "save every k on every round" table the
 * textbook formulation uses.
 *
 * @param a - old-side hashes.
 * @param b - new-side hashes.
 * @param aLo - inclusive old-side start.
 * @param aHi - exclusive old-side end.
 * @param bLo - inclusive new-side start.
 * @param bHi - exclusive new-side end.
 * @param maxD - distance cap.
 * @returns the runs in forward order, or undefined when the cap was exceeded.
 */
function myersRange(
	a: Int32Array,
	b: Int32Array,
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
	maxD: number,
): Run[] | undefined {
	const n = aHi - aLo;
	const m = bHi - bLo;
	const mid = maxD;
	const v = new Int32Array(2 * maxD + 1);
	const trace: Int32Array[] = [];
	let reachedAt = -1;
	for (let d = 0; d <= maxD && reachedAt < 0; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;
			else x = v[mid + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
				x += 1;
				y += 1;
			}
			v[mid + k] = x;
			if (x >= n && y >= m) {
				reachedAt = d;
				break;
			}
		}
	}
	if (reachedAt < 0) return undefined;
	return backtrack(aLo, bLo, n, m, reachedAt, trace, mid);
}

/**
 * Reconstruct the script by walking backwards from (n, m).
 *
 * At each round the step onto the current diagonal is taken first, then the
 * snake of equal lines back to where that diagonal's path came from — which is
 * the forward order reversed, so the runs are flipped at the end.
 *
 * @param aLo - old-side range start.
 * @param bLo - new-side range start.
 * @param n - old-side length.
 * @param m - new-side length.
 * @param dEnd - the distance the search completed at.
 * @param trace - `V` snapshots, one per round (index `d` is the state BEFORE round `d`).
 * @param mid - the k offset those vectors use.
 * @returns the runs, forward order, absolute indices.
 */
function backtrack(
	aLo: number,
	bLo: number,
	n: number,
	m: number,
	dEnd: number,
	trace: Int32Array[],
	mid: number,
): Run[] {
	const builder = new RunBuilder();
	let x = n;
	let y = m;
	for (let d = dEnd; d > 0; d--) {
		const v = trace[d]!;
		const k = x - y;
		const down = k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!);
		const prevK = down ? k + 1 : k - 1;
		const prevX = v[mid + prevK]!;
		const prevY = prevX - prevK;
		// Walk back along the SNAKE first, then take the one edit step that joined
		// this diagonal to the previous round's path. Doing it the other way round
		// emits the step at coordinates the path never visited, which silently
		// DROPS insertions (the `two changes far apart` case lost its `+` line).
		while (x > prevX && y > prevY) {
			builder.push("equal", x - 1, x, y - 1, y);
			x -= 1;
			y -= 1;
		}
		if (down) {
			builder.push("ins", x, x, y - 1, y);
			y -= 1;
		} else {
			builder.push("del", x - 1, x, y, y);
			x -= 1;
		}
	}
	while (x > 0 && y > 0) {
		builder.push("equal", x - 1, x, y - 1, y);
		x -= 1;
		y -= 1;
	}
	const runs = builder.runs;
	runs.reverse();
	for (const run of runs) {
		run.a0 += aLo;
		run.a1 += aLo;
		run.b0 += bLo;
		run.b1 += bLo;
	}
	return runs;
}

/**
 * Diff one range, appending its runs; splitting when the distance is too wide.
 *
 * @param builder - the accumulating script.
 * @param a - old-side hashes.
 * @param b - new-side hashes.
 * @param aLo - inclusive old-side start.
 * @param aHi - exclusive old-side end.
 * @param bLo - inclusive new-side start.
 * @param bHi - exclusive new-side end.
 * @param maxD - distance cap per search.
 * @param depth - remaining split budget.
 * @returns true when part of the range was emitted coarse.
 */
function walk(
	builder: RunBuilder,
	a: Int32Array,
	b: Int32Array,
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
	maxD: number,
	depth: number,
): boolean {
	let prefix = 0;
	while (aLo + prefix < aHi && bLo + prefix < bHi && a[aLo + prefix] === b[bLo + prefix]) prefix += 1;
	if (prefix > 0) {
		builder.push("equal", aLo, aLo + prefix, bLo, bLo + prefix);
		aLo += prefix;
		bLo += prefix;
	}
	let suffix = 0;
	while (aHi - suffix > aLo && bHi - suffix > bLo && a[aHi - suffix - 1] === b[bHi - suffix - 1]) suffix += 1;
	const aMidHi = aHi - suffix;
	const bMidHi = bHi - suffix;
	let degraded = false;
	if (aLo === aMidHi) {
		builder.push("ins", aLo, aLo, bLo, bMidHi);
	} else if (bLo === bMidHi) {
		builder.push("del", aLo, aMidHi, bLo, bLo);
	} else {
		const runs = myersRange(a, b, aLo, aMidHi, bLo, bMidHi, maxD);
		if (runs !== undefined) {
			for (const run of runs) builder.push(run.kind, run.a0, run.a1, run.b0, run.b1);
		} else if (depth > 0) {
			// Too wide for one search: halve it and try again. Each half carries a
			// smaller distance, so this converges instead of exploding.
			const aSplit = aLo + ((aMidHi - aLo) >> 1);
			const bSplit = bLo + ((bMidHi - bLo) >> 1);
			degraded = walk(builder, a, b, aLo, aSplit, bLo, bSplit, maxD, depth - 1) || degraded;
			degraded = walk(builder, a, b, aSplit, aMidHi, bSplit, bMidHi, maxD, depth - 1) || degraded;
		} else {
			builder.push("del", aLo, aMidHi, bLo, bLo);
			builder.push("ins", aMidHi, aMidHi, bLo, bMidHi);
			degraded = true;
		}
	}
	if (suffix > 0) builder.push("equal", aMidHi, aHi, bMidHi, bHi);
	return degraded;
}

/**
 * Turn the script into jsdiff-shaped parts: within a block the removed lines
 * come first, then the added ones.
 *
 * @param runs - the script's runs, in order.
 * @param oldUnits - old-side units.
 * @param newUnits - new-side units.
 * @returns the blocks.
 */
function partsFromRuns(runs: Run[], oldUnits: string[], newUnits: string[]): LineDiffPart[] {
	const parts: LineDiffPart[] = [];
	const append = (units: string[], kind: "equal" | "removed" | "added"): void => {
		if (units.length === 0) return;
		const last = parts[parts.length - 1];
		const same =
			last !== undefined &&
			(kind === "equal"
				? !last.added && !last.removed
				: kind === "added"
					? last.added === true
					: last.removed === true);
		if (same && last !== undefined) {
			last.value += units.join("");
			last.count += units.length;
			return;
		}
		const part: LineDiffPart = { value: units.join(""), count: units.length };
		if (kind === "added") part.added = true;
		if (kind === "removed") part.removed = true;
		parts.push(part);
	};
	let pendingDel: string[] = [];
	let pendingIns: string[] = [];
	const flush = (): void => {
		append(pendingDel, "removed");
		append(pendingIns, "added");
		pendingDel = [];
		pendingIns = [];
	};
	for (const run of runs) {
		if (run.kind === "equal") {
			flush();
			append(oldUnits.slice(run.a0, run.a1), "equal");
			continue;
		}
		if (run.kind === "del") {
			if (pendingIns.length > 0) flush();
			pendingDel.push(...oldUnits.slice(run.a0, run.a1));
			continue;
		}
		pendingIns.push(...newUnits.slice(run.b0, run.b1));
	}
	flush();
	return parts;
}

/**
 * Diff two texts line by line.
 *
 * @param oldText - the pre-change text.
 * @param newText - the post-change text.
 * @param maxD - distance cap per search.
 * @returns the blocks and whether any range was emitted coarse.
 */
export function diffLinesBoundedResult(
	oldText: string,
	newText: string,
	maxD: number = DEFAULT_MAX_D,
): LineDiffResult {
	const oldUnits = splitUnits(oldText);
	const newUnits = splitUnits(newText);
	if (oldUnits.length === 0 && newUnits.length === 0) return { parts: [], degraded: false };
	const a = Int32Array.from(oldUnits, hashUnit);
	const b = Int32Array.from(newUnits, hashUnit);
	const builder = new RunBuilder();
	const degraded = walk(builder, a, b, 0, a.length, 0, b.length, maxD, MAX_SPLIT_DEPTH);
	return { parts: partsFromRuns(builder.runs, oldUnits, newUnits), degraded };
}

/**
 * Diff two texts line by line, in jsdiff's `diffLines` part shape.
 *
 * @param oldText - the pre-change text.
 * @param newText - the post-change text.
 * @returns the blocks.
 */
export function diffLinesBounded(oldText: string, newText: string): LineDiffPart[] {
	return diffLinesBoundedResult(oldText, newText).parts;
}
