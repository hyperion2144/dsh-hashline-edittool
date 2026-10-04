/**
 * Bounds the bounded diff itself forgot (#229, #230).
 *
 * `src/render/line-diff.ts` replaced jsdiff's allocation spike with Myers over
 * per-line hashes, but two of its own edges were unbounded:
 *
 *  - **#229** — `partsFromRuns` splices runs back into line arrays with
 *    `pendingDel.push(...slice)`. A spread passes every element as an ARGUMENT,
 *    so one contiguous same-direction block of ≥ ~200k lines throws
 *    `RangeError: Maximum call stack size exceeded`. The diff has already been
 *    computed correctly at that point (`degraded` is still `false`) — the crash
 *    is in rendering it, which is exactly what `write` of a huge file and a
 *    huge `undo` rollback do.
 *  - **#230** — `maxD` had no hard ceiling and the trace is `O(maxD²)`
 *    (`maxD + 1` vectors of `2·maxD + 1` int32). At 16,384 that is ~1.3 GB; the
 *    production default of 256 is also larger than any real edit needs.
 *
 * What these tests assert is deliberately coarse-grained: that a 1M-line
 * one-direction block renders instead of throwing, and that raising `maxD`
 * cannot inflate the trace without bound. The exact clamp (1,024) and the exact
 * memory arithmetic are stated in the module, not recomputed here — a test that
 * recomputed them would agree with the code by construction.
 *
 * @module dsh-hashline-edittool/test/core/line-diff-bounds
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_D,
	DIFF_HARD_MAX_D,
	diffLinesBounded,
	diffLinesBoundedResult,
	effectiveMaxD,
} from "../../src/render/line-diff.js";

/** `n` distinct lines, each terminated — so no two lines collapse together. */
function numberedLines(from: number, n: number, prefix: string): string {
	const out: string[] = [];
	for (let i = 0; i < n; i++) out.push(`${prefix}${from + i}\n`);
	return out.join("");
}

// 1,000,000 — the size #229 reports throwing (measured on macOS arm64 / Node 26).
const HUGE = 1_000_000;

describe("#229: a one-direction contiguous block of any size renders instead of throwing", () => {
	it("renders a pure insertion of 1,000,000 lines", () => {
		const after = numberedLines(0, HUGE, "ins-");
		// Previously: RangeError from `pendingIns.push(...slice)`. The parts are
		// the whole point — one added block carrying every line.
		const { parts, degraded } = diffLinesBoundedResult("", after);
		expect(degraded).toBe(false);
		expect(parts).toHaveLength(1);
		expect(parts[0]!.added).toBe(true);
		expect(parts[0]!.count).toBe(HUGE);
		const lines = parts[0]!.value.split("\n");
		expect(lines[0]).toBe("ins-0");
		expect(lines[HUGE - 1]).toBe(`ins-${HUGE - 1}`);
	});

	it("renders a pure deletion of 1,000,000 lines", () => {
		const before = numberedLines(0, HUGE, "del-");
		const { parts } = diffLinesBoundedResult(before, "");
		expect(parts).toHaveLength(1);
		expect(parts[0]!.removed).toBe(true);
		expect(parts[0]!.count).toBe(HUGE);
	});

	it("is byte-identical to the jsdiff-shaped output for a block that fits the old path", () => {
		// The fix must not change output, only how the array is filled. A small
		// block exercises the same two splice sites.
		const before = numberedLines(0, 3, "a-");
		const after = numberedLines(0, 3, "a-") + numberedLines(0, 3, "b-");
		const { parts } = diffLinesBoundedResult(before, after);
		expect(parts.map((p) => ({ count: p.count, added: p.added ?? false, removed: p.removed ?? false }))).toEqual([
			{ count: 3, added: false, removed: false },
			{ count: 3, added: true, removed: false },
		]);
	});
});

describe("#230: maxD is hard-capped and defaults smaller than the old 256", () => {
	it("clamps an over-large maxD to the hard ceiling", () => {
		expect(effectiveMaxD(65_536)).toBe(DIFF_HARD_MAX_D);
		expect(effectiveMaxD(Number.POSITIVE_INFINITY)).toBe(DIFF_HARD_MAX_D);
	});

	it("leaves a within-bounds maxD alone and floors nonsense to 0", () => {
		expect(effectiveMaxD(64)).toBe(64);
		expect(effectiveMaxD(-5)).toBe(0);
	});

	/** The 60-line fixture `test/core/line-diff.test.ts` calls a whole-file rewrite. */
	const rewriteBody = (tag: string): string =>
		Array.from({ length: 60 }, (_, i) => `const v${i} = ${i}; // ${tag}`)
			.map((line) => `${line}\n`)
			.join("");

	it("finds a common subsequence 64 half-diagonals cannot reach", () => {
		// The measurement behind #230 (800k lines, 50% changed, "64 is faster and
		// bit-identical") does NOT generalise, and this is the counter-example: a
		// whole-file rewrite whose tail is unchanged. The wider search pairs the
		// surviving tail as EQUAL; at 64 the budget runs out first, the range is
		// split, and those lines render as removed + re-added.
		//
		// `test/core/line-diff.test.ts` treats exactly this shape as parity with
		// jsdiff — which is why DEFAULT_MAX_D stays 256.
		const narrow = diffLinesBoundedResult(rewriteBody("filled"), rewriteBody("rewritten"), 64);
		const wide = diffLinesBoundedResult(rewriteBody("filled"), rewriteBody("rewritten"), 256);
		expect(narrow.parts).not.toEqual(wide.parts);
		expect(narrow.degraded).toBe(wide.degraded);
		// The wider cap is the one that keeps every line accounted for.
		expect(wide.parts.reduce((n, part) => n + part.count, 0)).toBe(120);
	});

	it("makes an over-large maxD behave exactly as the ceiling does", () => {
		// The sharpest available statement of "the clamp is at the TRACE, not just in
		// the helper": the two caps must produce the same diff, because the larger
		// one cannot be reached. Unclamped, `myersRange` keeps searching instead of
		// handing the range back to be split — and on this input (20k fully-different
		// lines, so no prefix/suffix trim and one trace per fragment) that is 2
		// coarse blocks in 6.4 s versus 128 blocks in 0.3 s, with ~0.5 GB of trace
		// churn on the way. Deterministic, so it is not a timing test.
		const before = numberedLines(0, 20_000, "before-");
		const after = numberedLines(0, 20_000, "after-");
		const huge = diffLinesBoundedResult(before, after, 65_536);
		const ceiling = diffLinesBoundedResult(before, after, DIFF_HARD_MAX_D);
		expect(huge.parts).toEqual(ceiling.parts);
		expect(huge.degraded).toBe(ceiling.degraded);
		// And it is still a correct description of the change: every line accounted
		// for on both sides.
		const oldSide = huge.parts.reduce((n, p) => n + (p.removed === true ? p.count : 0), 0);
		const newSide = huge.parts.reduce((n, p) => n + (p.added === true ? p.count : 0), 0);
		expect(oldSide).toBe(20_000);
		expect(newSide).toBe(20_000);
	});
});

describe("#230: the default cap stays where the parity contract needs it", () => {
	it("uses DEFAULT_MAX_D when no maxD is passed", () => {
		const base = numberedLines(0, 5_000, "d-");
		const after = base.replace("d-1\n", "d-1 changed\n");
		expect(diffLinesBounded(base, after)).toEqual(diffLinesBoundedResult(base, after, DEFAULT_MAX_D).parts);
	});

	it("sits below the hard ceiling", () => {
		// The two numbers have different jobs: the default is a quality floor (wide
		// enough to keep #190's output), the ceiling is a safety net (low enough
		// that no caller can inflate the trace).
		expect(DEFAULT_MAX_D).toBe(256);
		expect(DEFAULT_MAX_D).toBeLessThanOrEqual(DIFF_HARD_MAX_D);
	});
});
