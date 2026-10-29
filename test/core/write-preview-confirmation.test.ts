/**
 * `write.preview: confirmation` (map #354, spec #359, ticket #361) — the model
 * channel shrinks to one line and the store serves NOTHING.
 *
 * The seam is the tool boundary, the same one `write-shadow.test.ts` drives:
 * what the model reads (`modelText`), what the card receives (`diffRows`), and
 * what the store records (served anchors). IO is the real local bridge over a
 * temp dir; only the language-server manager is faked where a format pass has
 * to produce a section.
 *
 * @module test/core/write-preview-confirmation.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { applyEffective, type HashlineSettings } from "../../src/config.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { loadServed } from "../../src/domain/session/served.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { getWritableTempRoot, withStoreHome } from "../support/fixtures.js";

interface WriteOut {
	path: string;
	operation: string;
	before: string | null;
	after: string;
	diffRows?: Array<{ kind: string; lineNumber?: number; hash?: string; text: string }>;
	formats?: unknown[];
	modelText: string;
}

function makeExec(
	cwd: string,
	sessionKey = "write-preview-session",
): (args: unknown) => ToolRunContext {
	return (args) =>
		({
			signal: new AbortController().signal,
			agent: {
				id: sessionKey,
				session: { id: sessionKey, header: { cwd } },
			},
			arguments: args,
			deferContext() {},
			concludeTurn() {},
		}) as unknown as ToolRunContext;
}

function testSandbox(): FsSandboxController {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/**
 * A ready-only language-server manager: formatting answers, nothing spawns.
 * The same shape `format-auto-integration.test.ts` uses.
 */
function fakeFormatManager(edits: unknown[]): void {
	const session = {
		serverCapabilities: {
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true,
		},
		request: async (method: string) => {
			if (method === "textDocument/rangeFormatting") return edits;
			if (method === "textDocument/formatting") return edits;
			return undefined;
		},
		notify: async () => {},
	};
	setLspManager({
		readyLanguages: ["typescript"],
		readySessionFor: () => session,
		status: async () => [{ language: "typescript", server: { displayName: "fake-ts" } }],
		openDocumentFor: () => () => {},
		waitForSession: async () => session,
	} as never);
}

/** Drive one preview mode over a temp dir and an isolated store home. */
async function withPreview(
	settings: HashlineSettings,
	run: (ctx: {
		dir: string;
		sessionKey: string;
		io: FileIO;
		write: ReturnType<typeof buildWriteShadowTool>;
		read: ReturnType<typeof buildReadTool>;
		edit: ReturnType<typeof buildEditTool>;
		exec: (args: unknown) => ToolRunContext;
	}) => Promise<void>,
): Promise<void> {
	await withStoreHome(async () => {
		const dir = await mkdtemp(join(await getWritableTempRoot(), "write-preview-"));
		const sessionKey = "write-preview-session";
		const io = localIO();
		const sandbox = testSandbox();
		const write = buildWriteShadowTool(io, sandbox);
		const read = buildReadTool(io);
		const edit = buildEditTool(io, sandbox);
		const exec = makeExec(dir, sessionKey);
		applyEffective(settings);
		try {
			await run({ dir, sessionKey, io, write, read, edit, exec });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}

afterEach(() => {
	applyEffective(undefined);
	setLspManager(undefined);
});

describe("write.preview: confirmation", () => {
	it("replaces the auto-read preview with one confirmation line", async () => {
		await withPreview({ write: { preview: "confirmation" } }, async ({ dir, write, exec }) => {
			await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf-8");
			const out = (await write.execute(
				{ file_path: "a.txt", content: "one\nTWO\n" },
				exec({}),
			)) as WriteOut;
			expect(out.modelText).toBe("Wrote a.txt (update).");
			expect(out.modelText).not.toContain("Auto-read");
			// No file window, no resume token: the window sentence never appears.
			expect(out.modelText).not.toMatch(/Lines \d+-\d+ of \d+/);
		});
	});

	it("hot-reloads: the NEXT call follows the mode, with no tool re-registration", async () => {
		await withPreview({ write: { preview: "full" } }, async ({ dir, write, exec }) => {
			const first = (await write.execute(
				{ file_path: "b.txt", content: "one\ntwo\n" },
				exec({}),
			)) as WriteOut;
			expect(first.modelText).toContain("Auto-read (hashline anchors)");

			applyEffective({ write: { preview: "confirmation" } });
			const second = (await write.execute(
				{ file_path: "b.txt", content: "one\nTWO\n" },
				exec({}),
			)) as WriteOut;
			expect(second.modelText).toBe("Wrote b.txt (update).");
		});
	});

	it("serves no anchors, and the card rows carry blank hashes", async () => {
		await withPreview({ write: { preview: "confirmation" } }, async ({ dir, sessionKey, write, exec }) => {
			const out = (await write.execute(
				{ file_path: "c.txt", content: "one\ntwo\n" },
				exec({}),
			)) as WriteOut;
			expect(await loadServed(sessionKey, join(dir, "c.txt"))).toEqual(new Set());
			const rows = out.diffRows ?? [];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				if (row.kind === "hunk") continue;
				expect(row.hash).toBe("");
			}
		});
	});

	it("serves no anchors on an UPDATE either", async () => {
		await withPreview({ write: { preview: "confirmation" } }, async ({ dir, sessionKey, write, exec }) => {
			await writeFile(join(dir, "d.txt"), "one\ntwo\n", "utf-8");
			const out = (await write.execute(
				{ file_path: "d.txt", content: "one\nTWO\nthree\n" },
				exec({}),
			)) as WriteOut;
			expect(out.operation).toBe("update");
			expect(await loadServed(sessionKey, join(dir, "d.txt"))).toEqual(new Set());
		});
	});

	it("keeps JSON output parseable: {path, operation}", async () => {
		await withPreview(
			{ write: { preview: "confirmation" }, output_format: "json" },
			async ({ write, exec }) => {
				const out = (await write.execute(
					{ file_path: "e.txt", content: "x\n" },
					exec({}),
				)) as WriteOut;
				expect(JSON.parse(out.modelText)).toEqual({ path: "e.txt", operation: "create" });
			},
		);
	});

	it("a changed line cannot be edited until it is read again", async () => {
		await withPreview({ write: { preview: "confirmation" } }, async ({ dir, write, read, edit, exec }) => {
			await writeFile(join(dir, "f.txt"), "one\ntwo\nthree\n", "utf-8");
			const first = (await read.execute({ path: "f.txt" }, exec({}))) as { modelText: string };
			const oldAnchor = /^([A-Za-z0-9]{1,8}):two$/m.exec(first.modelText)?.[1];
			expect(oldAnchor).toBeDefined();

			const wrote = (await write.execute(
				{ file_path: "f.txt", content: "one\nTWO\nthree\n" },
				exec({}),
			)) as WriteOut;
			expect(wrote.modelText).toBe("Wrote f.txt (update).");

			const failed = (await edit.execute(
				{ path: "f.txt", edits: [{ op: "replace", anchor_start: oldAnchor!, lines: ["TWO!"] }] },
				exec({}),
			)) as unknown;
			// The batch wrapper names E_BATCH_ABORT; the INNER cause is the stale anchor.
			// Refused: the marker was minted for the OLD line, and the write changed it.
			// The batch wrapper names E_BATCH_ABORT; the cause is the unverified range.
			expect(JSON.stringify(failed)).toMatch(/E_RANGE_UNVERIFIED|E_STALE/);

			const fresh = (await read.execute({ path: "f.txt" }, exec({}))) as { modelText: string };
			const newAnchor = /^([A-Za-z0-9]{1,8}):TWO$/m.exec(fresh.modelText)?.[1];
			expect(newAnchor).toBeDefined();
			const ok = (await edit.execute(
				{ path: "f.txt", edits: [{ op: "replace", anchor_start: newAnchor!, lines: ["TWO!"] }] },
				exec({}),
			)) as { error?: unknown };
			expect(ok.error).toBeUndefined();
		});
	});

	it("reports a formatter change as a header-only section, with no anchor rows", async () => {
		await withPreview(
			{ write: { preview: "confirmation" }, format: { auto: "full" } },
			async ({ dir, write, exec }) => {
				await writeFile(join(dir, "g.ts"), "function a() {\nreturn 1;\n}\n", "utf-8");
				fakeFormatManager([
					{
						range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1000 } },
						newText: "\treturn 1;",
					},
				]);
				const out = (await write.execute(
					{ file_path: "g.ts", content: "function a() {\nreturn 1;\n}\n" },
					exec({}),
				)) as WriteOut;
				expect(out.modelText).toContain("[auto-format: fake-ts");
				expect(out.modelText).toContain("unserved]");
				// No `+<anchor>:` rows: a row would quote an anchor the model cannot use.
				expect(out.modelText).not.toMatch(/^\+[A-Za-z0-9]{1,8}:/m);
			},
		);
	});
});
