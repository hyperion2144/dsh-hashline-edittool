import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	loadHashStore,
	shutdownHashStore,
	type HashStore,
} from "../../src/domain/session/hash-store.js";
import { HASH_STORE_VERSION } from "../../src/infra/constants.js";
import { getWritableTempRoot } from "../support/fixtures.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";

let tmpHome: string;
beforeAll(async () => {
});

async function withTempHome(
	run: (home: string) => Promise<void>,
): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-hashstore-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	// Point the harness home at the TEMP home explicitly — an EMPTY stub leans on
	// `homedir()/.dsh`, which is a different directory on Windows
	// (`os.homedir()` reads USERPROFILE).
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		await run(tmpHome);
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(tmpHome, { recursive: true, force: true });
	}
}

function configHome(home: string): string {
	return join(home, ".dsh", "plugins", "dsh-hashline-edittool");
}

function sqlitePath(home: string): string {
	return join(configHome(home), "hash-store.sqlite");
}

function legacyPath(home: string): string {
	return join(configHome(home), "hash-store.json");
}

/**
 * Seed one file's anchor state, the way a read does.
 *
 * Was `store.upsertSnapshot(...)` against the `snapshots` table, which is gone
 * (contract §8). The same fact now lives in the two tables that survived it:
 * `anchor_meta` (checksum + line count) and `anchor_lines` (one row per line).
 *
 * Written through its OWN connection rather than a store method, so a test can
 * prove the row really reached the database and is not an in-process cache —
 * which is the property these cases are about.
 */
function put(
	home: string,
	path: string,
	content: string,
	hashes: string[],
): void {
	const db = new DatabaseSync(sqlitePath(home));
	try {
		db.prepare(
			"INSERT OR REPLACE INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?)",
		).run(path, contentChecksum(content), hashes.length, Date.now());
		const ins = db.prepare(
			"INSERT OR REPLACE INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (let i = 0; i < hashes.length; i++) {
			ins.run(path, i + 1, hashes[i]!, i, Date.now());
		}
	} finally {
		db.close();
	}
}

/**
 * Read one file's anchors back, or `undefined` when it holds none.
 *
 * The reader `getSnapshot` used to be. It matches on (path, checksum) the way
 * that one did — a different content is a miss — but reads `anchor_lines`
 * through a SEPARATE connection, so a test can prove that what it seeded really
 * reached the database rather than only an in-process cache.
 */
function snapshotOf(
	home: string,
	path: string,
	content: string,
): string[] | undefined {
	const db = new DatabaseSync(sqlitePath(home), { readOnly: true });
	try {
		const meta = db
			.prepare("SELECT checksum FROM anchor_meta WHERE path = ?")
			.get(path) as { checksum?: string } | undefined;
		if (meta?.checksum !== contentChecksum(content)) return undefined;
		const rows = db
			.prepare("SELECT anchor FROM anchor_lines WHERE path = ? ORDER BY line ASC")
			.all(path) as { anchor: string }[];
		if (rows.length === 0) return undefined;
		return rows.map((row) => row.anchor);
	} finally {
		db.close();
	}
}

/** Row count in one table, read through a separate connection. */
function countRows(home: string, table: string): number {
	const db = new DatabaseSync(sqlitePath(home), { readOnly: true });
	try {
		return (
			db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

async function writeLegacyStore(
	home: string,
	snapshots: unknown,
): Promise<void> {
	await mkdir(configHome(home), { recursive: true });
	await writeFile(
		legacyPath(home),
		JSON.stringify({ version: 1, snapshots }),
		"utf-8",
	);
}

describe("hash-store — loadHashStore", () => {
	it("opens a fresh sqlite database when none exists", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			expect(existsSync(sqlitePath(home))).toBe(true);
			expect(store.allKnownPaths()).toEqual([]);
		});
	});

	it("creates the config directory", async () => {
		await withTempHome(async () => {
			await loadHashStore();
			const s = await stat(configHome(tmpHome));
			expect(s.isDirectory()).toBe(true);
		});
	});

	/**
	 * Contract §8: `snapshots` is deleted — it duplicated `anchor_meta` +
	 * `anchor_lines`. The DROP is the migration (no version bump: wiping every
	 * anchor a model holds is not worth removing a redundant table), so this
	 * checks the table is gone from a store that predates the change.
	 */
	it("drops the redundant snapshots table and does not recreate it", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			// A store from before the change: the table exists and holds a row.
			const old = new DatabaseSync(sqlitePath(home));
			old.exec(
				"CREATE TABLE snapshots (path TEXT PRIMARY KEY, checksum TEXT NOT NULL, line_count INTEGER NOT NULL, hashes TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			old.prepare(
				"INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run("/p.ts", contentChecksum("x\n"), 1, JSON.stringify(["XYZ"]), Date.now());
			old.close();

			await loadHashStore();

			const check = new DatabaseSync(sqlitePath(home), { readOnly: true });
			const row = check
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
				.get();
			check.close();
			expect(row).toBeUndefined();
		});
	});
});

describe("hash-store — migration from legacy hash-store.json", () => {
	/**
	 * The legacy JSON held `{snapshots: {path: {content, hashes}}}` — whole-file
	 * anchor arrays. It is no longer imported: anchors are a deterministic
	 * function of content, so the next read re-derives exactly the same array,
	 * and the JSON has no per-line content keys an `anchor_lines` row would need
	 * to answer the §2.2 verdict. The file is still retired to `.bak` so it is
	 * not re-examined on every open.
	 */
	it("does not import the payload but retires the file to .bak", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/valid.ts": { content: "ok\n", hashes: ["ABC"] },
				"/also.ts": { content: "good\nmore\n", hashes: ["XYZ", "QWE"] },
			});

			const store = await loadHashStore();

			// Nothing was imported: the JSON is a cache, not a source of truth.
			expect(store.allKnownPaths()).toEqual([]);
			expect(snapshotOf(home, "/valid.ts", "ok\n")).toBeUndefined();
			// …and the file is retired, not deleted (kept as the historical record).
			expect(existsSync(legacyPath(home))).toBe(false);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
		});
	});

	it("retires a legacy file whose snapshots field is malformed", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, ["not-an-object"]);
			const store = await loadHashStore();
			expect(store.allKnownPaths()).toEqual([]);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);
		});
	});

	it("does not run migration when no legacy file exists", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			expect(store.allKnownPaths()).toEqual([]);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(false);
		});
	});

	it("migrates only once even if legacy file reappears", async () => {
		await withTempHome(async (home) => {
			await writeLegacyStore(home, {
				"/one.ts": { content: "1\n", hashes: ["AAA"] },
			});
			const first = await loadHashStore();
			expect(first.allKnownPaths()).toEqual([]);
			expect(existsSync(`${legacyPath(home)}.bak`)).toBe(true);

			await writeFile(
				legacyPath(home),
				JSON.stringify({
					version: 1,
					snapshots: { "/two.ts": { content: "2\n", hashes: ["BBB"] } },
				}),
				"utf-8",
			);

			const second = await loadHashStore();
			expect(second.allKnownPaths()).toEqual([]);
			expect(snapshotOf(home, "/two.ts", "2\n")).toBeUndefined();
		});
	});
});

describe("hash-store — concurrency (issue #10)", () => {
	it("preserves anchors written by a separately-opened connection", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/a.ts", "alpha\n", ["AAB"]);

			const second = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			second.exec("BEGIN IMMEDIATE");
			second
				.prepare(
					"INSERT OR REPLACE INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?)",
				)
				.run("/b.ts", contentChecksum("beta\n"), 1, Date.now());
			second
				.prepare(
					"INSERT OR REPLACE INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("/b.ts", 1, "BBC", 0, Date.now());
			second.exec("COMMIT");
			second.close();

			shutdownHashStore();
			const reloaded = await loadHashStore();
			expect(snapshotOf(home, "/a.ts", "alpha\n")).toEqual(["AAB"]);
			expect(snapshotOf(home, "/b.ts", "beta\n")).toEqual(["BBC"]);
		});
	});

	it("a fresh reopen sees anchors written by a prior session", async () => {
		await withTempHome(async (home) => {
			const a = await loadHashStore();
			put(home, "/first.ts", "one\n", ["111"]);
			shutdownHashStore();

			const b = await loadHashStore();
			put(home, "/second.ts", "two\n", ["222"]);
			shutdownHashStore();

			const c = await loadHashStore();
			expect(snapshotOf(home, "/first.ts", "one\n")).toEqual(["111"]);
			expect(snapshotOf(home, "/second.ts", "two\n")).toEqual(["222"]);
		});
	});
});

describe("hash-store — incremental writes (issue #8)", () => {
	it("upserting a new path does not alter an existing path's stored hashes", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			const bigContent = "x\n".repeat(2000);
			const bigHashes = bigContent
				.split("\n")
				.map((_, i) => i.toString(16).padStart(3, "0"));
			put(home, "/big.ts", bigContent, bigHashes);
			const before = snapshotOf(home, "/big.ts", bigContent);

			put(home, "/other.ts", "y\n", ["YYZ"]);

			expect(snapshotOf(home, "/big.ts", bigContent)).toEqual(before);
		});
	});
});

describe("hash-store — WAL checkpoint on shutdown", () => {
	it("truncates the WAL file after shutdownHashStore", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "x\n", ["XYZ"]);

			const walPath = sqlitePath(home) + "-wal";
			expect(existsSync(walPath)).toBe(true);

			shutdownHashStore();

			expect(existsSync(walPath)).toBe(false);
		});
	});
});

describe("hash-store — corrupt database recovery", () => {
	it("rebuilds the store when the database file is corrupt", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			await writeFile(
				sqlitePath(home),
				"this is not a sqlite database",
				"utf-8",
			);

			const store = await loadHashStore();
			expect(snapshotOf(home, "/x.ts", "a\n")).toBeUndefined();

			put(home, "/x.ts", "a\n", ["AAA"]);
			expect(snapshotOf(home, "/x.ts", "a\n")).toEqual(["AAA"]);
		});
	});

	it("quarantines the corrupt file instead of deleting it", async () => {
		await withTempHome(async (home) => {
			await mkdir(configHome(home), { recursive: true });
			await writeFile(sqlitePath(home), "garbage bytes", "utf-8");

			await loadHashStore();

			const entries = await readdir(configHome(home));
			expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
			expect(existsSync(sqlitePath(home))).toBe(true);
		});
	});

	it("keeps working when the store is healthy", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "b\n", ["BBB"]);
			expect(snapshotOf(home, "/p.ts", "b\n")).toEqual(["BBB"]);
			const entries = await readdir(configHome(home));
			expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
		});
	});
});

describe("hash-store — schema versioning", () => {
	it("writes the current version on first open", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = db
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			db.close();

			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});

	it("keeps anchors when the stored version matches", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const reloaded = await loadHashStore();
			expect(snapshotOf(home, "/p.ts", "x\n")).toEqual(["XYZ"]);
		});
	});

	/**
	 * The upgrade path, per contract §8 / decision #222: NOTHING is migrated
	 * ("不迁移任何数据"). Asserting the anchors are gone is only half of it — the
	 * SERVED set has to go too, or a session would keep believing it had seen
	 * anchors the store no longer holds, and every edit would fail the §2.2
	 * liveness condition while the model was told it had read the file.
	 */
	it("invalidates anchors AND served when the stored version differs", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "x\n", ["XYZ"]);
			store.upsertServed("session-1", "/p.ts", ["XYZ"]);
			store.pushUndo("/u.ts", {
				content: "old",
				bom: "",
				ending: "\n",
				hashes: ["UVW"],
				resultContent: "new",
			});
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			db.close();

			const reloaded = await loadHashStore();
			expect(snapshotOf(home, "/p.ts", "x\n")).toBeUndefined();
			expect(reloaded.getServed("session-1", "/p.ts")).toEqual(new Set());
			expect(reloaded.getUndo("/u.ts")).toBeUndefined();
			expect(countRows(home, "anchor_lines")).toBe(0);
			expect(countRows(home, "served")).toBe(0);

			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = check
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			check.close();
			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});

	/**
	 * Decision #222: the operational `meta` keys describe the STORE's health,
	 * not the anchors in it, so they must survive the wipe. `last_rebuild_at`
	 * is the throttle that stops a 24h rebuild loop, and
	 * `last_open_integrity_check` is what keeps the integrity probe from running
	 * on every launch.
	 *
	 * `clean_shutdown` is deliberately NOT asserted here: it is
	 * lifecycle-managed (set on graceful shutdown, cleared at open so an unclean
	 * exit is detectable), so its absence after an open is the mechanism working,
	 * not a key being lost.
	 */
	it("preserves operational meta keys across a version change", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			store.metaSet("last_rebuild_at", "1700000000000");
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.prepare("UPDATE meta SET value = '999' WHERE key = 'version'").run();
			db.close();

			const reloaded = await loadHashStore();
			expect(reloaded.metaGet("last_rebuild_at")).toBe("1700000000000");
			expect(reloaded.metaGet("last_open_integrity_check")).toBeDefined();
		});
	});

	it("keeps anchors from a pre-versioning database and writes the version", async () => {
		await withTempHome(async (home) => {
			const store = await loadHashStore();
			put(home, "/p.ts", "x\n", ["XYZ"]);
			shutdownHashStore();

			const db = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			db.exec("DROP TABLE meta");
			db.close();

			const reloaded = await loadHashStore();
			expect(snapshotOf(home, "/p.ts", "x\n")).toEqual(["XYZ"]);

			const check = new DatabaseSync(sqlitePath(home), {
				defensive: false,
			} as any);
			const row = check
				.prepare("SELECT value FROM meta WHERE key = 'version'")
				.get() as { value?: string } | undefined;
			check.close();
			expect(row?.value).toBe(String(HASH_STORE_VERSION));
		});
	});
});
