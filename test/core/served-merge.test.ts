/**
 * DIAG repro — "served mirror says never served right after read".
 *
 * Exercises the serve → persist → read-back → migrate loop at the module
 * seam (hash-store + session-view) without the dsh tool layer, in a
 * throwaway workspace, to isolate whether the in-session "never served"
 * failures come from the store/merge logic or from the tool layer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadHashStore, shutdownHashStore, withStore } from "../../src/hash-store.js";
import {
  withWorkspace,
  recordServed,
  loadServed,
  recordServedAfterEdit,
  _mergeServedRows,
  sessionKeyFor,
} from "../../src/session-view.js";
import { lineHashesPure, contentChecksum } from "../../src/hashline/hash-assign.js";
import { assignAnchors } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/utils.js";

const ws = mkdtempSync(join(tmpdir(), "diag-serve-"));
const path = join(ws, "a.txt");
const key = "diag-session";

afterAll(async () => {
  await shutdownHashStore();
  rmSync(ws, { recursive: true, force: true });
});

function makeFile(content: string) {
  // simulate a write the plugin's own write path does
  return content;
}

describe("serve loop round-trip (DIAG)", () => {
  it("read serves all rows; loadServed returns them intact", async () => {
    const content = makeFile("alpha\nbeta\ngamma\ndelta\n");
    await withWorkspace(ws, async () => {
      const store = await loadHashStore(ws);
      const anchors = anchorsOf(content);
      const rows = anchors.map((anchor, i) => ({
        position: i,
        anchor,
        contentKey: contentChecksum(splitLines(content)[i]!),
      }));
      await recordServed(key, path, rows, anchors.length);

      const served = await loadServed(key, path);
      expect(served.length).toBe(anchors.length);
      expect(served.some((v) => v === null)).toBe(false);
      expect(served).toEqual(anchors);
    });
  });

  it("after an edit, migrate keeps untouched rows served; re-read re-serves all", async () => {
    const oldContent = makeFile("alpha\nbeta\ngamma\ndelta\n");
    const newContent = makeFile("alpha\nbeta\nBETA2\ndelta\n");
    await withWorkspace(ws, async () => {
      const store = await loadHashStore(ws);
      const oldAnchors = anchorsOf(oldContent);
      const rows = oldAnchors.map((anchor, i) => ({
        position: i,
        anchor,
        contentKey: contentChecksum(splitLines(oldContent)[i]!),
      }));
      await recordServed(key, path, rows, oldAnchors.length);

      // simulate plugin edit: hunk at original line 3 (1-indexed), replaced by ["BETA2"]
      const newAnchors = anchorsOf(newContent);
      await recordServedAfterEdit(
        key,
        path,
        [{ position: 2, anchor: newAnchors[2]! }],
        newAnchors.length,
        oldAnchors,
        newAnchors,
      );

      const served = await loadServed(key, path);
      // line 3's anchor updated; others preserved
      expect(served[2]).toBe(newAnchors[2]);
      expect(served[0]).toBe(oldAnchors[0]);
      expect(served[1]).toBe(oldAnchors[1]);
      expect(served[3]).toBe(oldAnchors[3]);
      expect(served.some((v) => v === null)).toBe(false);
    });
  });
});

function anchorsOf(content: string): string[] {
  void lineHashesPure; // keep import honest; the v2 path is the allocator
  return assignAnchors(splitLines(content));
}

describe("merge doesn't corrupt under repeated serve", () => {
  it("re-serving overlapping windows yields no nulls", () => {
    const base: (string | null)[] = ["aa", "bb", "cc", null, null];
    const merged = _mergeServedRows(
      base,
      [
        { position: 3, anchor: "dd", contentKey: "x" },
        { position: 4, anchor: "ee", contentKey: "y" },
      ],
    );
    expect(merged).toEqual(["aa", "bb", "cc", "dd", "ee"]);
    expect(merged.some((v) => v === null)).toBe(false);
  });
});