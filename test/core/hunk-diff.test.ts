/**
 * `computeHunkDiffs` must produce the hunks jsdiff's `structuredPatch` produced
 * (#192) — same change, bounded cost.
 *
 * `structuredPatch` ran a second unbounded whole-file Myers on every edit
 * (407 MB at 800k lines). The replacement builds hunks from the bounded line
 * diff's parts (`#190`), grouping them the way a unified diff does: changes
 * within 2×context merge into one hunk, up to `context` unchanged lines ride on
 * each side.
 *
 * The reference below is the removed implementation, kept verbatim in the test
 * so the two can be compared directly rather than against a golden file.
 *
 * @module dsh-hashline-edittool/test/core/hunk-diff
 */
import { describe, expect, it } from "vitest";
import { structuredPatch } from "diff";
import { computeHunkDiffs, type FileDiff } from "../../src/render/edit-card.js";

/** The implementation #192 replaced, verbatim, as the reference. */
function referenceHunks(path: string, before: string, after: string): FileDiff[] {
	const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
	const diffs: FileDiff[] = [];
	for (const hunk of patch.hunks) {
		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (const line of hunk.lines) {
			if (line.startsWith("\\")) continue;
			const text = line.slice(1);
			if (line.startsWith("-")) oldLines.push(text);
			else if (line.startsWith("+")) newLines.push(text);
			else {
				oldLines.push(text);
				newLines.push(text);
			}
		}
		diffs.push({
			path,
			oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
			newText: newLines.join("\n"),
		});
	}
	return diffs;
}

const body = (n: number, tag = "filled") =>
	Array.from({ length: n }, (_, i) => `const v${i} = ${i}; // ${tag}`);
const text = (lines: string[]) => lines.join("\n") + "\n";

function expectSameHunks(label: string, before: string, after: string): void {
	expect(computeHunkDiffs("/x.ts", before, after), label).toEqual(referenceHunks("/x.ts", before, after));
}

describe("#192: hunk diffs match the structuredPatch implementation", () => {
	it("identical text produces no hunk at all", () => {
		expectSameHunks("identical", text(body(20)), text(body(20)));
	});

	it("one change in the middle", () => {
		const before = body(40);
		const after = [...before];
		after[20] = "const v20 = 999;";
		expectSameHunks("middle", text(before), text(after));
	});

	it("a change at EOF with and without a trailing newline", () => {
		const before = body(20);
		const after = [...before];
		after[19] = "const v19 = -1;";
		expectSameHunks("eof", text(before), text(after));
		expectSameHunks("eof no newline", text(before).slice(0, -1), text(after).slice(0, -1));
	});

	it("pure insertion and pure deletion", () => {
		const before = body(30);
		expectSameHunks("insert", text(before), text([...before.slice(0, 10), "const added = 1;", ...before.slice(10)]));
		expectSameHunks("delete", text(before), text([...before.slice(0, 10), ...before.slice(11)]));
		expectSameHunks("append", text(before), text([...before, "const last = 1;"]));
	});

	it("changes close enough to merge into one hunk, and far enough to split", () => {
		const near = body(40);
		const nearAfter = [...near];
		nearAfter[10] = "const v10 = 1;";
		nearAfter[14] = "const v14 = 1;"; // 3 unchanged lines between → one hunk
		expectSameHunks("merge", text(near), text(nearAfter));

		const far = body(60);
		const farAfter = [...far];
		farAfter[5] = "const v5 = 1;";
		farAfter[40] = "const v40 = 1;"; // far apart → two hunks
		expectSameHunks("split", text(far), text(farAfter));
	});

	it("a blank line added and removed", () => {
		const before = body(20);
		expectSameHunks("blank add", text(before), text([...before.slice(0, 8), "", ...before.slice(8)]));
		const withBlank = [...before.slice(0, 8), "", ...before.slice(8)];
		expectSameHunks("blank remove", text(withBlank), text(before));
	});

	it("a whole-file rewrite, and empty sides", () => {
		expectSameHunks("rewrite", text(body(30)), text(body(30, "rewritten")));
		expectSameHunks("create", "", text(body(5)));
		expectSameHunks("delete all", text(body(5)), "");
		expectSameHunks("both empty", "", "");
	});
});
