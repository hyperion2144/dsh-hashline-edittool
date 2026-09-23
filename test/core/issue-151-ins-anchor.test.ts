/**
 * Issue #151 / Problem 1 — `op: "ins"` anchor drift.
 *
 * `ins` expands to "keep the anchor line, append the new lines below it". The
 * engine used to model that as a one-line REPLACE whose replacement happens to
 * repeat the anchor line at index 0, and the hunk's LCS alignment walks from the
 * END (trailing match wins — right for `replace`, whose closing line is the one
 * being kept). When an inserted line has the same content as the anchor line —
 * a closing brace inserted under a closing brace, the common case — the trailing
 * match paired the anchor line's anchor with the NEW line, and the anchor line
 * itself was re-anchored. A model that cached the anchor silently hit the
 * inserted line instead, with no error.
 *
 * The contract these tests pin: `ins` leaves its anchor line OUTSIDE the hunk,
 * so the anchor line keeps its anchor verbatim and every inserted line is
 * freshly allocated. Nothing else in the file may be re-anchored.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
	servedRows,
	type Harness,
} from "../support/fixtures.js";

/** add's and mul's closing braces are both `  }` — the duplicate-content shape. */
const CALC = [
	"class Calc {",
	"  result = 0;",
	"  add(n: number): this {",
	"    this.result += n;",
	"    return this;",
	"  }",
	"  mul(n: number): this {",
	"    this.result *= n;",
	"    return this;",
	"  }",
	"}",
	"",
].join("\n");

/** The `div` method the issue inserted: its body ALSO ends with `  }`. */
const DIV = ["", "  div(n: number): this {", "    this.result /= n;", "    return this;", "  }"];

/** Insert `lines` below the `index`-th row and hand back the re-read rows. */
async function insBelow(
	harness: Harness,
	path: string,
	index: number,
	lines: string[],
): Promise<{ before: Awaited<ReturnType<typeof servedRows>>; after: Awaited<ReturnType<typeof servedRows>> }> {
	const before = await servedRows(harness, path);
	const res = await harness.editTool.execute("edit", {
		path,
		edits: [{ op: "ins", anchor_after: before[index]!.hash, lines }],
	});
	expect(getText(res)).toContain("Successfully edited");
	return { before, after: await servedRows(harness, path) };
}

/** Every row outside [from, to] (0-based, inclusive) keeps its anchor. */
function expectUntouchedKept(
	before: { hash: string }[],
	after: { hash: string }[],
	from: number,
	to: number,
): void {
	for (let i = 0; i < before.length; i++) {
		if (i >= from && i <= to) continue;
		expect({ line: i + 1, hash: after[i]!.hash }).toEqual({ line: i + 1, hash: before[i]!.hash });
	}
}

describe("#151 P1 — ins keeps its anchor line's anchor", () => {
	it("the anchor line keeps its anchor when the inserted block ends with the same line", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			// Row 10 (1-based) is mul's closing brace; row 6 is add's — same text.
			const { before, after } = await insBelow(harness, "calc.ts", 9, DIV);

			expect(before[5]!.content).toBe(before[9]!.content);
			expect(before[9]!.hash).not.toBe(before[5]!.hash);

			// The anchor line is line 10 and still carries ITS anchor.
			expect(after[9]!.content).toBe("  }");
			expect(after[9]!.hash).toBe(before[9]!.hash);
			// The inserted closing brace is a NEW line and must not inherit it.
			expect(after[14]!.content).toBe("  }");
			expect(after[14]!.hash).not.toBe(before[9]!.hash);
			expect(after[14]!.hash).not.toBe(before[5]!.hash);
			// Rows 1..10 and the class's closing brace are untouched.
			expectUntouchedKept(before, after, 9, 14);
			expect(after[15]!.hash).toBe(before[10]!.hash);
		});
	});

	it("every inserted copy of the anchor line is fresh when the block repeats it", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const block = [
				"",
				"  one(): void {}",
				"  }",
				"",
				"  two(): void {}",
				"  }",
			];
			const { before, after } = await insBelow(harness, "calc.ts", 9, block);

			expect(after[9]!.hash).toBe(before[9]!.hash);
			const inserted = after.slice(10, 16).map((r) => r.hash);
			expect(new Set(inserted).size).toBe(inserted.length);
			expect(inserted).not.toContain(before[9]!.hash);
			expect(inserted).not.toContain(before[5]!.hash);
			expectUntouchedKept(before, after, 9, 15);
		});
	});

	it("the anchor line keeps its anchor when the duplicate sits mid-block or first", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			// `  }` appears FIRST (matching the anchor line) and again in the middle.
			const block = ["  }", "  tail = 1;", "  }", "", "  note();"];
			const { before, after } = await insBelow(harness, "calc.ts", 9, block);

			expect(after[9]!.hash).toBe(before[9]!.hash);
			const inserted = after.slice(10, 15).map((r) => r.hash);
			expect(new Set(inserted).size).toBe(inserted.length);
			expect(inserted).not.toContain(before[9]!.hash);
			expectUntouchedKept(before, after, 9, 14);
		});
	});

	it("an ins on an already-edited file keeps the anchor line's anchor", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const start = await servedRows(harness, "calc.ts");
			await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [
					{
						op: "replace",
						anchor_start: start[6]!.hash,
						anchor_end: start[8]!.hash,
						lines: ["  mul(n: number): this {", "    this.result *= n; // kept", "    return this;"],
					},
				],
			});
			const mid = await servedRows(harness, "calc.ts");
			// Only the CHANGED line is re-anchored: an alignment-paired survivor
			// keeps its anchor even though it sits inside the replaced range.
			expect(mid[7]!.hash).not.toBe(start[7]!.hash);
			expect(mid[6]!.hash).toBe(start[6]!.hash);

			const { before, after } = await insBelow(harness, "calc.ts", 9, DIV);
			expect(after[9]!.hash).toBe(before[9]!.hash);
			expect(after[14]!.hash).not.toBe(before[9]!.hash);
			expectUntouchedKept(before, after, 9, 14);
		});
	});

	it("a follow-up replace with a pre-ins anchor still hits its own line", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const { before, after } = await insBelow(harness, "calc.ts", 9, DIV);
			const anchor = before[9]!.hash; // mul's closing brace, cached BEFORE the ins
			expect(after[14]!.content).toBe("  }");

			// The model still holds the pre-ins anchor. It must name mul's closing
			// brace — not the identically-shaped brace the ins just inserted.
			const res = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["  } // mul"] }],
			});
			expect(getText(res)).toContain("Successfully edited");
			const final = await servedRows(harness, "calc.ts");
			expect(final[9]!.content).toBe("  } // mul");
			expect(final[14]!.content).toBe("  }"); // div's brace, untouched
		});
		});

	it("a batch containing an ins keeps every untouched anchor", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, "calc.ts");
			const res = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [
					{ op: "replace", anchor_start: before[1]!.hash, anchor_end: before[1]!.hash, lines: ["  result = 1;"] },
					{ op: "ins", anchor_after: before[9]!.hash, lines: DIV },
				],
			});
			expect(getText(res)).toContain("Successfully edited");
			const after = await servedRows(harness, "calc.ts");

			expect(after[1]!.content).toBe("  result = 1;");
			// The ins anchor line is 10 in the original and 10 in the result.
			expect(after[9]!.hash).toBe(before[9]!.hash);
			expect(after[14]!.content).toBe("  }");
			expect(after[14]!.hash).not.toBe(before[9]!.hash);
			for (const i of [0, 2, 3, 4, 5, 6, 7, 8]) {
				expect({ line: i + 1, hash: after[i]!.hash }).toEqual({ line: i + 1, hash: before[i]!.hash });
			}
			// The class's closing brace shifted down by the inserted block and kept
			// its anchor — it is outside the hunk entirely.
			expect(after[15]!.content).toBe("}");
			expect(after[15]!.hash).toBe(before[10]!.hash);
		});
	});

	it("del releases the deleted line's anchor and never hands it to a survivor", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const before = await servedRows(harness, "calc.ts");
			// add's closing brace (line 6) is byte-identical to mul's (line 10).
			expect(before[5]!.content).toBe(before[9]!.content);
			expect(before[5]!.hash).not.toBe(before[9]!.hash);

			const res = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [{ op: "del", anchor_start: before[5]!.hash }],
			});
			expect(getText(res)).toContain("Successfully edited");

			const after = await servedRows(harness, "calc.ts");
			expect(after).toHaveLength(before.length - 1);
			for (const i of [0, 1, 2, 3, 4]) {
				expect({ line: i + 1, hash: after[i]!.hash }).toEqual({ line: i + 1, hash: before[i]!.hash });
			}
			// mul's closing brace keeps ITS anchor...
			expect(after[8]!.content).toBe("  }");
			expect(after[8]!.hash).toBe(before[9]!.hash);
			// ...and the deleted line's anchor names nothing any more.
			expect(after.map((r) => r.hash)).not.toContain(before[5]!.hash);
			expect(after[9]!.hash).toBe(before[10]!.hash);
		});
	});
});

/**
 * The two single-line-edit reporting bugs in #151, pinned end to end through the
 * `edit` tool.
 *
 * Both come from the same shape: a single-line edit sends the SAME reference
 * twice (`anchor_end` folds to `anchor_start`), and the two bounds used to be
 * processed as if they were two independent claims — the hint warning was
 * emitted twice (P2) and a stale anchor was counted and listed twice (P3).
 *
 * @module
 */
describe("#151 P2 — a single-line edit warns once", () => {
	it("emits [E_LINE_HINT] exactly once when the hint disagrees", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, "calc.ts");
			// The hint claims line 9; the anchor lives on line 3 and is authoritative.
			const res = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [
					{
						op: "replace",
						anchor_start: `9:${rows[2]!.hash}`,
						anchor_end: `9:${rows[2]!.hash}`,
						lines: ["  result = 42;"],
					},
				],
			});
			const text = getText(res);
			expect(text).toContain("Successfully edited");
			expect(text.match(/\[E_LINE_HINT\]/g) ?? []).toHaveLength(1);
			const after = await servedRows(harness, "calc.ts");
			expect(after[2]!.content).toBe("  result = 42;");
		});
	});
});

/**
 * The drift notice is a warning about anchors THIS edit invalidated, and nothing
 * else.
 *
 * The model's served-anchor set is a session-long accumulator, so it still holds
 * every anchor an EARLIER edit released. Reporting those on each later edit said
 * "N anchor(s) outside the edited range drifted" about anchors that had not
 * moved at all — the model re-read to discover nothing was wrong (#151/P4).
 *
 * @module
 */
describe("#151 P4 — the drift notice does not cry wolf", () => {
	it("a second single-line replace emits no drift notice and moves no anchor", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const start = await servedRows(harness, "calc.ts");
			const first = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [{ op: "replace", anchor_start: start[1]!.hash, anchor_end: start[1]!.hash, lines: ["  result = 1;"] }],
			});
			expect(getText(first)).not.toContain("Drift notice");

			// The first edit released line 2's anchor. This second edit touches a
			// different line entirely; nothing else in the file moved.
			const mid = await servedRows(harness, "calc.ts");
			const second = await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [
					{
						op: "replace",
						anchor_start: mid[2]!.hash,
						anchor_end: mid[2]!.hash,
						lines: ["  add(n: number): this { // edited"],
					},
				],
			});
			const text = getText(second);
			expect(text).toContain("Successfully edited");
			expect(text).not.toContain("Drift notice");

			const after = await servedRows(harness, "calc.ts");
			for (const i of [0, 3, 4, 5, 6, 7, 8, 9, 10]) {
				expect({ line: i + 1, hash: after[i]!.hash }).toEqual({ line: i + 1, hash: mid[i]!.hash });
			}
		});
	});
});

/**
 * Problem 5, end to end: the undo history is a STACK, so a second call walks
 * back one more edit instead of reporting "No undo history".
 *
 * @module
 */
describe("#151 P5 — undo_last_edit walks back more than one edit", () => {
	it("two consecutive undo calls revert the last two edits", async () => {
		await withTempFile("calc.ts", CALC, async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const start = await servedRows(harness, "calc.ts");
			await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [{ op: "replace", anchor_start: start[1]!.hash, anchor_end: start[1]!.hash, lines: ["  result = 1;"] }],
			});
			const mid = await servedRows(harness, "calc.ts");
			await harness.editTool.execute("edit", {
				path: "calc.ts",
				edits: [
					{
						op: "replace",
						anchor_start: mid[2]!.hash,
						anchor_end: mid[2]!.hash,
						lines: ["  add(n: number): this { // edited"],
					},
				],
			});

			const first = await harness.getTool("undo_last_edit")!.execute("undo_last_edit", { path: "calc.ts" });
			expect(getText(first)).toContain("Undone last edit");
			const afterFirst = await servedRows(harness, "calc.ts");
			expect(afterFirst[2]!.content).toBe("  add(n: number): this {");
			expect(afterFirst[1]!.content).toBe("  result = 1;");

			// The SECOND call is the whole point: the first undo consumed its entry
			// and left the earlier one in place.
			const second = await harness.getTool("undo_last_edit")!.execute("undo_last_edit", { path: "calc.ts" });
			expect(getText(second)).toContain("Undone last edit");
			const afterSecond = await servedRows(harness, "calc.ts");
			expect(afterSecond[1]!.content).toBe("  result = 0;");

			// Nothing left to revert: the third call says so, plainly.
			const third = await harness.getTool("undo_last_edit")!.execute("undo_last_edit", { path: "calc.ts" });
			expect(getText(third)).toContain("No undo history");
		});
	});
});

/**
 * The two ends of the line space, where a hunk's range is empty in the other
 * direction: `ins` below the LAST line, and `del` through it.
 *
 * @module
 */
describe("#151 P1 — the empty-range hunks at the file's edges", () => {
	it("ins below the last line, then del through it, keeps every anchor honest", async () => {
		await withTempFile("tail.ts", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const start = await servedRows(harness, "tail.ts");
			// The anchor line is the file's LAST line: the hunk is empty at the end.
			await harness.editTool.execute("edit", {
				path: "tail.ts",
				edits: [{ op: "ins", anchor_after: start[2]!.hash, lines: ["d"] }],
			});
			const afterIns = await servedRows(harness, "tail.ts");
			expect(afterIns.map((r) => r.content)).toEqual(["a", "b", "c", "d"]);
			expect(afterIns[2]!.hash).toBe(start[2]!.hash); // the anchor line
			expect(afterIns[0]!.hash).toBe(start[0]!.hash);
			expect(afterIns[3]!.hash).not.toBe(start[2]!.hash); // the inserted one

			// Delete 1..3: every deleted anchor is released, and the survivor `d`
			// keeps its OWN anchor rather than inheriting a deleted neighbour's.
			await harness.editTool.execute("edit", {
				path: "tail.ts",
				edits: [{ op: "del", anchor_start: afterIns[0]!.hash, anchor_end: afterIns[2]!.hash }],
			});
			const afterDel = await servedRows(harness, "tail.ts");
			expect(afterDel.map((r) => r.content)).toEqual(["d"]);
			expect(afterDel[0]!.hash).toBe(afterIns[3]!.hash);
			for (const i of [0, 1, 2]) expect(afterDel[0]!.hash).not.toBe(afterIns[i]!.hash);
		});
	});
});
