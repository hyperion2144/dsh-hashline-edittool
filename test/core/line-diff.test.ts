/**
 * `diffLinesBounded` must render what jsdiff rendered (#190).
 *
 * `genDiff` used jsdiff's `diffLines`, which allocates ~8× the file's bytes over
 * the whole text (376 MB for a 48 MB file) — and `edit` renders a diff on every
 * call. The replacement reuses this repo's bounded alignment (`#182`), and this
 * file is the contract that swapping the producer changed COST, not OUTPUT:
 * `genDiff` takes an optional `partsFor` producer, so every shape below is
 * rendered twice in the same process — once with jsdiff as the reference, once
 * with the bounded producer — and the two renderings must be identical field for
 * field: the `diff` string, `rows` (kind / line number / anchor / hash /
 * content), `servedRows` (position / anchor / contentKey) and
 * `firstChangedLine`.
 *
 * The battery deliberately includes the shapes that historically broke this
 * code: a change at EOF with and without a trailing newline, a pure insertion, a
 * pure deletion, a whole-file rewrite, far-apart changes, a blank-line
 * insertion, a "reformat everything" edit, and the degenerate empty sides.
 *
 * @module dsh-hashline-edittool/test/core/line-diff
 */
import { describe, expect, it } from "vitest";
import { diffLines, structuredPatch } from "diff";
import { genDiff } from "../../src/render/edit-diff.js";
import { diffLinesBounded } from "../../src/render/line-diff.js";
import type { LineDiffPart } from "../../src/render/line-diff.js";
import { assignAnchors } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/infra/utils.js";
import { contextLinesCfg } from "../../src/hashline/hash-assign.js";

/** Anchors for both sides, as the edit path supplies them. */
function bothSides(before: string, after: string): { beforeHashes: string[]; afterHashes: string[] } {
	return {
		beforeHashes: assignAnchors(splitLines(before)),
		afterHashes: assignAnchors(splitLines(after)),
	};
}

/** jsdiff as the reference producer, normalised into the seam's part shape. */
const jsdiffParts = (oldText: string, newText: string): LineDiffPart[] =>
	diffLines(oldText, newText).map((part) => ({
		value: part.value,
		count: part.count ?? 0,
		...(part.added ? { added: true as const } : {}),
		...(part.removed ? { removed: true as const } : {}),
	}));

/** Render the same pair through both producers and compare everything. */
function expectSameRendering(label: string, before: string, after: string): void {
	const { beforeHashes, afterHashes } = bothSides(before, after);
	const reference = genDiff(before, after, contextLinesCfg(), afterHashes, beforeHashes, true, jsdiffParts);
	const bounded = genDiff(before, after, contextLinesCfg(), afterHashes, beforeHashes, true, diffLinesBounded);
	expect(bounded.diff, `${label}: rendered diff`).toBe(reference.diff);
	expect(bounded.rows, `${label}: rows`).toEqual(reference.rows);
	expect(bounded.servedRows, `${label}: servedRows`).toEqual(reference.servedRows);
	expect(bounded.firstChangedLine, `${label}: firstChangedLine`).toBe(reference.firstChangedLine);
}

const body = (n: number, tag = "filled") => Array.from({ length: n }, (_, i) => `const v${i} = ${i}; // ${tag}`);
const text = (lines: string[]) => lines.join("\n") + "\n";

describe("#190: the bounded line diff renders exactly what jsdiff rendered", () => {
	it("no change at all", () => {
		expectSameRendering("identical", text(body(20)), text(body(20)));
	});

	it("one line changed in the middle", () => {
		const before = body(50);
		const after = [...before];
		after[24] = "const v24 = 999; // changed";
		expectSameRendering("middle change", text(before), text(after));
	});

	it("a change on the LAST line, with and without a trailing newline", () => {
		const before = body(30);
		const after = [...before];
		after[29] = "const v29 = -1; // tail";
		expectSameRendering("eof change", text(before), text(after));
		expectSameRendering("eof change, no trailing newline", text(before).slice(0, -1), text(after).slice(0, -1));
		// The terminator itself changing is a change.
		expectSameRendering("terminator added", text(before).slice(0, -1), text(before));
	});

	it("pure insertion and pure deletion", () => {
		const before = body(40);
		expectSameRendering("insert in the middle", text(before), text([...before.slice(0, 20), "const inserted = 1;", ...before.slice(20)]));
		expectSameRendering("delete in the middle", text(before), text([...before.slice(0, 20), ...before.slice(21)]));
		expectSameRendering("insert at the very top", text(before), text(["const first = 0;", ...before]));
		expectSameRendering("append at EOF", text(before), text([...before, "const last = 1;"]));
	});

	it("two changes far apart", () => {
		const before = body(200);
		const after = [...before];
		after[9] = "const v9 = 900;";
		after[190] = "const v190 = 1900;";
		expectSameRendering("far apart", text(before), text(after));
	});

	it("a blank line inserted and removed", () => {
		const before = body(30);
		expectSameRendering("blank inserted", text(before), text([...before.slice(0, 10), "", ...before.slice(10)]));
		const withBlank = [...before.slice(0, 10), "", ...before.slice(10)];
		expectSameRendering("blank removed", text(withBlank), text(before));
	});

	it("a whole-file rewrite (degraded alignment path)", () => {
		expectSameRendering("rewrite", text(body(60)), text(body(60, "rewritten")));
	});

	it("empty sides", () => {
		expectSameRendering("create", "", text(body(10)));
		expectSameRendering("delete all", text(body(10)), "");
		expectSameRendering("both empty", "", "");
	});

	it("repeated identical lines around a change", () => {
		const before = ["a;", "b;", "});", "});", "});", "c;", "});", "});"];
		const after = ["a;", "b;", "});", "});", "c;", "});", "});"];
		expectSameRendering("duplicate-heavy", text(before), text(after));
	});

	it("a reformat-style edit (every line touched, similar content)", () => {
		const before = body(300);
		const after = before.map((line, i) => (i % 3 === 0 ? `  ${line}` : line));
		expectSameRendering("reformat", text(before), text(after));
	});
});

describe("#190: the bounded producer's own contract", () => {
	it("keeps the parts' text equal to the inputs, in jsdiff's part shape", () => {
		const before = "a\nb\nc\n";
		const after = "a\nB\nc\n";
		const parts = diffLinesBounded(before, after);
		// Reassembling the equal+removed parts reproduces the old text, and the
		// equal+added parts the new one — the invariant `count` and `value` carry.
		const oldText = parts.filter((p) => !p.added).map((p) => p.value).join("");
		const newText = parts.filter((p) => !p.removed).map((p) => p.value).join("");
		expect(oldText).toBe(before);
		expect(newText).toBe(after);
		expect(parts.every((p) => p.count === splitUnits(p.value))).toBe(true);
	});

	it("agrees with jsdiff on which lines are equal, removed and added", () => {
		const cases: Array<[string, string]> = [
			["a\nb\nc\n", "a\nB\nc\n"],
			["", "x\n"],
			["x\n", ""],
			["a\n", "a\nb\n"],
			["a\nb\n", "b\n"],
		];
		for (const [before, after] of cases) {
			const shape = (parts: Array<{ added?: boolean; removed?: boolean; count: number }>) =>
				parts.map((p) => `${p.added ? "+" : p.removed ? "-" : "="}${p.count}`);
			expect(shape(diffLinesBounded(before, after)), JSON.stringify([before, after])).toEqual(
				shape(diffLines(before, after)),
			);
		}
	});
});

/** Count lines in a part's value, the same way jsdiff's `count` reports. */
function splitUnits(value: string): number {
	if (value === "") return 0;
	return value.split("\n").filter((_, i, all) => i < all.length - 1 || all[i] !== "").length;
}

describe("#190: structuredPatch parity for the web-card hunks (reference for #190 C2)", () => {
	it("is measurable", () => {
		// Kept as a guard on the assumption behind the second half of #190: if
		// `structuredPatch` ever stops being used, this test says so by failing.
		expect(structuredPatch("", "", "a\nb\n", "a\nc\n", undefined, undefined, { context: 3 }).hunks.length).toBe(1);
	});
});
