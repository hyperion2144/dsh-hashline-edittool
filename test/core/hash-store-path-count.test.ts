/**
 * The maintained PATH count (issue #311, spec #184, ADR-0010).
 *
 * The count used to be COMPUTED — a UNION over the three row families that
 * hold a path (`undo`, `served`, `anchor_meta`) — so the cold open and every
 * write paid a price that grew with the number of paths. Spec #184 promises
 * the opposite ("冷开与库体量无关"), and #305 made the ROW count maintained;
 * the path count was the same defect one level up.
 *
 * The count is the size of the UNION, not the sum of the three tables: a path
 * held by several families counts ONCE. These cases pin:
 *
 *   1. it is EXACT — after every write path it equals the real union size,
 *      and a path held by all three families still counts once;
 *   2. the open path READS it — a store whose maintained value is deliberately
 *      wrong reports the wrong number, the observable proof that no union was
 *      scanned;
 *   3. the union is not counted on open or on a write;
 *   4. a store written before the change is repaired ONCE, at open;
 *   5. the budget lines decide the same way the counted paths would.
 *
 * Where it matters the assertion is statement-level: a wall-clock bound would
 * be a machine-speed gate, so these tests ask whether the union was COUNTED,
 * not how long it took.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { resetStoreBudgetLimits, setStoreBudgetLimits } from "../../src/domain/session/store-budget.js";
import { storeDbPath, withStoreHome } from "../support/fixtures.js";
import {
	clearMaintained,
	maintainedValue,
	recordStatements,
	setMaintained,
	withDb,
} from "../support/store-counts.js";

/** The meta key that holds the maintained path count. */
const PATHS_KEY = "anchor_paths_count";


/**
 * Put a path into `anchor_meta` — the family that holds one row per file.
 *
 * The write goes through its OWN connection, so the row really is in the
 * database and the store's triggers really see it.
 */
function seedMetaPath(home: string, path: string, updatedAt: number = Date.now()): void {
	withDb(home, (db) => {
		db.prepare(
			"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, " +
			"line_count = excluded.line_count, updated_at = excluded.updated_at",
		).run(path, "checksum", 1, updatedAt);
	});
}

/** Put a path into `served` — the per-session family, one row per session. */
function seedServedPath(
	home: string,
	sessionId: string,
	path: string,
	updatedAt: number = Date.now(),
): void {
	withDb(home, (db) => {
		db.prepare(
			"INSERT INTO served (session_id, path, hashes, reported, updated_at) " +
			"VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, " +
			"reported = excluded.reported, updated_at = excluded.updated_at",
		).run(sessionId, path, "[]", null, updatedAt);
	});
}

/** Put a path into `undo` — the family that holds a stack per path. */
function seedUndoPath(home: string, path: string, depth = 0, updatedAt: number = Date.now()): void {
	withDb(home, (db) => {
		db.prepare(
			"INSERT INTO undo " +
			"(path, depth, content, bom, ending, hashes, result_content, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(path, depth) DO UPDATE SET content = excluded.content, " +
			"bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, " +
			"result_content = excluded.result_content, updated_at = excluded.updated_at",
		).run(path, depth, "content", "none", "lf", "[]", "content", updatedAt);
	});
}

/** Drop a path from one family. */
function deleteFrom(
	home: string,
	table: "undo" | "served" | "anchor_meta",
	path: string,
): void {
	withDb(home, (db) => {
		if (table === "served") {
			db.prepare("DELETE FROM served WHERE path = ?").run(path);
			return;
		}
		db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
	});
}

/** The path count as the tables really have it — the union the count stands for. */
function realPathCount(home: string): number {
	let count = 0;
	withDb(home, (db) => {
		const row = db.prepare(
			"SELECT COUNT(*) AS n FROM (" +
				"SELECT path FROM undo UNION SELECT path FROM served UNION SELECT path FROM anchor_meta)",
		).get() as { n?: number } | undefined;
		count = Number(row?.n ?? 0);
	});
	return count;
}


/** The statements that counted the union of paths. */

/** The indexes the store's database really has. */
function indexNames(home: string): string[] {
	let names: string[] = [];
	withDb(home, (db) => {
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
			name: string;
		}[];
		names = rows.map((row) => row.name);
	});
	return names;
}
function countsTheUnion(sql: string[]): string[] {
	return sql.filter(
		(statement) => /COUNT\s*\(\s*\*\s*\)/i.test(statement) && /UNION/i.test(statement),
	);
}

describe("hash-store — the maintained path count (#311)", () => {
	it("reports the maintained count, not a fresh count of the union", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedMetaPath(home, "/a.ts");
			expect(store.stats().paths).toBe(1);
			shutdownHashStore();

			// Make the maintained value WRONG but well-formed. A store that still
			// counted the union would report 1; one that reads the maintained
			// value reports 7 — the observable proof that no scan happened.
			setMaintained(home, PATHS_KEY, "7");

			const reopened = await loadHashStore();
			expect(reopened.stats().paths).toBe(7);
		});
	});

	it("never counts the union of paths on open or on a write", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedMetaPath(home, "/a.ts");
			shutdownHashStore();

			const recorder = recordStatements();
			try {
				const store = await loadHashStore();
				// The write path runs the budget check on every served anchor —
				// the higher-frequency half of the same defect.
				store.upsertServed("s1", "/a.ts", ["AAA"]);

				// The recorder has to be LIVE, or the assertion below would pass
				// for the wrong reason.
				expect(recorder.sql.some((sql) => /FROM meta WHERE key/i.test(sql))).toBe(true);
				expect(countsTheUnion(recorder.sql)).toEqual([]);
			} finally {
				recorder.restore();
			}
		});
	});

	it("repairs a store that carries no maintained value, once", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedMetaPath(home, "/a.ts");
			seedServedPath(home, "s1", "/b.ts");
			shutdownHashStore();

			// A store written before #311 carries no maintained value.
			clearMaintained(home, PATHS_KEY);

			// The repair is the ONE count the open path is allowed to pay.
			const repairing = recordStatements();
			let repairedPaths = -1;
			try {
				repairedPaths = (await loadHashStore()).stats().paths;
			} finally {
				repairing.restore();
			}
			expect(countsTheUnion(repairing.sql).length).toBeGreaterThan(0);
			expect(repairedPaths).toBe(2);
			expect(maintainedValue(home, PATHS_KEY)).toBe("2");
			shutdownHashStore();

			// The second open finds the value and counts nothing.
			const recorder = recordStatements();
			try {
				await loadHashStore();
			} finally {
				recorder.restore();
			}
			expect(countsTheUnion(recorder.sql)).toEqual([]);
		});
	});

	it("keeps the maintained count exact across every write path", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();

			// 1. A path written by a writer that is NOT the store.
			seedMetaPath(home, "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));

			// 2. The SAME path in a second family is still one path.
			seedServedPath(home, "s1", "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("1");
			// 3. And in the third family too.
			seedUndoPath(home, "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("1");
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));

			// 4. The store's own write paths.
			store.upsertServed("s2", "/b.ts", ["AAA"]);
			expect(maintainedValue(home, PATHS_KEY)).toBe("2");
			store.pushUndo("/c.ts", {
				content: "content",
				bom: "none",
				ending: "lf",
				hashes: [],
				resultContent: "content",
			});
			expect(maintainedValue(home, PATHS_KEY)).toBe("3");
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));

			// 5. Removing one family does not remove the path.
			deleteFrom(home, "served", "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("3");
			deleteFrom(home, "anchor_meta", "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("3");
			// 6. The LAST family goes: the path is gone, the count follows.
			deleteFrom(home, "undo", "/a.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("2");
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));
		});
	});

	it("recomputes the count after a store version change", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedMetaPath(home, "/a.ts");
			shutdownHashStore();

			// A version change wipes the store's rows; the maintained value must
			// not survive as a stale number.
			withDb(home, (db) => {
				db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			});

			const reopened = await loadHashStore();
			expect(reopened.stats().paths).toBe(0);
			expect(maintainedValue(home, PATHS_KEY)).toBe("0");
		});
	});

	it("re-establishes the count after the legacy dense migration", async () => {
		await withStoreHome(async (home) => {
			// A store from before the sparse anchor model: one dense `anchor_state`
			// row per path, with the anchors as a JSON array. The migration expands
			// it into sparse rows — and REPLACEs, which is exactly the write that
			// would drift a maintained count, so the count has to be re-established.
			await mkdir(dirname(storeDbPath(home)), { recursive: true });
			withDb(home, (db) => {
				db.exec(
					"CREATE TABLE anchor_state (" +
						"path TEXT PRIMARY KEY, " +
						"checksum TEXT NOT NULL, " +
						"line_count INTEGER NOT NULL, " +
						"anchors TEXT NOT NULL, " +
						"line_keys TEXT NOT NULL, " +
						"updated_at INTEGER NOT NULL" +
						")",
				);
				db.prepare(
					"INSERT INTO anchor_state (path, checksum, line_count, anchors, line_keys, updated_at) " +
						"VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					"/old.ts",
					"sum",
					2,
					JSON.stringify(["aA1", "bB2"]),
					JSON.stringify([1, 2]),
					Date.now(),
				);
			});

			await loadHashStore();

			// The legacy row expanded into one path, and the maintained count says
			// exactly that.
			expect(realPathCount(home)).toBe(1);
			expect(maintainedValue(home, PATHS_KEY)).toBe("1");
		});
	});

	it("re-establishes the count after the store is rebuilt", async () => {
		await withStoreHome(async (home) => {
			// A corrupt database is quarantined and rebuilt from scratch — the new
			// file starts with no rows, and its maintained count says so.
			await mkdir(dirname(storeDbPath(home)), { recursive: true });
			await writeFile(storeDbPath(home), "garbage bytes");

			await loadHashStore();
			expect(realPathCount(home)).toBe(0);
			expect(maintainedValue(home, PATHS_KEY)).toBe("0");
		});
	});

	it("counts once and writes the value back when the maintained count goes missing", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedMetaPath(home, "/a.ts");
			shutdownHashStore();

			// Another process (or a hand-edited meta table) dropped the key.
			clearMaintained(home, PATHS_KEY);
			const reopened = await loadHashStore();
			expect(reopened.stats().paths).toBe(1);

			// The count was taken from the tables ONCE and written back, so the
			// value is there again — and the triggers maintain it from now on.
			expect(maintainedValue(home, PATHS_KEY)).toBe("1");
			seedMetaPath(home, "/b.ts");
			expect(maintainedValue(home, PATHS_KEY)).toBe("2");
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));
		});
	});

	it("evicts on the path budget only when the count is OVER the limit", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedMetaPath(home, "/a.ts");
			seedMetaPath(home, "/b.ts");

			// A limit equal to the count is not over it: 2 paths are not over 2.
			store.sweep({ paths: 2 });
			expect(realPathCount(home)).toBe(2);
			expect(maintainedValue(home, PATHS_KEY)).toBe("2");

			// One below, and the sweep drops the paths.
			store.sweep({ paths: 1 });
			expect(realPathCount(home)).toBe(0);
			expect(maintainedValue(home, PATHS_KEY)).toBe("0");
		});
	});

	it("rebuilds the served path index after a store version change", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			shutdownHashStore();

			// A version change DROPS the `served` table — and with it the path
			// index the count triggers look paths up in. Without a rebuild, every
			// later path lookup scans the table: the cost this count exists to
			// remove, paid again on every write.
			withDb(home, (db) => {
				db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			});

			await loadHashStore();
			expect(indexNames(home)).toContain("served_by_path");
		});
	});

	it("keeps the count exact after the open path prunes stale rows", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			shutdownHashStore();

			// A served row older than the TTL: the open path prunes it, and the
			// path it was the last holder of disappears with it.
			seedServedPath(home, "s1", "/old.ts", Date.now() - 365 * 24 * 3600 * 1000);
			seedMetaPath(home, "/new.ts");

			const reopened = await loadHashStore();
			expect(reopened.stats().paths).toBe(1);
			expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));
		});
	});

	it("decides the evict and rebuild lines from the maintained count", async () => {
		await withStoreHome(async (home) => {
			setStoreBudgetLimits({ paths: 1 });
			try {
				await loadHashStore();
				shutdownHashStore();

				// 4 paths with a limit of 1: the 4× evict line. The store reads the
				// MAINTAINED count to decide, and the sweep that follows keeps the
				// count exact.
				for (let i = 0; i < 4; i += 1) seedMetaPath(home, `/p${i}.ts`);
				const swept = await loadHashStore();
				expect(swept.stats().paths).toBeLessThan(4);
				expect(maintainedValue(home, PATHS_KEY)).toBe(String(realPathCount(home)));
				shutdownHashStore();

				// 16 paths with a limit of 1: the 16× rebuild line. The store is torn
				// down and rebuilt, so the count starts from zero again.
				for (let i = 0; i < 16; i += 1) seedMetaPath(home, `/q${i}.ts`);
				const rebuilt = await loadHashStore();
				expect(rebuilt.stats().paths).toBe(0);
				expect(maintainedValue(home, PATHS_KEY)).toBe("0");
			} finally {
				resetStoreBudgetLimits();
			}
		});
	});
});
