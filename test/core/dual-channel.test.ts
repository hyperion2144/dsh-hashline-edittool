/**
 * Dual-channel integration tests for read / grep / edit (spec #85).
 *
 * Each tool's execute accepts BOTH an object payload (JSON channel, unchanged
 * 0.4 contract) and a string payload (text DSL channel). Both must produce
 * the same canonical outcome — payload equivalence is the parity contract.
 *
 * @module test/core/dual-channel.test
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReadTool } from "../../src/tool-read.js";
import { buildGrepTool } from "../../src/tool-grep.js";
import { buildEditTool } from "../../src/tool-edit.js";
import type { FileIO } from "../../src/fs-bridge.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { applyHashlineShape } from "../../src/hashline/hash-assign.js";

applyHashlineShape({ separator: ":", contextLines: 3 });

function makeExec(cwd: string): () => ToolRunContext {
	return () =>
		({
			cwd,
			signal: new AbortController().signal,
			agent: { session: { header: { cwd } } },
			sessionKey: "test-session",
		}) as unknown as ToolRunContext;
}

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

type Canonical = { modelText?: string; [key: string]: unknown };

describe("dual-channel read", () => {
	let dir: string;
	let io: FileIO;
	let execFor: () => ToolRunContext;
	let filePath: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "dual-read-"));
		io = localIO();
		execFor = makeExec(dir);
		filePath = join(dir, "sample.ts");
		await writeFile(filePath, "line one\nline two\nline three\n", "utf-8");
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("JSON channel and text channel produce the same canonical value", async () => {
		const tool = buildReadTool(io);
		const json = (await tool.execute(
			{ file_path: "sample.ts", offset: 2, limit: 2 },
			execFor(),
		)) as Canonical;
		const text = (await tool.execute("sample.ts\noffset: 2\nlimit: 2", execFor())) as Canonical;
		expect(typeof json.modelText).toBe("string");
		expect(text.modelText).toBe(json.modelText);
	});

	it("rejects an unknown text option with E_PARSE_UNKNOWN_OPTION", async () => {
		const tool = buildReadTool(io);
		await expect(tool.execute("sample.ts\nbogus: 1", execFor())).rejects.toThrow(
			"[E_PARSE_UNKNOWN_OPTION]",
		);
	});
});

describe("dual-channel grep", () => {
	let dir: string;
	let io: FileIO;
	let execFor: () => ToolRunContext;
	let filePath: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "dual-grep-"));
		io = localIO();
		execFor = makeExec(dir);
		filePath = join(dir, "sample.ts");
		await writeFile(filePath, "alpha beta\ngamma\nbeta beta\n", "utf-8");
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("JSON channel and text channel return identical match sets", async () => {
		const tool = buildGrepTool(io);
		const json = (await tool.execute(
			{ pattern: "beta", path: "sample.ts" },
			execFor(),
		)) as Canonical;
		const text = (await tool.execute('beta\npath: sample.ts', execFor())) as Canonical;
		expect(text.modelText).toBe(json.modelText);
	});
});

describe("dual-channel edit", () => {
	let dir: string;
	let io: FileIO;
	let sandbox: FsSandboxController;
	let execFor: () => ToolRunContext;
	let filePath: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "dual-edit-"));
		io = localIO();
		sandbox = testSandbox();
		execFor = makeExec(dir);
		filePath = join(dir, "sample.txt");
		await writeFile(filePath, "keep a\nreplace me\nkeep b\n", "utf-8");
		// Read once so the file is served (edit requires served anchors).
		await buildReadTool(io).execute("sample.txt", execFor());
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("applies the same replacement via JSON and via text DSL", async () => {
		// Extract a served anchor from a JSON read.
		const read = (await buildReadTool(io).execute("sample.txt", execFor())) as Canonical & {
			hashlines?: Array<{ hash: string; text: string }>;
		};
		const line = read.hashlines?.find((h) => h.text === "replace me");
		expect(line).toBeDefined();
		const anchor = line!.hash;

		const editTool = buildEditTool(io, sandbox);
		const jsonResult = (await editTool.execute(
			{
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						anchor_start: anchor,
						lines: ["replaced!"],
					},
				],
			},
			execFor(),
		)) as Canonical;
		expect(jsonResult.modelText ?? "").toContain("replaced!");

		// Rewrite the file to the pre-edit state so the text channel sees the
		// same original content (edit is applied against the current file).
		await writeFile(filePath, "keep a\nreplace me\nkeep b\n", "utf-8");
		await buildReadTool(io).execute("sample.txt", execFor());

		const textResult = (await editTool.execute(
			`sample.txt\nreplace ${anchor}\n<<<END\nreplaced!\n<<<END`,
			execFor(),
		)) as Canonical;
		expect(textResult.modelText ?? "").toContain("replaced!");
	});
});

describe("dual-channel multi-file edit (@@ sections)", () => {
	let dir: string;
	let io: FileIO;
	let sandbox: FsSandboxController;
	let execFor: () => ToolRunContext;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "dual-edit-multi-"));
		io = localIO();
		sandbox = testSandbox();
		execFor = makeExec(dir);
		await mkdir(join(dir, "sub"), { recursive: true });
		await writeFile(join(dir, "a.txt"), "aaa\nbbb\n", "utf-8");
		await writeFile(join(dir, "b.txt"), "bbb\nccc\n", "utf-8");
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("parses @@ sections into per-file ops like the JSON per-item path", async () => {
		// Serve both files first.
		const readTool = buildReadTool(io);
		await readTool.execute("a.txt", execFor());
		await readTool.execute("b.txt", execFor());
		const read = (await readTool.execute("a.txt", execFor())) as Canonical & {
			hashlines?: Array<{ hash: string }>;
		};
		const a = read.hashlines?.[0]?.hash;
		const readB = (await readTool.execute("b.txt", execFor())) as Canonical & {
			hashlines?: Array<{ hash: string }>;
		};
		const b = readB.hashlines?.[0]?.hash;
		expect(a).toBeDefined();
		expect(b).toBeDefined();

		const editTool = buildEditTool(io, sandbox);
		const result = (await editTool.execute(
			`@@ a.txt\ndel ${a}\n@@ b.txt\ndel ${b}`,
			execFor(),
		)) as { success?: Array<{ path: string }>; fail?: unknown[] };
		expect(result.fail ?? []).toEqual([]);
		expect(result.success?.map((s) => s.path).sort()).toEqual(["a.txt", "b.txt"]);
	});
});
