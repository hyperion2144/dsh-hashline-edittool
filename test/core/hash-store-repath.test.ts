/**
 * `HashStore.renamePath` — the path migration the `rename` tool calls.
 *
 * The contract under test: all four families move from one canonical path to
 * another in one transaction, the destination's dead residue is purged first,
 * payloads (anchors, undo bodies, `updated_at`) are carried verbatim, and the
 * maintained path / row counts stay equal to the tables they mirror.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore } from "../../src/domain/session/hash-store.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
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

/** Seed one path's anchor families at a known timestamp. */
function seedAnchors(
	home: string,
	path: string,
	checksum: string,
	lineCount: number,
	rows: Array<[line: number, anchor: string, contentKey: number]>,
	updatedAt: number,
): void {
	const db = new DatabaseSync(storeDbPath(home));
	try {
		db.prepare(
			"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?)",
		).run(path, checksum, lineCount, updatedAt);
		const line = db.prepare(
			"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (const [number, anchor, contentKey] of rows) {
			line.run(path, number, anchor, contentKey, updatedAt);
		}
	} finally {
		db.close();
	}
}

/** The two maintained values and the tables they mirror. */
function maintenanceFacts(home: string): {
	maintainedRows: number;
	actualRows: number;
	maintainedPaths: number;
	actualPaths: number;
} {
	const db = new DatabaseSync(storeDbPath(home));
	try {
		const actualRows = Number(
			(db.prepare("SELECT COUNT(*) AS n FROM anchor_lines").get() as { n: number }).n,
		);
		const actualPaths = Number(
			(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM (" +
							"SELECT path FROM anchor_meta UNION " +
							"SELECT path FROM anchor_lines UNION " +
							"SELECT path FROM served UNION " +
							"SELECT path FROM undo)",
					)
					.get() as { n: number }
			).n,
		);
		return { maintainedRows: 0, actualRows, maintainedPaths: 0, actualPaths };
	} finally {
		db.close();
	}
}

describe("HashStore.renamePath", () => {
	it("moves the four families and purges the destination's residue", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const from = "/tmp/repath-from.ts";
			const to = "/tmp/repath-to.ts";
			const other = "/tmp/repath-other.ts";
			const older = Date.now() - 60_000;

			seedAnchors(home, from, contentChecksum("alpha\nbeta\n"), 2, [
				[1, "AAA", 0],
				[2, "BBB", 1],
			], older);
			// The destination's file is gone; its rows are residue to reclaim.
			seedAnchors(home, to, contentChecksum("dead\n"), 1, [[1, "ZZZ", 9]], older - 5_000);
			seedAnchors(home, other, contentChecksum("keep\n"), 1, [[1, "CCC", 0]], older);

			store.pushUndo(from, undoLayer("before\n"));
			store.pushUndo(to, undoLayer("dead-before\n"));
			store.pushUndo(other, undoLayer("keep-undo\n"));
			store.upsertServed("s1", from, ["AAA", "BBB"]);
			store.upsertServed("s2", from, ["AAA"]);
			store.upsertServed("s1", to, ["ZZZ"]);
			store.upsertServed("s1", other, ["CCC"]);

			const report = store.renamePath(from, to);

			expect(report).toMatchObject({
				anchorMeta: 1,
				anchorLines: 2,
				servedRows: 2,
				undoLayers: 1,
			});
			expect(report.purged).toMatchObject({
				anchorMeta: 1,
				anchorLines: 1,
				servedRows: 1,
				undoLayers: 1,
			});

			// The moved rows are the source's, not the destination's.
			expect(store.getUndo(from)).toBeUndefined();
			expect(store.getUndo(to)).toMatchObject({ content: "before\n" });
			expect(store.getServed("s1", to)).toEqual(new Set(["AAA", "BBB"]));
			expect(store.getServed("s2", to)).toEqual(new Set(["AAA"]));
			expect(store.getServed("s1", from).size).toBe(0);
			expect(store.allKnownPaths().map((row) => row.path).sort()).toEqual([other, to].sort());

			// The other path keeps its own four families.
			expect(store.getUndo(other)).toBeDefined();
			expect(store.getServed("s1", other)).toEqual(new Set(["CCC"]));
		});
	});

	it("carries anchors, undo bodies and updated_at verbatim", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const from = "/tmp/repath-payload-from.ts";
			const to = "/tmp/repath-payload-to.ts";
			const updatedAt = 1_700_000_000_000;

			seedAnchors(home, from, contentChecksum("one\ntwo\n"), 2, [
				[1, "Ab", 0],
				[2, "Cd", 1],
			], updatedAt);
			store.pushUndo(from, undoLayer("payload-before\n"));

			store.renamePath(from, to);

			const db = new DatabaseSync(storeDbPath(home));
			try {
				const meta = db
					.prepare("SELECT checksum, line_count, updated_at FROM anchor_meta WHERE path = ?")
					.get(to) as { checksum: string; line_count: number; updated_at: number };
				expect(meta).toEqual({
					checksum: contentChecksum("one\ntwo\n"),
					line_count: 2,
					updated_at: updatedAt,
				});

				const lines = db
					.prepare("SELECT line, anchor, content_key, updated_at FROM anchor_lines WHERE path = ? ORDER BY line")
					.all(to) as Array<{ line: number; anchor: string; content_key: number; updated_at: number }>;
				expect(lines).toEqual([
					{ line: 1, anchor: "Ab", content_key: 0, updated_at: updatedAt },
					{ line: 2, anchor: "Cd", content_key: 1, updated_at: updatedAt },
				]);

				const undone = db
					.prepare("SELECT content FROM undo WHERE path = ?")
					.get(to) as { content: Uint8Array };
				expect(Buffer.from(undone.content).toString("utf8")).toBe("payload-before\n");
			} finally {
				db.close();
			}
		});
	});

	it("keeps the maintained row / path counts equal to the tables", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const from = "/tmp/repath-count-from.ts";
			const to = "/tmp/repath-count-to.ts";
			const other = "/tmp/repath-count-other.ts";
			const older = Date.now() - 60_000;

			seedAnchors(home, from, contentChecksum("a\nb\nc\n"), 3, [
				[1, "Aa", 0],
				[2, "Bb", 1],
				[3, "Cc", 2],
			], older);
			seedAnchors(home, to, contentChecksum("dead\n"), 1, [[1, "Zz", 9]], older);
			seedAnchors(home, other, contentChecksum("keep\n"), 1, [[1, "Kk", 0]], older);
			store.upsertServed("s1", from, ["Aa"]);
			store.upsertServed("s1", other, ["Kk"]);

			store.renamePath(from, to);

			const facts = maintenanceFacts(home);
			const stats = store.stats();
			expect(stats.rows).toBe(facts.actualRows);
			expect(stats.paths).toBe(facts.actualPaths);
		});
	});

	it("is a no-op for an absent source and for a same-path rename", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			const from = "/tmp/repath-noop.ts";
			const to = "/tmp/repath-noop-target.ts";
			seedAnchors(home, from, contentChecksum("x\n"), 1, [[1, "Xx", 0]], Date.now());
			store.upsertServed("s1", from, ["Xx"]);

			expect(store.renamePath("/tmp/repath-missing.ts", to)).toMatchObject({
				anchorMeta: 0,
				anchorLines: 0,
				servedRows: 0,
				undoLayers: 0,
			});

			expect(store.renamePath(from, from)).toMatchObject({
				anchorMeta: 0,
				anchorLines: 0,
				servedRows: 0,
				undoLayers: 0,
			});
			// Same-path must NOT purge the rows it was asked to keep.
			expect(store.getServed("s1", from)).toEqual(new Set(["Xx"]));
		});
	});
});
