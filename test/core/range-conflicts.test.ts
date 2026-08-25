import { describe, expect, it } from "vitest";
import {
	detectRangeConflicts,
	type RangeEdge,
} from "../../src/range-conflicts.js";

describe("detectRangeConflicts", () => {
	it("flags overlapping replace/del ranges (inclusive endpoints)", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 4, endLine: 6, isIns: false },
			{ index: 1, startLine: 6, endLine: 6, isIns: false },
		];
		const conflicts = detectRangeConflicts(edges);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toEqual([edges[0], edges[1]]);
	});

	it("allows adjacent non-overlapping ranges", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 2, endLine: 3, isIns: false },
			{ index: 1, startLine: 5, endLine: 6, isIns: false },
		];
		expect(detectRangeConflicts(edges)).toHaveLength(0);
	});

	it("flags two ins at the same anchor line", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 3, endLine: 3, isIns: true },
			{ index: 1, startLine: 3, endLine: 3, isIns: true },
		];
		const conflicts = detectRangeConflicts(edges);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toEqual([edges[0], edges[1]]);
	});

	it("allows ins at different anchor lines", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 3, endLine: 3, isIns: true },
			{ index: 1, startLine: 5, endLine: 5, isIns: true },
		];
		expect(detectRangeConflicts(edges)).toHaveLength(0);
	});

	it("flags ins whose anchor line lies inside a replace/del range", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 4, endLine: 6, isIns: false },
			{ index: 1, startLine: 4, endLine: 4, isIns: true }, // insert after line 4, which is being replaced
		];
		const conflicts = detectRangeConflicts(edges);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toEqual([edges[0], edges[1]]);
	});


	it("flags ins whose anchor line is strictly inside a replace range (reverse direction)", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 4, endLine: 6, isIns: false },
			{ index: 1, startLine: 5, endLine: 5, isIns: true }, // anchor 5 is strictly inside 4..6
		];
		const conflicts = detectRangeConflicts(edges);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toEqual([edges[0], edges[1]]);
	});

	it("allows ins right before a replace range (anchor line outside)", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 4, endLine: 6, isIns: false },
			{ index: 1, startLine: 3, endLine: 3, isIns: true }, // insert after line 3, replace 4-6: no ambiguity
		];
		expect(detectRangeConflicts(edges)).toHaveLength(0);
	});

	it("flags ins whose anchor line equals the range start", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 4, endLine: 6, isIns: false },
			{ index: 1, startLine: 6, endLine: 6, isIns: true },
		];
		expect(detectRangeConflicts(edges)).toHaveLength(1);
	});

	it("returns all conflicting pairs in a cluster", () => {
		const edges: RangeEdge[] = [
			{ index: 0, startLine: 1, endLine: 3, isIns: false },
			{ index: 1, startLine: 2, endLine: 4, isIns: false },
			{ index: 2, startLine: 3, endLine: 5, isIns: false },
		];
		const conflicts = detectRangeConflicts(edges);
		expect(conflicts).toHaveLength(3);
	});

	it("is symmetric regardless of edge order", () => {
		const a: RangeEdge = { index: 0, startLine: 1, endLine: 2, isIns: false };
		const b: RangeEdge = { index: 1, startLine: 3, endLine: 4, isIns: false };
		expect(detectRangeConflicts([a, b])).toHaveLength(0);
		expect(detectRangeConflicts([b, a])).toHaveLength(0);
	});
});
