import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  lineHashesPure,
  resEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("applyEdit — recovery scenarios", () => {
  it("autocorrects reversed range (start > end)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `4#${hashes[3]!}`,
      remove_to: `2#${hashes[1]!}`, replacement_text: "X" },
    ));
    expect(result.content).toBe("a\nX\ne");
    expect(result.warnings?.[0]).toMatch(/reversed remove_from\/remove_to/);
  });

  it("rejects stale anchor", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, resEdit(
        { remove_from: `1#${hashes[0]!}`,
        remove_to: `2#${hashes[1]!}`, replacement_text: "X\nY" },
      ), undefined, ["STALE", "STALE", "STALE", "STALE", "STALE"])
    ).toThrow(/E_STALE_ANCHOR/);
  });

  it("shows current context around the resolved anchor when only one anchor of a range is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleStart = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: "1#ZZZ",
        remove_to: `3#${hashes[2]!}`, replacement_text: "X" },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
    expect(caught!.message).toMatch(/Echo of the line you tried/);
    expect(caught!.message).toContain(`3#${hashes[2]}:c`);
  });

  it("shows context anchored on the start when only the end is stale", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const staleEnd = "ZZZ";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: `1#${hashes[0]!}`,
        remove_to: "1#ZZZ", replacement_text: "X" },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Echo of the line you tried/);
    expect(caught!.message).toContain(`1#${hashes[0]}:a`);
  });

  it("always echoes ±3 context, even when both anchors are stale", async () => {
    // [E_STALE_ANCHOR] UX is now consistent with [E_RANGE_UNVERIFIED]:
    // when both anchors fail validation, the model still gets a ±3 read-format
    // echo around the requested line (claimed line as fallback when neither
    // anchor is resolved). This is the only path the model has to recover
    // the content via the fresh marker.
    const content = "a\nb\nc";
    let caught: Error | undefined;
    try {
      applyEdit(content, resEdit(
        { remove_from: "1#ZZZ",
        remove_to: "1#YYY", replacement_text: "X" },
      ));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/Echo of the line you tried/);
    expect(caught!.message).toMatch(/ANCHOR:FILELINE/);
  });

  it("validates at the exact line#hash (no hash-only ambiguity)", () => {
    // With line#hash, identical content at multiple positions is no longer
    // ambiguous: each (line, hash) pair is unique. Send the same hash at
    // line 1 and the file's first line resolves cleanly.
    const content = "a\nb\nc\nd\ne";
    const hashes = lineHashesPure(content);
    const forgedHashes = [hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!, hashes[0]!];
    const result = applyEdit(content, resEdit(
      { remove_from: `1#${hashes[0]!}`,
      remove_to: `1#${hashes[0]!}`, replacement_text: "X" },
    ), undefined, forgedHashes);
    expect(result.content).toBe("X\nb\nc\nd\ne");
  });

  it("rejects unknown fields in edit items", () => {
    const edit = { remove_from: "1#ZZZ", remove_to: "1#ZZZ", replacement_text: "x", extra: true } as any;
    expect(() => resEdit(edit)).toThrow(/unknown or unsupported fields/);
  });

  it("rejects missing replacement_text", () => {
    const edit = { remove_from: "1#ZZZ",
    remove_to: "1#ZZZ" } as any;
    expect(() => resEdit(edit)).toThrow(/requires a "replacement_text" field/);
  });

  it("rejects null replacement_text", () => {
    const edit = { remove_from: "1#ZZZ",
    remove_to: "1#ZZZ", replacement_text: null } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("rejects array replacement_text", () => {
    const edit = { remove_from: "1#ZZZ",
    remove_to: "1#ZZZ", replacement_text: ["hello", "world"] } as any;
    expect(() => resEdit(edit)).toThrow(/must be a string with \\n line separators, not an array/);
  });

  it("accepts string replacement_text with line separators", () => {
    const edit = { remove_from: "1#ZZZ",
    remove_to: "1#ZZZ", replacement_text: "hello\nworld\n" } as any;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["hello", "world", ""]);
  });

  it("rejects malformed hash_bounds", () => {
    const edit = { remove_from: "not-valid",
    remove_to: "not-valid", replacement_text: "x" };
    expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
  });

  it("strips bare hash prefix in content_lines", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: `${hashes[1]!}:b\nX` },
    ));
    expect(result.content).toBe("a\nb\nX\nd\ne");
    expect(result.warnings?.[0]).toMatch(/stripped "HASH:" prefix/);
  });

  it("strips diff preview rows in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `2#${hashes[1]!}`, replacement_text: `+${hashes[1]!}:B` },
    ));
    expect(result.content).toBe("a\nB\nc");
    expect(result.warnings?.[0]).toMatch(/stripped diff-preview marker/);
  });

  it("warns on unicode escape sequences in content", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `2#${hashes[1]!}`, replacement_text: "\\uDDDD" },
    ));
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain("\\uDDDD");
  });

  it("handles tab characters in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `3#${hashes[2]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: "\t\treplaced" },
    ));
    expect(result.content).toBe("a\nb\n\t\treplaced");
  });

  it("preserves literal tab in content_lines", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `3#${hashes[2]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: "\t\treplaced" },
    ));
    expect(result.content).toContain("\t\treplaced");
  });

  it("detects noop when content unchanged", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `2#${hashes[1]!}`, replacement_text: "b" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("detects noop for range", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: "b\nc" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("handles single-line file", async () => {
    const content = "hello";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `1#${hashes[0]!}`,
      remove_to: `1#${hashes[0]!}`, replacement_text: "world" },
    ));
    expect(result.content).toBe("world");
  });

  it("handles append to last line", async () => {
    const content = "a\nb";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `2#${hashes[1]!}`,
      remove_to: `2#${hashes[1]!}`, replacement_text: "b\nc" },
    ));
    expect(result.content).toBe("a\nb\nc");
  });

  it("handles delete of first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `1#${hashes[0]!}`,
      remove_to: `1#${hashes[0]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("handles delete of last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `3#${hashes[2]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("handles edit of entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `1#${hashes[0]!}`,
      remove_to: `3#${hashes[2]!}`, replacement_text: "x\ny" },
    ));
    expect(result.content).toBe("x\ny");
  });
});
