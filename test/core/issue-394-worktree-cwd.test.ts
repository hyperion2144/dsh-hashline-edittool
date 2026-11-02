/**
 * #394: a session's LIVE working directory, not its creation-time header.
 *
 * DSH moves a session's working directory when the model enters a worktree or
 * calls `cd`: the move is committed as a `working-directory/change` event and
 * the live directory follows it. The session HEADER keeps the creation-time cwd
 * forever — by design, and deliberately NOT what the host's own fs tools use.
 *
 * The plugin resolved every relative path against that header, so after a
 * worktree switch every read / edit / write landed in the ORIGINAL checkout
 * while the model believed it was working in the worktree. The seam under test
 * asks the HOST where the session's directory is right now (dsh's
 * `workingDirectory` service) and resolves relative paths there.
 *
 * The fake service is what the host hands the plugin: the plugin NEVER probes
 * the disk for worktree directories, because several checkouts can exist at
 * once and only the host knows which one this session is in.
 *
 * @module dsh-hashline-edittool/test/core/issue-394-worktree-cwd
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { withTempDir } from "../support/fixtures.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

afterEach(() => {
	shutdownHashStore();
});

/** The `workingDirectory` service the cwd seam reads (dsh ≥ 0.2). */
interface FakeWorkingDirectory {
	/** The session's live working directory. */
	readonly dir?: string;
	/** The error `ensure` throws when the host cannot answer. */
	readonly error?: Error;
}

/**
 * A tool execution whose session HEADER says `headerCwd` while the host
 * reports `live` as the session's current directory.
 */
function execFor(
	headerCwd: string,
	args: unknown,
	live?: FakeWorkingDirectory,
): ToolRunContext {
	const service =
		live === undefined
			? undefined
			: {
				ensure: async (): Promise<string> => {
					if (live.error !== undefined) throw live.error;
					if (live.dir === undefined) throw new Error("working-directory: no directory");
					return live.dir;
				},
			};
	return {
		signal: new AbortController().signal,
		agent: {
			id: "test-session",
			session: { id: "test-session", header: { cwd: headerCwd } },
			ctx: {
				get: (name: string): unknown =>
					name === "workingDirectory" ? service : undefined,
			},
		},
		arguments: args,
	} as unknown as ToolRunContext;
}

/** The rendered model text of a tool call. */
function modelTextOf(result: unknown): string {
	const value = result as { modelText?: unknown };
	return typeof value.modelText === "string" ? value.modelText : String(result);
}

/** The anchor of the first row a read served. */
function firstAnchor(modelText: string): string {
	for (const line of modelText.split("\n")) {
		if (line.startsWith("ANCHOR:")) continue;
		const body = line.replace(/^[+\- ]+/, "");
		const sep = body.indexOf(":");
		if (sep === -1) continue;
		const first = body.slice(0, sep);
		if (/^\d+$/.test(first)) continue;
		return first;
	}
	throw new Error("the read served no anchor");
}

/** The served rows a workspace's store holds. */
function servedCount(cwd: string, path: string): number {
	if (!existsSync(hashStorePath(cwd))) return 0;
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS n FROM served WHERE path = ?").get(path) as
			| { n?: number }
			| undefined;
		return Number(row?.n ?? 0);
	} finally {
		db.close();
	}
}

/** A sandbox with no confining backend: no escalation fields, no policy. */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** Two checkouts on disk: the session's header one, and the one it moved to. */
async function withTwoCheckouts(
	run: (args: { main: string; worktree: string }) => Promise<void>,
): Promise<void> {
	await withTempDir("dsh-394-", async (home) => {
		const main = join(home, "main");
		const worktree = join(home, "worktree");
		await mkdir(main, { recursive: true });
		await mkdir(worktree, { recursive: true });
		await writeFile(join(main, "marker.txt"), "FROM-MAIN\n", "utf-8");
		await writeFile(join(worktree, "marker.txt"), "FROM-WORKTREE\n", "utf-8");
		await run({ main, worktree });
	});
}

describe("the session's live working directory (#394)", () => {
	it("resolves a relative read against the directory the session moved to", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const tool = buildReadTool(localIO());
			const args = { path: "marker.txt" };

			const result = await tool.execute(args, execFor(main, args, { dir: worktree }));

			const text = modelTextOf(result);
			expect(text).toContain("FROM-WORKTREE");
			expect(text).not.toContain("FROM-MAIN");
		});
	});

	it("keeps the served rows in the live workspace's store, not the header's", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const tool = buildReadTool(localIO());
			const args = { path: "marker.txt" };

			await tool.execute(args, execFor(main, args, { dir: worktree }));

			const servedPath = join(worktree, "marker.txt");
			expect(servedCount(worktree, servedPath)).toBeGreaterThan(0);
			expect(servedCount(main, servedPath)).toBe(0);
			expect(existsSync(hashStorePath(main))).toBe(false);
		});
	});

	it("applies a relative edit in the directory the session moved to", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const io = localIO();
			const readTool = buildReadTool(io);
			const editTool = buildEditTool(io, testSandbox());
			const args = { path: "marker.txt" };
			const exec = execFor(main, args, { dir: worktree });

			const served = modelTextOf(await readTool.execute(args, exec));
			const anchor = firstAnchor(served);

			await editTool.execute(
				{
					path: "marker.txt",
					edits: [{ op: "replace", anchor_start: anchor, lines: ["EDITED-IN-WORKTREE"] }],
				},
				exec,
			);

			expect(await readFile(join(worktree, "marker.txt"), "utf-8")).toContain("EDITED-IN-WORKTREE");
			expect(await readFile(join(main, "marker.txt"), "utf-8")).toContain("FROM-MAIN");
		});
	});

	it("writes a relative file into the directory the session moved to", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const args = { file_path: "created.txt", content: "written\n" };

			await tool.execute(args, execFor(main, args, { dir: worktree }));

			expect(existsSync(join(worktree, "created.txt"))).toBe(true);
			expect(existsSync(join(main, "created.txt"))).toBe(false);
		});
	});

	it("falls back to the session header's cwd when the host has no such service", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const tool = buildReadTool(localIO());
			const args = { path: "marker.txt" };

			const result = await tool.execute(args, execFor(main, args));

			expect(modelTextOf(result)).toContain("FROM-MAIN");
			expect(existsSync(hashStorePath(worktree))).toBe(false);
		});
	});

	it("propagates the host's failure instead of resolving against a stale header", async () => {
		await withTwoCheckouts(async ({ main, worktree }) => {
			const tool = buildReadTool(localIO());
			const args = { path: "marker.txt" };

			await expect(
				tool.execute(
					args,
					execFor(main, args, { error: new Error("working-directory: unavailable") }),
				),
			).rejects.toThrow("working-directory: unavailable");
			expect(existsSync(hashStorePath(worktree))).toBe(false);
		});
	});
});
