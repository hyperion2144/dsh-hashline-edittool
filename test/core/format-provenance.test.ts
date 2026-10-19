/**
 * Provenance — the two exact walks and their composition.
 *
 * These maps are the anchor contract's arithmetic: a final line's eligibility
 * is only as honest as the "which pre-call line ended up here" answer, so
 * every walk is pinned against hand-computed expectations, including the
 * split/merge inheritance policy (G2's "all": every descendant of one served
 * line shares its fate).
 */
import { describe, expect, it } from "vitest";
import {
	composeProvenance,
	lineMapFromHunks,
	lineMapFromTextEdits,
} from "../../src/domain/format/provenance.js";

describe("lineMapFromHunks", () => {
	it("maps a no-hunk file one-to-one", () => {
		const map = lineMapFromHunks(3, []);
		expect([...map.keys()]).toEqual([1, 2, 3]);
		expect(map.get(3)).toEqual(new Set([3]));
	});

	it("maps a plain replace to its own range", () => {
		// Original lines 2-3 replaced by 1 new line at post-hunk position 2.
		const map = lineMapFromHunks(4, [
			{ originalStartLine: 2, originalEndLine: 3, newStartLine: 2, newLineCount: 1 },
		]);
		expect(map.get(1)).toEqual(new Set([1]));
		expect(map.get(2)).toEqual(new Set([2, 3]));
		expect(map.get(3)).toEqual(new Set([4]));
	});

	it("gives EVERY split descendant the same sources (all-inheritance)", () => {
		// Original line 2 split into three lines.
		const map = lineMapFromHunks(3, [
			{ originalStartLine: 2, originalEndLine: 2, newStartLine: 2, newLineCount: 3 },
		]);
		expect(map.get(2)).toEqual(new Set([2]));
		expect(map.get(3)).toEqual(new Set([2]));
		expect(map.get(4)).toEqual(new Set([2]));
		expect(map.get(5)).toEqual(new Set([3]));
	});

	it("merges sources into the survivor", () => {
		// Original lines 1-2 merged into one line at position 1.
		const map = lineMapFromHunks(2, [
			{ originalStartLine: 1, originalEndLine: 2, newStartLine: 1, newLineCount: 1 },
		]);
		expect(map.get(1)).toEqual(new Set([1, 2]));
	});

	it("drops pure deletes — the originals have no final line", () => {
		const map = lineMapFromHunks(3, [
			{ originalStartLine: 2, originalEndLine: 2, newStartLine: 2, newLineCount: 0 },
		]);
		expect(map.size).toBe(2);
		expect(map.get(2)).toEqual(new Set([3]));
	});
});

describe("lineMapFromTextEdits", () => {
	const pos = (line: number, character: number) => ({ line, character });

	it("passes untouched text through one-to-one", () => {
		const map = lineMapFromTextEdits(3, []);
		expect(map.get(1)).toEqual(new Set([1]));
		expect(map.get(2)).toEqual(new Set([2]));
		expect(map.get(3)).toEqual(new Set([3]));
	});

	it("inherits the touched line into the replacement's lines", () => {
		// Line 2 (0-based 1) replaced by two lines.
		const map = lineMapFromTextEdits(3, [
			{ range: { start: pos(1, 0), end: pos(1, 5) }, newText: "two\nand a half" },
		]);
		expect(map.get(1)).toEqual(new Set([1]));
		expect(map.get(2)).toEqual(new Set([2]));
		expect(map.get(3)).toEqual(new Set([2]));
		expect(map.get(4)).toEqual(new Set([3]));
	});

	it("gives formatter-invented lines no entry", () => {
		// An edit anchored INSIDE line 1 produces two lines; both inherit line 1.
		// A following edit CANNOT invent a line without touching one — the map
		// simply never contains a final line outside its coverage.
		const map = lineMapFromTextEdits(2, [
			{ range: { start: pos(0, 3), end: pos(0, 3) }, newText: "\ninserted" },
		]);
		// "abc\ndef" -> "abc\ninserted\ndef": final line 2 is the inserted one,
		// and it inherits line 1 (the edit's touched range), per the all policy.
		expect(map.get(2)).toEqual(new Set([1]));
		expect(map.get(3)).toEqual(new Set([2]));
	});

	it("handles an out-of-order edit list", () => {
		const map = lineMapFromTextEdits(3, [
			{ range: { start: pos(2, 0), end: pos(2, 1) }, newText: "C" },
			{ range: { start: pos(0, 0), end: pos(0, 1) }, newText: "A" },
		]);
		expect(map.get(1)).toEqual(new Set([1]));
		expect(map.get(3)).toEqual(new Set([3]));
	});

	it("a delete leaves the survivors shifted", () => {
		const map = lineMapFromTextEdits(3, [
			{ range: { start: pos(1, 0), end: pos(2, 0) }, newText: "" },
		]);
		expect(map.get(1)).toEqual(new Set([1]));
		// Lines 2-3 original were removed with the edit; final line 2 is the
		// untouched trailing line 3.
		expect(map.get(2)).toEqual(new Set([3]));
	});
});

describe("composeProvenance", () => {
	it("chains final → model → pre-call, unioning sets", () => {
		// Model hunks: pre-call 2 split into model lines 3+4.
		const modelToPreCall = lineMapFromHunks(2, [
			{ originalStartLine: 2, originalEndLine: 2, newStartLine: 3, newLineCount: 2 },
		]);
		// Formatter: model line 4 re-indented in place (a text change).
		const finalToModel = lineMapFromTextEdits(4, [
			{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }, newText: "\t4" },
		]);
		const composed = composeProvenance(finalToModel, modelToPreCall);
		// Final line 4 ← model line 4 ← pre-call line 2.
		expect(composed.get(4)).toEqual(new Set([2]));
		// Final line 1 is untouched model line 1 ← pre-call line 1.
		expect(composed.get(1)).toEqual(new Set([1]));
	});

	it("loses the path when a middle hop has none (formatter-invented text)", () => {
		const finalToModel = new Map([[1, new Set([1])]]);
		const modelToPreCall = new Map<number, ReadonlySet<number>>(); // model line 1 is formatter-invented
		expect(composeProvenance(finalToModel, modelToPreCall).size).toBe(0);
	});
});
