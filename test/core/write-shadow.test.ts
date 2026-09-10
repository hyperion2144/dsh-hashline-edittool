/**
 * write-shadow tests.
 *
 * The shadow replaces the built-in `write` on the agent scope. It must keep
 * the built-in contract (`{file_path, content}` in, `{path, operation,
 * before, after}` out), serve the written lines so the model can keep editing
 * (auto-read preview with `行号:锚点`), and publish structured `diffRows` so
 * the web card draws the SAME gutter the edit card draws.
 *
 * @module test/core/write-shadow.test
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWriteShadowTool } from "../../src/tool-write-shadow.js";
import type { FileIO } from "../../src/fs-bridge.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

function makeExec(cwd: string): (args: unknown) => ToolRunContext {
	return (args: unknown) =>
		({
			signal: new AbortController().signal,
			agent: {
				id: "test-session",
				session: { id: "test-session", header: { cwd } },
			},
			arguments: args,
		}) as unknown as ToolRunContext;
}

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

interface WriteOut {
	path: string;
	operation: string;
	before: string | null;
	after: string;
	diffRows?: Array<{ kind: string; lineNumber: number; hash: string; text: string }>;
	modelText: string;
}

describe("write shadow", () => {
	let dir: string;
	let io: FileIO;
	let tool: ReturnType<typeof buildWriteShadowTool>;
	let execFor: (args: unknown) => ToolRunContext;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "hashline-write-shadow-"));
		io = localIO();
		tool = buildWriteShadowTool(io, testSandbox());
		execFor = makeExec(dir);
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a file and returns the built-in create contract", async () => {
		const result = (await tool.execute(
			{ file_path: "a.txt", content: "line 1\nline 2\n" },
			execFor({}),
		)) as WriteOut;
		expect(result.operation).toBe("create");
		expect(result.before).toBeNull();
		expect(result.after).toBe("line 1\nline 2\n");
	});

	it("serves the written lines: the model text carries the hashline preview", async () => {
		const result = (await tool.execute(
			{ file_path: "preview.txt", content: "alpha\nbeta\n" },
			execFor({}),
		)) as WriteOut;
		expect(result.modelText).toContain("Auto-read (hashline anchors)");
		// Every written line appears with its `行号:锚点` marker.
		expect(result.modelText).toMatch(/\b1:[A-Za-z0-9]{2,8}\b/);
		expect(result.modelText).toMatch(/\b2:[A-Za-z0-9]{2,8}\b/);
	});

	it("returns update + the pre-write content when the file exists", async () => {
		await writeFile(join(dir, "c.txt"), "old content\n", "utf-8");
		const result = (await tool.execute(
			{ file_path: "c.txt", content: "new content" },
			execFor({}),
		)) as WriteOut;
		expect(result.operation).toBe("update");
		expect(result.before).toBe("old content\n");
		expect(result.after).toBe("new content");
	});

	it("publishes structured diffRows carrying lineNumber + anchor for the card gutter", async () => {
		const result = (await tool.execute(
			{ file_path: "rows.txt", content: "one\ntwo\nthree\n" },
			execFor({}),
		)) as WriteOut;
		const rows = result.diffRows ?? [];
		expect(rows.length).toBeGreaterThan(0);
		// A create diffs against "" -> every row is an addition with an anchor.
		for (const row of rows) {
			expect(row.kind).toBe("+");
			expect(row.lineNumber).toBeGreaterThanOrEqual(1);
			expect(row.hash).toMatch(/^[A-Za-z0-9]{2,8}$/);
		}
		const texts = rows.map((row) => row.text);
		expect(texts).toEqual(["one", "two", "three"]);
	});

	it("update rows mix context/removals/additions — each carrying an anchor where known", async () => {
		await writeFile(join(dir, "mix.txt"), "keep\nold line\ntail\n", "utf-8");
		const result = (await tool.execute(
			{ file_path: "mix.txt", content: "keep\nnew line\ntail\n" },
			execFor({}),
		)) as WriteOut;
		const rows = result.diffRows ?? [];
		const kinds = new Set(rows.map((row) => row.kind));
		expect(kinds.has("+")).toBe(true);
		// Context + additions carry post-write anchors (the chained-edit currency).
		const added = rows.filter((row) => row.kind === "+");
		expect(added.length).toBeGreaterThan(0);
		for (const row of added) expect(row.hash).toMatch(/^[A-Za-z0-9]{2,8}$/);
	});

	it("rejects a missing file_path without touching the filesystem", async () => {
		await expect(tool.execute({ content: "x" }, execFor({}))).rejects.toThrow(
			"file_path",
		);
	});

	it("rejects a non-string content", async () => {
		await expect(
			tool.execute({ file_path: "x.txt", content: 42 }, execFor({})),
		).rejects.toThrow("content");
	});

	it("presentResult falls back to the intended whole-file addition on a create", () => {
		const view = tool.presentResult?.(
			{ file_path: "new.txt", content: "a\nb\n" },
			{ isError: false, meta: { path: "new.txt", diffs: [] } } as never,
		) as { diffs?: Array<{ oldText: string | null; newText: string }> } | undefined;
		expect(view?.diffs).toEqual([
			{ path: "new.txt", oldText: null, newText: "a\nb\n" },
		]);
	});

	it("presentResult prefers the applied hunks on an overwrite", () => {
		const hunks = [{ path: "c.txt", oldText: "old\n", newText: "new\n" }];
		const view = tool.presentResult?.(
			{ file_path: "c.txt", content: "new\n" },
			{ isError: false, meta: { path: "c.txt", diffs: hunks } } as never,
		) as { diffs?: unknown[] } | undefined;
		expect(view?.diffs).toEqual(hunks);
	});

	it("presentationMeta carries path + diffRows (and no hunks on create)", () => {
		const meta = tool.output.presentationMeta?.(
			{ file_path: "m.txt" },
			{
				path: "m.txt",
				operation: "create",
				before: null,
				after: "x\n",
				diffRows: [{ kind: "+", lineNumber: 1, hash: "ab", text: "x" }],
				modelText: "",
			},
		) as { path?: string; diffs?: unknown[]; diffRows?: unknown[] } | undefined;
		expect(meta?.path).toBe("m.txt");
		expect(meta?.diffs).toEqual([]);
		expect(meta?.diffRows).toHaveLength(1);
	});
});
