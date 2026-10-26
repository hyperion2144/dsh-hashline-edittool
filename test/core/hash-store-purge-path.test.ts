/**
 * `HashStore.purgePath` — the one per-path cascade the delete tool, the sweep
 * and `pruneMissing` share — and the shutdown VACUUM it arms.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";

import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { DatabaseSync } from "node:sqlite";
import { storeDbPath, withStoreHome } from "../support/fixtures.js";

function undoLayer(content: string) {
	return {
		content,
		bom: "",
		ending: "\n",
		hashes: ["AAA"],
		resultContent: "after\n",
	};
}

describe("HashStore.purgePath", () => {
	it("removes every row family for one path and leaves the others alone", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const path = "/tmp/purge-a.ts";
			const other = "/tmp/purge-b.ts";

			const seedDb = new DatabaseSync(storeDbPath(home));
			try {
				seedDb
					.prepare(
						"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, updated_at = excluded.updated_at",
					)
					.run(path, contentChecksum("alpha\nbeta\n"), 2, Date.now());
				seedDb
					.prepare(
						"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, line) DO UPDATE SET anchor = excluded.anchor, content_key = excluded.content_key, updated_at = excluded.updated_at",
					)
					.run(path, 1, "AAA", 0, Date.now());
				seedDb
					.prepare(
						"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, line) DO UPDATE SET anchor = excluded.anchor, content_key = excluded.content_key, updated_at = excluded.updated_at",
					)
					.run(path, 2, "BBB", 1, Date.now());
				seedDb
					.prepare(
						"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, updated_at = excluded.updated_at",
					)
					.run(other, contentChecksum("other\n"), 1, Date.now());
				seedDb
					.prepare(
						"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, line) DO UPDATE SET anchor = excluded.anchor, content_key = excluded.content_key, updated_at = excluded.updated_at",
					)
					.run(other, 1, "CCC", 0, Date.now());
			} finally {
				seedDb.close();
			}
			store.pushUndo(path, undoLayer("x".repeat(512 * 1024)));
			store.pushUndo(other, undoLayer("keep\n"));
			store.upsertServed("s1", path, ["AAA"]);
			store.upsertServed("s2", path, ["BBB"]);
			store.upsertServed("s1", other, ["CCC"]);
			const before = store.stats().rows;

			const report = store.purgePath(path);

			expect(report).toMatchObject({
				anchorMeta: 1,
				anchorLines: 2,
				undoLayers: 1,
				servedRows: 2,
			});
			expect(report.bytesFreed).toBeGreaterThan(0);
			expect(store.metaGet("pending_vacuum")).toBe("1");
			expect(store.getUndo(path)).toBeUndefined();
			expect(store.getServed("s1", path).size).toBe(0);
			expect(store.getServed("s2", path).size).toBe(0);
			expect(store.allKnownPaths().some((row) => row.path === path)).toBe(false);
			expect(store.stats().rows).toBe(before - 2);

			// The other path owns its own four families, untouched.
			expect(store.getUndo(other)).toBeDefined();
			expect(store.getServed("s1", other)).toEqual(new Set(["CCC"]));
			expect(store.allKnownPaths().some((row) => row.path === other)).toBe(true);

			// Idempotent: a second purge of the same path reports zeros.
			expect(store.purgePath(path)).toMatchObject({
				anchorMeta: 0,
				anchorLines: 0,
				undoLayers: 0,
				servedRows: 0,
				bytesFreed: 0,
			});

			// The DB file is still on disk; the marker only arms the close path.
			expect(statSync(storeDbPath(home)).size).toBeGreaterThan(0);
		});
	});

	it("the pending marker makes shutdown run a VACUUM that returns disk", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const path = "/tmp/purge-big.ts";
			store.pushUndo(path, undoLayer("y".repeat(2 * 1024 * 1024)));

			store.purgePath(path);
			expect(store.metaGet("pending_vacuum")).toBe("1");
			shutdownHashStore();

			const after = statSync(storeDbPath(home)).size;
			expect(after).toBeLessThan(512 * 1024);

			// A successful VACUUM clears the marker; the store reopens clean.
			const reopened = await loadHashStore();
			expect(reopened.metaGet("pending_vacuum")).toBeUndefined();
		});
	});
});
