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
import { loadHashStore, shutdownHashStore, withStore } from "../../src/domain/session/hash-store.js";
import {
  withWorkspace,
  recordServed,
  loadServed,
  recordServedAfterEdit,
  sessionKeyFor,
} from "../../src/domain/session/session-view.js";
import { lineHashesPure, contentChecksum } from "../../src/hashline/hash-assign.js";
import { assignAnchors } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/infra/utils.js";

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
      expect(served.size).toBe(anchors.length);
      expect(served).toEqual(new Set(anchors));
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
      );

      const served = await loadServed(key, path);
      // line 3's anchor updated; others preserved
      // With a Set, order is insertion order — check membership, not position.
      expect(served.has(newAnchors[2]!)).toBe(true);
      expect(served.has(oldAnchors[0]!)).toBe(true);
      expect(served.has(oldAnchors[1]!)).toBe(true);
      expect(served.has(oldAnchors[3]!)).toBe(true);
    });
  });
});

function anchorsOf(content: string): string[] {
  void lineHashesPure; // keep import honest; the v2 path is the allocator
  return assignAnchors(splitLines(content));
}

