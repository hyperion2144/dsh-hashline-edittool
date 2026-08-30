/**
 * Tests for the structured web-UI presentation (the dsh-tools
 * `output.presentationMeta` + `presentResult` contract) added to the
 * five hashline tools in 0.3.
 *
 * Mirrors the pattern in `@deepseek-ai/dsh-tool-fs` (the authoritative
 * reference for the contract): a tool that wants a typed card emits
 * structured metadata via `presentationMeta` and a typed view via
 * `presentResult`; the soft-validators in `presentation-helpers.ts`
 * fall back to the generic card on any malformed data so replay of
 * older logged calls degrades gracefully.
 *
 * The model-facing text is **byte-identical** to pre-0.3 — these tests
 * assert the structured value alongside the text, not the text shape
 * (text shape is covered by read-preview, edit-diff, line-hashline).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";

beforeAll(async () => {
});

describe("tool-read structured presentation", () => {
	it("returns a structured canonical value with lines + hashlines", async () => {
		await withTempFile("p.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { localIO } = await import("../../src/fs-bridge.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const tool = buildReadTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute({ path: "p.txt" }, exec({}))) as {
				path: string;
				offset: number;
				totalLines: number;
				lines: { number: number; text: string }[];
				hashlines: { number: number; hash: string; text: string }[];
				modelText: string;
			};
			expect(value.path).toBe("p.txt");
			expect(value.offset).toBe(1);
			expect(value.totalLines).toBe(3);
			expect(value.lines).toHaveLength(3);
			expect(value.lines[0]).toEqual({ number: 1, text: "alpha" });
			expect(value.lines[1]).toEqual({ number: 2, text: "beta" });
			expect(value.hashlines[0]?.hash).toMatch(/^[A-Za-z0-9]{3}$/);
			expect(value.hashlines[0]?.number).toBe(1);
			expect(value.modelText).toMatch(/^ANCHOR:FILELINE/);
		});
	});

	it("the model text starts with the hashline header and ends with the pagination footer", async () => {
		await withTempFile("p2.txt", "x\n".repeat(2500), async ({ cwd }) => {
			const { localIO } = await import("../../src/fs-bridge.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const tool = buildReadTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute({ path: "p2.txt" }, exec({}))) as { modelText: string; lines: { number: number }[] };
			expect(value.modelText.startsWith("ANCHOR:FILELINE")).toBe(true);
			expect(value.modelText).toMatch(/\[Showing lines 1-2000 of 2500/);
			expect(value.lines).toHaveLength(2000);
		});
	});
});

describe("tool-grep structured presentation", () => {
	it("returns files + truncated + total in the canonical value", async () => {
		await withTempFile("g.txt", "alpha\nbeta\nalpha-again\ngamma\n", async ({ cwd }) => {
			const { ctx } = setupIntegrationTest(cwd);
			const { buildGrepTool } = await import("../../src/tool-grep.js");
			const { localIO } = await import("../../src/fs-bridge.js");
			const tool = buildGrepTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute(
				{ path: "g.txt", pattern: "alpha" },
				exec(ctx),
			)) as {
				files: { path: string; matches: { lineNumber: number; line: string }[] }[];
				truncated: boolean;
				total: number;
				modelText: string;
			};
			expect(value.files).toHaveLength(1);
			expect(value.files[0]?.path).toBe("g.txt");
			expect(value.files[0]?.matches).toHaveLength(2);
			expect(value.total).toBe(2);
			expect(value.truncated).toBe(false);
			expect(value.modelText).toMatch(/^--- g\.txt ---$/m);
		});
	});

	it("sets truncated=true when the per-file cap is hit", async () => {
		const content = "hit\n".repeat(150);
		await withTempFile("big.txt", content, async ({ cwd }) => {
			const { ctx } = setupIntegrationTest(cwd);
			const { buildGrepTool } = await import("../../src/tool-grep.js");
			const { localIO } = await import("../../src/fs-bridge.js");
			const tool = buildGrepTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute(
				{ path: "big.txt", pattern: "hit", limit: 50 },
				exec(ctx),
			)) as { files: unknown[]; truncated: boolean; total: number };
			expect(value.truncated).toBe(true);
			expect(value.total).toBe(50);
		});
	});
});

describe("edit / undo structured value shape", () => {
	it("edit returns a value with path/before/after + modelText", async () => {
		await withTempFile("e.txt", "a\nb\nc\n", async ({ cwd }) => {
			const { localIO } = await import("../../src/fs-bridge.js");
			const { FsSandboxController } = await import("../../src/sandbox.js");
			const { buildEditTool } = await import("../../src/tool-edit.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const io = localIO();
			const read = buildReadTool(io);
			const edit = buildEditTool(io, sandbox);
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const readValue = (await read.execute({ path: "e.txt" }, exec({}))) as { lines: { number: number; hash: string }[]; hashlines: { number: number; hash: string }[] };
			const lineMarker = `${readValue.hashlines[1]?.number}#${readValue.hashlines[1]?.hash}`;
			const value = (await edit.execute(
				{ path: "e.txt", edits: [{ op: "replace", anchor_start: lineMarker, anchor_end: lineMarker, lines: ["B!"] }] },
				exec({}),
			)) as {
				path: string;
				before: string;
				after: string;
				added: number;
				removed: number;
				modelText: string;
			};
			expect(value.path).toMatch(/e\.txt$/);
			expect(value.before).toBe("a\nb\nc\n");
			expect(value.after).toBe("a\nB!\nc\n");
			expect(value.removed).toBe(1);
			expect(value.added).toBe(1);
			// 1→1 line replacement produces no line shift below the edit, so the
			// Shift block is suppressed. The model text carries the new
			// ANCHOR:FILELINE block instead of a unified diff.
			expect(value.modelText).toMatch(/Successfully edited in e\.txt/);
			expect(value.modelText).toMatch(/2#[A-Za-z0-9]{3}:B!/);
		});
	});

	it("edit applies a per-item path override across files", async () => {
		await withTempFile("b1.txt", "a\nb\nc\n", async ({ cwd, path: b1Path }) => {
			// Create the second file in the same cwd so a single edit call
			// can target both via per-item `path` overrides.
			await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
			const { localIO } = await import("../../src/fs-bridge.js");
			const { FsSandboxController } = await import("../../src/sandbox.js");
			const { buildEditTool } = await import("../../src/tool-edit.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const io = localIO();
			const read = buildReadTool(io);
			const edit = buildEditTool(io, sandbox);
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const readB1 = (await read.execute({ path: "b1.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
			const readB2 = (await read.execute({ path: "b2.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
			const m1 = `${readB1.hashlines[1]?.number}#${readB1.hashlines[1]?.hash}`;
			const m2 = `${readB2.hashlines[1]?.number}#${readB2.hashlines[1]?.hash}`;
			// Per-item path overrides let one `edit` call target multiple files.
			await edit.execute(
				{
					path: "b1.txt",
					edits: [
						{ op: "replace", path: "b1.txt", anchor_start: m1, anchor_end: m1, lines: ["B1!"] },
						{ op: "replace", path: "b2.txt", anchor_start: m2, anchor_end: m2, lines: ["B2!"] },
					],
				},
				exec({}),
			);
			expect(await readFile(b1Path, "utf-8")).toBe("a\nB1!\nc\n");
			expect(await readFile(join(cwd, "b2.txt"), "utf-8")).toBe("x\nB2!\nz\n");
		});
	});
});

describe("presentation-helpers — computeHunkDiffs", () => {
	it("produces a 3-line-context hunk (mirroring dsh-tool-fs)", async () => {
		const { computeHunkDiffs } = await import("../../src/presentation-helpers.js");
		const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
		const after = "a\nb\nc\nd\nE\nF\ng\nh\ni\nj\n";
		const diffs = computeHunkDiffs("/foo.ts", before, after);
		expect(diffs).toHaveLength(1);
		const diff = diffs[0]!;
		expect(diff.path).toBe("/foo.ts");
		// 3 lines of context above + the two removed + 3 lines below = 8 lines
		// (b..i). The first 'a' and the last 'j' are out of the context window.
		expect(diff.oldText).toContain("b");
		expect(diff.oldText).toContain("c");
		expect(diff.oldText).toContain("d");
		expect(diff.oldText).toContain("e");
		expect(diff.oldText).toContain("f");
		expect(diff.oldText).toContain("g");
		expect(diff.oldText).toContain("h");
		expect(diff.oldText).toContain("i");
		expect(diff.oldText).not.toContain("a");
		expect(diff.oldText).not.toContain("j");
		expect(diff.newText).toContain("E");
		expect(diff.newText).toContain("F");
		expect(diff.newText).toContain("d");
		expect(diff.newText).not.toContain("j");
	});

	it("returns oldText: null for a noop or create", async () => {
		const { computeHunkDiffs } = await import("../../src/presentation-helpers.js");
		const diffs = computeHunkDiffs("/foo.ts", "a\nb\n", "a\nb\n");
		expect(diffs).toEqual([]);
	});
});

describe("presentation-helpers — langFromPath", () => {
	it("derives a syntax-highlighting language from a file extension", async () => {
		const { langFromPath } = await import("../../src/presentation-helpers.js");
		expect(langFromPath("src/foo.ts")).toBe("ts");
		expect(langFromPath("/abs/path/foo.py")).toBe("py");
		expect(langFromPath("README.md")).toBe("md");
	});

	it("returns undefined for unknown extensions", async () => {
		const { langFromPath } = await import("../../src/presentation-helpers.js");
		expect(langFromPath("data.xyz")).toBeUndefined();
		expect(langFromPath("Makefile")).toBeUndefined();
	});
});
