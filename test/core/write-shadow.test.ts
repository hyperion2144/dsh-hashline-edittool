/**
 * write-shadow dual-channel tests (spec #85).
 *
 * The shadow replaces the built-in `write` on the agent scope: both the JSON
 * channel (`{file_path, content}`) and the text channel (`file_path` line +
 * heredoc body) must produce the native create/update contract, and the model
 * content always carries the auto-read hashline preview with fresh anchors.
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
	const sessionKey = "test-session";
	return () =>
		({
			cwd,
			signal: new AbortController().signal,
			agent: { session: { header: { cwd } } },
			...(sessionKey ? { sessionKey } : {}),
		}) as unknown as ToolRunContext;
}

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
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

	it("creates a file via the JSON channel and returns create + auto-read preview", async () => {
		const result = (await tool.execute(
			{ file_path: "a.txt", content: "line 1\nline 2\n" },
			execFor({}),
		)) as {
			path: string;
			operation: string;
			before: string | null;
			after: string;
			modelText: string;
		};
		expect(result.operation).toBe("create");
		expect(result.before).toBeNull();
		expect(result.after).toBe("line 1\nline 2\n");
		expect(result.modelText).toContain("--- Auto-read (hashline anchors) ---");
	});

	it("creates the same file via the TEXT channel (heredoc payload)", async () => {
		const result = (await tool.execute("b.txt\n<<<END\nline one\nline two\n<<<END", execFor({}))) as {
			path: string;
			operation: string;
			content_?: never;
			before: string | null;
			after: string;
			modelText: string;
		};
		expect(result.operation).toBe("create");
		expect(result.after).toBe("line one\nline two");
		expect(result.modelText).toContain("Auto-read");
	});

	it("returns update + a diffable before when the file already exists", async () => {
		await writeFile(join(dir, "c.txt"), "old content\n", "utf-8");
		const result = (await tool.execute("c.txt\n<<<END\nnew content\n<<<END", execFor({}))) as {
			operation: string;
			before: string | null;
			after: string;
		};
		expect(result.operation).toBe("update");
		expect(result.before).toBe("old content\n");
		expect(result.after).toBe("new content");
	});

	it("rejects malformed text DSL with E_PARSE_* and writes nothing", async () => {
		await expect(tool.execute("d.txt\nno heredoc here", execFor({}))).rejects.toThrow(
			"[E_PARSE_HEREDOC_EXPECTED]",
		);
	});

	it("auto-read preview exposes 行号:锚点 markers the model can reuse", async () => {
		const result = (await tool.execute(
			{ file_path: "e.txt", content: "aaa\nbbb\nccc\n" },
			execFor({}),
		)) as { modelText: string };
		// The auto-read renders hashline rows; every row has an anchor column.
		const rowRe = /^\s*[A-Za-z0-9]+:/m;
		expect(rowRe.test(result.modelText)).toBe(true);
	});
});
