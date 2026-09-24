/**
 * Issue #151 / Problem 5 — the undo stack, and the store it moved into.
 *
 * The undo row family used to hold ONE row per path (`path` the primary key),
 * so a second edit overwrote the first and `undo_last_edit` could walk back
 * exactly one step — the write that consumed the undo wiped the history. It is
 * now a bounded stack.
 *
 * The migration is the risky half and this file owns it: an existing store must
 * be upgraded IN PLACE, keeping the entry an in-flight undo would have used,
 * and WITHOUT touching the other row families. A `HASH_STORE_VERSION` bump would
 * have been the easy way to reshape the table, and it would also have wiped
 * `anchor_state` — every anchor the session had served would go stale.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../src/infra/paths.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { getUndo, popUndo, saveUndo, undoDepth } from "../../src/domain/edit/undo-edit.js";
import { anchorsFor } from "../../src/hashline/session-anchors.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { contentKey } from "../../src/hashline/alloc.js";
import { withTempDir } from "../support/fixtures.js";

/**
 * The anchored file the migration must NOT re-anchor. Its checksum and
 * contentKeys are the real ones, so `anchorsFor` can only serve the persisted
 * anchors if the row survived the migration intact.
 */
const KEPT_CONTENT = "alpha\nbeta";
const KEPT_ANCHORS = ["aA1", "bB2"];

/** The pre-#151 shape: one undo row per path, `path` as the primary key. */
const LEGACY_UNDO_DDL =
	"CREATE TABLE IF NOT EXISTS undo (" +
	"path TEXT PRIMARY KEY, " +
	"content TEXT NOT NULL, " +
	"bom TEXT NOT NULL, " +
	"ending TEXT NOT NULL, " +
	"hashes TEXT NOT NULL, " +
	"result_content TEXT NOT NULL, " +
	"updated_at INTEGER NOT NULL" +
	")";

/** Write a store in the OLD shape, plus an anchor_state row to watch. */
function writeLegacyStore(): void {
	// The real store creates its directory on open; a hand-written one must too.
	mkdirSync(dirname(hashStorePath()), { recursive: true });
	const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
	try {
		db.exec(LEGACY_UNDO_DDL);
		db.prepare(
			"INSERT INTO undo (path, content, bom, ending, hashes, result_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("/legacy.ts", "old", "", "\n", '["xY7"]', "new", Date.now());
		db.exec(
			"CREATE TABLE IF NOT EXISTS anchor_state (" +
				"path TEXT PRIMARY KEY, " +
				"checksum TEXT NOT NULL, " +
				"line_count INTEGER NOT NULL, " +
				"anchors TEXT NOT NULL, " +
				"line_keys TEXT NOT NULL, " +
				"updated_at INTEGER NOT NULL" +
				")",
		);
		db.prepare(
			"INSERT INTO anchor_state (path, checksum, line_count, anchors, line_keys, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			"/keep.ts",
				contentChecksum(KEPT_CONTENT),
				2,
				JSON.stringify(KEPT_ANCHORS),
				JSON.stringify(KEPT_CONTENT.split("\n").map(contentKey)),
				Date.now(),
			);
	} finally {
		db.close();
	}
}

describe("#151 P5 — the undo stack survives old stores", () => {
	it("migrates a pre-#151 single-row undo table in place, keeping the entry", async () => {
		await withTempDir("undo-migration-", async () => {
			writeLegacyStore();
			const store = await loadHashStore();

			// The one legacy entry is now the stack's TOP: an undo that was
			// pending before the upgrade still works.
			expect(store.undoDepth("/legacy.ts")).toBe(1);
			const entry = store.getUndo("/legacy.ts");
			expect(entry).toMatchObject({ content: "old", resultContent: "new", hashes: ["xY7"] });

			// And the stack keeps working on top of it.
			store.pushUndo("/legacy.ts", {
				content: "newer",
				bom: "",
				ending: "\n",
				hashes: ["xY7"],
				resultContent: "newest",
			});
			expect(store.undoDepth("/legacy.ts")).toBe(2);
			expect(store.getUndo("/legacy.ts")!.content).toBe("newer");
			store.popUndo("/legacy.ts");
			expect(store.getUndo("/legacy.ts")!.content).toBe("old");
		});
	});

	it("the legacy dense anchor_state rows expand 1:1 into the sparse model", async () => {
		await withTempDir("undo-migration-anchors-", async () => {
			writeLegacyStore();
			await loadHashStore();
			// While the store is open, the anchors the legacy row described are
			// served VERBATIM — the migration did not re-anchor the file.
			expect(anchorsFor("/keep.ts", KEPT_CONTENT)).toEqual(KEPT_ANCHORS);
			shutdownHashStore();

			const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
			try {
				// The legacy DENSE table is GONE — expanded into the sparse rows.
				const meta = db
					.prepare("SELECT checksum, line_count FROM anchor_meta WHERE path = ?")
					.get("/keep.ts") as { checksum?: string; line_count?: number } | undefined;
				expect(meta?.checksum).toBe(contentChecksum(KEPT_CONTENT));
				expect(meta?.line_count).toBe(KEPT_ANCHORS.length);
				const rows = db
					.prepare("SELECT line, anchor, content_key FROM anchor_lines WHERE path = ? ORDER BY line")
					.all("/keep.ts") as Array<{ line: number; anchor: string; content_key: number }>;
				expect(rows).toHaveLength(KEPT_ANCHORS.length);
				for (let i = 0; i < KEPT_ANCHORS.length; i++) {
					expect(rows[i]!.line).toBe(i + 1);
					expect(rows[i]!.anchor).toBe(KEPT_ANCHORS[i]);
					expect(rows[i]!.content_key).toBe(contentKey(KEPT_CONTENT.split("\n")[i]!));
				}
				const legacyLeft = db
					.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'anchor_state'")
					.get() as { n: number };
				expect(legacyLeft.n).toBe(0); // the legacy table is dropped after expanding
			} finally {
				db.close();
			}
		});
	});

	it("a legacy store whose undo row is corrupt clears the stack instead of throwing", async () => {
		await withTempDir("undo-migration-corrupt-", async () => {
			writeLegacyStore();
			const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
			db.prepare("UPDATE undo SET hashes = ? WHERE path = ?").run("{not json", "/legacy.ts");
			db.close();

			const store = await loadHashStore();
			expect(store.getUndo("/legacy.ts")).toBeUndefined();
			expect(store.undoDepth("/legacy.ts")).toBe(0);
		});
	});
});

describe("#151 P5 — undo_last_edit walks back more than one edit", () => {
	it("two consecutive undos revert the last two edits, newest first", async () => {
		await withTempDir("undo-stack-", async () => {
			const path = "/undo-stack.txt";
			await saveUndo(path, {
				content: "one",
				bom: "",
				originalEnding: "\n",
				hashes: ["aA1"],
				resultContent: "two",
			});
			await saveUndo(path, {
				content: "two",
				bom: "",
				originalEnding: "\n",
				hashes: ["bB2"],
				resultContent: "three",
			});
			expect((await getUndo(path))!.content).toBe("two");
			expect(await undoDepth(path)).toBe(2);

			// The first undo consumes the newest entry and leaves the earlier one
			// in place — that is the whole difference from a single slot.
			await popUndo(path);
			expect((await getUndo(path))!.content).toBe("one");
			expect(await undoDepth(path)).toBe(1);

			await popUndo(path);
			expect(await getUndo(path)).toBeUndefined();
			expect(await undoDepth(path)).toBe(0);
		});
	});
});
