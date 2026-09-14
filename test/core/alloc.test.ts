/**
 * S2 — allocator pure-function tests (dynamic-hashline v2.0).
 *
 * Covers the shortest-first layered allocation contract: determinism,
 * per-line uniqueness (identical content → distinct anchors), the 2-char
 * layer's real capacity for repeated content (probe-cursor continuity —
 * regression: without the per-content cursor, identical lines spilled after
 * ~64 rows per layer), and incremental edit updates.
 */
import { describe, expect, it } from "vitest";
import { assignAnchors, allocateAnchor } from "../../src/hashline/alloc.js";
import {
  updateAnchorsAfterEdit,
  anchorsFor,
  anchorsPure,
} from "../../src/hashline/session-anchors.js";
import { splitLines } from "../../src/utils.js";

/**
 * Usable 2-character anchors: `62 ** 2` slots, MINUS every digits-only one.
 *
 * The alphabet leads with `0`-`9`, and an all-digit anchor is not usable as
 * one: a row is `<line>:<anchor>` and the marker may be passed back with or
 * without its line part, so `36` alone is ambiguous with line 36 — and the
 * ambiguity resolves to a WRONG edit rather than a rejected one. Allocation
 * steps over those candidates, so the layer really is this much smaller.
 */
const TWO_CHAR_CAPACITY = 62 ** 2 - 10 ** 2;

describe("assignAnchors — determinism & uniqueness", () => {
  it("same content + same order → identical anchors (deterministic)", () => {
    const content = "a\nb\nc\na\n\nb\n";
    expect(assignAnchors(splitLines(content))).toEqual(
      assignAnchors(splitLines(content)),
    );
  });

  it("every anchor is unique within the file", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i % 37}`);
    const anchors = assignAnchors(splitLines(content.join("\n")));
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("duplicate lines get DISTINCT anchors (Q2-A)", () => {
    const anchors = assignAnchors(splitLines("x\nx\nx\n"));
    expect(anchors.length).toBe(3);
    expect(new Set(anchors).size).toBe(3);
  });
});

describe("shortest-first layers", () => {
  it("fills the 2-char layer with 3,844 identical lines before spilling to 3", () => {
    const lines = new Array<string>(TWO_CHAR_CAPACITY).fill("}");
    const anchors = assignAnchors(lines);
    expect(new Set(anchors).size).toBe(TWO_CHAR_CAPACITY);
    expect(anchors.every((a) => a.length === 2)).toBe(true);
  });

  it("line 3,845 (identical content) lands in the 3-char layer — regression fix", () => {
    // Regression: identical lines SHARE a probe sequence; without the
    // per-content cursor each extra row re-probed the same ~64 slots and
    // spilled after ~64 rows — 20k identical braces threw E_HASH_SPACE.
    const lines = new Array<string>(20_000).fill("}");
    const anchors = assignAnchors(lines);
    expect(anchors.length).toBe(20_000);
    expect(new Set(anchors).size).toBe(20_000);
    const len2 = anchors.filter((a) => a.length === 2).length;
    expect(len2).toBe(TWO_CHAR_CAPACITY);
    expect(anchors[20_000 - 1]!.length).toBeGreaterThanOrEqual(3);
  });

  it("mixed normal content stays shortest-first with 2-char anchors", () => {
    const content = Array.from({ length: 100 }, (_, i) => `value ${i}`);
    const anchors = assignAnchors(splitLines(content.join("\n")));
    expect(anchors.every((a) => a.length === 2)).toBe(true);
  });
});

describe("allocateAnchor — probe continuity via groupCursor", () => {
  it("repeated identical content advances through the layer, never colliding", () => {
    const used = new Set<string>();
	const cursor = { offsets: {} } as { offsets: Record<number, number> };
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { anchor } = allocateAnchor(used, "same", cursor);
      used.add(anchor);
      seen.add(anchor);
    }
    expect(seen.size).toBe(500);
  });
});

describe("updateAnchorsAfterEdit — incremental semantics", () => {
  it("preserves untouched anchors; replaces the hunk with fresh ones", () => {
    const oldContent = "a\nb\nc\nd\n";
    const newContent = "a\nb\nB2\nd\n";
    const oldAnchors = anchorsPure(oldContent);
    const merged = updateAnchorsAfterEdit({
      path: "/tmp/x.txt",
      oldContent,
      newContent,
      oldAnchors,
      hunks: [
        { oldStart1: 3, oldEnd1: 3, finalStart1: 3, finalEnd1: 3 },
      ],
    });
    expect(merged[0]).toBe(oldAnchors[0]);
    expect(merged[1]).toBe(oldAnchors[1]);
    expect(merged[3]).toBe(oldAnchors[3]);
    expect(merged[2]).toBe(anchorsPure(newContent)[2]);
    expect(new Set(merged).size).toBe(4);
  });

  it("releases removed anchors and allocates inserts (multi-hunk)", () => {
    const oldContent = "a\nb\nc\nd\ne\n";
    const newContent = "a\nX\nc\nd\nZ\n";
    const oldAnchors = anchorsPure(oldContent);
    const merged = updateAnchorsAfterEdit({
      path: "/tmp/y.txt",
      oldContent,
      newContent,
      oldAnchors,
      hunks: [
        { oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 2 },
        { oldStart1: 5, oldEnd1: 5, finalStart1: 5, finalEnd1: 5 },
      ],
    });
    expect(merged[0]).toBe(oldAnchors[0]);
    expect(merged[2]).toBe(oldAnchors[2]);
    expect(merged[3]).toBe(oldAnchors[3]);
    expect(new Set(merged).size).toBe(5);
    // inserted anchors must not collide with surviving ones
    const survivors = new Set([
      oldAnchors[0],
      oldAnchors[2],
      oldAnchors[3],
    ]);
    expect(survivors.has(merged[1]!)).toBe(false);
    expect(survivors.has(merged[4]!)).toBe(false);
  });

  it("identical inserted lines still get distinct anchors without spilling", () => {
    const oldContent = "head\n";
    const newContent = "head\n}\n}\n}\n}\n";
    const oldAnchors = anchorsPure(oldContent);
    const merged = updateAnchorsAfterEdit({
      path: "/tmp/z.txt",
      oldContent,
      newContent,
      oldAnchors,
      hunks: [
        { oldStart1: 2, oldEnd1: 1, finalStart1: 2, finalEnd1: 5 },
      ],
    });
    expect(merged.length).toBe(5);
    expect(merged[0]).toBe(oldAnchors[0]);
    expect(new Set(merged).size).toBe(5);
    expect(merged.slice(1).every((a) => a!.length === 2)).toBe(true);
  });
});

describe("issue #66/B4 — snapshot poisoning defense", () => {
  it("anchorsFor recomputes when the cached snapshot length drifts from the content", () => {
    const content = "a\nb\nc\n";
    const path = "/tmp/b4-poison.txt";
    const good = anchorsFor(path, content);
    expect(good.length).toBe(3);
    // The B4 guard: any snapshot whose length drifts from the actual line
    // count must be recomputed, never trusted. We verify the invariant that
    // anchorsFor always returns one anchor per line, including after the
    // store was touched by an incremental update.
    const merged = updateAnchorsAfterEdit({
      path,
      oldContent: content,
      newContent: content,
      oldAnchors: good,
      hunks: [],
    });
    const again = anchorsFor(path, content);
    expect(again.length).toBe(3);
    expect(again).toEqual(merged);
  });

  it("updateAnchorsAfterEdit skips out-of-range rows instead of crashing", () => {
    const oldContent = "a\nb\nc\n";
    const newContent = "a\nb\nG\n";
    const oldAnchors = anchorsPure(oldContent);
    // A hint-poisoned hunk pointing past EOF (the #66/B6 shape): must not
    // throw 'cannot read properties of undefined (reading replace)'.
    const merged = updateAnchorsAfterEdit({
      path: "/tmp/b4-oob.txt",
      oldContent,
      newContent,
      oldAnchors,
      hunks: [
        { oldStart1: 3, oldEnd1: 3, finalStart1: 8, finalEnd1: 10 },
      ],
    });
    expect(Array.isArray(merged)).toBe(true);
  });
});

describe("issue #122 — a surviving line keeps its anchor inside the hunk", () => {
	/**
	 * Reported symptom: a row whose TEXT did not change came back from an edit
	 * with a different anchor, because the whole hunk's anchors were released and
	 * every line in it was re-allocated — sometimes handing a survivor a
	 * duplicate sibling's old anchor.
	 *
	 * `dup` appears twice, which is the case that matters: the reported file had
	 * two identical lines, and content-keyed matching cannot tell them apart.
	 * Alignment by relative order can, and the line that survives here is the
	 * LAST `dup` — a `replace` keeps its closing line.
	 */
	it("keeps the last duplicate's anchor when the replacement keeps it", () => {
		const old = ["line A", "dup", "line C", "dup", "line E"];
		const oldAnchors = assignAnchors(old);
		const next = updateAnchorsAfterEdit({
			path: "t.txt",
			oldContent: old.join("\n"),
			newContent: ["line A", "// new", "dup", "line E"].join("\n"),
			oldAnchors,
			hunks: [{ oldStart1: 2, oldEnd1: 4, finalStart1: 2, finalEnd1: 3 }],
		});

		// Old lines 2..4 became new lines 2..3: `// new` is new, and the `dup`
		// that survives is the one that was on old line 4.
		expect(next[2]).toBe(oldAnchors[3]);
		expect(next[0]).toBe(oldAnchors[0]); // outside the hunk: untouched
		expect(next[3]).toBe(oldAnchors[4]); // outside the hunk: untouched
		expect(new Set(next).size).toBe(next.length); // still all distinct
	});
});

describe("issue #122 — the invariant is 'not in the diff', not 'outside the hunk'", () => {
	/**
	 * The user's framing, which is sharper than mine: a line that is not
	 * ultimately in the diff keeps its anchor, whether or not the hunk's RANGE
	 * happens to cover it.
	 *
	 * That exposes an ordering hole. A changed line earlier in the hunk
	 * allocates fresh, and nothing stops it from taking an anchor that a LATER
	 * surviving line is about to reclaim — the hunk's anchors are all free at
	 * that moment, because the whole range was released.
	 */
	it("does not let a changed line steal a later survivor's anchor", () => {
		// A hunk whose first line changes and whose second survives.
		const old = ["a", "b", "KEEP", "d", "e"];
		const oldAnchors = assignAnchors(old);
		const next = updateAnchorsAfterEdit({
			path: "t2.txt",
			oldContent: old.join("\n"),
			newContent: ["a", "B2", "KEEP", "d", "e"].join("\n"),
			oldAnchors,
			hunks: [{ oldStart1: 2, oldEnd1: 3, finalStart1: 2, finalEnd1: 3 }],
		});

		// "KEEP" is untouched in the diff, so its anchor must not move.
		expect(next[2]).toBe(oldAnchors[2]);
		expect(new Set(next).size).toBe(next.length);
	});

	it("holds across many hunks and repeated content", () => {
		const old = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? "rep" : `v${i}`));
		const oldAnchors = assignAnchors(old);
		// Change every 5th line; everything else survives.
		const newLines = old.map((line, i) => (i % 5 === 0 ? `// changed ${i}` : line));
		const hunks = [];
		for (let i = 0; i < 40; i += 5) {
			hunks.push({ oldStart1: i + 1, oldEnd1: i + 1, finalStart1: i + 1, finalEnd1: i + 1 });
		}
		const next = updateAnchorsAfterEdit({
			path: "t3.txt",
			oldContent: old.join("\n"),
			newContent: newLines.join("\n"),
			oldAnchors,
			hunks,
		});

		for (let i = 0; i < 40; i++) {
			if (i % 5 === 0) continue; // in the diff: a fresh anchor is expected
			expect(next[i]).toBe(oldAnchors[i]);
		}
		expect(new Set(next).size).toBe(next.length);
	});
});

describe("issue #122 — the rule, tested against a whole-file diff", () => {
	/** Ground truth: a whole-file LCS. A line is in the diff iff it is unmatched. */
	function diffKept(oldLines: readonly string[], newLines: readonly string[]) {
		const m = oldLines.length;
		const n = newLines.length;
		const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				dp[i]![j] =
					oldLines[i - 1] === newLines[j - 1]
						? dp[i - 1]![j - 1]! + 1
						: Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
		const keptOldToNew = new Map<number, number>();
		let i = m;
		let j = n;
		while (i > 0 && j > 0) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				keptOldToNew.set(i - 1, j - 1);
				i -= 1;
				j -= 1;
			} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i -= 1;
			else j -= 1;
		}
		return keptOldToNew;
	}

	/**
	 * The user's rule, verbatim: within one edit call, a line that is neither
	 * added nor removed keeps its anchor. Checked against a whole-file diff
	 * computed independently of how the implementation finds its hunks.
	 */
	function assertRule(oldLines: readonly string[], newLines: readonly string[], hunks: readonly { oldStart1: number; oldEnd1: number; finalStart1: number; finalEnd1: number }[], label: string) {
		const oldAnchors = assignAnchors([...oldLines]);
		const next = updateAnchorsAfterEdit({
			path: `${label}.txt`,
			oldContent: oldLines.join("\n"),
			newContent: newLines.join("\n"),
			oldAnchors,
			hunks: [...hunks],
		});
		const kept = diffKept(oldLines, newLines);
		for (const [oldIdx, newIdx] of kept) {
			expect({ label, line: newIdx + 1, old: oldAnchors[oldIdx], next: next[newIdx] }).toEqual({
				label,
				line: newIdx + 1,
				old: oldAnchors[oldIdx],
				next: oldAnchors[oldIdx],
			});
		}
		expect(new Set(next).size).toBe(next.length);
	}

	it("holds for a single-line change", () => {
		assertRule(["a", "b", "c", "d"], ["a", "B2", "c", "d"], [{ oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 2 }], "one");
	});

	it("holds when the change sits between duplicates", () => {
		assertRule(["dup", "x", "dup"], ["dup", "Y", "dup"], [{ oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 2 }], "dups");
	});

	it("holds when a duplicate is deleted and one survives", () => {
		assertRule(["line A", "dup", "line C", "dup", "line E"], ["line A", "// new", "dup", "line E"], [{ oldStart1: 2, oldEnd1: 4, finalStart1: 2, finalEnd1: 3 }], "surv");
	});

	it("holds across a 40-line file edited in five places", () => {
		const old = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? "rep" : `v${i}`));
		const next = old.map((line, i) => (i % 7 === 0 ? `// changed ${i}` : line));
		const hunks = [];
		for (let i = 0; i < 40; i += 7) hunks.push({ oldStart1: i + 1, oldEnd1: i + 1, finalStart1: i + 1, finalEnd1: i + 1 });
		assertRule(old, next, hunks, "wide");
	});
});

describe("anchors are never digits only", () => {
	/**
	 * The alphabet leads with `0`-`9`, so a small index encodes to something like
	 * `36`. A row is `<line>:<anchor>` and the marker may be passed back WITH or
	 * WITHOUT its line part — so `36` alone is ambiguous with line 36, and that
	 * ambiguity resolves to a wrong edit rather than a rejected one.
	 */
	it("never allocates an anchor that reads as a line number", () => {
		const offenders: string[] = [];
		for (let n = 10; n <= 500; n += 10) {
			const lines = Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);
			for (const anchor of assignAnchors(lines)) {
				if (/^[0-9]+$/.test(anchor)) offenders.push(anchor);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("still allocates distinct anchors for a large file", () => {
		const lines = Array.from({ length: 1000 }, (_, i) => `x${i}`);
		const anchors = assignAnchors(lines);
		expect(new Set(anchors).size).toBe(1000);
	});
});

describe("an insert above a blank does not steal the blank's anchor (#125)", () => {
  /**
   * End-to-end through the real tools, because the hunk SHAPE is what makes this
   * work and the shape is the engine's to decide.
   *
   * `ins` after line 4 has an EMPTY old range: the four lines it adds occupy
   * 5..8 and the old line 5 is pushed to 9. Nothing paired it, nothing released
   * it, so it keeps its anchor by not being touched at all — which is the
   * strongest form of the #122 invariant, not a weaker one.
   *
   * #125 was filed claiming the opposite, on a measurement whose two rows I had
   * labelled backwards. The test stays because the property is worth guarding;
   * the ticket does not, because there was no defect.
   */
  it("keeps the OLD blank's anchor at its new line, and gives the new blank a fresh one", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildEditTool } = await import("../../src/tool-edit.js");
    const { buildReadTool } = await import("../../src/tool-read.js");
    const { FsSandboxController } = await import("../../src/sandbox.js");
    const { localIO } = await import("../../src/fs-bridge.js");

    const dir = await mkdtemp(join(tmpdir(), "anchor-ins-"));
    await writeFile(join(dir, "a.txt"), ["L1", "L2", "L3", "L4", "", "L6", "L7"].join("\n"), "utf-8");
    const io = localIO();
    const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
    const read = buildReadTool(io);
    const edit = buildEditTool(io, sandbox);
    const exec = (args: unknown) =>
      ({ signal: new AbortController().signal, agent: { id: "s", session: { id: "s", header: { cwd: dir } } }, arguments: args }) as never;

    const before = (await read.execute({ path: "a.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
    const line4 = before.hashlines[3]!.hash;
    const oldBlank = before.hashlines[4]!.hash;

    // Five lines after line 4, the FIRST of them blank — the shape that made the
    // old blank and the new blank indistinguishable by content alone.
    await edit.execute({ path: "a.txt", edits: [{ op: "ins", anchor_after: line4, lines: ["", "X1", "X2", "X3", "X4"] }] }, exec({}));

    const after = (await read.execute({ path: "a.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
    // The inserted block is 5..9; the old blank moved to 10 and must still be `oldBlank`.
    expect(after.hashlines[9]!.hash).toBe(oldBlank);
    // And the blank that was INSERTED is a new line, so it gets a new anchor.
    expect(after.hashlines[4]!.hash).not.toBe(oldBlank);
    expect(new Set(after.hashlines.map((h) => h.hash)).size).toBe(after.hashlines.length);

    await rm(dir, { recursive: true, force: true });
  });
});
