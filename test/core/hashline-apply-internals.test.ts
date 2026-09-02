import { describe, expect, it } from "vitest";
import {
  applyEdit,
  lineHashes,
  resEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("resAnchor (via applyEdit)", () => {
  it("resolves a hash that exists exactly once", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

	it("reports not_found for a hash that does not exist", () => {
		const content = "a\nb\nc\nd\ne";
		expect(() =>
			applyEdit(content,
				resEdit(
					{ remove_from: `ZZZZ`, remove_to: `ZZZZ`, replacement_text: "X" },
				))
		// #59 contract: an anchor that does not resolve renders [E_STALE] with the
		// ±context echo + fresh markers (the -1 sentinel no longer leaks into an
		// "out of range" message).
		).toThrow(/E_STALE/);
	});

	it("rejects an anchor whose hash doesn't match current content (stale drift)", async () => {
		// v2.0: anchors are unique per row; a bare anchor that no longer exists
		// (or was never served) is rejected via [E_STALE] with an echo block.
		const content = "a\nb\nc\nd\ne";
		expect(() =>
			applyEdit(content,
				resEdit(
					{ remove_from: `ZZZZ`, remove_to: `ZZZZ`, replacement_text: "X" },
				))
		).toThrow(/E_STALE/);
	});
});

describe("checkBoundaryDup (via applyEdit) — detection (issue #66/B7: warning-only)", () => {
  it("detects trailing duplication but keeps the row, with a warning", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X\nd" },
    ));
    // #66/B7: the duplicated "d" is KEPT (old behavior silently dropped it).
    expect(result.content).toBe("a\nX\nd\nd");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("auto-fixes leading duplication", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "a\nX" },
    ));
    expect(result.content).toBe("a\na\nX\nd");
    expect(result.autoFixes).toBeUndefined();
  });

  it("does not auto-fix when replacement does not duplicate adjacent lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X\nY" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("does not auto-fix when replacement edge is empty string", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "" },
    ));
    expect(result.autoFixes ?? []).toHaveLength(0);
  });

  it("auto-fixes trailing duplication when content_lines has trailing empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: `X\nd\n` },
    ));
    expect(result.content).toBe("a\nX\nd\n\nd");
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("auto-fixes leading duplication when content_lines has leading empty lines", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: `\na\nX` },
    ));
    expect(result.content).toBe("a\n\na\nX\nd");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("auto-fixes both trailing and leading in one edit", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "a\nd" },
    ));
    expect(result.content).toBe("a\na\nd\nd");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("keeps a non-unique adjacent duplicate row (old auto-fix case) with a warning", async () => {
    const content = "if (a) {\n  x();\n}\nif (b) {\n  y();\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, resEdit(
      { remove_from: `${hashes[3]!}`, remove_to: `${hashes[4]!}`, replacement_text: "if (b) {\n  yNew();\n}" },
    ));
    // v2.0 #66/B7: the "if (b) {" row the old auto-fixer swallowed is kept.
    expect(result.content).toBe("if (a) {\n  x();\n}\nif (b) {\n  yNew();\n}\n}\n");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });
});

describe("resToSpan (via applyEdit)", () => {
  it("branch: non-empty replacement in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X\nY" },
    ));
    expect(result.content).toBe("a\nX\nY\nd\ne");
  });

  it("branch: empty replacement (deletion) in middle of file", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nd\ne");
  });

  it("branch: empty replacement covering entire file", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    expect(() =>
      applyEdit(content, 
resEdit(
        { remove_from: `${hashes[0]!}`, remove_to: `${hashes[2]!}`, replacement_text: "" },
      ))
    ).toThrow(/E_WOULD_EMPTY/);
  });

  it("branch: empty replacement ending at last line (not full file)", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[2]!}`, remove_to: `${hashes[4]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });

  it("branch: noop detection returns noop span", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[1]!}`, replacement_text: "b" },
    ));
    expect(result.noopEdit).toBeDefined();
  });

  it("branch: replacement at first line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[0]!}`, remove_to: `${hashes[0]!}`, replacement_text: "X" },
    ));
    expect(result.content).toBe("X\nb\nc");
  });

  it("branch: replacement at last line", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[2]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X" },
    ));
    expect(result.content).toBe("a\nb\nX");
  });

  it("branch: deletion of first line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[0]!}`, remove_to: `${hashes[0]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("b\nc");
  });

  it("branch: deletion of last line only", async () => {
    const content = "a\nb\nc";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[2]!}`, remove_to: `${hashes[2]!}`, replacement_text: "" },
    ));
    expect(result.content).toBe("a\nb");
  });
});

describe("assemble (via applyEdit)", () => {
  it("applies a single edit in the middle", async () => {
    const content = "a\nb\nc\nd\ne";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[0]!}`, remove_to: `${hashes[0]!}`, replacement_text: "A" },
    ));
    expect(result.content).toBe("A\nb\nc\nd\ne");
  });
});

describe("auto-fix via applyEdit — legacy cases under #66/B7 warning-only contract", () => {
  it("auto-fixes trailing duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: `new one\nnew two\nafter` },
    ));
    expect(result.content).toBe("before\nnew one\nnew two\nafter\nafter");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("auto-fixes leading duplication", async () => {
    const content = "before\nold one\nold two\nafter";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: `before\nnew one\nnew two` },
    ));
    expect(result.content).toBe("before\nbefore\nnew one\nnew two\nafter");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("auto-fixes both leading and trailing in one edit", async () => {
    const content = "ctx1\nctx2\nold1\nold2\nctx3\nctx4";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[2]!}`, remove_to: `${hashes[3]!}`, replacement_text: `ctx2\ndup\ndup\nctx3` },
    ));
    expect(result.content).toBe("ctx1\nctx2\nctx2\ndup\ndup\nctx3\nctx3\nctx4");
    expect(result.autoFixes).toBeUndefined();
  });
});

describe("boundary-dup detection (issue #66/B7 — warning-only, content preserved)", () => {
  it("keeps a replacement line that matches the line after the range, with a warning", async () => {
    const content = "a\nb\nc\nd";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "X\nd" },
    ));
    // v2.0 #66/B7: the "d" must be KEPT (the old behavior silently dropped it).
    expect(result.content).toBe("a\nX\nd\nd");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("keeps an edge-duplicated full-range replacement and reports a noop with a warning", async () => {
    const content = "class A {\n  x = 1;\n\n  constructor() {}\n}\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[0]!}`, remove_to: `${hashes[2]!}`, replacement_text: "class A {\n  x = 1;\n\n  constructor() {}\n}" },
    ));
    // v2.0 #66/B7: boundary rows are kept verbatim (no silent dedup), so the
    // replacement appends a duplicate tail — observable via warning, not magic.
    expect(result.content).toBe(content + "  constructor() {}\n}\n");
    expect(result.noopEdit).toBeUndefined();
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });

  it("keeps a leading boundary duplicate (noop) instead of stripping it", async () => {
    const content = "foo();\nbar();\nbaz();\n";
    const hashes = await lineHashes(content, home.testPath);
    const result = applyEdit(content, 
resEdit(
      { remove_from: `${hashes[1]!}`, remove_to: `${hashes[2]!}`, replacement_text: "bar();\nbaz();\nfoo();" },
    ));
    // v2.0 #66/B7: kept verbatim — foo(); is appended again + warning.
    expect(result.content).toBe("foo();\nbar();\nbaz();\nfoo();\n");
    expect(result.autoFixes).toBeUndefined();
    expect(result.warnings?.join("\n")).toMatch(/\[E_PASTE_DUP\]/);
  });
});
