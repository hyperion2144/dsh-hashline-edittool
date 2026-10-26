/**
 * The `rename` tool through the real tool builder and the local bridge:
 * file move + four-family migration, the cross-path anchor guarantee (an
 * anchor served before the rename edits the file afterwards without a
 * re-read), destination refusal, symlink/directory refusal, request-order
 * chains, partial failure, and the declared output schema.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildRenameTool } from "../../src/tools/tool-rename.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { hashStorePath } from "../../src/infra/paths.js";
import type { FsSandboxController } from "../../src/infra/sandbox.js";
import {
	getText,
	makeExec,
	setupIntegrationTest,
	withTempFile,
} from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

afterEach(() => {
	shutdownHashStore();
});

/** The store rows one path still owns, read through a separate connection. */
function countsFor(path: string, cwd: string): {
	anchorMeta: number;
	anchorLines: number;
	undo: number;
	served: number;
} {
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		const one = (sql: string): number =>
			Number((db.prepare(sql).get(path) as { n?: number } | undefined)?.n ?? 0);
		return {
			anchorMeta: one("SELECT COUNT(*) AS n FROM anchor_meta WHERE path = ?"),
			anchorLines: one("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?"),
			undo: one("SELECT COUNT(*) AS n FROM undo WHERE path = ?"),
			served: one("SELECT COUNT(*) AS n FROM served WHERE path = ?"),
		};
	} finally {
		db.close();
	}
}

function undoLayer(content: string) {
	return {
		content,
		bom: "",
		ending: "\n",
		hashes: ["AAA"],
		resultContent: "after\n",
	};
}

describe("rename tool", () => {
	it("moves the file and keeps every served anchor editable at the new path", async () => {
		await withTempFile("a.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path });
			const store = await loadHashStore(cwd);
			const served = store.getServed(harness.sessionKey, path);
			expect(served.size).toBeGreaterThan(0);
			store.pushUndo(path, undoLayer("before\n"));
			store.upsertServed("other-session", path, ["ZZZ"]);
			const target = join(cwd, "b.ts");

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [{ from: path, to: target }],
				}),
			);

			expect(text).toContain("1 renamed");
			expect(existsSync(path)).toBe(false);
			expect(existsSync(target)).toBe(true);
			expect(countsFor(path, cwd)).toEqual({
				anchorMeta: 0,
				anchorLines: 0,
				undo: 0,
				served: 0,
			});
			expect(store.getServed(harness.sessionKey, target)).toEqual(served);
			expect(store.getServed("other-session", target)).toEqual(new Set(["ZZZ"]));
			expect(store.getUndo(target)).toBeDefined();

			// The SAME anchor served before the rename edits the file after it —
			// no re-read, no second batch.
			const anchor = [...served][0]!;
			const edited = getText(
				await harness.editTool.execute("edit", {
					path: target,
					edits: [{ op: "replace", anchor_start: anchor, lines: ["ALPHA"] }],
				}),
			);
			expect(edited).not.toContain("E_STALE");
			expect(edited).not.toContain("E_RANGE_UNVERIFIED");
			expect(await readFile(target, "utf-8")).toContain("ALPHA");
		});
	});

	it("refuses an existing destination and leaves both files untouched", async () => {
		await withTempFile("a.ts", "a\n", async ({ cwd, path }) => {
			const target = join(cwd, "b.ts");
			await writeFile(target, "keep\n");
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path });

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [{ from: path, to: target }],
				}),
			);

			expect(text).toContain("E_EXISTS");
			expect(existsSync(path)).toBe(true);
			expect(await readFile(target, "utf-8")).toBe("keep\n");
			expect(countsFor(path, cwd).anchorLines).toBeGreaterThan(0);
		});
	});

	it("allows a case-only spelling change", async () => {
		await withTempFile("Case.ts", "x\n", async ({ cwd, path }) => {
			const target = join(cwd, "case.ts");
			const harness = setupIntegrationTest(cwd);

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [{ from: path, to: target }],
				}),
			);

			expect(text).toContain("1 renamed");
			expect(existsSync(target)).toBe(true);
		});
	});

	it("runs the pairs in request order so a chain works", async () => {
		await withTempFile("a.ts", "x\n", async ({ cwd, path }) => {
			const b = join(cwd, "b.ts");
			const c = join(cwd, "c.ts");
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path });

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [
						{ from: path, to: b },
						{ from: b, to: c },
					],
				}),
			);

			expect(text).toContain("2 renamed");
			expect(existsSync(c)).toBe(true);
			expect(existsSync(b)).toBe(false);
			expect(existsSync(path)).toBe(false);
		});
	});

	it("refuses a symlink and a directory", async () => {
		await withTempFile("target.ts", "t\n", async ({ cwd, path }) => {
			const link = join(cwd, "link.ts");
			await symlink(path, link);
			const dir = join(cwd, "subdir");
			await mkdir(dir);
			const harness = setupIntegrationTest(cwd);

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [
						{ from: link, to: join(cwd, "moved-link.ts") },
						{ from: dir, to: join(cwd, "moved-dir") },
					],
				}),
			);

			expect(text).toContain("E_SYMLINK");
			expect(text).toContain("E_NOT_FILE");
			expect(existsSync(link)).toBe(true);
			expect(existsSync(dir)).toBe(true);
		});
	});

	it("reports a partial failure and keeps the successful pair", async () => {
		await withTempFile("a.ts", "a\n", async ({ cwd, path }) => {
			const missing = join(cwd, "missing.ts");
			const target = join(cwd, "b.ts");
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path });

			const text = getText(
				await harness.renameTool.execute("rename", {
					renames: [
						{ from: missing, to: join(cwd, "x.ts") },
						{ from: path, to: target },
					],
				}),
			);

			expect(text).toContain("1 renamed");
			expect(text).toContain("1 failed");
			expect(existsSync(target)).toBe(true);
			expect(existsSync(path)).toBe(false);
		});
	});

	it("validates the returned value against the declared output schema", async () => {
		await withTempFile("schema.ts", "x\n", async ({ cwd, path }) => {
			const sandbox = {
				escalationModes: [],
				schemaFields: () => ({}),
				resolvePolicy: async () => undefined,
				mapError: (error: unknown) => error,
			} as unknown as FsSandboxController;
			const tool = buildRenameTool(localIO(), sandbox);
			const target = join(cwd, "schema-moved.ts");
			const args = { renames: [{ from: path, to: target }] };
			const value = await tool.execute(args, makeExec(cwd)(args));
			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});
});
