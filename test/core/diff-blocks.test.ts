/**
 * The unified-diff block structure (#297).
 *
 * A diff is a list of BLOCKS: each one names the line range it covers on each
 * side of the edit and holds the rows it contains. The block header is the
 * only place the range is stated, so it has to be RIGHT — it comes from the
 * diff's own line counters, never from the rendered text.
 *
 * The same blocks feed the model text and the web card, but the two never
 * parse each other: the card reads the structured rows, the model reads the
 * rendered lines.
 *
 * @module test/core/diff-blocks
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { genDiff } from "../../src/render/edit-diff.js";
import { diffRowsFromBlocks, diffRowsFromMeta } from "../../src/render/edit-card.js";
import { EDIT_DIFF_LEGEND, renderUnifiedDiff } from "../../src/domain/edit/edit-response.js";
import { getText, servedRows, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

/** A file with three changes far apart from each other. */
function threeChanges(): { before: string; after: string } {
	const before: string[] = [];
	const after: string[] = [];
	for (let i = 1; i <= 60; i++) {
		before.push(`line ${i}`);
		after.push(`line ${i}`);
	}
	after[4] = "line 5 changed";
	after[29] = "line 30 changed";
	after[54] = "line 55 changed";
	return { before: before.join("\n"), after: after.join("\n") };
}

describe("genDiff — the unified-diff blocks", () => {
	it("counts the context lines into the block's range", () => {
		const { diff, blocks } = genDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nD\ne\nf\ng", 2);
		expect(blocks).toHaveLength(1);
		const block = blocks[0]!;
		// The change is on line 4; two context lines on each side ⇒ lines 2..6.
		expect(block.oldStart).toBe(2);
		expect(block.oldCount).toBe(5);
		expect(block.newStart).toBe(2);
		expect(block.newCount).toBe(5);
		expect(block.header).toBe("@@ -2,5 +2,5 @@");
		// The header is the FIRST line of the block, and it is not a row.
		expect(diff.split("\n")[0]).toBe("@@ -2,5 +2,5 @@");
	});

	it("splits three far-apart changes into three blocks, each with its own header", () => {
		const { before, after } = threeChanges();
		const { diff, blocks } = genDiff(before, after, 3);
		expect(blocks.map((block) => block.header)).toEqual([
			"@@ -2,7 +2,7 @@",
			"@@ -27,7 +27,7 @@",
			"@@ -52,7 +52,7 @@",
		]);
		// The gap between two changes is ABSENT now — no ` ... ` marker any more.
		expect(diff).not.toContain("...");
		expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(3);
	});

	it("merges the same changes into ONE block when the context is wide enough", () => {
		const { before, after } = threeChanges();
		const { blocks } = genDiff(before, after, 40);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.header).toBe("@@ -1,60 +1,60 @@");
		expect(blocks[0]?.oldStart).toBe(1);
		expect(blocks[0]?.oldCount).toBe(60);
	});

	it("names the enclosing function in the block header", () => {
		const before = ["function alpha() {", "  const x = 1;", "  return x;", "}"].join("\n");
		const after = ["function alpha() {", "  const x = 2;", "  return x;", "}"].join("\n");
		const { blocks } = genDiff(before, after, 3);
		expect(blocks[0]?.scope).toBe("alpha()");
		expect(blocks[0]?.header).toBe("@@ -1,4 +1,4 @@ alpha()");
	});

	it("names EVERY function a block's changes fall into", () => {
		const before = [
			"def first():",
			"    x = 1",
			"    return x",
			"",
			"def second():",
			"    y = 2",
			"    return y",
		].join("\n");
		const after = before.replace("x = 1", "x = 10").replace("y = 2", "y = 20");
		const { blocks } = genDiff(before, after, 3, undefined, undefined, false, { path: "demo.py" });
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.scopes).toEqual(["first()", "second()"]);
		expect(blocks[0]?.header).toBe("@@ -1,7 +1,7 @@ first() / second()");
	});

	it("names the function the CHANGE is in, not the one the context pulled in", () => {
		const before = [
			"def first():",
			"    x = 1",
			"    return x",
			"",
			"def second():",
			"    y = 2",
			"    return y",
		].join("\n");
		const after = before.replace("y = 2", "y = 20");
		const { blocks } = genDiff(before, after, 3, undefined, undefined, false, { path: "demo.py" });
		expect(blocks[0]?.scopes).toEqual(["second()"]);
		expect(blocks[0]?.header.endsWith("@@ second()")).toBe(true);
	});

	it("leaves the name out when no symbol encloses the change", () => {
		const { blocks } = genDiff("a\nb\nc", "a\nB\nc", 3);
		expect(blocks[0]?.scope).toBeUndefined();
		expect(blocks[0]?.header).toBe("@@ -1,3 +1,3 @@");
	});

	it("marks a deleted row with the PRE-edit anchor and a `~`", () => {
		const { diff, blocks, rows } = genDiff(
			"alpha\nbeta\ngamma",
			"alpha\ngamma",
			undefined,
			undefined,
			["AAA", "BBB", "CCC"],
			false,
		);
		const deleted = blocks[0]?.rows.find((row) => row.prefix === "-");
		expect(deleted?.oldHash).toBe("BBB");
		// `~` is not Base62: a model that copies it gets a clean E_BAD_REF.
		expect(diff).toMatch(/^-\s*~BBB:beta$/m);
		// The flat row channel carries the same marker — and the PURE hash beside
		// it, so the card's gutter is unaffected.
		const flat = rows.find((row) => row.kind === "-");
		expect(flat?.anchor).toBe("~BBB");
		expect(flat?.hash).toBe("BBB");
	});

	it("counts a whole-file create as an empty old side", () => {
		const { blocks } = genDiff("", "one\ntwo\nthree\n", 3);
		expect(blocks[0]?.header).toBe("@@ -0,0 +1,3 @@");
		expect(blocks[0]?.oldCount).toBe(0);
		expect(blocks[0]?.newCount).toBe(3);
	});

	it("counts a whole-file deletion as an empty new side", () => {
		const { blocks } = genDiff("one\ntwo\nthree\n", "", 3);
		expect(blocks[0]?.header).toBe("@@ -1,3 +0,0 @@");
		expect(blocks[0]?.newCount).toBe(0);
	});
});

describe("the card's structured rows", () => {
	it("carries the block header as a hunk row, then the block's rows", () => {
		const { blocks } = genDiff("a\nb\nc", "a\nB\nc", 3);
		const cardRows = diffRowsFromBlocks(blocks);
		expect(cardRows[0]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,3 @@" });
		expect(cardRows).toHaveLength(blocks[0]!.rows.length + 1);
		// The card keeps the OLD hash form — the `~` is the model text's marker.
		// The NEW side always has an anchor: genDiff allocates them when the
		// caller passes none, so the card's gutter never degrades to a bare line
		// number. The PRE-edit side can only carry the anchors the caller knows —
		// a removed row without them has no hash at all.
		for (const row of cardRows) {
			if (row.kind === "hunk") continue;
			if (row.kind === "-") continue;
			expect(row.hash).toMatch(/^[A-Za-z0-9]{2,8}$/);
		}
		const withOld = diffRowsFromBlocks(
			genDiff("a\nb\nc", "a\nB\nc", 3, undefined, ["ol1", "ol2", "ol3"]).blocks,
		);
		const removed = withOld.filter((row) => row.kind === "-")[0];
		expect(removed).toEqual({ kind: "-", lineNumber: 2, hash: "ol2", text: "b" });
	});

	it("passes a hunk row through diffRowsFromMeta (a rejected row silently loses the diff)", () => {
		const { blocks } = genDiff("a\nb\nc", "a\nB\nc", 3);
		const cardRows = diffRowsFromBlocks(blocks);
		const projected = diffRowsFromMeta({ diffRows: cardRows });
		expect(projected).toEqual(cardRows);
		// A row of an unknown kind still degrades the whole projection.
		expect(diffRowsFromMeta({ diffRows: [{ kind: "x", lineNumber: 1, hash: "ab", text: "x" }] })).toBeUndefined();
	});
});

describe("the shared model-text rendering", () => {
	it("puts the legend above the file header and the blocks", () => {
		const { blocks } = genDiff("a\nb\nc", "a\nB\nc", 3);
		const text = renderUnifiedDiff([{ path: "f.ts", blocks }]);
		const lines = text.split("\n");
		expect(lines[0]).toBe(EDIT_DIFF_LEGEND);
		expect(lines[1]).toBe("--- f.ts");
		expect(lines[2]).toBe("+++ f.ts");
		expect(lines[3]).toBe("@@ -1,3 +1,3 @@");
	});

	it("separates two files with a blank line", () => {
		const first = genDiff("a\nb\nc", "a\nB\nc", 3).blocks;
		const second = genDiff("x\ny\nz", "x\nY\nz", 3).blocks;
		const text = renderUnifiedDiff([
			{ path: "one.ts", blocks: first },
			{ path: "two.ts", blocks: second },
		]);
		expect(text).toContain("--- one.ts\n+++ one.ts");
		expect(text).toContain("--- two.ts\n+++ two.ts");
		expect(text).toContain("\n\n--- two.ts");
	});
});

describe("the four tools answer with the same shape", () => {
	it("edit: legend, file header, block header, status line", async () => {
		await withTempDir("diff-pres-edit-", async (dir) => {
			await writeFile(join(dir, "f.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
			const harness = setupIntegrationTest(dir);
			const rows = await servedRows(harness, "f.ts");
			const res = await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{
						op: "replace",
						anchor_start: rows[1]!.hash,
						anchor_end: rows[1]!.hash,
						lines: ["const b = 3;"],
					},
				],
			});
			const text = getText(res);
			expect(text).toContain(EDIT_DIFF_LEGEND);
			expect(text).toContain("--- f.ts\n+++ f.ts");
			expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
			expect(text).toContain("Successfully edited in f.ts.");
		});
	});

	it("undo_last_edit: the same shape, for the revert", async () => {
		await withTempDir("diff-pres-undo-", async (dir) => {
			await writeFile(join(dir, "f.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
			const harness = setupIntegrationTest(dir);
			const rows = await servedRows(harness, "f.ts");
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{
						op: "replace",
						anchor_start: rows[1]!.hash,
						anchor_end: rows[1]!.hash,
						lines: ["const b = 3;"],
					},
				],
			});
			const res = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.ts" });
			const text = getText(res);
			expect(text).toContain(EDIT_DIFF_LEGEND);
			expect(text).toContain("--- f.ts\n+++ f.ts");
			expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
		});
	});
});
