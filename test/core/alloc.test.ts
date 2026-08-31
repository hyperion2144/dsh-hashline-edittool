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
  anchorsPure,
} from "../../src/hashline/session-anchors.js";
import { splitLines } from "../../src/utils.js";

const TWO_CHAR_CAPACITY = 62 ** 2;

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