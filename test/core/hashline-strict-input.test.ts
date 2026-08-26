import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	resEdit,
	type HTEdit,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("edit input validation", () => {
	it("keeps a bare hash: content prefix as literal (only line#hash: rows strip)", async () => {
		const file = "foo\nbar";
		const hashes = await lineHashes(file, home.testPath);
		const toolEdit: HTEdit = { remove_from: `1#${hashes[0]!}`, remove_to: `1#${hashes[0]!}`, replacement_text: `${hashes[0]!}:FOO` };
    const result = applyEdit(file, resEdit(toolEdit));
		// a bare `hash:` prefix has no line number — it is NOT an anchor,
		// so it must survive verbatim (the line locates, line#hash is the
		// only anchor form).
		expect(result.content).toBe(`${hashes[0]!}:FOO\nbar`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("rejects array replacement_text before patch-prefix validation", () => {
		const toolEdit: HTEdit = {
      remove_from: "1#ZZZ",
      remove_to: "1#ZZZ", replacement_text: ["+ZZZ:foo"],
    } as unknown as HTEdit;
    expect(() => resEdit(toolEdit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
    );
	});

	it("passes through numbered deletion rows as literal content", () => {
		const toolEdit: HTEdit = { remove_from: "1#ZZZ",
		remove_to: "1#ZZZ", replacement_text: "-1    foo" };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["-1    foo"]);
	});

	it("accepts plain literal content unchanged", () => {
		const toolEdit: HTEdit = { remove_from: "1#ZZZ",
		remove_to: "1#ZZZ", replacement_text: "bar" };
    const resolved = resEdit(toolEdit);
		expect(resolved.content_lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const toolEdit: HTEdit = { remove_from: "1#ZZZ",
		remove_to: "1#ZZZ", replacement_text: "# keep me" };
    const resolved = resEdit(toolEdit);
    expect(resolved.content_lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("keeps a bare hash: prefix verbatim even when the hash exists in the file", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `${betaHash}:### heading\nreal content` },
    hashes);
    expect(result.content).toBe(`${betaHash}:### heading\nreal content\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("keeps a bare hash: prefix verbatim (no line number = not an anchor)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const gammaHash = hashes[2]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `${gammaHash}:text` },
    hashes);
    expect(result.content).toBe(`${gammaHash}:text\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("keeps bare prefixes verbatim even when they look like hashes", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "ZZZ:one\nZZP:two" },
    hashes);
    expect(result.content).toBe("ZZZ:one\nZZP:two\nbeta\ngamma\ndelta");
    expect(result.warnings ?? []).toEqual([]);
	});

	it("strips a full line#hash: prefix and reports the replacement_text line", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `2#${hashes[1]!}:one\nreal` },
    hashes);
    expect(result.content).toBe("one\nreal\nbeta\ngamma\ndelta");
    expect(result.warnings?.[0]).toMatch(/replacement_text line 1/);
	});

	it("keeps a leading-space bare hash prefix verbatim (no line# = not an anchor)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `  ${hashes[1]!}:  indented` },
    hashes);
    expect(result.content).toBe(`  ${hashes[1]!}:  indented\nbeta\ngamma\ndelta`);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "TS: TypeScript" },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "# heading" },
    hashes);
    expect(result.warnings ?? []).toEqual([]);
	});

	it("keeps a long bare hash: content prefix verbatim (no truncation)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const betaHash = hashes[1]!;
		const longLine = `${betaHash}:${"y".repeat(500)}`;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: longLine },
    hashes);
    expect(result.content).toContain(`${betaHash}:${"y".repeat(500)}`);
    expect(result.warnings ?? []).toEqual([]);
	});
});

describe("diff preview rows copied into content", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("keeps a bare +hash: diff row verbatim (no line# = not an anchor)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `+${hashes[1]!}:### heading\nreal content` },
    hashes);
		expect(result.content).toBe(`+${hashes[1]!}:### heading\nreal content\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("keeps bare -hash: / -   : deletion rows verbatim", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `-${hashes[1]!}:one\n-   :two` },
    hashes);
		expect(result.content).toBe(`-${hashes[1]!}:one\n-   :two\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves numbered deletion rows as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "-1    foo" },
    hashes);
		expect(result.content).toBe("-1    foo\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves plain +x / -x unified-diff lines as literal content without warning", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "+added\n-removed" },
    hashes);
		expect(result.content).toBe("+added\n-removed\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});
});

describe("diff-prefix false-positive guards (tightened shapes)", () => {
	const file = "alpha\nbeta\ngamma\ndelta";

	function applyTool(toolEdit: HTEdit, precomputedHashes?: string[]) {
		return applyEdit(file, resEdit(toolEdit), undefined, precomputedHashes);
	}

	it("leaves literal '+ HASH:' content with a space after the plus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `+ ${hashes[1]!}:one` },
    hashes);
		expect(result.content).toBe(`+ ${hashes[1]!}:one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '- HASH:' content with a space after the minus untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `- ${hashes[1]!}:one` },
    hashes);
		expect(result.content).toBe(`- ${hashes[1]!}:one\nbeta\ngamma\ndelta`);
		expect(result.warnings ?? []).toEqual([]);
	});

	it("leaves literal '+ abc:' / '- xyz:' lines untouched", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: "+ abc:def\n- xyz:uvw" },
    hashes);
		expect(result.content).toBe("+ abc:def\n- xyz:uvw\nbeta\ngamma\ndelta");
		expect(result.warnings ?? []).toEqual([]);
	});

	it("strips a full +line#hash: row (anchored diff row)", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `+2#${hashes[1]!}:one` },
    hashes);
		expect(result.content).toBe("one\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/stripped diff-preview marker/);
	});

	it("strips full -line#hash: rows", async () => {
		const hashes = await lineHashes(file, home.testPath);
		const anchor = hashes[0]!;
		const result = applyTool(
      { remove_from: `1#${anchor}`,
      remove_to: `1#${anchor}`, replacement_text: `-2#${hashes[1]!}:one\n-1#   :two` },
    hashes);
		expect(result.content).toBe("one\ntwo\nbeta\ngamma\ndelta");
		expect(result.warnings?.[0]).toMatch(/stripped diff-preview marker/);
	});
});
