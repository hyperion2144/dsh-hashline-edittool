/**
 * The `delete` tool through the real tool builder and the local bridge:
 * removal + four-family reclaim, idempotence for an absent path, the
 * symlink/directory refusals, multi-file partial failure, and the declared
 * output schema.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildDeleteTool } from "../../src/tools/tool-delete.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { noteAlignmentDegraded, takeAlignmentNotice } from "../../src/domain/session/anchor-state.js";
import type { FsSandboxController } from "../../src/infra/sandbox.js";
import {
	getText,
	makeExec,
	setupIntegrationTest,
	withTempFile,
} from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";
import { hashStorePath } from "../../src/infra/paths.js";

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

/** Serve one path and leave an undo layer + another session's served row. */
async function seed(cwd: string, path: string): Promise<ReturnType<typeof setupIntegrationTest>> {
	const harness = setupIntegrationTest(cwd);
	await harness.readTool.execute("read", { path });
	const store = await loadHashStore(cwd);
	store.pushUndo(path, {
		content: "before\n",
		bom: "",
		ending: "\n",
		hashes: ["AAA"],
		resultContent: "after\n",
	});
	store.upsertServed("other-session", path, ["ZZZ"]);
	return harness;
}

describe("delete tool", () => {
	it("deletes the file and purges all four row families, reporting the counts", async () => {
		await withTempFile("gone.ts", "alpha\nbeta\n", async ({ cwd, path }) => {
			const harness = await seed(cwd, path);
			noteAlignmentDegraded(path);
			expect(countsFor(path, cwd).anchorLines).toBeGreaterThan(0);

			const text = getText(await harness.deleteTool.execute("delete", { paths: [path] }));

			expect(existsSync(path)).toBe(false);
			expect(text).toContain("1 deleted");
			expect(text).toContain("anchors");
			expect(countsFor(path, cwd)).toEqual({ anchorMeta: 0, anchorLines: 0, undo: 0, served: 0 });
			expect(takeAlignmentNotice(path)).toBeUndefined();
		});
	});

	it("purges only the deleted path: another file's undo and served rows survive", async () => {
		await withTempFile("a.ts", "a\n", async ({ cwd, path }) => {
			const other = join(cwd, "b.ts");
			await writeFile(other, "b\n", "utf-8");
			const harness = await seed(cwd, path);
			await harness.readTool.execute("read", { path: other });
			const store = await loadHashStore(cwd);
			store.pushUndo(other, {
				content: "old-b\n",
				bom: "",
				ending: "\n",
				hashes: ["BBB"],
				resultContent: "new-b\n",
			});

			await harness.deleteTool.execute("delete", { paths: [path] });

			expect(countsFor(path, cwd)).toEqual({ anchorMeta: 0, anchorLines: 0, undo: 0, served: 0 });
			expect(countsFor(other, cwd).undo).toBe(1);
			expect(store.getUndo(other)).toBeDefined();
			expect(store.getUndo(path)).toBeUndefined();
			expect(existsSync(other)).toBe(true);
		});
	});

	it("treats a missing path as already-absent and still reclaims its residue", async () => {
		await withTempFile("residue.ts", "x\n", async ({ cwd, path }) => {
			const harness = await seed(cwd, path);
			await rm(path);

			const text = getText(await harness.deleteTool.execute("delete", { paths: [path] }));

			expect(text).toContain("1 already absent");
			expect(countsFor(path, cwd)).toEqual({ anchorMeta: 0, anchorLines: 0, undo: 0, served: 0 });
		});
	});

	it("refuses a symlink without touching the link or its target", async () => {
		await withTempFile("target.ts", "target\n", async ({ cwd, path }) => {
			const link = join(cwd, "link.ts");
			await symlink(path, link);
			const harness = setupIntegrationTest(cwd);

			const text = getText(await harness.deleteTool.execute("delete", { paths: [link] }));

			expect(text).toContain("[E_SYMLINK]");
			expect(existsSync(link)).toBe(true);
			expect(existsSync(path)).toBe(true);
		});
	});

	it("refuses a directory", async () => {
		await withTempFile("anchor.ts", "x\n", async ({ cwd }) => {
			const dir = join(cwd, "subdir");
			await mkdir(dir);
			const harness = setupIntegrationTest(cwd);

			const text = getText(await harness.deleteTool.execute("delete", { paths: [dir] }));

			expect(text).toContain("[E_NOT_FILE]");
			expect(existsSync(dir)).toBe(true);
		});
	});

	it("reports a multi-file partial failure and keeps going", async () => {
		await withTempFile("one.ts", "one\n", async ({ cwd, path }) => {
			const dir = join(cwd, "nope");
			await mkdir(dir);
			const harness = setupIntegrationTest(cwd);

			const text = getText(await harness.deleteTool.execute("delete", { paths: [path, dir] }));

			expect(text).toContain("1 deleted");
			expect(text).toContain("1 failed");
			expect(text).toContain("[E_NOT_FILE]");
			expect(existsSync(path)).toBe(false);
			expect(existsSync(dir)).toBe(true);
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
			const tool = buildDeleteTool(localIO(), sandbox);
			const value = await tool.execute({ paths: [path] }, makeExec(cwd)({ paths: [path] }));
			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});
});
