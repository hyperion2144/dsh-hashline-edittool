/**
 * #441 — the allocator probes integer-only against a batch-built slot space
 * (Uint8Array bitset ≤ depth 4, Set<number> above), replaces the per-probe
 * regex with a digit-box check, and skips fully saturated layers. The probe
 * order and skip predicates are byte-identical to the string era: these pin
 * the invariants that must hold at every speed.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { assignAnchors, isNumericAnchor } from "../../src/hashline/alloc.js";

describe("#441 allocator: integer probing + slot space", () => {
	const big = Array.from({ length: 20_000 }, (_, i) => (i % 7 === 0 ? "" : `stmt_${i} = ${i};`));

	it("is deterministic: the same content picks the same anchors", () => {
		expect(assignAnchors(big)).toEqual(assignAnchors([...big]));
	});

	it("never mints a duplicate or digits-only anchor at scale", () => {
		const anchors = assignAnchors(big);
		expect(new Set(anchors).size).toBe(anchors.length);
		expect(anchors.every((a) => !isNumericAnchor(a))).toBe(true);
	});

	it("keeps per-content cursor continuity across a saturating duplicate run", () => {
		// 5_000 identical blanks: the depth-2 layer saturates (~3.7k usable
		// slots); the cursor walks each copy onto the next free slot instead
		// of burning PROBE_LIMIT per line — the property #441 preserves while
		// probing went integer-only and saturated layers became skippable.
		const anchors = assignAnchors(Array.from({ length: 5_000 }, () => ""));
		expect(new Set(anchors).size).toBe(5_000);
		expect(anchors.every((a) => !isNumericAnchor(a))).toBe(true);
	});

	it("spills to higher layers once depth 2 saturates — shortest-first survives", () => {
		const anchors = assignAnchors(Array.from({ length: 10_000 }, (_, i) => `u${i}`));
		const depths = anchors.map((a) => a.length);
		expect(Math.min(...depths)).toBe(2);
		expect(new Set(anchors).size).toBe(anchors.length);
	});
});
