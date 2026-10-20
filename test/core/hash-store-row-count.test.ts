/**
 * The maintained `anchor_lines` row count (issue #305, spec #184, ADR-0010).
 *
 * The count used to be COMPUTED — `SELECT COUNT(*) FROM anchor_lines`, whose
 * plan is a scan of the table's index — so the cold open and every write paid a
 * price that grew with the library. Spec #184 promises the opposite ("冷开与库
 * 体量无关"). The count is now MAINTAINED, in `meta`, by two triggers that move
 * it in the same transaction as the row write.
 *
 * These cases pin the three properties that make a maintained count safe:
 *
 *   1. it is EXACT — after every write path it equals `COUNT(*)`;
 *   2. the open path READS it — a store whose maintained value is deliberately
 *      wrong reports the wrong number, which is the observable proof that no
 *      table scan happened;
 *   3. a store written before the change is repaired ONCE, at open;
 *   4. the budget lines decide the same way the counted rows would — pinned on
 *      BOTH sides of the line (the open path's rebuild/evict rules and the
 *      sweep's row limit).
 *
 * Where it matters the assertion is statement-level: a wall-clock bound would
 * be a machine-speed gate (the same open measured 8 ms on a laptop and 131 ms in
 * CI), so these tests ask whether the table was COUNTED, not how long it took.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import {
	isOverEvictLimit,
	isOverRebuildLimit,
} from "../../src/domain/session/store-budget.js";
import { storeDbPath, withStoreHome } from "../support/fixtures.js";
import {
	clearMaintained,
	maintainedValue,
	recordStatements,
	setMaintained,
	withDb,
} from "../support/store-counts.js";

/** The meta key that holds the maintained row count. */
const ROWS_KEY = "anchor_lines_rows";



/**
 * Seed anchor rows the way a reader does — but through its OWN connection, so
 * the rows really are in the database and the store's triggers really see them.
 */
function seedLines(
	home: string,
	path: string,
	count: number,
	updatedAt: number = Date.now(),
): void {
	withDb(home, (db) => {
		db.prepare(
			"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, " +
			"line_count = excluded.line_count, updated_at = excluded.updated_at",
		).run(path, "checksum", count, updatedAt);
		const insert = db.prepare(
			"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (let i = 0; i < count; i++) {
			insert.run(path, i + 1, `A${i}`, i, updatedAt);
		}
	});
}

/** Re-write one row that already exists — the count must not move. */
function upsertLine(home: string, path: string, line: number, anchor: string): void {
	withDb(home, (db) => {
		db.prepare(
			"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT(path, line) DO UPDATE SET anchor = excluded.anchor, " +
				"content_key = excluded.content_key, updated_at = excluded.updated_at",
		).run(path, line, anchor, line, Date.now());
	});
}

/** Drop one row. */
function deleteLine(home: string, path: string, line: number): void {
	withDb(home, (db) => {
		db.prepare("DELETE FROM anchor_lines WHERE path = ? AND line = ?").run(path, line);
	});
}

/** The row count as the table really has it. */
function realRowCount(home: string): number {
	let count = 0;
	withDb(home, (db) => {
		const row = db.prepare("SELECT COUNT(*) AS n FROM anchor_lines").get() as {
			n?: number;
		};
		count = Number(row?.n ?? 0);
	});
	return count;
}


/** The statements that counted the whole table. */
function countsTheTable(sql: string[]): string[] {
	return sql.filter(
		(statement) =>
			/COUNT\s*\(\s*\*\s*\)/i.test(statement) && /FROM\s+anchor_lines/i.test(statement),
	);
}

describe("hash-store — the maintained anchor_lines row count (#305)", () => {
	it("reports the maintained count, not a fresh count of the table", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedLines(home, "/a.ts", 3);
			expect(store.stats().rows).toBe(3);

			// Make the maintained value WRONG but well-formed. A store that still
			// counted the table would report 3; one that reads the maintained
			// value reports 7 — the observable proof that no scan happened.
			shutdownHashStore();
			setMaintained(home, ROWS_KEY, "7");

			const reopened = await loadHashStore();
			expect(reopened.stats().rows).toBe(7);
		});
	});

	it("never counts the anchor_lines table on open or on a write", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedLines(home, "/a.ts", 5);
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
				expect(countsTheTable(recorder.sql)).toEqual([]);
			} finally {
				recorder.restore();
			}
		});
	});

	it("repairs a store that carries no maintained value, once", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedLines(home, "/a.ts", 4);
			shutdownHashStore();

			// A store written before #305 carries no maintained value.
			clearMaintained(home, ROWS_KEY);

			// The repair is the ONE count the open path is allowed to pay.
			const repairing = recordStatements();
			let repairedRows = -1;
			try {
				repairedRows = (await loadHashStore()).stats().rows;
			} finally {
				repairing.restore();
			}
			expect(countsTheTable(repairing.sql).length).toBeGreaterThan(0);
			expect(repairedRows).toBe(4);
			expect(maintainedValue(home, ROWS_KEY)).toBe("4");
			shutdownHashStore();

			// The second open finds the value and counts nothing.
			const recorder = recordStatements();
			try {
				await loadHashStore();
			} finally {
				recorder.restore();
			}
			expect(countsTheTable(recorder.sql)).toEqual([]);
		});
	});

	it("keeps the maintained count exact across every write path", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();

			// 1. Rows written by a writer that is NOT the store.
			seedLines(home, "/a.ts", 3);
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));

			// 2. Re-writing a row that exists changes no count.
			upsertLine(home, "/a.ts", 1, "ZZZ");
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));

			// 3. Deleting one row.
			deleteLine(home, "/a.ts", 1);
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));

			// 4. The TTL prune — the sweep's first phase — drops the rows that
			//    aged out.
			seedLines(home, "/old.ts", 2, Date.now() - 40 * 24 * 60 * 60 * 1000);
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));
			store.sweep();
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));

			// 5. The paths that are gone from disk go with them.
			await store.pruneMissing();
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));
			expect(store.stats().rows).toBe(0);
		});
	});

	it("recomputes the count after a store version change", async () => {
		await withStoreHome(async (home) => {
			await loadHashStore();
			seedLines(home, "/a.ts", 3);
			shutdownHashStore();

			// A version change wipes the store's rows; the maintained value must
			// not survive as a stale number.
			withDb(home, (db) => {
				db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			});

			const reopened = await loadHashStore();
			expect(reopened.stats().rows).toBe(0);
			expect(maintainedValue(home, ROWS_KEY)).toBe("0");
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

			// The legacy row expanded into two sparse lines, and the maintained
			// count says exactly that.
			expect(realRowCount(home)).toBe(2);
			expect(maintainedValue(home, ROWS_KEY)).toBe("2");
		});
	});

	it("re-establishes the count after the store is rebuilt", async () => {
		await withStoreHome(async (home) => {
			// A corrupt database is quarantined and rebuilt from scratch — the new
			// file starts with no rows, and its maintained count says so.
			await mkdir(dirname(storeDbPath(home)), { recursive: true });
			await writeFile(storeDbPath(home), "garbage bytes");

			await loadHashStore();

			expect(realRowCount(home)).toBe(0);
			expect(maintainedValue(home, ROWS_KEY)).toBe("0");
		});
	});

	it("counts once and writes the value back when the maintained count goes missing", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedLines(home, "/a.ts", 3);

			// Another process (or a hand-edited meta table) dropped the key.
			clearMaintained(home, ROWS_KEY);
			expect(store.stats().rows).toBe(3);

			// The count was taken from the table ONCE and written back, so the
			// value is there again — and the triggers maintain it from now on.
			expect(maintainedValue(home, ROWS_KEY)).toBe("3");
			upsertLine(home, "/a.ts", 4, "ZZZ");
			expect(maintainedValue(home, ROWS_KEY)).toBe(String(realRowCount(home)));
		});
	});

	it("decides the rebuild and evict lines on both sides of the boundary", () => {
		const limits = { bytes: 1000, paths: 10, rows: 5 };
		const nothing = { bytes: 0, paths: 0, rows: 0 };

		// The rebuild line is 16× the budget, the evict line 4×; the line itself
		// counts as over.
		expect(isOverRebuildLimit({ ...nothing, rows: limits.rows * 16 - 1 }, limits)).toBe(false);
		expect(isOverRebuildLimit({ ...nothing, rows: limits.rows * 16 }, limits)).toBe(true);
		expect(isOverRebuildLimit({ ...nothing, paths: limits.paths * 16 - 1 }, limits)).toBe(false);
		expect(isOverRebuildLimit({ ...nothing, paths: limits.paths * 16 }, limits)).toBe(true);
		expect(isOverRebuildLimit({ ...nothing, bytes: limits.bytes * 16 - 1 }, limits)).toBe(false);
		expect(isOverRebuildLimit({ ...nothing, bytes: limits.bytes * 16 }, limits)).toBe(true);

		expect(isOverEvictLimit({ ...nothing, rows: limits.rows * 4 - 1 }, limits)).toBe(false);
		expect(isOverEvictLimit({ ...nothing, rows: limits.rows * 4 }, limits)).toBe(true);
		expect(isOverEvictLimit({ ...nothing, paths: limits.paths * 4 - 1 }, limits)).toBe(false);
		expect(isOverEvictLimit({ ...nothing, paths: limits.paths * 4 }, limits)).toBe(true);
		expect(isOverEvictLimit({ ...nothing, bytes: limits.bytes * 4 - 1 }, limits)).toBe(false);
		expect(isOverEvictLimit({ ...nothing, bytes: limits.bytes * 4 }, limits)).toBe(true);
	});

	it("evicts on the row budget only when the count is OVER the limit", async () => {
		await withStoreHome(async (home) => {
			const store = await loadHashStore();
			seedLines(home, "/a.ts", 3);

			// A limit equal to the count is not over it: 3 rows are not over 3.
			store.sweep({ rows: 3 });
			expect(realRowCount(home)).toBe(3);

			// One below, and the sweep drops the path.
			store.sweep({ rows: 2 });
			expect(realRowCount(home)).toBe(0);
		});
	});
});
