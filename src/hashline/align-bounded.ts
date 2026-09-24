/**
 * Bounded alignment (ADR-0011) — three layers, in this fixed order:
 *
 *   1. Common prefix/suffix trimming      O(min(m, n))
 *   2. Heap-derived DP-budget threshold   `effective = min(5·10⁷, floor(heapLimit / 32))`
 *   3. Blocked (windowed) DP above it     one block at a time; never `m·n · 8 B` at once
 *
 * When the input is fully different AND large enough to fall into the blocked
 * path, the block-pairs step may find no credible pairing at all — we then
 * return an empty mapping and set `degraded: true`, which is the explicit
 * channel the call site inspects (the original `alignPreserved` wrapper hides
 * it from existing callers by returning just the pairs).
 *
 * --------------------------------------------------------------------------
 *   Peak memory upper bound (the line the implementation comment promised)
 *
 *     DP cells   ≤  effective · 8 B           (one block DP at a time)
 *     input copy ≤  (m + n) · 8 B             (number arrays; only after trim)
 *     input copy ≤  (m + n) · ptr·B           (strings/objects; ≤ 2·B per cell
 *                                              when `B = floor(sqrt(effective))`)
 *     output Map ≤  min(m, n) · ~16 B         (key + value + slot overhead)
 *
 *   With `effective = floor(heapLimit / 32)`, the DP term alone is `≤ heap/4`,
 *   so on any well-formed heap the blocked path cannot fatal-abort V8 the way
 *   the previous full `8·(m+1)·(n+1)` table could (#181).
 *
 * --------------------------------------------------------------------------
 *
 * `alignPreservedBounded` is the test seam — same inputs as the original
 * `alignPreserved`, plus an optional `effective` override so tests can force
 * the blocked path on tiny inputs without actually allocating hundreds of MB.
 *
 * @module dsh-hashline-edittool/hashline/align-bounded
 */
import { getHeapStatistics } from "node:v8";

// ---------------------------------------------------------------------------
//  threshold
// ---------------------------------------------------------------------------

/** Hard ceiling on the DP table size — entries (m·n). 5·10⁷ × 8 B = 400 MB. */
export const DEFAULT_MAX_DP_ENTRIES = 50_000_000;

/**
 * The DP-budget the active process should use. Capped at 1/4 of the V8 heap
 * so a near-budget allocation cannot push the process over the heap limit and
 * trigger the non-catchable `Ineffective mark-compacts near heap limit` abort.
 *
 * Result is cached after the first call — `v8.getHeapStatistics()` is not
 * cheap, and the heap size does not move at runtime.
 */
let cachedEffective: number | undefined;
let loggedEffective: number | undefined;

export function effectiveDpBudget(override?: number): number {
	if (override !== undefined) return override;
	if (cachedEffective !== undefined) return cachedEffective;
	const heapLimit = getHeapStatistics().heap_size_limit;
	cachedEffective = Math.min(DEFAULT_MAX_DP_ENTRIES, Math.floor(heapLimit / 32));
	if (loggedEffective !== cachedEffective) {
		// One-shot per process — log only when the budget changes (first call
		// or after a test overrides it for a small input).
		console.error(
			`[alignPreserved] effective=${cachedEffective} (heap_limit=${heapLimit}); ` +
				`DP budget cap = floor(heap/32); default hard cap = ${DEFAULT_MAX_DP_ENTRIES}`,
		);
		loggedEffective = cachedEffective;
	}
	return cachedEffective;
}

/** Test seam: forget the cached budget. Production code never needs this. */
export function resetEffectiveDpBudgetForTests(): void {
	cachedEffective = undefined;
	loggedEffective = undefined;
}

// ---------------------------------------------------------------------------
//  public surface
// ---------------------------------------------------------------------------

export interface AlignOptions {
	/**
	 * Override the effective DP budget. Default: `effectiveDpBudget()` from
	 * `v8.getHeapStatistics()`. Pass a small value (e.g. 100) to force the
	 * blocked path on small inputs.
	 */
	effective?: number;

	/**
	 * Override the blocked-path "very low similarity" threshold. The blocked
	 * aligner bails out (returns empty + `degraded: true`) when the kept-pair
	 * count drops below `min(max(1, min(mMid, nMid) * lowSimilarityFloor), 4)`.
	 * Default 0.05 (5% preserved lines). Exposed for tests.
	 */
	lowSimilarityFloor?: number;
}

export interface AlignResult {
	/**
	 * new-index → old-index pairs in the ORIGINAL coordinate space. Empty
	 * Map when degraded, or when no content survived across the two inputs.
	 */
	pairs: Map<number, number>;

	/**
	 * True when the blocked aligner bailed out — similarity too low to trust
	 * any block pairing. Callers MUST treat this as "this edit invalidated
	 * every anchor the model was holding for this file"; surface it to the
	 * model via a plain-language re-read prompt.
	 */
	degraded: boolean;
}

/**
 * Pair new indices to old indices by surviving content. LCS-based backtrace
 * for small enough inputs, blocked alignment otherwise. See module header for
 * the memory bound.
 */
export function alignPreservedBounded<T>(
	oldSeg: readonly T[],
	newSeg: readonly T[],
	options: AlignOptions = {},
): AlignResult {
	const m = oldSeg.length;
	const n = newSeg.length;
	if (m === 0 || n === 0) return { pairs: new Map(), degraded: false };

	// --- step 1: common prefix/suffix strip -----------------------------
	// O(min(m, n)). The stripped pairs pair by identity — the same `i` in both
	// arrays is the same line, so they always match.
	let prefix = 0;
	const maxPrefix = m < n ? m : n;
	while (prefix < maxPrefix && oldSeg[prefix] === newSeg[prefix]) prefix++;
	let suffix = 0;
	const maxSuffix = m - prefix < n - prefix ? m - prefix : n - prefix;
	while (
		suffix < maxSuffix &&
		oldSeg[m - 1 - suffix] === newSeg[n - 1 - suffix]
	) {
		suffix++;
	}

	const mMid = m - prefix - suffix;
	const nMid = n - prefix - suffix;

	// The prefix/suffix strips already pair everything — no DP needed.
	if (mMid <= 0 || nMid <= 0) {
		return { pairs: identityPairs(m, n, prefix, suffix), degraded: false };
	}

	const effective = effectiveDpBudget(options.effective);
	const lowSimilarityFloor = options.lowSimilarityFloor ?? 0.05;

// --- step 2: threshold check ----------------------------------------
	// DP table bytes = 8 · m · n. Below the threshold, run the full DP; the
	// trim already collapsed the typical "small edit, large file" case down
	// to the changed region.
	if (mMid * nMid <= effective) {
		const midPairs = lcsBacktrace(
			oldSeg as readonly unknown[],
			newSeg as readonly unknown[],
			prefix,
			m - prefix - suffix,
			prefix,
			n - prefix - suffix,
		);
		return {
			pairs: assembleAllPairs(m, n, prefix, suffix, midPairs),
			degraded: false,
		};
	}

// --- step 3: blocked DP ---
	// Block size so one block's DP table fits the budget: B² ≤ effective ⇒
	// B = floor(sqrt(effective)). No lower bound — a tiny `effective` (test
	// seam) gets a tiny block, which is still correct; the budget wins.
	const blockSize = Math.max(1, Math.floor(Math.sqrt(effective)));

	const result = blockedAlign(
		oldSeg as readonly unknown[],
		newSeg as readonly unknown[],
		prefix,
		m - prefix - suffix,
		prefix,
		n - prefix - suffix,
		blockSize,
		lowSimilarityFloor,
	);
	if (result.degraded) {
		return { pairs: new Map(), degraded: true };
	}
	return {
		pairs: assembleAllPairs(m, n, prefix, suffix, result.pairs),
		degraded: false,
	};
}

// ---------------------------------------------------------------------------
//  internals
// ---------------------------------------------------------------------------

/**
 * Build the prefix + suffix identity pairs. When both prefix and suffix
 * exhaust the inputs, `mMid` and `nMid` are zero and we return identity across
 * the whole shorter input, plus any "tail" if one side is longer than the
 * other.
 */
function identityPairs(m: number, n: number, prefix: number, suffix: number): Map<number, number> {
	const out = new Map<number, number>();
	for (let i = 0; i < prefix; i++) out.set(i, i);
	// Suffix maps the LAST `suffix` new indices to the LAST `suffix` old
	// indices — both walk back from the end.
	for (let i = 0; i < suffix; i++) {
		out.set(n - 1 - i, m - 1 - i);
	}
	return out;
}

/**
 * Merge the mid-section pairs (already in MID-local coordinates) with the
 * prefix and suffix identity pairs in the ORIGINAL coordinate space. Used
 * after both the direct DP path and the blocked path: the strip's identity
 * pairs are independent of whatever the DP found, so the union is always
 * safe.
 */
function assembleAllPairs(
	m: number,
	n: number,
	prefix: number,
	suffix: number,
	midPairs: ReadonlyMap<number, number>,
): Map<number, number> {
	const out = new Map<number, number>();
	// prefix: new[i] → old[i] for i in [0, prefix)
	for (let i = 0; i < prefix; i++) out.set(i, i);
	// mid: re-base mid-local j/i into ORIGINAL coordinates (add prefix offset)
	for (const [j, i] of midPairs) out.set(prefix + j, prefix + i);
	// suffix: new[n-1-i] → old[m-1-i] for i in [0, suffix)
	for (let i = 0; i < suffix; i++) {
		out.set(n - 1 - i, m - 1 - i);
	}
	return out;
}

/**
 * Allocate the (oldLen+1) × (newLen+1) DP table, fill it, and back-trace the LCS.
 * Returns pairs in MID-LOCAL 0-indexed coordinates (no offset re-base here —
 * `assembleAllPairs` does that once, consistently with prefix + suffix).
 *
 * Memory: 8·(oldLen+1)·(newLen+1) bytes for the table. Caller has already
 * gated on `m·n ≤ effective`, so the table fits the budget.
 */
function lcsBacktrace(
	oldSeg: readonly unknown[],
	newSeg: readonly unknown[],
	oldOffset: number,
	oldLen: number,
	newOffset: number,
	newLen: number,
): Map<number, number> {
	const dp: number[][] = Array.from({ length: oldLen + 1 }, () =>
		new Array<number>(newLen + 1).fill(0),
	);
	for (let i = 1; i <= oldLen; i++) {
		for (let j = 1; j <= newLen; j++) {
			dp[i]![j] =
				oldSeg[oldOffset + (i - 1)] === newSeg[newOffset + (j - 1)]
					? dp[i - 1]![j - 1]! + 1
					: Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
		}
	}
	const pairs = new Map<number, number>();
	let i = oldLen;
	let j = newLen;
while (i > 0 && j > 0) {
		const ov = oldSeg[oldOffset + (i - 1)];
		const nv = newSeg[newOffset + (j - 1)];
		if (ov === nv) {
			// MID-LOCAL 0-indexed (no offset applied).
			pairs.set(j - 1, i - 1);
			i -= 1;
			j -= 1;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return pairs;
}
/**
 * Cheap, explainable similarity score between two same-direction index
 * windows. Longest common prefix dominates; tail matches (the last `tail`
 * cells agreeing) add a smaller bonus — so a block whose contents survived
 * outranks a block whose first line merely happens to coincide.
 */
function blockSimilarity(a: readonly unknown[], b: readonly unknown[]): number {
	const len = a.length < b.length ? a.length : b.length;
	if (len === 0) return 0;
	let lcp = 0;
	while (lcp < len && a[lcp] === b[lcp]) lcp++;
	const tailProbe = len < 4 ? len : 4;
	let tail = 0;
	while (tail < tailProbe && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	// Anchor equality on the FIRST element is rare enough to be diagnostic —
	// weight it heavily.
	const anchorBonus = a[0] === b[0] ? 5 : 0;
	return lcp * 3 + tail + anchorBonus;
}

/**
 * Split `mid` into blocks, greedily pair old blocks to new blocks by similarity,
 * then run the LCS back-trace inside each pair and union the pairs in old-block
 * order. Peak memory: one block DP at a time.
 */
function blockedAlign(
	oldSeg: readonly unknown[],
	newSeg: readonly unknown[],
	oldOffset: number,
	oldLen: number,
	newOffset: number,
	newLen: number,
	blockSize: number,
	lowSimilarityFloor: number,
): AlignResult {
type Block = { start: number; end: number; slice: readonly unknown[] };
	const blocks = (
		source: readonly unknown[],
		length: number,
		offset: number,
	): Block[] => {
		const out: Block[] = [];
		for (let s = 0; s < length; s += blockSize) {
			const e = s + blockSize < length ? s + blockSize : length;
			out.push({ start: s, end: e, slice: source.slice(offset + s, offset + e) });
		}
		return out;
	};
	const oldBlocks = blocks(oldSeg, oldLen, oldOffset);
const newBlocks = blocks(newSeg, newLen, newOffset);

	// Score every (old, new) pair; pick the best new-block for each old-block
	// greedily in score-descending order. Greedy + monotonic picks is fine:
	// real alignments rarely collide on the new side, and the worst case (a
	// true shuffle) gives the same answer as the full DP would have for the
	// surviving cells.
	const scores: { oi: number; ni: number; score: number }[] = [];
	for (let oi = 0; oi < oldBlocks.length; oi++) {
		for (let ni = 0; ni < newBlocks.length; ni++) {
			const s = blockSimilarity(oldBlocks[oi]!.slice, newBlocks[ni]!.slice);
			if (s > 0) scores.push({ oi, ni, score: s });
		}
	}
	scores.sort((a, b) => b.score - a.score);

	const usedOld = new Set<number>();
	const usedNew = new Set<number>();
	const blockPairs: { oi: number; ni: number }[] = [];
	for (const { oi, ni, score } of scores) {
		if (usedOld.has(oi) || usedNew.has(ni)) continue;
		if (score <= 0) continue;
		usedOld.add(oi);
		usedNew.add(ni);
		blockPairs.push({ oi, ni });
	}

	// No credible pairing at all → bail.
	if (blockPairs.length === 0) {
		return { pairs: new Map(), degraded: true };
	}

	// Stitch the per-block LCS results in old-block order so indices are
	// monotonically increasing on the new side (callers iterate the Map and
	// expect stable order).
	blockPairs.sort((a, b) => a.oi - b.oi);
	const out = new Map<number, number>();
for (const { oi, ni } of blockPairs) {
		const ob = oldBlocks[oi]!;
		const nb = newBlocks[ni]!;
		const local = lcsBacktrace(
			ob.slice,
			nb.slice,
			0,
			ob.slice.length,
			0,
			nb.slice.length,
		);
		// Re-base into mid-local coordinates (block start offsets only); the
		// outer `assembleAllPairs` will add the prefix offset once, not twice.
		for (const [j, i] of local) {
			out.set(nb.start + j, ob.start + i);
		}
	}

	// "Very low similarity" guard: blocked alignment kept almost nothing. The
	// kept fraction has to clear a floor (5% of the smaller side, with an
	// absolute minimum of 1 line and a ceiling at 4 lines so tiny inputs are
	// not over-penalized).
	const minSide = Math.min(oldLen, newLen);
	const absFloor = minSide < 20 ? 1 : Math.min(4, Math.ceil(minSide * lowSimilarityFloor));
	if (out.size < absFloor) {
		return { pairs: new Map(), degraded: true };
	}

	return { pairs: out, degraded: false };
}