/**
 * Issue #198 — `lines` is a LINE ARRAY, and a diff names the line it removed.
 *
 * Two defects came in one report:
 *
 * 1. The payload was flattened to a string before the engine saw it, and the
 *    string surface spells BOTH "no lines" (`""` — the delete marker) and the
 *    all-blank families with newlines alone. So `[""]` arrived as ZERO lines
 *    and a `replace` silently deleted the line, `["",""]` arrived as one, and
 *    an `ins` of `[""]` inserted nothing at all (a noop).
 * 2. A removal row's anchor came from the text diff's own alignment, which is
 *    head-first: with two identical adjacent lines it named the LATER twin —
 *    the survivor — instead of the line the engine actually spliced out.
 *
 * The contract pinned here (maintainer direction on #198): in `lines`, one
 * element is ONE line; only an element that itself carries a newline becomes
 * several; no input may change the line count silently; and a `-` row names
 * the line that really went.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { encodeText, parseText } from "../../src/hashline/index.js";
import { replacedOriginalRanges } from "../../src/domain/edit/edit-engine.js";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
	servedRows,
	useNumberedRows,
} from "../support/fixtures.js";
// #244: the line-number switch belongs to the user now and defaults OFF; this
// file asserts numbered rows, so every test here pins it ON.
useNumberedRows();

/** Two identical adjacent lines — the shape that made the diff misattribute. */
const TWINS = ["alpha", "DUP", "DUP", "omega", ""].join("\n");

/** The `-` row of a rendered diff, or undefined when there is none. */
function minusRow(text: string): string | undefined {
	return text.split("\n").find((line) => line.startsWith("-") && !line.startsWith("---"));
}

/** The `+` rows of a rendered diff. */
function plusRows(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

describe("#198 — the array surface is lossless", () => {
	it("one element is one line, whatever it holds", () => {
		expect(parseText(encodeText([""]))).toEqual([""]);
		expect(parseText(encodeText(["", ""]))).toEqual(["", ""]);
		expect(parseText(encodeText(["", "", ""]))).toEqual(["", "", ""]);
		expect(parseText(encodeText(["a", ""]))).toEqual(["a", ""]);
		expect(parseText(encodeText(["", "a"]))).toEqual(["", "a"]);
		expect(parseText(encodeText(["a", "", "b"]))).toEqual(["a", "", "b"]);
	});

	it("only an element's OWN newline breaks it into more lines", () => {
		expect(parseText(encodeText(["a\nb"]))).toEqual(["a", "b"]);
		// The element is a bare newline, so it is a break — two blank lines, not one.
		expect(parseText(encodeText(["\n"]))).toEqual(["", ""]);
		expect(parseText(encodeText(["\r\n"]))).toEqual(["", ""]);
		expect(parseText(encodeText(["a\n"]))).toEqual(["a", ""]);
	});

	it("no lines at all stays the string surface's delete", () => {
		expect(encodeText([])).toBe("");
		expect(parseText(encodeText([]))).toEqual([]);
	});

	it("expands EVERY array over a small alphabet exactly as the rule says", () => {
		// Exhaustive rather than sampled: all arrays of length 0..3 over an alphabet
		// covering the blank families, an element's own newline, CRLF and text — 156
		// cases. The expectation is DERIVED from the rule (one element = one line;
		// only an element's own newline breaks it), not written per case, so a silent
		// line-count change anywhere in the bridge fails here.
		const ALPHABET = ["", "a", "\n", "a\nb", "\r\n"];
		const expand = (lines: readonly string[]): string[] =>
			lines.flatMap((line) => line.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"));
		const cases: string[][] = [[]];
		for (let length = 1; length <= 3; length++) {
			let layer: string[][] = [[]];
			for (let i = 0; i < length; i++) {
				layer = layer.flatMap((prefix) => ALPHABET.map((ch) => [...prefix, ch]));
			}
			cases.push(...layer);
		}
		expect(cases).toHaveLength(1 + 5 + 25 + 125);
		for (const lines of cases) {
			expect(parseText(encodeText(lines)), JSON.stringify(lines)).toEqual(expand(lines));
		}
	});
});

describe("#198 — a single-line replace with [\"\"] clears the line", () => {
	it("clears instead of deleting, and the diff names the twin it touched", async () => {
		await withTempFile("twins.txt", TWINS, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);
			expect(before.map((r) => r.content)).toEqual(["alpha", "DUP", "DUP", "omega"]);

			// The FIRST twin is the target; the second is byte-identical.
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: [""] }],
			});
			const text = getText(res);
			expect(text).toContain("Successfully edited");
			expect(text).toContain("Added 1 line(s), removed 1 line(s)");

			// The line still EXISTS — it is empty now, so the file kept its length.
			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "", "DUP", "omega"]);
			// The survivor is the SECOND twin, which keeps its own anchor.
			expect(after[2]!.hash).toBe(before[2]!.hash);

			// The removal row names the line that went (the first twin), and the
			// replacement row is the blank line — not a bare deletion.
			expect(minusRow(text)).toContain(before[1]!.hash);
			expect(minusRow(text)).not.toContain(before[2]!.hash);
			expect(minusRow(text)).toContain(":2:DUP");
			expect(plusRows(text)).toHaveLength(1);
			expect(plusRows(text)[0]).toMatch(/:2:$/); // the blank replacement, at line 2
		});
	});

	it("keeps every blank line the caller sent", async () => {
		await withTempFile("twins.txt", TWINS, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: ["", ""] }],
			});
			expect(getText(res)).toContain("Added 2 line(s), removed 1 line(s)");

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "", "", "DUP", "omega"]);
		});
	});

	it("an element's own newline is the only thing that adds a line", async () => {
		await withTempFile("tail.txt", "alpha\nTARGET\nomega\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: ["\n"] }],
			});
			expect(getText(res)).toContain("Added 2 line(s), removed 1 line(s)");

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "", "", "omega"]);
		});
	});

	it("op:del still deletes — the two are distinguishable", async () => {
		await withTempFile("twins.txt", TWINS, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "del", anchor_start: before[1]!.hash }],
			});
			expect(getText(res)).toContain("Added 0 line(s), removed 1 line(s)");

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "DUP", "omega"]);
		});
	});
});

describe("#198 — ins takes blank lines too", () => {
	it("inserts one blank line below the anchor", async () => {
		await withTempFile("anchor.txt", "alpha\nANCHOR\nomega\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "ins", anchor_after: before[1]!.hash, lines: [""] }],
			});
			const text = getText(res);
			expect(text).toContain("Successfully edited");
			expect(text).toContain("inserted 1 line(s)");
			expect(text).not.toContain("noop");

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "ANCHOR", "", "omega"]);
		});
	});

	it("inserts a blank line below an EMPTY anchor line", async () => {
		// The anchor line's own content is empty, so the hunk's replacement is
		// [empty, empty] — the all-blank family again, one join further down.
		await withTempFile("gap.txt", "alpha\n\nomega\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);
			expect(before.map((r) => r.content)).toEqual(["alpha", "", "omega"]);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "ins", anchor_after: before[1]!.hash, lines: [""] }],
			});
			expect(getText(res)).toContain("inserted 1 line(s)");

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "", "", "omega"]);
		});
	});
});

describe("#198 — a removal row names the line the engine removed", () => {
	it("del of the FIRST of two identical lines reports that line, not the survivor", async () => {
		await withTempFile("twins.txt", TWINS, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);
			expect(before[1]!.content).toBe(before[2]!.content);
			expect(before[1]!.hash).not.toBe(before[2]!.hash);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "del", anchor_start: before[1]!.hash }],
			});
			const text = getText(res);

			// The engine deleted line 2 and line 3 survived — its anchor kept.
			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "DUP", "omega"]);
			expect(after[1]!.hash).toBe(before[2]!.hash);

			// So the removal row must carry the DELETED twin's anchor and line,
			// and the survivor's anchor must not appear on a removal row at all.
			const minus = minusRow(text);
			expect(minus).toContain(before[1]!.hash);
			expect(minus).toContain(":2:DUP");
			expect(minus).not.toContain(before[2]!.hash);
		});
	});

	it("replace of one twin with fresh content still names that twin", async () => {
		await withTempFile("twins.txt", TWINS, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: ["REPLACED"] }],
			});
			const text = getText(res);

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "REPLACED", "DUP", "omega"]);

			expect(minusRow(text)).toContain(before[1]!.hash);
			expect(minusRow(text)).toContain(":2:DUP");
		});
	});

	it("a unique line's removal row is unchanged", async () => {
		await withTempFile("unique.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: ["BETA"] }],
			});
			const text = getText(res);

			expect(minusRow(text)).toContain(before[1]!.hash);
			expect(minusRow(text)).toContain(":2:beta");
			expect(plusRows(text)).toHaveLength(1);

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual(["alpha", "BETA", "gamma"]);
		});
	});

	it("an ins elsewhere in the batch never lends its anchor line to a removal row", async () => {
		// Two DUP lines, but only ONE is removed: the other is an `ins` anchor, whose
		// line the engine KEEPS (toAnchorHunk's rule — `ins` covers no old line). A
		// removal row must name the replaced line, never that untouched anchor.
		await withTempFile("pool.txt", "alpha\nDUP\ngamma\ndelta\nDUP\nomega\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, path);
			expect(before[1]!.content).toBe(before[4]!.content);

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [
					{ op: "ins", anchor_after: before[1]!.hash, lines: ["INSERTED"] },
					{ op: "replace", anchor_start: before[4]!.hash, anchor_end: before[4]!.hash, lines: ["REPLACED"] },
				],
			});
			const text = getText(res);

			const after = await servedRows(harness, path);
			expect(after.map((r) => r.content)).toEqual([
				"alpha",
				"DUP",
				"INSERTED",
				"gamma",
				"delta",
				"REPLACED",
				"omega",
			]);

			const minus = minusRow(text);
			expect(minus).toContain(before[4]!.hash);
			expect(minus).toContain(":5:DUP");
			expect(minus).not.toContain(before[1]!.hash);
		});
	});
});

/** A `HunkShift` with every field set; `isIns` marks a pure insertion. */
function hunk(index: number, line: number, isIns?: boolean) {
	return {
		index,
		delta: 0,
		firstStableLineNew: line + 1,
		lastChangedLine: line,
		originalStartLine: line,
		originalEndLine: line,
		finalStartLine: line,
		finalEndLine: line,
		...(isIns === true ? { isIns: true } : {}),
	};
}

describe("#198 — the attribution pool holds only hunks that removed something", () => {
	it("drops `ins` hunks (their anchor line is kept) and sorts ascending", () => {
		// The failing shape: an `ins` anchored on a DUP, and a replace of a LATER
		// DUP. Both hunks reach the renderer in whatever order the batch applied
		// them — the pool must exclude the kept anchor line AND be ascending, or the
		// removal row names the untouched anchor.
		expect(replacedOriginalRanges([hunk(1, 5), hunk(0, 2, true), hunk(2, 9)])).toEqual([
			{ originalStartLine: 5, originalEndLine: 5 },
			{ originalStartLine: 9, originalEndLine: 9 },
		]);
	});

	it("keeps every non-ins hunk's own range, ends included", () => {
		expect(replacedOriginalRanges([hunk(0, 3), hunk(1, 7)])).toEqual([
			{ originalStartLine: 3, originalEndLine: 3 },
			{ originalStartLine: 7, originalEndLine: 7 },
		]);
		expect(replacedOriginalRanges([])).toEqual([]);
	});
});
