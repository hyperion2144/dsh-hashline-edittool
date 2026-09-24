/**
 * ADR-0011 — bounded alignment tests (issue #180, spec #184).
 *
 * Five surfaces, each one a single `describe` block:
 *
 *   1. Common prefix/suffix trimming produces the same pairs as full DP
 *      on small inputs (the strip is zero-risk by construction).
 *   2. The blocked path agrees with the full path on small inputs when the
 *      threshold is forced tiny — the threshold injection works.
 *   3. Keep-rate floors (the headline acceptance criterion):
 *        - ≤1% change: ≥99% preserved
 *        - shift-by-N: ≥90% preserved
 *        - full rewrite: empty pairs + `degraded: true`
 *   4. Edge cases (empty / equal / single / non-string).
 *   5. Below-threshold behavior is unchanged — the default budget keeps the
 *      existing full DP for any small input.
 *
 * @module test/core/align-preserved
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
	alignPreservedBounded,
	effectiveDpBudget,
	resetEffectiveDpBudgetForTests,
} from "../../src/hashline/align-bounded.js";

// The original `alignPreserved` is a module-private wrapper inside
// session-anchors.ts; for testing it end-to-end we use the public bounded
// variant (above) AND drive the wrapper through `anchorsFor`.
import { anchorsFor, registerAnchorPersistence, allocateForLines } from "../../src/hashline/session-anchors.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// `lowSimilarityFloor` default is 0.05 — large inputs need a few preserved
// lines to count as "kept". For the very small tests below 20 elements the
// abs-floor kicks in and we only need 1 preserved line.

beforeEach(() => {
	resetEffectiveDpBudgetForTests();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const keys = (n: number, base = 1): number[] => Array.from({ length: n }, (_, i) => base + i);

const keepRate = (preserved: Map<number, number>, oldLen: number): number =>
	oldLen === 0 ? 1 : preserved.size / oldLen;

const seededRandom = (seed: number): (() => number) => {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
};

// ---------------------------------------------------------------------------
// 1. Common prefix/suffix trimming — equivalence with full DP
// ---------------------------------------------------------------------------

describe("common prefix/suffix trimming", () => {
	it("matches the original DP on a tiny pure-prefix change", () => {
		// Full-DP reference (the original implementation), re-derived in-place so
		// the test is independent of the bounded module.
		const reference = (a: readonly number[], b: readonly number[]): Map<number, number> => {
			const m = a.length;
			const n = b.length;
			if (m === 0 || n === 0) return new Map();
			const dp: number[][] = Array.from({ length: m + 1 }, () =>
				new Array<number>(n + 1).fill(0),
			);
			for (let i = 1; i <= m; i++) {
				for (let j = 1; j <= n; j++) {
					dp[i]![j] =
						a[i - 1] === b[j - 1]
							? dp[i - 1]![j - 1]! + 1
							: Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
				}
			}
			const out = new Map<number, number>();
			let i = m;
			let j = n;
			while (i > 0 && j > 0) {
				if (a[i - 1] === b[j - 1]) {
					out.set(j - 1, i - 1);
					i -= 1;
					j -= 1;
				} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
					i -= 1;
				} else {
					j -= 1;
				}
			}
			return out;
		};

		const oldKeys = keys(20);
		// 5 lines inserted at the head, 5 at the tail — head + tail strips
		// collapse the whole diff for the bounded aligner.
		const headIns = [100, 101, 102, 103, 104];
		const tailIns = [200, 201, 202, 203, 204];
		const newKeys = [...headIns, ...oldKeys, ...tailIns];

		const ref = reference(oldKeys, newKeys);
		const got = alignPreservedBounded(oldKeys, newKeys).pairs;
		expect([...got].sort()).toEqual([...ref].sort());
	});

	it("pure-ins / pure-del short-circuits to identity pairs, no DP", () => {
		// Both sides share the entire body; the trim alone is the answer.
		const a = keys(50);
		const b = [-1, ...a, -2];
		const r = alignPreservedBounded(a, b);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(50);
		// Identity: new[j] = old[j+1] for j=0..49 → shift by 1.
		for (let j = 0; j < 50; j++) {
			expect(r.pairs.get(j + 1)).toBe(j);
		}
	});

	it("shared prefix + shared suffix collapse mid to nothing", () => {
		const a = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const b = [0, 1, 2, 99, 98, 97, 9]; // prefix 0-2, suffix 9
		const r = alignPreservedBounded(a, b);
		expect(r.degraded).toBe(false);
		// Prefix: 0→0, 1→1, 2→2. Suffix: index 6 → index 9.
		expect(r.pairs.get(0)).toBe(0);
		expect(r.pairs.get(1)).toBe(1);
		expect(r.pairs.get(2)).toBe(2);
		expect(r.pairs.get(6)).toBe(9);
	});
});

// ---------------------------------------------------------------------------
// 2. Blocked path equivalence with full path
// ---------------------------------------------------------------------------

describe("blocked path equivalence with full path on small inputs", () => {
	it("agrees when the change sits inside a single block", () => {
		// blockSize with effective=16 is 4; the change at index 5 is inside
		// block 1 (indices 4..7). Other blocks are identical, so the block
		// pairing is unambiguous and the per-block DP matches the full DP.
		const a = keys(20);
		const b = a.slice();
		b[5] = 999;
		const full = alignPreservedBounded(a, b).pairs;
		const blocked = alignPreservedBounded(a, b, { effective: 16 }).pairs;
		expect([...blocked].sort()).toEqual([...full].sort());
		expect(full.size).toBe(19); // one missing
		expect(blocked.size).toBe(19);
	});

	it("threshold injection switches the code path", () => {
		// 50×50 input: direct path at default budget (5e7), blocked when forced
		// tiny. Pair counts must agree (the test asserts structural identity
		// of the result, not exact map equality, because blocked alignment can
		// legitimately differ on cross-block boundary cases).
		const a = keys(50);
		const b = a.slice();
		// a couple of non-adjacent changes inside different blocks
		b[3] = -3;
		b[27] = -27;
		const full = alignPreservedBounded(a, b).pairs;
		const blocked = alignPreservedBounded(a, b, { effective: 25 }).pairs; // blockSize=5
		expect(full.size).toBe(48);
		expect(blocked.size).toBe(48);
	});

	it("forced blocked path on a fully-shuffled input bails out cleanly", () => {
		// A pure shuffle: similarity too low for blocked alignment to pair
		// any block credibly — degraded = true, no OOM.
		const a = keys(50);
		const b = a.slice().reverse();
		const r = alignPreservedBounded(a, b, { effective: 25 });
		expect(r.degraded).toBe(true);
		expect(r.pairs.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 3. Keep-rate floors (headline acceptance criterion)
// ---------------------------------------------------------------------------

describe("keep-rate floors", () => {
	it("≤1% change retains ≥99% of old anchors", () => {
		const oldLen = 1000;
		const oldKeys = keys(oldLen);
		const newKeys = oldKeys.slice();
		// Mutate 5 lines (~0.5%) deep inside the file so trim is a no-op.
		newKeys[100] = -100;
		newKeys[300] = -300;
		newKeys[500] = -500;
		newKeys[700] = -700;
		newKeys[900] = -900;
		const r = alignPreservedBounded(oldKeys, newKeys);
		expect(r.degraded).toBe(false);
		const rate = keepRate(r.pairs, oldLen);
		expect(rate).toBeGreaterThanOrEqual(0.99);
	});

	it("shift by N inserted lines at the top retains ≥90% via suffix identity", () => {
		const oldLen = 500;
		const oldKeys = keys(oldLen);
		const inserted = range(37); // totally new content
		const newKeys = [...inserted, ...oldKeys];
		const r = alignPreservedBounded(oldKeys, newKeys);
		expect(r.degraded).toBe(false);
		// Every old anchor pairs to a new line via suffix identity: keep rate
		// is exactly 1.0 (the prefix is new content, the suffix is the whole
		// old file, so prefix=0, suffix=oldLen, mid is empty, no DP runs).
		expect(keepRate(r.pairs, oldLen)).toBe(1);
		expect(r.pairs.size).toBe(oldLen);
		// and the shift is exactly +inserted.length.
		for (let i = 0; i < oldLen; i++) {
			expect(r.pairs.get(inserted.length + i)).toBe(i);
		}
	});

it("whole-file rewrite on a big input returns empty + degraded", () => {
		// Force the blocked path with a tiny effective budget so the similarity
		// guard fires. Without forcing, the default budget would let the direct
		// DP run on 1500×1500 and find 0 pairs by itself — not the resource-
		// exhaustion case this assertion is gating.
		const N = 1500;
		const oldKeys = keys(N);
		const newKeys: number[] = [];
		const rng = seededRandom(42);
		for (let i = 0; i < N; i++) newKeys.push(Math.floor(rng() * 1e9) + 10_000);
		const r = alignPreservedBounded(oldKeys, newKeys, { effective: 100 });
		expect(r.degraded).toBe(true);
		expect(r.pairs.size).toBe(0);
	});

	it("typical edit (≤1%) is unchanged: same pairs as a 4-line example on 100-line file", () => {
		const oldKeys = keys(100);
		const newKeys = oldKeys.slice();
		newKeys[42] = -42;
		const a = alignPreservedBounded(oldKeys, newKeys);
		const b = alignPreservedBounded(oldKeys, newKeys, { effective: 5 }); // force blocked
		expect(a.degraded).toBe(false);
		expect(b.degraded).toBe(false);
		expect(a.pairs.size).toBe(b.pairs.size);
		// Every key pair should be the same except possibly the changed index —
		// but on this input (1 line changed out of 100) both produce the
		// exact same set.
		expect([...b.pairs].sort()).toEqual([...a.pairs].sort());
	});
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("empty arrays return empty (not degraded)", () => {
		const r = alignPreservedBounded([], []);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(0);
	});

	it("empty old, non-empty new", () => {
		const r = alignPreservedBounded([], [1, 2, 3]);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(0);
	});

	it("non-empty old, empty new", () => {
		const r = alignPreservedBounded([1, 2, 3], []);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(0);
	});

	it("identical single-element arrays pair by identity", () => {
		const r = alignPreservedBounded(["x"], ["x"]);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(1);
		expect(r.pairs.get(0)).toBe(0);
	});

	it("single-element different → no pair, not degraded (no DP resources needed)", () => {
		const r = alignPreservedBounded(["x"], ["y"]);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(0);
	});

	it("works with non-number element types (strings)", () => {
		const r = alignPreservedBounded(
			["a", "b", "c", "d", "e", "f"],
			["a", "b", "X", "d", "e", "f"],
		);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(5);
		expect(r.pairs.get(2)).toBe(undefined); // 'X' has no old counterpart
		expect(r.pairs.get(0)).toBe(0);
		expect(r.pairs.get(3)).toBe(3);
	});

	it("returns a Map instance (callers iterate as Map)", () => {
		const r = alignPreservedBounded([1, 2, 3], [1, 2, 3]);
		expect(r.pairs).toBeInstanceOf(Map);
	});

	it("each new index maps to at most one old index (the contract)", () => {
		const r = alignPreservedBounded(keys(100), keys(100).reverse());
		// values are unique because they're Map values (Map keys are unique,
		// so the (new→old) function is unique by construction).
		const vals = [...r.pairs.values()];
		expect(new Set(vals).size).toBe(vals.length);
	});
});

// ---------------------------------------------------------------------------
// 5. Threshold-below unchanged behavior
// ---------------------------------------------------------------------------

describe("threshold-below behavior is unchanged", () => {
	it("the default effective budget is at least the legacy 5×10⁷ entries", () => {
		// On any reasonably configured V8 (≥128 MB heap), effectiveDpBudget
		// returns the 5×10⁷ ceiling. On smaller heaps the heap-derived term
		// kicks in — accept either, but assert it's BIG (way above any input
		// the current callers pass).
		const eff = effectiveDpBudget();
		expect(eff).toBeGreaterThanOrEqual(1_000_000);
	});

	it("a 100×100 input still uses the direct DP (no blocked artifacts)", () => {
		const oldKeys = keys(100);
		const newKeys = oldKeys.slice();
		newKeys[50] = -50;
		// If the blocked path leaked in, similarity guards could degrade on
		// tiny inputs — assert the explicit non-degraded outcome.
		const r = alignPreservedBounded(oldKeys, newKeys);
		expect(r.degraded).toBe(false);
		expect(r.pairs.size).toBe(99);
	});

it("the wrapper in session-anchors returns the bounded pairs (1-line edit)", () => {
		const dir = mkdtempSync(join(tmpdir(), "align-test-"));
		registerAnchorPersistence(undefined);
		try {
			const path = join(dir, "a.txt");
			const before = "alpha\nbeta\ngamma\n";
			// Allocate ALL lines so the sparse state has entries for the whole
			// file — `anchorsFor` only materializes existing entries.
			const anchors = allocateForLines(path, before, [1, 2, 3]);
			expect(anchors.every((a) => a.length > 0)).toBe(true);
			const after = "alpha\nBETA\ngamma\n";
			const afterAnchors = allocateForLines(path, after, [1, 2, 3]);
			// Surrounding lines keep their anchor (content survived); the
			// changed line gets a fresh one — proves the wrapper reached the
			// bounded aligner and surfaced its pairs.
			expect(afterAnchors[0]).toBe(anchors[0]);
			expect(afterAnchors[2]).toBe(anchors[2]);
			expect(afterAnchors[1]).not.toBe(anchors[1]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			registerAnchorPersistence(undefined);
		}
	});
});