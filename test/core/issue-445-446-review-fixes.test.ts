/**
 * #445 + #446 — regression tests from the maintainer's real-machine PR review:
 * the formatter's changed-count must report TEXT changes (not the edit span),
 * and the cached slot space must stay byte-identical across the state's
 * mutation sites while making repeated small allocations O(1)-ish.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { formatterChangedLines } from "../../src/domain/format/format-section.js";
import { lineMapFromTextEdits } from "../../src/domain/format/provenance.js";
import { allocateInto, type SparseState } from "../../src/hashline/alloc.js";

describe("#445 formatterChangedLines — text changes, not edit spans", () => {
	it("a wide no-op rewrite reports ZERO changed lines", () => {
		// The review's shape: 5001 lines covered by formatter edits whose text
		// is IDENTICAL to the model's — only provenance degrades (multi-source).
		const modelLines = Array.from({ length: 5001 }, (_, i) => `const v${i} = ${i};`);
		const finalLines = [...modelLines];
		const finalToModel = lineMapFromTextEdits(modelLines.length, [
			{
				range: { start: { line: 4999, character: 0 }, end: { line: 5000, character: 0 } },
				newText: modelLines.slice(5000).join("\n") + "\n",
			},
		]);
		const changed = formatterChangedLines(modelLines, finalLines, finalToModel);
		expect(changed.size).toBe(0);
	});

	it("one real change inside a wide rewrite reports exactly that line", () => {
		const modelLines = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`);
		const finalLines = [...modelLines];
		finalLines[99] = "const v99 = 999;";
		const finalToModel = lineMapFromTextEdits(modelLines.length, [
			{
				range: { start: { line: 99, character: 0 }, end: { line: 199, character: 0 } },
				newText: finalLines.slice(100).join("\n") + "\n",
			},
		]);
		const changed = formatterChangedLines(modelLines, finalLines, finalToModel);
		// Line 100 (1-based) is the real change; lines 101..200 survive the
		// rewrite with identical text.
		expect([...changed]).toEqual([100]);
	});

	it("the REAL runtime shape: three sub-line edits on one line keep the map aligned", () => {
		// typescript-language-server's rangeFormatting response for one line:
		// three same-line edits, each newText without a newline. They change text
		// only — the line pointers must not advance, or every following final
		// line shifts (the 5001-changed bug).
		const model = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
		const edits = [
			{ range: { start: { line: 19, character: 5 }, end: { line: 19, character: 8 } }, newText: " " },
			{ range: { start: { line: 19, character: 11 }, end: { line: 19, character: 11 } }, newText: " " },
			{ range: { start: { line: 19, character: 12 }, end: { line: 19, character: 12 } }, newText: " " },
		];
		const map = lineMapFromTextEdits(model.length, edits, model);
		expect(map.size).toBe(40);
		for (let line = 1; line <= 40; line++) expect(map.get(line)).toEqual(new Set([line]));
		const final = [...model];
		final[19] = "const v19 = 999;";
		expect(formatterChangedLines(model, final, map).size).toBe(1);
	});

	it("a sub-line edit on the LAST line does not overflow the map", () => {
		const model = Array.from({ length: 5 }, (_, i) => `line ${i}`);
		const map = lineMapFromTextEdits(
			model.length,
			[{ range: { start: { line: 4, character: 2 }, end: { line: 4, character: 4 } }, newText: "X" }],
			model,
		);
		expect(map.size).toBe(5);
		expect(map.get(5)).toEqual(new Set([5]));
	});

	it("sub-line edits mixed with a real cross-line edit advance only on the cross-line one", () => {
		const model = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		const map = lineMapFromTextEdits(
			model.length,
			[
				{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, newText: "X" },
				// replace lines 4-4 (0-based 3) with two lines: structural
				{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 100 } }, newText: "a\nb\n" },
				{ range: { start: { line: 6, character: 1 }, end: { line: 6, character: 2 } }, newText: "Y" },
			],
			model,
		);
		// 10 model lines + 1 net line = 11 final lines, all mapped.
		expect(map.size).toBe(11);
		expect(map.get(1)).toEqual(new Set([1]));
		expect(map.get(4)).toEqual(new Set([4]));
		expect(map.get(5)).toEqual(new Set([4]));
		expect(map.get(6)).toEqual(new Set([5]));
	});

	it("the runtime shape: a wide identical-text edit keeps identity provenance", () => {
		// The review's runtime: one edit covers lines 5000-10000 with identical
		// text. With modelLines passed, the walk maps 1:1 — every line keeps its
		// own source, so the changed set is empty (and eligibility stays per-line).
		const modelLines = Array.from({ length: 10_000 }, (_, i) => `const v${i} = ${i};`);
		const finalToModel = lineMapFromTextEdits(
			modelLines.length,
			[
				{
					range: { start: { line: 4999, character: 0 }, end: { line: 9999, character: 0 } },
					newText: modelLines.slice(4999).join("\n") + "\n",
				},
			],
			modelLines,
		);
		expect(finalToModel.get(5000)).toEqual(new Set([5000]));
		expect(finalToModel.get(10000)).toEqual(new Set([10000]));
		const changed = formatterChangedLines(modelLines, modelLines, finalToModel);
		expect(changed.size).toBe(0);
	});

	it("no provenance + identical text at the same index is NOT a change (#445 review)", () => {
		// The undefined branch: a wide rewrite can leave the walk without an
		// entry; same-index text equality is the fallback.
		const modelLines = ["a", "b", "c", "d"];
		const finalLines = ["a", "b", "c", "d"];
		const changed = formatterChangedLines(modelLines, finalLines, new Map());
		expect(changed.size).toBe(0);
	});

	it("no provenance + different text (a true insertion) still counts", () => {
		const modelLines = ["a", "b", "c"];
		const finalLines = ["a", "INSERTED", "b", "c"];
		const changed = formatterChangedLines(modelLines, finalLines, new Map());
		expect([...changed]).toEqual([2, 3, 4]);
	});

	it("a merge of two different lines still counts as changed", () => {
		const modelLines = ["alpha", "beta"];
		const finalLines = ["alphabeta"];
		const finalToModel = new Map([[1, new Set([1, 2])]]);
		const changed = formatterChangedLines(modelLines, finalLines, finalToModel);
		expect([...changed]).toEqual([1]);
	});

	it("an identical-text split counts as unchanged (#122 survivor policy)", () => {
		const modelLines = ["same"];
		const finalLines = ["same", "same"];
		const finalToModel = new Map([
			[1, new Set([1])],
			[2, new Set([1])],
		]);
		const changed = formatterChangedLines(modelLines, finalLines, finalToModel);
		expect(changed.size).toBe(0);
	});
});

describe("#446 cached slot space — byte-identical, O(1)-ish reuse", () => {
	function mintedState(lineCount: number): SparseState {
		const state: SparseState = {
			checksum: "x",
			lineCount,
			entries: new Map(),
		};
		const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`);
		const content = lines.join("\n");
		allocateInto(state, content, lines.map((_, i) => i + 1));
		expect(state.entries.size).toBe(lineCount);
		return state;
	}

	it("repeated small allocations on a minted 10k state reuse the cache and stay unique", () => {
		const state = mintedState(10_000);
		expect(state.slotSpace).toBeDefined(); // built by the first pass
		const before = [...state.entries.values()].map((e) => e.anchor);
		// 50 single-line rewrites — each would have rebuilt O(live) before.
		// `lines` are FILE line numbers; hand the full mutated text each round.
		const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
		for (let round = 0; round < 50; round++) {
			const line = 1 + ((round * 197) % 9_998);
			lines[line - 1] = `rewritten ${round} r${round}`;
			allocateInto(state, lines.join("\n"), [line]);
		}
		const anchors = [...state.entries.values()].map((e) => e.anchor);
		expect(new Set(anchors).size).toBe(anchors.length); // no duplicates
		const untouched = anchors.filter((a, i) => a === before[i]).length;
		expect(untouched).toBeGreaterThanOrEqual(anchors.length - 50); // ≤1 mint per round
	});

	it("a caller-provided `used` set still fences the mint (extras path)", () => {
		const state = mintedState(1_000);
		const pool = new Set([...state.entries.values()].map((e) => e.anchor)); // pretend-release everything
		const before = [...state.entries.values()].map((e) => e.anchor);
		// Snapshot BEFORE the call: allocateIntoRows deliberately adds each mint
		// back into the caller's avoid-set (existing behavior), so post-call
		// membership checks would tautologically pass.
		const frozen = new Set(pool);
		allocateInto(state, "brand new text\nsecond new line", [1, 2], pool);
		const anchors = [...state.entries.values()].map((e) => e.anchor);
		expect(new Set(anchors).size).toBe(anchors.length);
		// The two MINTED anchors avoided every PRE-CALL pooled string.
		expect(frozen.has(anchors[0]!)).toBe(false);
		expect(frozen.has(anchors[1]!)).toBe(false);
		// And the untouched majority kept theirs.
		expect(anchors.slice(2)).toEqual(before.slice(2));
	});

	it("cache invalidation across the mutation sites keeps results equal to a cold state", () => {
		// Simulate the edit cycle: mint → invalidate (entries reassigned) → mint again,
		// and compare against a state that never cached.
		const a = mintedState(500);
		const b = mintedState(500); // identical twin
		expect([...a.entries.values()]).toEqual([...b.entries.values()]);
		const rewritten = "totally different content\nwith two lines";
		allocateInto(a, rewritten, [1, 2]);
		b.slotSpace = undefined; // force the cold path
		allocateInto(b, rewritten, [1, 2]);
		expect([...a.entries.values()]).toEqual([...b.entries.values()]);
	});
});
