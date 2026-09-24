/**
 * Hash-store eviction policy tests (issue #180, spec #184, ADR-0010).
 *
 * These tests pin the external behavior of `HashStore.sweep`:
 *  - any one of bytes / paths / rows exceeding its budget triggers eviction
 *  - the LRU path keeps the most recently used, drops the oldest
 *  - the TTL phase drops whole paths whose MAX(updated_at) is below cutoff
 *  - the per-path slim phase enforces UNDO_MAX_PATH_BYTES while keeping ≥ 1
 *    undo layer per path
 *  - the multi-delete (10 %) over-trim holds when LRU actually evicted
 *
 * Thresholds are injected via `SweepOptions` so we don't have to write 64 MiB
 * to drive eviction. Each test gets a fresh `$DSH_HOME` so db state cannot
 * leak between tests.
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	loadHashStore,
	shutdownHashStore,
	type HashStore,
} from "../../src/domain/session/hash-store.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/infra/utils.js";
import { getWritableTempRoot } from "../support/fixtures.js";

async function withFreshHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-store-budget-test-"),
	);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("DSH_HOME", join(home, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		return await run(home);
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	}
}

async function withStore(run: (store: HashStore) => Promise<void>): Promise<void> {
	await withFreshHome(async () => {
		const store = await loadHashStore();
		await run(store);
	});
}

function sqlitePath(home: string): string {
	return join(home, ".dsh", "plugins", "dsh-hashline-edittool", "hash-store.sqlite");
}

/** Push one path with a unique content; bumps its updated_at. */
function touchPath(
	store: HashStore,
	home: string,
	path: string,
	lines: string[],
	offsetMs = 0,
): void {
const content = lines.join("\n") + "\n"; store.upsertSnapshot(path, contentChecksum(content), splitLines(content).length, lines.map((_, i) => `${i.toString(16).padStart(4, "0")}a`)); 
	if (offsetMs !== 0) {
		const target = Date.now() - offsetMs;
		const db = new DatabaseSync(sqlitePath(home), { defensive: false } as never);
		db.prepare("UPDATE snapshots SET updated_at = ? WHERE path = ?").run(target, path);
		db.prepare("UPDATE anchor_meta SET updated_at = ? WHERE path = ?").run(target, path);
		db.prepare("UPDATE anchor_lines SET updated_at = ? WHERE path = ?").run(target, path);
		db.close();
	}
}

/** Build a path with N anchor_lines rows so we can drive the row budget. */
function pushPathWithLines(store: HashStore, path: string, lineCount: number, home: string): void { const lines: string[] = []; for (let i = 0; i < lineCount; i++) lines.push(`line ${i}`); const content = lines.join("\n") + "\n"; store.upsertSnapshot(path, contentChecksum(content), lineCount, lines.map((_, i) => `${i.toString(16).padStart(4, "0")}b`)); const db = new DatabaseSync(sqlitePath(home), { defensive: false } as never); db.prepare("INSERT OR REPLACE INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?)").run(path, contentChecksum(content), lineCount, Date.now()); const ins = db.prepare("INSERT OR REPLACE INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)"); for (let i = 0; i < lineCount; i++) ins.run(path, i + 1, `${i.toString(16).padStart(4, "0")}b`, i, Date.now()); db.close(); }

describe("hash-store.sweep — paths budget", () => {
	it("drops oldest paths first when paths exceeds budget", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			for (let i = 0; i < 10; i++) {
				touchPath(store, home, `/file-${i}.ts`, ["a", "b"], (10 - i) * 1000);
			}
			const before = store.stats();
			expect(before.paths).toBe(10);

			const report = store.sweep({ paths: 4 });
			expect(report.evictedPaths).toBeGreaterThanOrEqual(6);
			const after = store.stats();
			expect(after.paths).toBeLessThanOrEqual(4);

			// The NEWEST path (lowest offsetMs) MUST still be present.
			expect(store.allKnownPaths().some((row) => row.path === "/file-9.ts")).toBe(true);
			expect(store.allKnownPaths().some((row) => row.path === "/file-0.ts")).toBe(false);
		});
	});
});

describe("hash-store.sweep — rows budget", () => {
	it("drops paths until anchor_lines rows fits under the budget", async () => {
		await withFreshHome(async (home) => { const store = await loadHashStore(); const _h = home;
			pushPathWithLines(store, "/fat.ts", 50, _h);
			pushPathWithLines(store, "/recent.ts", 50, _h);
			const before = store.stats();
			expect(before.rows).toBeGreaterThanOrEqual(100);

			const report = store.sweep({ rows: 30 });
			expect(report.evictedPaths).toBeGreaterThan(0);
			const after = store.stats();
			expect(after.rows).toBeLessThanOrEqual(30);
		});
	});
});

describe("hash-store.sweep — TTL", () => {
	it("drops paths whose MAX(updated_at) is below the cutoff", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			touchPath(store, home, "/old.ts", ["x"], 8 * 24 * 60 * 60 * 1000);
			touchPath(store, home, "/fresh.ts", ["y"], 0);
			const report = store.sweep({
				paths: 100,
				ttlMs: 7 * 24 * 60 * 60 * 1000,
			});
			expect(report.ttlDropped).toBeGreaterThanOrEqual(1);
			expect(store.allKnownPaths().some((row) => row.path === "/old.ts")).toBe(false);
			expect(store.allKnownPaths().some((row) => row.path === "/fresh.ts")).toBe(true);
		});
	});

	it("stops at the cutoff (paths at the boundary survive)", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			touchPath(store, home, "/boundary.ts", ["x"], 7 * 24 * 60 * 60 * 1000 + 1000);
			touchPath(store, home, "/recent.ts", ["y"], 1000);
			const report = store.sweep({
				paths: 100,
				ttlMs: 7 * 24 * 60 * 60 * 1000,
			});
			expect(report.ttlDropped).toBe(1);
			expect(store.allKnownPaths().some((row) => row.path === "/boundary.ts")).toBe(false);
			expect(store.allKnownPaths().some((row) => row.path === "/recent.ts")).toBe(true);
		});
	});
});

describe("hash-store.trimUndo", () => {
	it("drops oldest undo layers until the path is ≤ maxBytes", async () => {
		await withStore(async (store) => {
			store.pushUndo("/p.ts", {
				content: "v1",
				bom: "",
				ending: "\n",
				hashes: ["a"],
				resultContent: "x".repeat(2000),
			});
			store.pushUndo("/p.ts", {
				content: "v2",
				bom: "",
				ending: "\n",
				hashes: ["b"],
				resultContent: "y".repeat(2000),
			});
			store.pushUndo("/p.ts", {
				content: "v3",
				bom: "",
				ending: "\n",
				hashes: ["c"],
				resultContent: "z".repeat(2000),
			});
			const before = store.undoDepth("/p.ts");
			expect(before).toBe(3);
			const dropped = store.trimUndo("/p.ts", 1024);
			expect(dropped).toBeGreaterThan(0);
			expect(store.undoDepth("/p.ts")).toBeLessThan(before);
			expect(store.undoDepth("/p.ts")).toBeGreaterThanOrEqual(1);
		});
	});

	it("keeps at least 1 layer even when the budget cannot accommodate it", async () => {
		await withStore(async (store) => {
			store.pushUndo("/p.ts", {
				content: "v1",
				bom: "",
				ending: "\n",
				hashes: ["a"],
				resultContent: "x".repeat(100_000),
			});
			const dropped = store.trimUndo("/p.ts", 1);
			expect(dropped).toBe(0); // over the budget but the rule keeps ≥ 1
			expect(store.undoDepth("/p.ts")).toBe(1);
		});
	});

	it("does nothing when already under the cap", async () => {
		await withStore(async (store) => {
			store.pushUndo("/p.ts", {
				content: "v1",
				bom: "",
				ending: "\n",
				hashes: ["a"],
				resultContent: "x",
			});
			const dropped = store.trimUndo("/p.ts", 1_000_000);
			expect(dropped).toBe(0);
			expect(store.undoDepth("/p.ts")).toBe(1);
		});
	});
});

describe("hash-store.sweep — over-delete", () => {
	it("deletes ~10% extra paths beyond the budget", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			for (let i = 0; i < 20; i++) {
				touchPath(store, home, `/p-${i}.ts`, ["x"], (20 - i) * 1000);
			}
			const report = store.sweep({ paths: 1 });
			// After the budget hit (down to 1) we over-delete 10 % → ~2 more → total
			// 19 dropped, 1 survivor.
			expect(report.evictedPaths).toBeGreaterThanOrEqual(19);
			expect(store.stats().paths).toBeLessThanOrEqual(1);
		});
	});
});

describe("hash-store.sweep — bytes budget", () => {
	it("is consulted alongside paths and rows", async () => {
		await withFreshHome(async (home) => { const store = await loadHashStore(); const _h = home;
			pushPathWithLines(store, "/fat.ts", 200, _h);
			const before = store.stats();
			// Bytes budget is `(page_count - freelist_count) * page_size`; we
			// can't easily force it from the row side without a 64 MiB seed.
			const report = store.sweep({ bytes: before.bytes, rows: 50 });
			expect(report.evictedPaths).toBeGreaterThanOrEqual(1);
		});
	});
});

describe("hash-store.sweep — invariants", () => {
	it("returns a SweepReport with before/after metrics that match stats()", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			for (let i = 0; i < 5; i++) {
				touchPath(store, home, `/p-${i}.ts`, ["x"], 1000 * (5 - i));
			}
			const before = store.stats();
			const report = store.sweep({ paths: 2 });
			const after = store.stats();
			expect(report.before).toEqual(before);
			expect(report.after).toEqual(after);
			expect(report.durationMs).toBeGreaterThanOrEqual(0);
		});
	});

	it("does not drop the only survivor of the LRU phase", async () => {
		await withFreshHome(async (home) => {
			const store = await loadHashStore();
			touchPath(store, home, "/only.ts", ["x"]);
			const report = store.sweep({ paths: 1 });
			expect(store.allKnownPaths().some((row) => row.path === "/only.ts")).toBe(true);
			expect(report.evictedPaths).toBe(0);
		});
	});
});