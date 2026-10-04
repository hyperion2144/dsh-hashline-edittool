import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withStore, withStoreAsync } from "../../src/domain/session/hash-store.js";
import { anchorForInWorkspace, loadServed, openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { releaseLines } from "../../src/domain/session/anchor-entry.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { withTempDir, getText, setupIntegrationTest } from "../support/fixtures.js";

/**
 * Contract §7: **one transaction per file**.
 *
 * The two anchor mutations an edit performs — "these lines now carry these
 * anchors" and "the anchors they displaced are released" — have to commit
 * together. `runFileEdits` wraps them in `withStoreAsync`, which only works
 * because `withStore` NESTS: each primitive's own `withStore` joins the open
 * transaction instead of trying to `BEGIN` a second one. SQLite would reject
 * that outright ("cannot start a transaction within a transaction"), so these
 * cases are about the mechanism §7 depends on, not about a convention.
 */
describe("one transaction per file (§7)", () => {
	it("nests instead of starting a second BEGIN", async () => {
		await withTempDir("onetx-1-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, "a\nb\n", "utf8");
			await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				// Two composed calls, each of which opens its own transaction.
				await expect(
					withStoreAsync(async () => {
						withStore(() => {});
						await anchorForInWorkspace({
							cwd: dir,
							absolutePath: path,
							content: "a\nb\n",
							lines: [1, 2],
							sessionKey: "s1",
						});
					}),
				).resolves.toBeUndefined();
			});
		});
	});

	it("rolls BOTH mutations back when the second one throws", async () => {
		await withTempDir("onetx-2-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, "a\nb\nc\n", "utf8");
			const harness = setupIntegrationTest(dir);
			// Read first so the anchors are live AND served.
			getText(await harness.readTool.execute("read", { path: "f.ts" }));

			await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				const before = [...(await loadServed("test-session", path))].sort();
				expect(before.length).toBe(3);

				await expect(
					withStoreAsync(async () => {
						// First mutation: a fresh allocation (a real write).
						await anchorForInWorkspace({
							cwd: dir,
							absolutePath: path,
							content: "a\nb\nc\n",
							lines: [1],
							sessionKey: "other-session",
						});
						// Second mutation throws: the whole file transaction must fail.
						throw new Error("boom");
					}),
				).rejects.toThrow("boom");

				// The allocation from the FIRST mutation must be gone with it.
				await expect(loadServed("other-session", path)).resolves.toEqual(new Set());
				await expect(loadServed("test-session", path)).resolves.toEqual(new Set(before));
			});
		});
	});

	it("commits both when neither throws", async () => {
		await withTempDir("onetx-3-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, "a\nb\nc\n", "utf8");
			await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				await withStoreAsync(async () => {
					await anchorForInWorkspace({
						cwd: dir,
						absolutePath: path,
						content: "a\nb\nc\n",
						lines: [1, 2],
						sessionKey: "s3",
					});
					await releaseLines({
						path,
						lines: [1],
						content: "a\nb\nc\n",
						sessionKey: "s3",
					});
				});
				const served = await loadServed("s3", path);
				// Line 1 was allocated then released; line 2 stays served.
				expect(served.size).toBe(1);
			});
		});
	});
});
