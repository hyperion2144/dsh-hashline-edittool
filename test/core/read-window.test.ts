/**
 * #245 / ADR-0014 — read's line window: anchor cursors and the one-sentence tail.
 *
 * The line-number switch is OFF here (the shipped default, #244): rows carry
 * bare markers, so an anchor is the only way to name a line. These tests pin the
 * whole contract end to end — both cursor fields take a number OR an anchor, the
 * window is closed, an inverted range is the only new hard reject, failures
 * speak `edit`'s vocabulary (`E_STALE` for a dead anchor, `E_RANGE_UNVERIFIED`
 * for a served anomaly — never `E_RANGE_STALE`, which stays the checksum/version
 * guard's code), `resume` and a cursor are mutually exclusive, and the text ends
 * in exactly ONE sentence whichever exit the call took.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { getWritableTempRoot, setupIntegrationTest, getText, makeExec, type Harness } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "read-window-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

afterEach(() => {
	applyEffective({});
});

/** Twelve labelled lines — the label is how a test names a line in the output. */
function twelveLines(): string {
	return Array.from({ length: 12 }, (_, i) => `line-${String(i + 1).padStart(2, "0")} content`).join("\n") + "\n";
}

async function makeCase(name: string): Promise<{ cwd: string; p: string }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	const p = join(cwd, "f.txt");
	await writeFile(p, twelveLines());
	return { cwd, p };
}

/** The anchor rendered on the row whose content is `<label> content`. */
function anchorOfLine(text: string, label: string): string {
	const row = text.split("\n").find((line) => line.includes(`${label} content`));
	expect(row, `no row for ${label}`).toBeDefined();
	const marker = /^\s*([A-Za-z0-9]{1,8}):/.exec(row!);
	expect(marker, `no marker on the ${label} row`).not.toBeNull();
	return marker![1]!;
}

/** `read` reports refusals as text; the caller never sees a throw. */
async function readText(h: Harness, args: Record<string, unknown>): Promise<string> {
	return getText(await h.readTool.execute("read", args));
}

describe("#245 read windows: anchors as cursors", () => {
	it("renders bare markers (switch OFF), and an anchor names the window's FIRST line", async () => {
		const { cwd } = await makeCase("offset-anchor");
		const h = setupIntegrationTest(cwd);
		const first = await readText(h, { path: "f.txt", offset: 1, limit: 3 });
		expect(first).toContain("line-03 content");
		expect(/^\s*[A-Za-z0-9]{1,8}:\d+:/m.test(first)).toBe(false);
		expect(first).toContain("[Lines 1-3 of 12. Use offset=\"");

		const anchor = anchorOfLine(first, "line-03");
		const rest = await readText(h, { path: "f.txt", offset: anchor });
		expect(rest).toContain("line-03 content");
		expect(rest).toContain("line-12 content");
		expect(rest).not.toContain("line-02 content");
		expect(rest).toContain("[Lines 3-12 of 12. End of file.]");
	});

	it("an anchor as `limit` stops AT that line — the range is closed", async () => {
		const { cwd } = await makeCase("limit-anchor");
		const h = setupIntegrationTest(cwd);
		const whole = await readText(h, { path: "f.txt" });
		const seventh = anchorOfLine(whole, "line-07");

		const win = await readText(h, { path: "f.txt", offset: 5, limit: seventh });
		expect(win).toContain("line-05 content");
		expect(win).toContain("line-07 content");
		expect(win).not.toContain("line-04 content");
		expect(win).not.toContain("line-08 content");
		// The continuation cursor is the anchor of the LAST served line.
		expect(win).toContain(`[Lines 5-7 of 12. Use offset="${seventh}" to continue.]`);
	});

	it("numbers and anchors mix in either field", async () => {
		const { cwd } = await makeCase("mixed");
		const h = setupIntegrationTest(cwd);
		const whole = await readText(h, { path: "f.txt" });
		const second = anchorOfLine(whole, "line-02");
		const fourth = anchorOfLine(whole, "line-04");

		// anchor start + numeric count (four rows from line 2)
		expect(await readText(h, { path: "f.txt", offset: second, limit: 4 })).toContain("[Lines 2-5 of 12.");
		// numeric start + anchor end
		expect(await readText(h, { path: "f.txt", offset: 3, limit: fourth })).toContain("[Lines 3-4 of 12.");
		// anchor start + anchor end
		expect(await readText(h, { path: "f.txt", offset: second, limit: fourth })).toContain("[Lines 2-4 of 12.");
	});

	it("an inverted range is the ONE new hard reject", async () => {
		const { cwd } = await makeCase("inverted");
		const h = setupIntegrationTest(cwd);
		const whole = await readText(h, { path: "f.txt" });
		const ninth = anchorOfLine(whole, "line-09");
		const fourth = anchorOfLine(whole, "line-04");

		const text = await readText(h, { path: "f.txt", offset: ninth, limit: fourth });
		expect(text).toContain("[E_BAD_SHAPE]");
		expect(text).toContain("ends before it starts");
	});

	it("a dead anchor is `[E_STALE]` — read speaks edit's vocabulary", async () => {
		const { cwd } = await makeCase("dead");
		await writeFile(join(cwd, "other.txt"), "other-1 content\nother-2 content\nother-3 content\n");
		const h = setupIntegrationTest(cwd);
		const other = await readText(h, { path: "other.txt", offset: 1, limit: 2 });
		const foreign = anchorOfLine(other, "other-2");

		const text = await readText(h, { path: "f.txt", offset: foreign });
		expect(text).toContain("[E_STALE]");
		expect(text).toContain("not live");
		// Not the checksum code: `E_RANGE_STALE` belongs to the version guard.
		expect(text).not.toContain("[E_RANGE_STALE]");
	});

	it("a served line that changed afterwards is `[E_RANGE_UNVERIFIED]`, not `E_RANGE_STALE`", async () => {
		const { cwd, p } = await makeCase("changed");
		const h = setupIntegrationTest(cwd);
		const first = await readText(h, { path: "f.txt", offset: 1, limit: 3 });
		const third = anchorOfLine(first, "line-03");

		await writeFile(p, twelveLines().replace("line-03 content", "line-03 REWRITTEN"));

		const text = await readText(h, { path: "f.txt", offset: third });
		expect(text).toContain("[E_RANGE_UNVERIFIED]");
		expect(text).not.toContain("[E_RANGE_STALE]");
	});

	it("a pasted `line#hash` marker is `[E_BAD_REF]`, never a cursor", async () => {
		const { cwd } = await makeCase("bad-ref");
		const h = setupIntegrationTest(cwd);
		const text = await readText(h, { path: "f.txt", offset: "7#abc" });
		expect(text).toContain("[E_BAD_REF]");
	});

	it("`resume` together with a cursor is `[E_RESUME_CONFLICT]`", async () => {
		const { cwd } = await makeCase("conflict");
		const h = setupIntegrationTest(cwd);
		expect(await readText(h, { path: "f.txt", resume: "rs-00000000000000000000000000000000", offset: 1 })).toContain(
			"[E_RESUME_CONFLICT]",
		);
		expect(await readText(h, { path: "f.txt", resume: "rs-00000000000000000000000000000000", limit: 2 })).toContain(
			"[E_RESUME_CONFLICT]",
		);
	});
});

describe("#245 read windows: the one closing sentence", () => {
	it("a window that ends at EOF says so, exactly once", async () => {
		const { cwd } = await makeCase("eof");
		const h = setupIntegrationTest(cwd);
		const text = await readText(h, { path: "f.txt", offset: 10 });
		expect(text).toContain("[Lines 10-12 of 12. End of file.]");
		expect(text.trimEnd().endsWith("End of file.]")).toBe(true);
	});

	it("a window with more to come offers the anchor of its LAST served line", async () => {
		const { cwd } = await makeCase("continue");
		const h = setupIntegrationTest(cwd);
		const text = await readText(h, { path: "f.txt", offset: 1, limit: 3 });
		const third = anchorOfLine(text, "line-03");
		expect(text).toContain(`[Lines 1-3 of 12. Use offset="${third}" to continue.]`);
		// The sentence replaces the retired renderer footers rather than joining them.
		expect(text).not.toContain("[Showing lines");
		expect(text).not.toContain("[End of file - total");
	});

	it("an empty file is a REAL serve: window {1,1,1}, one synthetic row, one notice", async () => {
		const { cwd } = await makeCase("empty");
		const tool = buildReadTool(localIO());
		const args = { path: "empty.txt" };
		await writeFile(join(cwd, "empty.txt"), "");
		const value = (await tool.execute(args, makeExec(cwd, "empty-session")(args))) as unknown as {
			totalLines: number;
			lines: Array<{ number: number; text: string }>;
			window?: { start: number; end: number; totalLines: number };
			modelText: string;
		};
		expect(value.window).toEqual({ start: 1, end: 1, totalLines: 1 });
		expect(value.totalLines).toBe(1);
		expect(value.lines.map((line) => line.number)).toEqual([1]);
		expect(value.modelText.trimEnd().endsWith("[File is empty. Use edit to insert content.]")).toBe(true);
	});

	it("an offset past the end serves nothing and carries NO window", async () => {
		const { cwd } = await makeCase("beyond");
		const tool = buildReadTool(localIO());
		const args = { path: "f.txt", offset: 99 };
		const value = (await tool.execute(args, makeExec(cwd, "beyond-session")(args))) as unknown as {
			window?: unknown;
			offset: number;
			modelText: string;
		};
		expect(value.window).toBeUndefined();
		expect(value.offset).toBe(99);
		expect(value.modelText).toContain(
			"[No lines read. Offset 99 is beyond end of file (12 lines total). Use offset=1 to read from the start.]",
		);
	});

	it("JSON mode stays PURE JSON and carries the window INSIDE the object", async () => {
		const { cwd } = await makeCase("json");
		applyEffective({ output_format: "json" });
		const tool = buildReadTool(localIO());
		const args = { path: "f.txt", offset: 5, limit: 2 };
		const value = (await tool.execute(args, makeExec(cwd, "json-session")(args))) as unknown as {
			modelText: string;
			window?: { start: number; end: number; totalLines: number };
		};
		const parsed = JSON.parse(value.modelText) as {
			offset: number;
			window?: { start: number; end: number; totalLines: number };
			lines: Record<string, string>;
		};
		expect(parsed.window).toEqual({ start: 5, end: 6, totalLines: 12 });
		expect(value.window).toEqual(parsed.window);
		expect(parsed.offset).toBe(5);
		// No prose tail may ride outside the object (#245 story: JSON is parseable).
		expect(value.modelText).not.toContain("[Lines ");
	});
});
