/**
 * The store migration, run against a COPY of a REAL database.
 *
 * The suite's other migration cases build their fixtures by hand, which proves
 * the code does what the code says. This one answers a different question —
 * *does a database that a previous version actually wrote migrate as designed?*
 * — by taking the live store from a running session and opening it with the
 * current code.
 *
 * It is OPT-IN, because it needs a real file that the repository must not
 * carry:
 *
 * ```text
 * cp ~/.dsh/plugins/dsh-hashline-edittool/--<project>--/hash-store.sqlite /tmp/live.sqlite
 * HASHLINE_LIVE_COPY=/tmp/live.sqlite npx vitest run test/core/live-store-migration.test.ts
 * ```
 *
 * It never touches the original: the file is copied into a temporary
 * `DSH_HOME`, and every assertion is about that copy.
 *
 * @module dsh-hashline-edittool/live-store-migration.test
 */
import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIVE_COPY = process.env["HASHLINE_LIVE_COPY"];

/** The version the current code writes — kept in sync by the assertion below. */
const CURRENT_VERSION = "7";

describe.skipIf(LIVE_COPY === undefined || !existsSync(LIVE_COPY))(
	"a real database from a previous version migrates on open",
	() => {
		it("rebuilds the anchor state, drops `snapshots`, and keeps the ops meta keys", async () => {
			const source = LIVE_COPY!;
			const home = mkdtempSync(join(tmpdir(), "hashline-live-"));
			const before = new DatabaseSync(source, { readOnly: true });
			const tablesBefore = before
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => String((row as Record<string, unknown>)["name"]));
			const versionBefore = before.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
				| Record<string, unknown>
				| undefined;
			const keysBefore = before
				.prepare("SELECT key FROM meta WHERE key IN ('clean_shutdown','last_open_integrity_check','last_rebuild_at')")
				.all()
				.map((row) => String((row as Record<string, unknown>)["key"]));
			before.close();
			expect(tablesBefore).toContain("anchor_lines");
			expect(keysBefore.length).toBeGreaterThan(0);

			// The copy has to land exactly where the store looks for it. With no
			// workspace scope (which is how `loadHashStore` runs outside a tool call)
			// the path is `<DSH_HOME>/plugins/dsh-hashline-edittool/hash-store.sqlite` —
			// the plugin BASE directory, NOT a per-project one. Getting this wrong is
			// silent: the store simply creates a fresh database somewhere else and every
			// assertion below reads an untouched file. Measured: the first version of
			// this test copied into the per-project directory and saw version 6.
			process.env["DSH_HOME"] = home;
			const { configDir } = await import("../../src/infra/paths.js");
			const cwd = process.cwd();
			const storePath = join(configDir(), "hash-store.sqlite");
			mkdirSync(configDir(), { recursive: true });
			copyFileSync(source, storePath);

			const { loadHashStore, findPathsByAnchors, shutdownHashStore } = await import("../../src/domain/session/hash-store.js");
			const { persistedAnchorLines } = await import("../../src/domain/session/anchor-state.js");
			await loadHashStore();

			const after = new DatabaseSync(storePath, { readOnly: true });
			const tablesAfter = after
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => String((row as Record<string, unknown>)["name"]));
			const versionAfter = after.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
				| Record<string, unknown>
				| undefined;
			const keysAfter = after
				.prepare("SELECT key FROM meta WHERE key IN ('clean_shutdown','last_open_integrity_check','last_rebuild_at')")
				.all()
				.map((row) => String((row as Record<string, unknown>)["key"]));
			const anchorRows = after.prepare("SELECT COUNT(*) AS n FROM anchor_lines").get() as Record<string, unknown>;
			const servedRows = after.prepare("SELECT COUNT(*) AS n FROM served").get() as Record<string, unknown>;
			after.close();

			// 1. the version moves to the current one.
			expect(versionAfter?.["value"]).toBe(CURRENT_VERSION);
			// 2. `snapshots` is GONE — the table the refactor deleted. Its absence is
			//    what the migration is for, so assert it directly rather than trusting
			//    the code path.
			expect(tablesAfter).not.toContain("snapshots");
			// 3. anchors and served are invalidated together: anchors that survive a
			//    version change would be anchors no session was ever served.
			expect(Number(anchorRows["n"])).toBe(0);
			expect(Number(servedRows["n"])).toBe(0);
			// 4. the operational keys survive, and they must: wiping them would make the
			//    next launch look like an unclean shutdown.
			for (const key of keysBefore) expect(keysAfter).toContain(key);
			// 5. and the version path must NOT stamp `last_rebuild_at`. Only the CAPACITY
			//    rebuild writes it, because the throttle reads it to decide whether a
			//    capacity rebuild is allowed — stamping it here would block a legitimate
			//    one for the next 24 hours. Measured on a real database: the key is absent
			//    before and after, while `last_open_integrity_check` survives.
			if (!keysBefore.includes("last_rebuild_at")) {
				expect(keysAfter).not.toContain("last_rebuild_at");
			}

			// 5. and the rebuilt store is USABLE: a path lookup answers nothing rather
			//    than throwing on a dropped table.
			expect(persistedAnchorLines(join(cwd, "package.json"))).toEqual([]);
			await expect(findPathsByAnchors(["aB"])).resolves.toEqual([]);

			shutdownHashStore();
			rmSync(home, { recursive: true, force: true });
		}, 60_000);
	},
);
