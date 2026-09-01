import { describe, expect, it } from "vitest";
import { lineHashes, resEdit, applyEdit } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("indentation-difference boundary rows (#66/B7 — warning-only)", () => {
  it("keeps a leading-duplicate replacement row when indentation matches, with warning", async () => {
    const file = "  foo\nbar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[1]!}`, replacement_text: "  foo\n  bar" },
    ));
    // #66/B7: kept verbatim — the tool never silently strips content.
    expect(result.content).toBe("  foo\n  foo\n  bar\n  baz");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("keeps a leading-duplicate row (indent+content match) with warning", async () => {
    const file = "  foo\n  bar\n  baz";
    const hashes = await lineHashes(file, home.testPath);
    const result = applyEdit(file, resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[1]!}`, replacement_text: "  foo\n  new" },
    ));
    expect(result.content).toBe("  foo\n  foo\n  new\n  baz");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });
});
