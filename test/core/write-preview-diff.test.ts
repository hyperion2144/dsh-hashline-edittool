/**
 * `write.preview: diff` (map #354, spec #359, ticket #362) — an UPDATE comes
 * back as a unified diff, a CREATE stays read-style, and the diff is drawn by
 * the SAME renderer every other edit tool uses (ADR-0020).
 *
 * The seam is the tool boundary: the model text, the canonical value, and the
 * anchors the follow-up edit is allowed to use.
 *
 * @module test/core/write-preview-diff.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { applyEffective, type HashlineSettings } from "../../src/config.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { getWritableTempRoot, withStoreHome } from "../support/fixtures.js";

interface WriteOut {
	path: string;
	operation: string;
	before: string | null;
	after: string;
	diffRows?: Array<{ kind: string; lineNumber?: number; hash?: string; text: string }>;
	modelText: string;
}

function makeExec(cwd: string, sessionKey = "write-preview-diff"): (args: unknown) => ToolRunContext {
	return (args) =>
		({
			signal: new AbortController().signal,
			agent: { id: sessionKey, session: { id: sessionKey, header: { cwd } } },
			arguments: args,
			deferContext() {},
			concludeTurn() {},
		}) as unknown as ToolRunContext;
}

function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

async function withDiff(
	settings: HashlineSettings,
	run: (ctx: {
		dir: string;
		write: ReturnType<typeof buildWriteShadowTool>;
		edit: ReturnType<typeof buildEditTool>;
		exec: (args: unknown) => ToolRunContext;
	}) => Promise<void>,
): Promise<void> {
	await withStoreHome(async () => {
		const dir = await mkdtemp(join(await getWritableTempRoot(), "write-preview-diff-"));
		const io: FileIO = localIO();
		const sandbox = testSandbox();
		const write = buildWriteShadowTool(io, sandbox);
		const edit = buildEditTool(io, sandbox);
		const exec = makeExec(dir);
		applyEffective(settings);
		try {
			await run({ dir, write, edit, exec });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

afterEach(() => {
	applyEffective(undefined);
});

describe("write.preview: diff", () => {
	it("renders an update as the unified diff edit uses", async () => {
		await withDiff({ write: { preview: "diff" } }, async ({ dir, write, exec }) => {
			await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n", "utf-8");
			const out = (await write.execute(
				{ file_path: "a.txt", content: "one\nTWO\nthree\n" },
				exec({}),
			)) as WriteOut;
			expect(out.operation).toBe("update");
			expect(out.modelText).toContain("Diff rows:");
			expect(out.modelText).toContain("--- a.txt");
			expect(out.modelText).toContain("+++ a.txt");
			expect(out.modelText).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
			// `-` rows carry the stale `~`; its anchor is blank when the pre-write line
			// was never served (the sparse view).
			expect(out.modelText).toMatch(/^-\s*~[A-Za-z0-9]*:two$/m);
			expect(out.modelText).toMatch(/^\+[A-Za-z0-9]{1,8}:TWO$/m);
			// Not a file window: no auto-read heading, no `[Lines X-Y of N]`.
			expect(out.modelText).not.toContain("Auto-read");
			expect(out.modelText).not.toMatch(/Lines \d+-\d+ of \d+/);
		});
	});

	it("makes the `+` rows writable immediately", async () => {
		await withDiff({ write: { preview: "diff" } }, async ({ dir, write, edit, exec }) => {
			await writeFile(join(dir, "b.txt"), "one\ntwo\n", "utf-8");
			const out = (await write.execute(
				{ file_path: "b.txt", content: "one\nTWO\n" },
				exec({}),
			)) as WriteOut;
			const anchor = /^\+([A-Za-z0-9]{1,8}):TWO$/m.exec(out.modelText)?.[1];
			expect(anchor).toBeDefined();
			const edited = (await edit.execute(
				{ path: "b.txt", edits: [{ op: "replace", anchor_start: anchor!, lines: ["TWO!"] }] },
				exec({}),
			)) as { error?: unknown };
			expect(edited.error).toBeUndefined();
			// The card keeps the real anchor gutter in diff mode (the card channel is
			// unchanged; only `confirmation` blanks it).
			const rows = out.diffRows ?? [];
			expect(rows.some((row) => row.kind === "+" && /^[A-Za-z0-9]/.test(row.hash ?? ""))).toBe(true);
		});
	});

	it("keeps a CREATE read-style — diff mode has no before side to draw", async () => {
		await withDiff({ write: { preview: "diff" } }, async ({ write, exec }) => {
			const out = (await write.execute(
				{ file_path: "c.txt", content: "one\ntwo\n" },
				exec({}),
			)) as WriteOut;
			expect(out.operation).toBe("create");
			expect(out.modelText).toContain("Auto-read (hashline anchors)");
			expect(out.modelText).not.toContain("Diff rows:");
		});
	});

	it("answers JSON mode with the marker-keyed diff dictionary", async () => {
		await withDiff(
			{ write: { preview: "diff" }, output_format: "json" },
			async ({ dir, write, exec }) => {
				await writeFile(join(dir, "d.txt"), "one\ntwo\n", "utf-8");
				const out = (await write.execute(
					{ file_path: "d.txt", content: "one\nTWO\n" },
					exec({}),
				)) as WriteOut;
				const parsed = JSON.parse(out.modelText) as {
					path: string;
					operation: string;
					diff: Record<string, string>;
				};
				expect(parsed.path).toBe("d.txt");
				expect(parsed.operation).toBe("update");
				const keys = Object.keys(parsed.diff);
			// JSON keys are `<prefix><marker>`; the line trails only when the user's
			// line-number switch is on.
			expect(keys.some((key) => /^\+[A-Za-z0-9]{1,8}$/.test(key))).toBe(true);
				expect(Object.values(parsed.diff)).toContain("TWO");
			},
		);
	});

	it("spills an oversized diff through the edit segment channel, not read's window", async () => {
		await withDiff({ write: { preview: "diff" } }, async ({ dir, write, exec }) => {
			const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} original`);
			await writeFile(join(dir, "big.txt"), lines.join("\n") + "\n", "utf-8");
			const rewritten = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} rewritten`);
			const out = (await write.execute(
				{ file_path: "big.txt", content: rewritten.join("\n") + "\n" },
				exec({}),
			)) as WriteOut;
			// The segment footer names the consumer it was written for.
			expect(out.modelText).toContain("Use read {resume:");
			expect(out.modelText).not.toMatch(/Lines \d+-\d+ of \d+/);
		});
	});

	it("falls back to read-style when the old bytes have no honest per-line diff", async () => {
		await withDiff({ write: { preview: "diff" } }, async ({ dir, write, exec }) => {
			await writeFile(join(dir, "lossy.txt"), Buffer.from([0xff, 0xfe, 0x0a]));
			const out = (await write.execute(
				{ file_path: "lossy.txt", content: "clean text\n" },
				exec({}),
			)) as WriteOut;
			expect(out.operation).toBe("update");
			expect(out.modelText).toContain("Auto-read");
			expect(out.modelText).not.toContain("Diff rows:");
		});
	});
});
