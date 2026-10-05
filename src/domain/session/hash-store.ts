/**
 * The hash store — ONE deep persistence module for the hashline domain.
 *
 * Owns the sqlite db, the schema and migrations, corruption quarantine,
 * busy-retry, WAL, the legacy-JSON migration, AND the three narrow row APIs
 * the rest of the plugin needs: hash snapshots, undo entries, and served
 * rows. The prepared statements are a private implementation detail — callers
 * use domain methods, never SQL.
 *
 * Corrupt-row handling (parse the JSON column → validate against the hash
 * alphabet → delete the corrupt row) lives here, once, for every row family.
 * Cross-table cleanup (pruneMissing) lives here too — a sibling module never
 * reaches into another family's rows.
 *
 * Issue #180 (spec #184, ADR-0010): the store is now bounded and self-evicting.
 * Three budgets — paths / rows / bytes — are enforced by `sweep`, which runs
 * on open, every N writes, and on over-budget writes. Cold-open cost is held
 * flat by skipping `PRAGMA quick_check` whenever the last exit was clean.
 *
 * @module dsh-hashline-edittool/hash-store
 */

import { existsSync } from "node:fs";
import { readFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../infra/paths.js";
import { workspaceCwd } from "../../infra/workspace.js";
import { errCode } from "../../infra/utils.js";
import { hashRe } from "../../hashline/hash-assign.js";
import {
	HASH_STORE_VERSION,
	HASH_STORE_BUSY_TIMEOUT,
	SERVED_TTL_MS,
	ANCHOR_STATE_TTL_MS,
	UNDO_STACK_DEPTH,
	HASH_STORE_MAX_BYTES,
	HASH_STORE_MAX_PATHS,
	HASH_STORE_MAX_ROWS,
	HASH_STORE_SWEEP_WRITES,
	HASH_STORE_EVICT_RATIO,
	HASH_STORE_REBUILD_RATIO,
	HASH_STORE_REBUILD_THROTTLE_MS,
	UNDO_MAX_PATH_BYTES,
} from "../../infra/constants.js";
import {
	anchorsFor,
	registerAnchorPersistence,
	type PersistedAnchorState,
	type PersistedAnchorLine,
	type AnchorStatePersistence,
} from "./anchor-state.js";
import { registerAnchorReader } from "../../hashline/anchor-pipeline.js";
import { storeBudgetLimits } from "./store-budget.js";
import { decodeServedAnchors, encodeServedAnchors } from "./served-codec.js";
// ---- validators (owned here; the store's corruption handling uses them) ----

export function isValidHashList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const hash of value) {
		// "" is the LAZY model's never-served placeholder (#169): a dense array
		// the engine hands the store may legitimately carry it, and a row that
		// does is NOT corrupt.
		if (hash === "") continue;
		if (typeof hash !== "string" || !hashRe().test(hash)) return false;
	}
	return true;
}

// `LegacySnapshot` + `isValidSnapshot` lived here. They validated the legacy
// JSON's `{content, hashes}` rows, and went with that payload: `snapshots` is
// deleted (contract §8) and so is the importer that consumed them.

/** A served-row array: per-position hash, or null for never-served slots. */
export function isValidServedList(value: unknown): value is (string | null)[] {
	if (!Array.isArray(value)) return false;
	for (const entry of value) {
		if (entry === null) continue;
		if (typeof entry !== "string" || !hashRe().test(entry)) return false;
	}
	return true;
}
/** The persisted per-line contentKey list (cyrb53 integers ≤ 2^53−1 —
 *  exactly JSON-safe, so a plain number[] round-trips). */
export function isValidLineKeyList(value: unknown): value is number[] {
	if (!Array.isArray(value)) return false;
	for (const key of value) {
		if (typeof key !== "number" || !Number.isInteger(key) || key < 0) return false;
	}
	return true;
}

/** The undo row contract shared by undo-edit and the store. */
export interface UndoRecord {
	content: string;
	bom: string;
	ending: string;
	hashes: string[];
	resultContent: string;
	/**
	 * Content checksum of the POST-edit body (#176), replacing the second full
	 * copy the stack used to hold. The stale check compares this against the
	 * current file; legacy rows leave it undefined and are verified by their
	 * stored `resultContent` text instead.
	 */
	resultChecksum?: string;
}

/** Compact store metrics used by sweep and the open-path budget check. */
export interface HashStoreStats {
	bytes: number;
	paths: number;
	rows: number;
}

/** Options a caller can pass to {@link HashStore.sweep} to drive it with
 *  smaller budgets than the production defaults — tests use this so the
 *  eviction path can be exercised without writing 64 MiB. */
export interface SweepOptions {
	bytes?: number;
	paths?: number;
	rows?: number;
	/** TTL for the per-path recency cutoff. Defaults to {@link SERVED_TTL_MS}. */
	ttlMs?: number;
	/** Per-path `undo` byte cap. Defaults to {@link UNDO_MAX_PATH_BYTES}. */
	undoMaxBytes?: number;
	/** Override for the clock; the sweep uses this for the TTL cutoff and
	 *  any `updated_at` it writes when calling delete. */
	now?: number;
	/** Cap on the number of paths the per-path slim phase visits. Defaults to 200. */
	slimBatch?: number;
}

/** The report returned from {@link HashStore.sweep}. */
export interface SweepReport {
	before: HashStoreStats;
	after: HashStoreStats;
	evictedPaths: number;
	ttlDropped: number;
	trimmedUndo: number;
	rebuilt: boolean;
	durationMs: number;
}

// ---- the domain interface --------------------------------------------------

type SqlParams = (string | number)[];

interface Prepared {
	allPaths: (...params: SqlParams) => Record<string, unknown>[];
	/** Paths whose live anchors contain every anchor in the JSON array (twice). */
	pathsByAnchors: (...params: SqlParams) => Record<string, unknown>[];
	undoPush: (...params: SqlParams) => void;
	undoPop: (...params: SqlParams) => void;
	undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	undoDepth: (...params: SqlParams) => number;
	undoDelete: (...params: SqlParams) => void;
	undoDeleteBelowDepth: (...params: SqlParams) => number;
	undoLayerSizes: (...params: SqlParams) => Record<string, unknown>[];
	servedGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	servedUpsert: (...params: SqlParams) => void;
	servedReportedUpsert: (...params: SqlParams) => void;
	servedReportedClear: (...params: SqlParams) => void;
	servedDelete: (...params: SqlParams) => void;
	servedDeletePath: (...params: SqlParams) => void;
	servedWipe: (...params: SqlParams) => void;
	servedPruneOlderThan: (...params: SqlParams) => number;
	anchorMetaGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	anchorMetaUpsert: (...params: SqlParams) => void;
	anchorMetaDelete: (...params: SqlParams) => void;
	anchorLinesAll: (...params: SqlParams) => Record<string, unknown>[];
	anchorLineGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	anchorLineUpsert: (...params: SqlParams) => void;
	anchorLinesDeletePath: (...params: SqlParams) => void;
	anchorLineDelete: (...params: SqlParams) => void;
	anchorPruneOlderThan: (...params: SqlParams) => number;
	// ---- budget / maintenance (#180) ----
	storeBytes: () => number;
	anchorRowCount: () => number;
	anchorPathCount: () => number;
	pathRecency: () => Record<string, unknown>[];
	undoBudget: (...params: SqlParams) => Record<string, unknown> | undefined;
	undoDepths: (...params: SqlParams) => Record<string, unknown>[];
	metaGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	metaSet: (...params: SqlParams) => void;
	metaDelete: (...params: SqlParams) => void;
	orphanAnchorLines: () => void;
	vacuum: () => void;
}

/**
 * The domain face of the hash store. Each row family gets a narrow API;
 * corruption healing (parse → validate → delete) happens inside the getters.
 */
export interface HashStore {
	readonly engine: "node:sqlite";

	/** Every path referenced by any row family (undo ∪ served ∪ anchor_meta). */
	allKnownPaths(): { path: string }[];
	/**
	 * Paths whose LIVE anchors contain every given anchor (contract §2.1).
	 *
	 * Replaces the old `snapshots`-backed scan: `anchor_lines` holds the same
	 * fact (one row per line, with the anchor), and the existing
	 * `(path, anchor)` index answers this without a table of its own.
	 */
	findPathsByAnchors(anchors: readonly string[]): string[];

	// ---- undo entries (a bounded stack per path, newest first) --------------
	/** The NEWEST undo row for a path, healing a corrupt row (parse → validate → clear). */
	getUndo(path: string): UndoRecord | undefined;
	/** Push an entry as the newest; the oldest past {@link UNDO_STACK_DEPTH} is dropped. */
	pushUndo(path: string, entry: UndoRecord): void;
	/** Drop the newest entry — the one below it is the next undo. */
	popUndo(path: string): void;
	/** Drop the path's whole history (an external write invalidated the chain). */
	deleteUndo(path: string): void;
	/** How many edits on this path can still be undone. */
	undoDepth(path: string): number;
	/** Drop oldest `undo` layers until the path's byte total is `<= maxBytes`,
	 *  keeping AT LEAST one layer. Returns the number of layers dropped. */
	trimUndo(path: string, maxBytes?: number): number;

	// ---- served rows (what the model has seen, per session+path) ------------
	/** The served anchors set for a session+path, healing a corrupt row; empty when nothing was served. */
	getServed(sessionKey: string, path: string): Set<string>;
	/** The reported-drift hash set for a session+path (lenient parse, never deletes). */
	getServedReported(sessionKey: string, path: string): Set<string>;
	/** Persist the hashes JSON column for a session+path. */
	/**
	 * Persist the served set for a session+path. Callers pass the anchors; the
	 * on-disk encoding (#176, packed deltas) is the store's business — passing a
	 * pre-serialized string here would silently encode its CHARACTERS, because a
	 * string is iterable.
	 */
	upsertServed(sessionKey: string, path: string, anchors: readonly string[]): void;
	/** Persist the reported-drift JSON column for a session+path (inserting a fresh empty hashes row). */
	upsertServedReported(sessionKey: string, path: string, reportedJson: string): void;
	clearServedReported(sessionKey: string, path: string): void;
	deleteServed(sessionKey: string, path: string): void;
	deleteServedByPath(path: string): void;
	wipeServed(sessionKey: string): void;
	pruneServedOlderThan(ts: number): void;

	// ---- meta (small key/value sidecar) ------------------------------------
	/** Read a meta value; undefined when the key is absent. */
	metaGet(key: string): string | undefined;
	/** Upsert a meta value. */
	metaSet(key: string, value: string): void;
	/** Remove a meta key (no-op when absent). */
	metaDelete(key: string): void;

	// ---- stats / eviction --------------------------------------------------
	/** Snapshot of the three store metrics sweep and the open-path check use. */
	stats(): HashStoreStats;
	/** Run the two-phase eviction: TTL prune → per-path slim → LRU. The
	 *  returned report describes the deltas. */
	sweep(opts?: SweepOptions): SweepReport;

	// ---- maintenance ---------------------------------------------------------
	/** Delete every row family's entries for paths that no longer exist on disk. */
	pruneMissing(): Promise<void>;
}

// ---- db plumbing (private) --------------------------------------------------

export function isCorruptionError(error: unknown): boolean {
	if (error && typeof error === "object") {
		const errcode = (error as { errcode?: unknown }).errcode;
		if (typeof errcode === "number") {
			return errcode === 11 || errcode === 24 || errcode === 26;
		}
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
	}
	return (
		error instanceof Error &&
		/corrupt|not a database|malformed|database disk image/i.test(error.message)
	);
}

function isBusyError(error: unknown): boolean {
	if (error && typeof error === "object") {
		const errcode = (error as { errcode?: unknown }).errcode;
		if (typeof errcode === "number") return errcode === 5 || errcode === 6;
	}
	return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
	const sab = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(sab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 100;

function withBusyRetry<T>(fn: () => T): T {
	let lastError: unknown;
	for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
		try {
			return fn();
		} catch (error) {
			lastError = error;
			if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
			sleepSync(BUSY_RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

function openDbWithBusyRetry(storePath: string): {
	db: DatabaseSync;
	stmts: Prepared;
} {
	return withBusyRetry(() => openDb(storePath));
}

/** One open store per store path (per workspace); parallel sessions share per-workspace dbs. */
const stores = new Map<
	string,
	{ path: string; db: DatabaseSync; stmts: Prepared; store: HashStore; budget: SweepBudget }
>();
const openings = new Map<string, Promise<HashStore>>();
let exitHandlerRegistered = false;

// ---- rebuild-warning hook (#180, spec #184, ADR-0010) ----------------------
//
// When the open path rebuilds the store, every anchor the model holds for
// this workspace is invalidated. The model has to know to re-read. We expose
// the message here so the tool layer (when ready) can prepend it to a tool
// result's warnings channel. This module never reads the value; session-view
// (or whoever owns the warnings channel) does.
let pendingRebuildWarning: string | undefined;
/** Take and clear the most recently-set rebuild message. Returns undefined
 *  when nothing was queued since the last call. */
export function takeRebuildWarning(): string | undefined {
	const m = pendingRebuildWarning;
	pendingRebuildWarning = undefined;
	return m;
}
export function setRebuildWarning(message: string | undefined): void {
	pendingRebuildWarning = message;
}

/** The shared store-wide sweep counters/limits carried alongside each open
 *  store, so open-time sweep triggering and write-time sweep triggering share
 *  one budget configuration. */
interface SweepBudget {
	/** Per-process write counter; reset on (re)open. */
	writeCounter: number;
}

function openDb(storePath: string): { db: DatabaseSync; stmts: Prepared } {
	const db = new DatabaseSync(storePath, {
		timeout: HASH_STORE_BUSY_TIMEOUT,
	});
	try {
		return buildStore(db);
	} catch (error) {
		try {
			db.close();
		} catch {
			// best-effort close when the store build fails
		}
		throw error;
	}
}

/**
 * The undo row family: a bounded STACK per path, NEWEST at the HIGHEST
 * `depth`. Depths are an APPEND counter (never renumbered — renumbering
 * collides with the primary key mid-statement), so `MAX(depth)` is the undo a
 * call reverts and the deepest rows past the bound are the ones dropped.
 *
 * It used to hold one row per path (`path` the primary key), which capped the
 * history at a single level — the write that consumed an undo also wiped it
 * (#151/P5).
 */
const UNDO_TABLE_DDL =
	"CREATE TABLE IF NOT EXISTS undo (" +
	"path TEXT NOT NULL, " +
	"depth INTEGER NOT NULL, " +
	"content TEXT NOT NULL, " +
	"bom TEXT NOT NULL, " +
	"ending TEXT NOT NULL, " +
	"hashes TEXT NOT NULL, " +
	"result_content TEXT NOT NULL, " +
	"updated_at INTEGER NOT NULL, " +
	"PRIMARY KEY (path, depth)" +
	")";

/**
 * Run one statement group inside a single transaction, retrying the WHOLE group
 * on a busy lock (a rolled-back transaction is safe to replay). A failure inside
 * rolls back, so a multi-statement move is never half-applied.
 *
 * NESTING IS HONOURED, and that is load-bearing rather than tidy: `withStore`
 * may already hold a transaction for this database (the primitives wrap their
 * whole read → decide → write in one), and SQLite has no nested `BEGIN`.
 * Joining instead of opening a second one is what lets the port's writes be
 * part of the CALLER's unit of work — which is the entire reason a caller wraps
 * anything at all. Before this, each port write opened its own transaction, so
 * `persistAnchorState`'s "one transaction" was three: a failure between them
 * left a file's meta row ahead of its line rows, a state neither the pre- nor
 * the post-write world can explain. Measured: wrapping `anchorFor` in a
 * transaction turned that into `cannot start a transaction within a
 * transaction` — the latent split, made loud.
 *
 * @param db - the database the group writes to.
 * @param path - its store key, which identifies the open transaction.
 * @param fn - the statement group.
 */
function withTransaction(db: DatabaseSync, path: string, fn: () => void): void {
	const depth = txnDepth.get(path) ?? 0;
	if (depth > 0) {
		txnDepth.set(path, depth + 1);
		try {
			fn();
		} finally {
			txnDepth.set(path, depth);
		}
		return;
	}
	withBusyRetry(() => {
		db.exec("BEGIN IMMEDIATE");
		txnDepth.set(path, 1);
		try {
			fn();
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Already unwound (the failure WAS the commit): the original error is
				// the one worth reporting.
			}
			throw error;
		} finally {
			txnDepth.delete(path);
		}
	});
}
/** Batched DELETE for the TTL phase. Each iteration removes up to `limit`
 *  rows matching `updated_at < cutoff`, so a huge stale backlog is paid down
 *  one page at a time instead of holding the writer for seconds. */
const TTL_BATCH_LIMIT = 5000;

function buildStore(db: DatabaseSync): { db: DatabaseSync; stmts: Prepared } {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	// `snapshots` IS GONE, and this DROP is the migration (contract §8 / #215 结论 A:
	// "`snapshots` 表删除 —— 与 `anchor_meta` 重复").
	//
	// `snapshots` held `(path, checksum, line_count, hashes)` — the anchor array for
	// a whole file. Every field is derivable: `anchor_meta` has the checksum and
	// line count, and `anchor_lines` has the per-line anchors. Keeping both meant
	// two writers for one fact, and the second one fell out of use the moment
	// `anchor_lines` became the served surface — leaving a table that still had
	// readers and no writers. Its one live consumer (look up which file holds these
	// anchors) is now answered by `anchor_lines` itself, off the existing
	// `(path, anchor)` index.
	//
	// DROP rather than a version bump, following the idiom above: a version change
	// wipes every anchor the model currently holds, and removing a redundant table
	// is not worth invalidating a workspace's whole anchor set.
	//
	// The legacy JSON importer loses its `snapshots` payload with it: the JSON has
	// no per-line CONTENT KEYS, and an `anchor_lines` row without one could not
	// answer the §2.2 verdict — importing it would manufacture rows that are live
	// but permanently unverifiable.
	db.exec("DROP TABLE IF EXISTS snapshots");
	db.exec(
		"CREATE TABLE IF NOT EXISTS meta (" +
			"key TEXT PRIMARY KEY, " +
			"value TEXT NOT NULL" +
			")",
	);
	db.exec(UNDO_TABLE_DDL);
	// Migration for a store written before #151/P5: the table exists in its old
	// single-row shape. Rebuild it IN PLACE rather than bumping
	// HASH_STORE_VERSION — a version change wipes anchor_state as well, and every
	// anchor the session served would go stale. The existing entry becomes the
	// stack's top, so an in-flight undo survives the upgrade.
	const undoColumns = db.prepare("PRAGMA table_info(undo)").all() as {
		name: string;
	}[];
	if (undoColumns.length > 0 && !undoColumns.some((column) => column.name === "depth")) {
		db.exec("ALTER TABLE undo RENAME TO undo_legacy");
		db.exec(UNDO_TABLE_DDL);
		db.exec(
			"INSERT INTO undo (path, depth, content, bom, ending, hashes, result_content, updated_at) " +
				"SELECT path, 0, content, bom, ending, hashes, result_content, updated_at FROM undo_legacy",
		);
		db.exec("DROP TABLE undo_legacy");
	}
	// `result_checksum` (#176): new rows store a checksum of the post-edit body
	// instead of a second full copy, which halves the biggest text payload in the
	// store. The column is ADDED rather than rebuilt — legacy rows keep working
	// (an empty checksum sends the stale check down the text path), and the stack
	// survives the upgrade in place, exactly as the depth migration does.
	//
	// This runs for EVERY store, including one just written by the current build
	// (where the column already exists and the check is a single PRAGMA read).
	if (undoColumns.length > 0 && !undoColumns.some((column) => column.name === "result_checksum")) {
		db.exec("ALTER TABLE undo ADD COLUMN result_checksum TEXT");
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS anchor_meta (" +
			"path TEXT PRIMARY KEY, " +
			"checksum TEXT NOT NULL, " +
			"line_count INTEGER NOT NULL, " +
			"updated_at INTEGER NOT NULL" +
			")",
	);
	db.exec(
		"CREATE TABLE IF NOT EXISTS anchor_lines (" +
			"path TEXT NOT NULL, " +
			"line INTEGER NOT NULL, " +
			"anchor TEXT NOT NULL, " +
			"content_key INTEGER NOT NULL, " +
			"updated_at INTEGER NOT NULL, " +
			"PRIMARY KEY (path, line)" +
			")",
	);
	db.exec(
		"CREATE INDEX IF NOT EXISTS anchor_lines_by_anchor ON anchor_lines (path, anchor)",
	);
	// TTL / recency indexes (#180, spec #184) are NOT created here. They are the
	// one cost that scales with row count, and at open time we may be about to
	// rebuild or sweep the store — building them first measured ~5 s of wasted
	// work over 3 M rows. `ensureMaintenanceIndexes` creates them right after the
	// budget gate, once per store (see `openStore`).
	// Migration for a store written before the sparse anchor model (#169): the
	// legacy DENSE anchor_state table (one row per path, anchors/line_keys as
	// JSON arrays) expands 1:1 into anchor_meta + anchor_lines — every anchor
	// the file has already given out survives verbatim, none is re-minted. A
	// corrupt legacy row is skipped, never fatal. Runs BEFORE the version
	// check so a version wipe still wins.
	const legacyAnchorColumns = db.prepare("PRAGMA table_info(anchor_state)").all() as {
		name: string;
	}[];
	if (legacyAnchorColumns.length > 0 && legacyAnchorColumns.some((c) => c.name === "anchors")) {
		const legacyRows = db
			.prepare("SELECT path, checksum, line_count, anchors, line_keys FROM anchor_state")
			.all() as Record<string, unknown>[];
		const now = Date.now();
		const metaUpsert = db.prepare(
			"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) " +
				"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, updated_at = excluded.updated_at",
		);
		const lineInsert = db.prepare(
			"INSERT OR REPLACE INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		for (const row of legacyRows) {
			try {
				const anchors = JSON.parse(row.anchors as string) as unknown;
				const lineKeys = JSON.parse(row.line_keys as string) as unknown;
				if (!Array.isArray(anchors) || !Array.isArray(lineKeys)) continue;
				metaUpsert.run(String(row.path), String(row.checksum), Number(row.line_count), now);
				for (let i = 0; i < anchors.length && i < lineKeys.length; i++) {
					const anchor = anchors[i];
					if (typeof anchor !== "string" || anchor === "") continue; // never-served lines carry no anchor
					lineInsert.run(String(row.path), i + 1, anchor, Number(lineKeys[i]), now);
				}
			} catch {
				// A corrupt legacy row does not block the migration of the rest.
			}
		}
		db.exec("DROP TABLE anchor_state");
	}
	const versionRow = db
		.prepare("SELECT value FROM meta WHERE key = 'version'")
		.get() as { value?: string } | undefined;
	const versionChanged =
		versionRow !== undefined &&
		versionRow.value !== String(HASH_STORE_VERSION);
	// The wipe is deliberate and total: nothing is migrated (map #214 / decision
	// #222 — "不迁移任何数据"). A set written under the old rules cannot be
	// trusted to answer the new per-line verdict, and every anchor the model
	// still holds has to be re-read either way.
	//
	// Only the ANCHOR STATE is touched. `meta` is left alone on purpose: the
	// operational keys (`clean_shutdown`, `last_open_integrity_check`,
	// `last_rebuild_at`) describe the STORE's health, not the anchors in it, and
	// wiping them would make the next launch look like an unclean shutdown and
	// defeat the 24h rebuild throttle.
	if (versionChanged) {
		db.exec("DELETE FROM undo");
		db.exec("DELETE FROM anchor_meta");
		db.exec("DELETE FROM anchor_lines");
		// One of the two rebuild wordings (contract §8 / decision #222): a version
		// upgrade is a ONE-OFF, not a symptom. The capacity-triggered rebuild says
		// something else entirely ("the store grew too large"), and telling the user
		// the alarming one when the cause is routine would train them to ignore it.
		setRebuildWarning(
			"本工作区锚点库已按新版本重建（一次性，非异常），旧锚点作废，请重新 read。",
		);
	}
	const servedColumns = db.prepare("PRAGMA table_info(served)").all() as {
		name: string;
	}[];
	if (
		versionChanged ||
		!servedColumns.some((column) => column.name === "session_id")
	) {
		db.exec("DROP TABLE IF EXISTS served");
	}
	db.exec(
		"CREATE TABLE IF NOT EXISTS served (" +
			"session_id TEXT NOT NULL, " +
			"path TEXT NOT NULL, " +
			"hashes TEXT NOT NULL, " +
			"reported TEXT, " +
			"updated_at INTEGER NOT NULL, " +
			"PRIMARY KEY (session_id, path)" +
			")",
	);
	db.prepare(
		"INSERT INTO meta (key, value) VALUES ('version', ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(String(HASH_STORE_VERSION));
	const allStmt = db.prepare(
		"SELECT path FROM undo UNION SELECT path FROM served UNION SELECT path FROM anchor_meta",
	);
	// "Which file holds all of these anchors?" — the query the deleted `snapshots`
	// table used to answer. `anchor_lines` holds one row per (path, line, anchor),
	// and `anchor_lines_by_anchor` is exactly the index for this: select the
	// candidate paths by anchor, then keep those that matched EVERY anchor. The
	// HAVING clause compares against the parameter count, so it stays a single
	// indexed pass rather than a per-path scan.
	//
	// Anchors are unique per file (the allocator guarantees it, contract §2.1), so
	// no DISTINCT is needed on the inner select.
	const pathsByAnchorsStmt = db.prepare(
		"SELECT path FROM anchor_lines WHERE anchor IN (" +
			"SELECT value FROM json_each(?)" +
			") GROUP BY path HAVING COUNT(*) = json_array_length(?)",
	);
	// The newest entry is the one with the HIGHEST depth. `depth` is an append
	// counter, never renumbered: renumbering on push/pop collided with the
	// (path, depth) primary key mid-statement (`UNIQUE constraint failed`),
	// because SQLite checks the constraint row by row.
	const undoPushStmt = db.prepare(
		"INSERT INTO undo (path, depth, content, bom, ending, hashes, result_content, result_checksum, updated_at) " +
			"VALUES (?, COALESCE((SELECT MAX(depth) FROM undo WHERE path = ?), -1) + 1, ?, ?, ?, ?, ?, ?, ?)",
	);
	const undoMaxStmt = db.prepare("SELECT MAX(depth) AS max FROM undo WHERE path = ?");
	const undoPruneStmt = db.prepare("DELETE FROM undo WHERE path = ? AND depth < ?");
	const undoGetStmt = db.prepare(
		"SELECT content, bom, ending, hashes, result_content, result_checksum FROM undo WHERE path = ? ORDER BY depth DESC LIMIT 1",
	);
	const undoPopStmt = db.prepare("DELETE FROM undo WHERE path = ? AND depth = ?");
	const undoDepthStmt = db.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?");
	const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
	/** The highest depth stored for a path (the newest undo), or undefined. */
	const topDepth = (path: string | number): number | undefined => {
		const row = undoMaxStmt.get(path) as { max?: number | null } | undefined;
		return row?.max === null || row?.max === undefined ? undefined : Number(row.max);
	};
	// Per-layer sizes, ordered oldest-first. Used by trimUndo to compute
	// how many oldest layers must go to bring the path under its byte cap.
	const undoLayerSizesStmt = db.prepare(
		"SELECT depth, LENGTH(content) + LENGTH(result_content) + LENGTH(hashes) AS bytes " +
			"FROM undo WHERE path = ? ORDER BY depth ASC",
	);
	// Drops every undo row with depth < the cutoff, returning the row count.
	// Cutoff is `targetDepth`: rows with depth < targetDepth are deleted.
	const undoDeleteBelowDepthStmt = db.prepare(
		"DELETE FROM undo WHERE path = ? AND depth < ?",
	);
	const servedGetStmt = db.prepare(
		"SELECT hashes, reported FROM served WHERE session_id = ? AND path = ?",
	);
	const servedUpsertStmt = db.prepare(
		"INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(session_id, path) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at",
	);
	const servedReportedUpsertStmt = db.prepare(
		"INSERT INTO served (session_id, path, hashes, reported, updated_at) VALUES (?, ?, '[]', ?, ?) " +
			"ON CONFLICT(session_id, path) DO UPDATE SET reported = excluded.reported, updated_at = excluded.updated_at",
	);
	const servedReportedClearStmt = db.prepare(
		"UPDATE served SET reported = NULL, updated_at = ? WHERE session_id = ? AND path = ?",
	);
	const servedDeleteStmt = db.prepare(
		"DELETE FROM served WHERE session_id = ? AND path = ?",
	);
	const servedDeletePathStmt = db.prepare("DELETE FROM served WHERE path = ?");
	const servedWipeStmt = db.prepare("DELETE FROM served WHERE session_id = ?");
	// Batched prune using the indexed `updated_at` column. A single DELETE on a
	// 9 M-row backlog with the index is sub-second; without the index it was
	// the dominant open-time cost. The caller loops until 0 rows remain.
	const servedPruneOlderThanStmt = db.prepare(
		"DELETE FROM served WHERE rowid IN (SELECT rowid FROM served WHERE updated_at < ? LIMIT " + TTL_BATCH_LIMIT + ")",
	);
	const anchorMetaGetStmt = db.prepare(
		"SELECT checksum, line_count FROM anchor_meta WHERE path = ?",
	);
	const anchorMetaUpsertStmt = db.prepare(
		"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, updated_at = excluded.updated_at",
	);
	const anchorLinesAllStmt = db.prepare(
		"SELECT line, anchor, content_key FROM anchor_lines WHERE path = ? ORDER BY line",
	);
	const anchorLineGetStmt = db.prepare(
		"SELECT anchor, content_key FROM anchor_lines WHERE path = ? AND line = ?",
	);
	const anchorLineUpsertStmt = db.prepare(
		"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(path, line) DO UPDATE SET anchor = excluded.anchor, content_key = excluded.content_key, updated_at = excluded.updated_at",
	);
	const anchorLinesDeletePathStmt = db.prepare("DELETE FROM anchor_lines WHERE path = ?");
	const anchorLineDeleteStmt = db.prepare("DELETE FROM anchor_lines WHERE path = ? AND line = ?");
	const anchorMetaDeleteStmt = db.prepare("DELETE FROM anchor_meta WHERE path = ?");
	const anchorPruneOlderThanStmt = db.prepare(
		"DELETE FROM anchor_meta WHERE rowid IN (SELECT rowid FROM anchor_meta WHERE updated_at < ? LIMIT " + TTL_BATCH_LIMIT + ")",
	);
	const anchorLinesPruneOlderThanStmt = db.prepare(
		"DELETE FROM anchor_lines WHERE rowid IN (SELECT rowid FROM anchor_lines WHERE updated_at < ? LIMIT " + TTL_BATCH_LIMIT + ")",
	);
	// ---- budget / maintenance (#180, spec #184) ----
	// `(page_count - freelist_count) * page_size` is the budget metric: DELETE
	// only moves pages to the freelist, so a physical page count could never be
	// brought back under budget and the sweep would delete the same paths
	// forever — freelist_count makes "rows deleted" visible immediately.
	const storeBytesStmt = db.prepare(
		"SELECT (page_count - freelist_count) * page_size AS bytes " +
			"FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()",
	);
	const anchorRowCountStmt = db.prepare("SELECT COUNT(*) AS n FROM anchor_lines");
	const anchorPathCountStmt = db.prepare("SELECT COUNT(*) AS n FROM (SELECT path FROM undo UNION SELECT path FROM served UNION SELECT path FROM anchor_meta)");
	// One row per path, oldest first: the LRU order across every row family that
	// outlives a session (served is per-session, but still ages the path).
	const pathRecencyStmt = db.prepare(
		"SELECT path, MAX(ts) AS ts FROM (" +
			"SELECT path, updated_at AS ts FROM anchor_meta " +
			"UNION ALL SELECT path, updated_at FROM undo " +
			"UNION ALL SELECT path, updated_at FROM served) " +
			"GROUP BY path ORDER BY ts ASC",
	);
	const undoBudgetStmt = db.prepare(
		"SELECT COALESCE(SUM(LENGTH(content) + LENGTH(result_content) + LENGTH(hashes)), 0) AS bytes, " +
			"COUNT(*) AS n FROM undo WHERE path = ?",
	);
	const undoDepthsStmt = db.prepare("SELECT depth FROM undo WHERE path = ? ORDER BY depth ASC");
	const metaGetStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
	const metaSetStmt = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	);
	const metaDeleteStmt = db.prepare("DELETE FROM meta WHERE key = ?");
	// Anchor lines whose meta row is gone (a TTL prune that caught only one side,
	// or a crashed writer): unreachable state that still costs pages.
	const orphanAnchorLinesStmt = db.prepare(
		"DELETE FROM anchor_lines WHERE path NOT IN (SELECT path FROM anchor_meta)",
	);
	const stmts: Prepared = {
		allPaths: (...params) =>
			allStmt.all(...params) as Record<string, unknown>[],
		pathsByAnchors: (...params) =>
			pathsByAnchorsStmt.all(...params) as Record<string, unknown>[],
		undoPush: (...params) => {
			// `params` = [path, content, bom, ending, hashesJson, resultContent, updatedAt];
			// the path appears TWICE in the INSERT — once for the row, once for the
			// MAX(depth) that numbers it. Insert and prune are ONE move: a crash between
			// them would leave the stack one deeper than advertised.
			// `params[0]` is the path — the same key `withStore` would hold.
			withTransaction(db, params[0] as string, () => {
				undoPushStmt.run(params[0], ...params);
				const top = topDepth(params[0]) ?? 0;
				undoPruneStmt.run(params[0], top - UNDO_STACK_DEPTH + 1);
			});
		},
		undoPop: (...params) => {
			// Read the top depth FIRST, then delete exactly that row: a
			// `depth = (SELECT MAX(depth) …)` in the DELETE re-evaluates as rows go
			// and would walk the whole stack out.
			withTransaction(db, params[0] as string, () => {
				const top = topDepth(params[0]);
				if (top === undefined) return;
				undoPopStmt.run(params[0], top);
			});
		},
		undoGet: (...params) =>
			undoGetStmt.get(...params) as Record<string, unknown> | undefined,
		undoDepth: (...params) =>
			((undoDepthStmt.get(...params) as { n?: number } | undefined)?.n ?? 0),
		undoDelete: (...params) => {
			withBusyRetry(() => {
				undoDelStmt.run(...params);
			});
		},
		undoDeleteBelowDepth: (...params) =>
			// `.changes` is not guaranteed by every driver or test stub (the open-error
			// tests replace statements wholesale): a missing count reads as 0, never
			// as a TypeError on a property of undefined.
			Number((undoDeleteBelowDepthStmt.run(...params) as { changes?: number } | undefined)?.changes ?? 0),
		undoLayerSizes: (...params) =>
			undoLayerSizesStmt.all(...params) as Record<string, unknown>[],
		servedGet: (...params) =>
			servedGetStmt.get(...params) as Record<string, unknown> | undefined,
		servedUpsert: (...params) => {
			withBusyRetry(() => {
				servedUpsertStmt.run(...params);
			});
		},
		servedReportedUpsert: (...params) => {
			withBusyRetry(() => {
				servedReportedUpsertStmt.run(...params);
			});
		},
		servedReportedClear: (...params) => {
			withBusyRetry(() => {
				servedReportedClearStmt.run(params[1], params[0], params[2]);
			});
		},
		servedDelete: (...params) => {
			withBusyRetry(() => {
				servedDeleteStmt.run(...params);
			});
		},
		servedDeletePath: (...params) => {
			withBusyRetry(() => {
				servedDeletePathStmt.run(...params);
			});
		},
		servedWipe: (...params) => {
			withBusyRetry(() => {
				servedWipeStmt.run(...params);
			});
		},
		servedPruneOlderThan: (...params) =>
			Number((servedPruneOlderThanStmt.run(...params) as { changes?: number } | undefined)?.changes ?? 0),
		anchorMetaGet: (...params) =>
			anchorMetaGetStmt.get(...params) as Record<string, unknown> | undefined,
		anchorMetaUpsert: (...params) => {
			withBusyRetry(() => {
				anchorMetaUpsertStmt.run(...params);
			});
		},
		anchorLinesAll: (...params) =>
			anchorLinesAllStmt.all(...params) as Record<string, unknown>[],
		anchorLineGet: (...params) =>
			anchorLineGetStmt.get(...params) as Record<string, unknown> | undefined,
		anchorLineUpsert: (...params) => {
			withBusyRetry(() => {
				anchorLineUpsertStmt.run(...params);
			});
		},
		anchorLineDelete: (...params) => {
			withBusyRetry(() => {
				anchorLineDeleteStmt.run(...params);
			});
		},
		anchorLinesDeletePath: (...params) => {
			withBusyRetry(() => {
				anchorLinesDeletePathStmt.run(...params);
			});
		},
		anchorMetaDelete: (...params) => {
			withBusyRetry(() => {
				anchorMetaDeleteStmt.run(...params);
			});
		},
		anchorPruneOlderThan: (...params) => {
			const cutoff = params[0] as number;
			let total = 0;
			for (;;) {
				const r = anchorPruneOlderThanStmt.run(cutoff);
				const rows = (r?.changes as number | undefined) ?? 0;
				const rowsLines = (anchorLinesPruneOlderThanStmt.run(cutoff)?.changes as number | undefined) ?? 0;
				total += rows + rowsLines;
				if (rows + rowsLines < TTL_BATCH_LIMIT * 2) break;
			}
			return total;
		},
		// ---- budget / maintenance (#180) ----
		storeBytes: () =>
			Number((storeBytesStmt.get() as { bytes?: number } | undefined)?.bytes ?? 0),
		anchorRowCount: () =>
			Number((anchorRowCountStmt.get() as { n?: number } | undefined)?.n ?? 0),
		anchorPathCount: () =>
			Number((anchorPathCountStmt.get() as { n?: number } | undefined)?.n ?? 0),
		pathRecency: () => pathRecencyStmt.all() as Record<string, unknown>[],
		undoBudget: (...params) =>
			undoBudgetStmt.get(...params) as Record<string, unknown> | undefined,
		undoDepths: (...params) => undoDepthsStmt.all(...params) as Record<string, unknown>[],
		metaGet: (...params) => metaGetStmt.get(...params) as Record<string, unknown> | undefined,
		metaSet: (...params) => {
			withBusyRetry(() => {
				metaSetStmt.run(...params);
			});
		},
		metaDelete: (...params) => {
			withBusyRetry(() => {
				metaDeleteStmt.run(...params);
			});
		},
		orphanAnchorLines: () => {
			withBusyRetry(() => {
				orphanAnchorLinesStmt.run();
			});
		},
		vacuum: () => {
			db.exec("VACUUM");
		},
	};
	return { db, stmts };
}

/** Wire the domain methods over the prepared statements. */
function makeDomainStore(
	stmts: Prepared,
	budget: SweepBudget,
	options: { bytes: number; paths: number; rows: number },
): HashStore {
	// Cheap check used by every write method. Reads three PRAGMAs; ~µs each.
	const overBudget = (): boolean => {
		const bytes = stmts.storeBytes();
		if (bytes > options.bytes) return true;
		if (stmts.anchorPathCount() > options.paths) return true;
		if (stmts.anchorRowCount() > options.rows) return true;
		return false;
	};
	let sweepScheduled = false;
	const maybeSweepAfterWrite = () => {
		budget.writeCounter++;
		if (sweepScheduled) return;
		if (budget.writeCounter % HASH_STORE_SWEEP_WRITES !== 0 && !overBudget()) return;
		sweepScheduled = true;
		try {
			const report = runSweep();
			// Logging only — the report is for callers / tests.
			if (report.evictedPaths > 0) {
				console.warn(
					`[hash-store] sweep freed ${report.evictedPaths} paths ` +
						`(${report.ttlDropped} TTL, ${report.trimmedUndo} slimmed) ` +
						`in ${report.durationMs}ms; ` +
						`store ${formatBytes(report.before.bytes)} → ${formatBytes(report.after.bytes)}.`,
				);
			}
		} finally {
			sweepScheduled = false;
		}
	};

	// ---- the eviction sweep --------------------------------------------------
	// One scan, three phases, strictly ordered:
	//   1. TTL:        drop whole paths whose MAX(updated_at) < now - ttlMs.
	//   2. Slim:       for the oldest 200 surviving paths, trim the per-path
	//                  undo stack to ≤ undoMaxBytes (always keep ≥ 1 layer).
	//   3. LRU:        while any of bytes/paths/rows exceeds its budget, drop
	//                  the next-oldest whole path; once under budget, delete
	//                  an extra 10% to amortise the next sweep.
	function runSweep(opts?: SweepOptions): SweepReport {
		const started = Date.now();
		const limits = {
			bytes: opts?.bytes ?? options.bytes,
			paths: opts?.paths ?? options.paths,
			rows: opts?.rows ?? options.rows,
			ttlMs: opts?.ttlMs ?? SERVED_TTL_MS,
			undoMaxBytes: opts?.undoMaxBytes ?? UNDO_MAX_PATH_BYTES,
			now: opts?.now ?? Date.now(),
			slimBatch: opts?.slimBatch ?? 200,
		};
		const before: HashStoreStats = {
			bytes: stmts.storeBytes(),
			paths: stmts.anchorPathCount(),
			rows: stmts.anchorRowCount(),
		};
		const recency = stmts.pathRecency() as { path: string; ts: number }[];
		const deleted = new Set<string>();
		let evictedPaths = 0;
		let ttlDropped = 0;
		let trimmedUndo = 0;

		const deletePathCascade = (path: string) => {
			stmts.undoDelete(path);
			stmts.servedDeletePath(path);
			stmts.anchorMetaDelete(path);
			stmts.anchorLinesDeletePath(path);
		};

		// 1. TTL: drop whole paths whose recency is below the cutoff.
		const ttlCutoff = limits.now - limits.ttlMs;
		for (const row of recency) {
			if (row.ts >= ttlCutoff) break;
			deletePathCascade(row.path);
			deleted.add(row.path);
			evictedPaths++;
			ttlDropped++;
		}

		// 2. Slim: undo-byte cap on the oldest surviving paths.
		const slimCandidates = recency
			.filter((r) => !deleted.has(r.path))
			.slice(0, limits.slimBatch);
		for (const row of slimCandidates) {
			const dropped = trimUndoInternal(row.path, limits.undoMaxBytes);
			if (dropped > 0) trimmedUndo++;
		}

		// 3. LRU: drop whole paths until every budget metric is in range,
		// then delete an additional ~10% to amortise the next sweep.
		const lruPool = recency.filter((r) => !deleted.has(r.path));
		let lruDeleted = 0;
		while (
			lruDeleted < lruPool.length &&
			(stmts.storeBytes() > limits.bytes ||
				stmts.anchorPathCount() > limits.paths ||
				stmts.anchorRowCount() > limits.rows)
		) {
			deletePathCascade(lruPool[lruDeleted].path);
			deleted.add(lruPool[lruDeleted].path);
			lruDeleted++;
		}
		// Multi-delete 10% once we've actually trimmed.
		if (lruDeleted > 0) {
			const extra = Math.ceil(lruDeleted * 0.1);
			for (let i = 0; i < extra && lruDeleted < lruPool.length; i++) {
				deletePathCascade(lruPool[lruDeleted].path);
				deleted.add(lruPool[lruDeleted].path);
				lruDeleted++;
			}
		}
		evictedPaths += lruDeleted;

		// Healed orphan anchor_lines cost pages but no metric; cheapest to fold in.
		stmts.orphanAnchorLines();

		const after: HashStoreStats = {
			bytes: stmts.storeBytes(),
			paths: stmts.anchorPathCount(),
			rows: stmts.anchorRowCount(),
		};
		return {
			before,
			after,
			evictedPaths,
			ttlDropped,
			trimmedUndo,
			rebuilt: false,
			durationMs: Date.now() - started,
		};
	}

	/** Internal trim: see {@link HashStore.trimUndo}. */
	function trimUndoInternal(path: string, maxBytes: number): number {
		const budget = stmts.undoBudget(path) as { bytes?: number; n?: number } | undefined;
		if (!budget) return 0;
		const bytes = Number(budget.bytes ?? 0);
		const n = Number(budget.n ?? 0);
		if (bytes <= maxBytes || n <= 1) return 0;
		const layers = stmts.undoLayerSizes(path) as { depth: number; bytes: number }[];
		// Walk from the oldest end, dropping layers, until the path is under the
		// cap or only one layer is left.
		let runningBytes = bytes;
		let keepFrom = 0;
		for (let i = 0; i < layers.length - 1; i++) {
			if (runningBytes <= maxBytes) break;
			runningBytes -= Number(layers[i].bytes);
			keepFrom = i + 1;
		}
		if (keepFrom === 0) return 0;
		// Layers are ordered ASC; the cut is "drop everything strictly below
		// the kept layer's depth".
		const cutoffDepth = Number(layers[keepFrom].depth);
		const removed = stmts.undoDeleteBelowDepth(path, cutoffDepth);
		return removed;
	}

	const store: HashStore = {
		engine: "node:sqlite",

		// `getSnapshot` / `upsertSnapshot` / `allSnapshotHashes` / `deleteSnapshot` /
		// `findSnapshotPaths` lived here and are gone with the `snapshots` table
		// (contract §8). `getSnapshot` had no caller at all outside the tests, and
		// `upsertSnapshot` had no PRODUCTION caller — which is why the table could
		// still be read and never written. The one caller that mattered ("which file
		// holds these anchors?") is `findPathsByAnchors` below, now answered from
		// `anchor_lines`.
		allKnownPaths() {
			return stmts.allPaths() as { path: string }[];
		},
		/**
		 * Paths whose live anchors contain every given anchor (contract §2.1).
		 *
		 * One indexed pass: the IN list narrows to candidate paths, and the HAVING
		 * keeps only those that matched all of them. Anchors are unique within a
		 * file, so a path matching N anchors is exactly a path holding all N.
		 */
		findPathsByAnchors(anchors) {
			if (anchors.length === 0) return [];
			const json = JSON.stringify([...anchors]);
			const rows = stmts.pathsByAnchors(json, json) as { path: string }[];
			return rows.map((row) => row.path);
		},

		getUndo(path) {
			const row = stmts.undoGet(path);
			if (!row) return undefined;
			try {
				const parsed = JSON.parse(row.hashes as string);
				if (!isValidHashList(parsed)) {
					// A corrupt TOP breaks the chain: every entry below it describes a state
					// this one was supposed to lead to, so the whole stack goes.
					stmts.undoDelete(path);
					return undefined;
				}
				return {
					content: row.content as string,
					bom: row.bom as string,
					ending: row.ending as string,
					hashes: parsed as string[],
					resultContent: row.result_content as string,
					// New rows carry a checksum instead of the post-edit body (#176);
					// legacy rows have an empty string here and are still verified by
					// their stored text.
					resultChecksum: (row.result_checksum as string | null) ?? undefined,
				};
			} catch {
				stmts.undoDelete(path);
				return undefined;
			}
		},
		pushUndo(path, entry) {
			stmts.undoPush(
				path,
				entry.content,
				entry.bom,
				entry.ending,
				JSON.stringify(entry.hashes),
				entry.resultContent,
				entry.resultChecksum ?? "",
				Date.now(),
			);
			maybeSweepAfterWrite();
		},
		popUndo(path) {
			stmts.undoPop(path);
		},
		deleteUndo(path) {
			stmts.undoDelete(path);
		},
		undoDepth(path) {
			return stmts.undoDepth(path);
		},
		trimUndo(path, maxBytes = UNDO_MAX_PATH_BYTES) {
			return trimUndoInternal(path, maxBytes);
		},

		getServed(sessionKey, path) {
			const row = stmts.servedGet(sessionKey, path);
			if (!row) return new Set();
			// The codec owns every shape this has ever been stored in (#176): the
			// packed form this build writes and the three legacy JSON shapes. An
			// unreadable payload heals the same way malformed JSON always did —
			// the row is dropped and the session re-serves what it needs.
			const decoded = decodeServedAnchors(row.hashes as string);
			if (decoded === undefined) {
				stmts.servedDelete(sessionKey, path);
				return new Set();
			}
			return decoded;
		},
		getServedReported(sessionKey, path) {
			const row = stmts.servedGet(sessionKey, path);
			if (!row) return new Set();
			const raw = row.reported;
			if (typeof raw !== "string" || raw.length === 0) return new Set();
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (!Array.isArray(parsed)) return new Set();
				return new Set(
					parsed.filter(
						(h): h is string => typeof h === "string" && hashRe().test(h),
					),
				);
			} catch {
				return new Set();
			}
		},
		upsertServed(sessionKey, path, anchors) {
			// Encode here, in one place (#176): callers hand over the set they have
			// and never see the on-disk shape.
			stmts.servedUpsert(sessionKey, path, encodeServedAnchors(anchors), Date.now());
			maybeSweepAfterWrite();
		},
		upsertServedReported(sessionKey, path, reportedJson) {
			stmts.servedReportedUpsert(sessionKey, path, reportedJson, Date.now());
		},
		clearServedReported(sessionKey, path) {
			stmts.servedReportedClear(sessionKey, Date.now(), path);
		},
		deleteServed(sessionKey, path) {
			stmts.servedDelete(sessionKey, path);
		},
		deleteServedByPath(path) {
			stmts.servedDeletePath(path);
		},
		wipeServed(sessionKey) {
			stmts.servedWipe(sessionKey);
		},
		pruneServedOlderThan(ts) {
			stmts.servedPruneOlderThan(ts);
		},

		metaGet(key) {
			const row = stmts.metaGet(key);
			return row?.value as string | undefined;
		},
		metaSet(key, value) {
			stmts.metaSet(key, value);
		},
		metaDelete(key) {
			stmts.metaDelete(key);
		},

		stats() {
			return {
				bytes: stmts.storeBytes(),
				paths: stmts.anchorPathCount(),
				rows: stmts.anchorRowCount(),
			};
		},
		sweep(opts) {
			return runSweep(opts);
		},

		async pruneMissing() {
			const rows = stmts.allPaths() as { path: string }[];
			const missing = await statMissing(rows);
			if (missing.length === 0) return;
			withStore(() => {
				for (const path of missing) {
					stmts.undoDelete(path);
					stmts.servedDeletePath(path);
					stmts.anchorMetaDelete(path);
					stmts.anchorLinesDeletePath(path);
				}
			});
		},
	};
	return store;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
	return `${(n / 1024 / 1024).toFixed(1)}MiB`;
}

/**
 * Create the TTL / recency indexes exactly once per store.
 *
 * They are deliberately NOT part of `buildStore`'s schema: creating them costs
 * a full pass over every row (measured ~5 s over 3 M rows), and the open path
 * may be about to REBUILD or SWEEP the store — work that would be thrown away.
 * They are still needed before the TTL prunes and the LRU order, both of which
 * read `updated_at` and would otherwise walk the tables linearly.
 *
 * Guarded by a meta marker rather than `IF NOT EXISTS` alone, so the check on
 * every subsequent open is one row read instead of four catalog lookups, and so
 * a fresh (rebuilt) store gets them immediately — there they are free.
 *
 * @param db - the open store connection.
 */
function ensureMaintenanceIndexes(db: DatabaseSync): void {
	const done = db.prepare("SELECT value FROM meta WHERE key = 'maintenance_indexes'").get() as
		| { value?: string }
		| undefined;
	if (done?.value === "1") return;
	db.exec("CREATE INDEX IF NOT EXISTS anchor_meta_updated_at ON anchor_meta (updated_at)");
	db.exec("CREATE INDEX IF NOT EXISTS anchor_lines_updated_at ON anchor_lines (updated_at)");
	db.exec("CREATE INDEX IF NOT EXISTS undo_updated_at ON undo (updated_at)");
	db.exec("CREATE INDEX IF NOT EXISTS served_updated_at ON served (updated_at)");
	db.prepare("INSERT INTO meta (key, value) VALUES ('maintenance_indexes', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

function isHealthy(db: DatabaseSync): boolean {
	try {
		const row = db.prepare("PRAGMA quick_check").get() as
			| { quick_check?: string }
			| undefined;
		return row?.quick_check === "ok";
	} catch (error) {
		if (isCorruptionError(error)) return false;
		return true;
	}
}

async function quarantineStore(storePath: string): Promise<void> {
	const suffix = `.corrupt-${Date.now()}`;
	for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
		try {
			await rename(candidate, `${candidate}${suffix}`);
		} catch (error) {
			if (errCode(error) !== "ENOENT") {
				console.error("Failed to quarantine corrupt hash store file:", error);
			}
		}
	}
}

/** Maximum time a VACUUM may take at close before we give up. A VACUUM that
 *  hangs forever is worse than one we let run on the next open. */
const VACUUM_TIMEOUT_MS = 60_000;

/** Close a store, running VACUUM if a `pending_vacuum` marker was left by a
 *  prior sweep and writing `clean_shutdown=1` for the next open to read. */
function shutdownDb(
	db: DatabaseSync,
	stmts: Prepared | undefined, storePath: string | undefined,
): void {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// best-effort checkpoint before close
	}
	if (stmts) {
		try {
			const pending = stmts.metaGet("pending_vacuum");
			const shouldVacuum = pending !== undefined;
			stmts.metaSet("clean_shutdown", "1");
			if (shouldVacuum) {
				const vacuumStart = Date.now();
				const timer = setTimeout(() => {
					// The VACUUM below will still run to completion (sync), but
					// the timeout gives us a way to detect a runaway one — see
					// the catch + abort dance in tryVacuumWithTimeout.
				}, VACUUM_TIMEOUT_MS);
				try {
					if (storePath) tryVacuumWithTimeout(db, storePath, VACUUM_TIMEOUT_MS);
					stmts.metaDelete("pending_vacuum");
					console.warn(
						`[hash-store] VACUUM completed in ${Date.now() - vacuumStart}ms; pending_vacuum cleared.`,
					);
				} catch (error) {
					console.error(
						"[hash-store] VACUUM failed or timed out, leaving pending_vacuum for next open:",
						error,
					);
					// Leave `pending_vacuum` in place; the next open will try again.
				} finally {
					clearTimeout(timer);
				}
			}
		} catch (error) {
			// Persisting clean_shutdown / vacuum must never block shutdown.
			console.error("[hash-store] shutdown bookkeeping failed:", error);
		}
	}
	db.close();
}

/** Run VACUUM on a worker so the main thread stays responsive, and abort
 *  after `timeoutMs`. On timeout the worker is detached (its VACUUM keeps
 *  running until done but its result is ignored). The main thread never
 *  blocks longer than `timeoutMs`. */
function tryVacuumWithTimeout(_db: DatabaseSync, storePath: string, timeoutMs: number): void {
	const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
	const worker = new Worker(
		"const { parentPort, workerData } = require('node:worker_threads');" +
			"const { DatabaseSync } = require('node:sqlite');" +
			"const db = new DatabaseSync(workerData.path, { timeout: 5000 });" +
			"try { db.exec('VACUUM'); parentPort.postMessage({ ok: true }); }" +
			"catch (e) { parentPort.postMessage({ ok: false, error: String(e) }); }" +
			"finally { try { db.close(); } catch {} }",
		{ eval: true, workerData: { path: storePath } },
	);
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		worker.terminate().catch(() => undefined);
		// Throw so the caller's catch leaves pending_vacuum in place.
		throw new Error(`VACUUM exceeded ${timeoutMs}ms`);
	}, timeoutMs);
	worker.on("message", (msg: { ok: boolean; error?: string }) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		worker.terminate().catch(() => undefined);
		if (!msg.ok) throw new Error(msg.error ?? "VACUUM worker failed");
	});
	worker.on("error", (err) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		throw err;
	});
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
	const missing: string[] = [];
	for (let i = 0; i < rows.length; i += STAT_BATCH) {
		const batch = rows.slice(i, i + STAT_BATCH);
		const results = await Promise.all(
			batch.map(async (row) => {
				try {
					await stat(row.path);
					return undefined;
				} catch {
					return row.path;
				}
			}),
		);
		for (const path of results) {
			if (path !== undefined) missing.push(path);
		}
	}
	return missing;
}

/** How often the open path is allowed to rebuild a single store. A workspace
 *  that legitimately needs more than the rebuild threshold doesn't lose its
 *  anchors on every launch. */
function readRebuildThrottle(stmts: Prepared): { lastAt: number; now: number } {
	const now = Date.now();
	const row = stmts.metaGet("last_rebuild_at");
	const lastAt = row ? Number(row.value ?? 0) : 0;
	return { lastAt, now };
}

/** Quick WAL cleanup; runs before any budget measurement so the sticky WAL
 *  doesn't fool the metric. Cheap: one TRUNCATE checkpoint. */
function tryCheckpointTruncate(db: DatabaseSync): void {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// best-effort
	}
}

async function openStore(storePath: string): Promise<HashStore> {
	// Multi-store: never close another workspace's store when opening this one.

	await mkdir(dirname(storePath), { recursive: true });

	let existed = existsSync(storePath);
	let opened: { db: DatabaseSync; stmts: Prepared };
	try {
		opened = openDbWithBusyRetry(storePath);
	} catch (error) {
		if (!isCorruptionError(error)) throw error;
		console.error("Hash store failed to open, rebuilding:", error);
		await quarantineStore(storePath);
		existed = false;
		opened = openDbWithBusyRetry(storePath);
	}
	// Open-path cost control (spec #184, ADR-0010): PRAGMA quick_check scans
	// every page. On a 2 GB store it was 80 % of the cold-open latency. We
	// only run it when the last shutdown was NOT clean — the marker is set
	// by `shutdownDb` and removed here once we've decided the store is
	// trustworthy. The first-time / quarantine paths still run quick_check
	// because there is no marker to consult.
	let skipQuickCheck = false;
	const cleanShutdownRow = opened.stmts.metaGet("clean_shutdown");
	if (cleanShutdownRow !== undefined) {
		// The marker proves the previous process exited through shutdownDb.
		// Drop it now — a future crash will leave it absent and we'll check.
		opened.stmts.metaDelete("clean_shutdown");
		skipQuickCheck = true;
	}
	if (!skipQuickCheck && !isHealthy(opened.db)) {
		shutdownDb(opened.db, undefined, storePath);
		await quarantineStore(storePath);
		existed = false;
		opened = openDbWithBusyRetry(storePath);
	}
	const { db, stmts } = opened;
	// Diagnostic (and the test seam for the cold-open gate): record WHICH decision
	// the open took, so "was the full-DB check skipped?" is answerable from the
	// store itself rather than by timing. Field use: a 20 s open can be attributed
	// to a real integrity check instead of being a mystery.
	stmts.metaSet("last_open_integrity_check", skipQuickCheck ? "skipped" : "ran");

	// WAL checkpoint before measuring: TRUNCATE returns the WAL to the main
	// store, so a sticky WAL doesn't inflate the byte budget. Cheap.
	tryCheckpointTruncate(db);

	if (!existed) {
		await migrateLegacy(db, storePath);
	}

	// ---- cold-open budget gate (spec #184, ADR-0010) ------------------------
	// A huge store on first open must NOT make the first tool call wait while
	// we evict. Above the rebuild threshold we tear it down and rebuild from
	// scratch — seconds, not the minutes a sweep over multi-million-row
	// indexes would be. Between evict and rebuild we run the in-place sweep.
	const initialStats = {
		bytes: stmts.storeBytes(),
		paths: stmts.anchorPathCount(),
		rows: stmts.anchorRowCount(),
	};
	// Limits come from the settings layer when it has published any (#179), and
	// from the constants otherwise — `storeBudgetLimits()` is the single seam.
	const limits = storeBudgetLimits();
	const evictThreshold = limits.bytes * HASH_STORE_EVICT_RATIO;
	const rebuildThreshold = limits.bytes * HASH_STORE_REBUILD_RATIO;
	const needsRebuild =
		initialStats.bytes >= rebuildThreshold ||
		initialStats.paths >= limits.paths * HASH_STORE_REBUILD_RATIO ||
		initialStats.rows >= limits.rows * HASH_STORE_REBUILD_RATIO;
	const { lastAt: lastRebuildAt, now: nowMs } = readRebuildThrottle(stmts);
	const throttled = nowMs - lastRebuildAt < HASH_STORE_REBUILD_THROTTLE_MS;

	const budget: SweepBudget = { writeCounter: 0 };
	const store = makeDomainStore(stmts, budget, limits);

	if (needsRebuild && !throttled) {
		const before = initialStats;
		const rebuildStart = Date.now();
		try {
			shutdownDb(db, stmts, storePath);
			await quarantineStore(storePath);
			const reopened = openDbWithBusyRetry(storePath);
			tryCheckpointTruncate(reopened.db);
			stores.set(storePath, {
				path: storePath,
				db: reopened.db,
				stmts: reopened.stmts,
				store: makeDomainStore(reopened.stmts, budget, limits),
				budget,
			});
			reopened.stmts.metaSet("last_rebuild_at", String(Date.now()));
			console.warn(
				`[hash-store] rebuild complete in ${Date.now() - rebuildStart}ms; ` +
					`freed ${formatBytes(before.bytes)} / ${before.paths} paths / ${before.rows} rows. ` +
					"All anchors for this workspace are invalidated — re-read files before editing.",
			);
			setRebuildWarning(
				"本工作区锚点库已重建，旧锚点作废，请重新 read。",
			);
			ensureMaintenanceIndexes(reopened.db);
			return stores.get(storePath)!.store;
		} catch (error) {
			console.error("[hash-store] rebuild failed, falling back to sweep:", error);
			setRebuildWarning(undefined);
			// Fall through to the sweep below using the original store.
		}
	}

	stores.set(storePath, { path: storePath, db, stmts, store, budget });
	// Maintenance indexes and TTL prunes run AFTER the budget gate on purpose.
	// They are the two costs that scale with row count, and a store that is about
	// to be rebuilt or swept must not pay them first: building four indexes over
	// 3 M rows measured ~5 s, all of it wasted when the store is then torn down.
	// `ensureMaintenanceIndexes` is guarded by a meta marker, so the build happens
	// once per store (and instantly on a freshly rebuilt one).
	ensureMaintenanceIndexes(db);
	withBusyRetry(() => {
		stmts.servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
	});
	withBusyRetry(() => {
		stmts.anchorPruneOlderThan(Date.now() - ANCHOR_STATE_TTL_MS);
	});

	// Above the evict threshold (or always when we deferred the rebuild
	// because of throttle): run an in-place sweep.
	const overEvict =
		initialStats.bytes >= evictThreshold ||
		initialStats.paths >= limits.paths * HASH_STORE_EVICT_RATIO ||
		initialStats.rows >= limits.rows * HASH_STORE_EVICT_RATIO;
	if (overEvict) {
		const report = store.sweep();
		if (report.evictedPaths > 0) {
			console.warn(
				`[hash-store] cold-open sweep freed ${report.evictedPaths} paths ` +
					`(${report.ttlDropped} TTL, ${report.trimmedUndo} slimmed) ` +
					`in ${report.durationMs}ms; ` +
					`store ${formatBytes(report.before.bytes)} → ${formatBytes(report.after.bytes)}.` +
					(needsRebuild && throttled
						? " (rebuild deferred: throttle window active)"
						: ""),
			);
		}
	}

	if (!exitHandlerRegistered) {
		exitHandlerRegistered = true;
		process.once("exit", () => shutdownHashStore());
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.once(sig, () => {
				shutdownHashStore();
				process.kill(process.pid, sig);
			});
		}
	}

	return store;
}

/** Resolve the store path for this call: explicit cwd, the active workspace, or the shared-home fallback. */
function storePathFor(cwd?: string): string {
	return hashStorePath(cwd ?? workspaceCwd());
}

/**
 * Load (and cache) the hash store for the given cwd — or, when omitted, the
 * workspace active for this async execution (`withWorkspace`), falling back to
 * the shared `$DSH_HOME` store outside a tool call.
 * @param cwd - optional explicit workspace root; defaults to the active workspace.
 */
export function loadHashStore(cwd?: string): Promise<HashStore> {
	const storePath = storePathFor(cwd);
	const cached = stores.get(storePath);
	if (cached && cached.db.isOpen) {
		return Promise.resolve(cached.store);
	}
	const existing = openings.get(storePath);
	if (existing) return existing;
	const promise = openStore(storePath).finally(() => {
		openings.delete(storePath);
	});
	openings.set(storePath, promise);
	return promise;
}

/** The cached store entry for the active workspace (or the shared-home fallback), if open. */
function currentStore():
	| { db: DatabaseSync; stmts: Prepared; store: HashStore; budget: SweepBudget; path: string }
	| undefined {
	const entry = stores.get(storePathFor());
	return entry?.db.isOpen ? entry : undefined;
}

/** Close every open store (process exit, HMR, tests). */
export function shutdownHashStore(): void {
	for (const [, entry] of stores) {
		shutdownDb(entry.db, entry.stmts, entry.path);
	}
	stores.clear();
	openings.clear();
	// Nothing to invalidate on the anchor side any more: it holds no cache (it
	// reads `anchor_lines` per call), and the port resolves the store lazily, so
	// with the store gone its reads answer "nothing allocated" and its writes are
	// no-ops until the next open. The cache-invalidation dance this used to do
	// existed only because a cache could sit AHEAD of the database.
}

/**
 * How deep the active store's transaction nesting is, per store path.
 *
 * SQLite has no nested `BEGIN`, so a second `withStore` inside a first must
 * JOIN the open transaction rather than try to start another. The counter is
 * keyed by path and cleared with the transaction, so it can never outlive the
 * BEGIN it belongs to.
 */
const txnDepth = new Map<string, number>();

/**
 * Run `fn` inside one BEGIN IMMEDIATE transaction on the active workspace's
 * store. Without an open store for this context the call runs bare (the
 * caller has already loaded the store in every in-process path).
 *
 * **Nestable.** A call made while a transaction is already open on this store
 * joins it: SQLite has no nested `BEGIN`, and a caller that wants several
 * primitives to commit together (contract §7 — "one transaction per file")
 * must be able to compose them without each one trying to open its own.
 * Only the OUTERMOST call commits or rolls back.
 */
export function withStore(fn: () => void): void {
	const store = currentStore();
	if (store) {
		const depth = txnDepth.get(store.path) ?? 0;
		if (depth > 0) {
			// Join the open transaction: no BEGIN, no COMMIT, no ROLLBACK here.
			txnDepth.set(store.path, depth + 1);
			try {
				fn();
			} finally {
				txnDepth.set(store.path, depth);
			}
			return;
		}
		withBusyRetry(() => {
			store.db.exec("BEGIN IMMEDIATE");
			txnDepth.set(store.path, 1);
			try {
				fn();
				store.db.exec("COMMIT");
			} catch (e) {
				try {
					store.db.exec("ROLLBACK");
				} catch {
					// best-effort rollback; the original error propagates
				}
				throw e;
			} finally {
				txnDepth.delete(store.path);
			}
		});
	} else {
		fn();
	}
}

/**
 * `withStore` for an ASYNC body — same transaction, same nesting rules.
 *
 * Needed because the primitives' write halves are `async` (they await the
 * store handle), so composing several of them into one transaction — which is
 * what contract §7 asks for, "one transaction per file" — cannot be done with
 * the sync form.
 *
 * **The body must not perform real I/O.** A transaction is held open across
 * its awaits, so a body that awaits anything other than an already-resolved
 * handle would let unrelated work join this transaction (see `withStore`,
 * which nests) and be committed or rolled back with it. Every caller here
 * awaits handles that are already open, so the window spans microtasks only.
 */
export async function withStoreAsync(fn: () => Promise<void>): Promise<void> {
	const store = currentStore();
	if (!store) {
		await fn();
		return;
	}
	const depth = txnDepth.get(store.path) ?? 0;
	if (depth > 0) {
		txnDepth.set(store.path, depth + 1);
		try {
			await fn();
		} finally {
			txnDepth.set(store.path, depth);
		}
		return;
	}
	await withBusyRetryAsync(async () => {
		store.db.exec("BEGIN IMMEDIATE");
		txnDepth.set(store.path, 1);
		try {
			await fn();
			store.db.exec("COMMIT");
		} catch (e) {
			try {
				store.db.exec("ROLLBACK");
			} catch {
				// best-effort rollback; the original error propagates
			}
			throw e;
		} finally {
			txnDepth.delete(store.path);
		}
	});
}

/**
 * The async twin of `withBusyRetry`: same policy, awaits the body.
 *
 * **A REPLAYED BODY MUST BE IDEMPOTENT**, because a busy lock replays it — that
 * is what the retry buys, and it is the part callers forget. Every effect the
 * primitives have, in-memory ones included, is idempotent BY CONSTRUCTION, and
 * this note is the reason each one is:
 *
 *  - the release pool (`markReleased`): a Set add, so adding twice is adding
 *    once; and it is per CALL, discarded when the call ends;
 *  - `anchorFor`: re-reads the rows, and allocation is a deterministic function
 *    of (rows, content, used-set) — the rolled-back attempt left no row behind,
 *    so attempt 2 mints exactly what attempt 1 did;
 *  - the alignment notice (`noteAlignmentDegraded`): keyed by path, so the
 *    second write replaces the first with the same string.
 *
 * Anything added later that mutates memory — a counter, an accumulator, a push
 * — breaks this without breaking the retry, which is the worst way for it to
 * break. Keep it idempotent, or move it outside the transaction.
 */
async function withBusyRetryAsync(fn: () => Promise<void>): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
			await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_DELAY_MS));
		}
	}
	throw lastError;
}

async function migrateLegacy(db: DatabaseSync, storePath: string): Promise<void> {
	const legacyPath = join(dirname(storePath), "hash-store.json");
	let content: string;
	try {
		content = await readFile(legacyPath, "utf-8");
	} catch (error: unknown) {
		if (errCode(error) === "ENOENT") return;
		console.error("Failed to read legacy hash store for migration:", error);
		return;
	}

	let parsed: { snapshots?: Record<string, unknown> };
	try {
		parsed = JSON.parse(content) as typeof parsed;
	} catch (error) {
		console.error(
			"Failed to parse legacy hash store, skipping migration:",
			error,
		);
		return;
	}

	// The legacy payload is NOT imported any more, and nothing is lost by that.
	//
	// The file held `{snapshots: {path: {content, hashes}}}` — whole-file anchor
	// arrays. Anchors are a DETERMINISTIC function of content (`anchorsPure`), so
	// the next read of each file re-derives exactly the same array; the JSON was a
	// cache, never a source of truth.
	//
	// It cannot be imported into the table that replaced it: `anchor_lines` needs a
	// per-line `content_key`, and the JSON stores no such thing. Writing rows
	// without one would manufacture anchors that are live but can never pass the
	// §2.2 verdict — worse than no row at all.
	//
	// The file is still renamed below so it is not re-examined on every open;
	// `.bak` (not deletion) keeps it as the historical record.
	const legacyKeys =
		parsed.snapshots && typeof parsed.snapshots === "object" && !Array.isArray(parsed.snapshots)
			? Object.keys(parsed.snapshots).length
			: 0;
	if (legacyKeys > 0) {
		console.warn(
			`[hash-store] legacy hash-store.json carried ${legacyKeys} anchor snapshots; not imported (they are re-derived from content on the next read).`
		);
	}

	try {
		await rename(legacyPath, `${legacyPath}.bak`);
	} catch (error) {
		console.error("Failed to rename legacy hash store after migration:", error);
	}
}

// ---- async convenience helpers (load the active store, then delegate) ------

/**
 * Files whose LIVE anchors contain every given anchor (contract §2.1).
 *
 * Served from `anchor_lines` — the authoritative mapping — instead of the
 * deleted `snapshots` table. This is also why the missing-`path` autocorrect
 * works again: `snapshots` had no PRODUCTION writer left, so the lookup could
 * only ever match rows from before the anchor refactor and silently resolved
 * nothing for a file read since.
 */
export async function findPathsByAnchors(anchors: readonly string[]): Promise<string[]> {
	if (anchors.length === 0) return [];
	const store = await loadHashStore();
	return store.findPathsByAnchors(anchors);
}
// ---- anchor-state persistence adapter (issue #136) -------------------------
//
// `domain/session/anchor-state.ts` owns the anchor state — the port, the
// transaction, the read/write of `anchor_lines`. This module owns the sqlite
// rows. The adapter keeps the layering one-way: the state module defines the
// port, the domain wires it. Every call resolves the ACTIVE workspace's
// already-open store — never opening one — so store-less contexts (pure unit
// tests, the window before a tool call opens the db) simply see no rows.
//
// The RESOLVE engine (`hashline/anchor-pipeline.ts`) needs the same read but
// lives in the pure layer, so it takes the reader as an injected port rather
// than importing down a layer. The reader is stateless — it goes through the
// port above, which answers "nothing allocated" when no store is open — so
// there is nothing to unwire at shutdown.
registerAnchorReader(anchorsFor);
const anchorStateAdapter: AnchorStatePersistence = {
	probe(path) {
		const entry = currentStore();
		if (!entry) return undefined;
		const row = entry.stmts.anchorMetaGet(path);
		return row ? (row.checksum as string) : undefined;
	},
	get(path): PersistedAnchorState | undefined {
		const entry = currentStore();
		if (!entry) return undefined;
		const meta = entry.stmts.anchorMetaGet(path);
		if (!meta) return undefined;
		// Sparse rows: only the lines a tool has SERVED carry an anchor. The
		// caller materializes the dense view (placeholders for never-served
		// lines) — the persisted truth stays O(served lines) (#169 redesign).
		const rows = entry.stmts.anchorLinesAll(path);
		const lines: PersistedAnchorLine[] = [];
		for (const row of rows) {
			const line = row.line as number;
			const anchor = row.anchor as string;
			const contentKey = row.content_key as number;
			if (!Number.isInteger(line) || line < 1 ||
				!isValidHashList([anchor]) || !Number.isInteger(contentKey) || contentKey < 0) {
				// Same corruption contract as every other row family: heal by delete.
				entry.stmts.anchorMetaDelete(path);
				entry.stmts.anchorLinesDeletePath(path);
				return undefined;
			}
			lines.push({ line, anchor, contentKey });
		}
		return { checksum: meta.checksum as string, lineCount: meta.line_count as number, lines };
	},
	put(path, state) {
		const entry = currentStore();
		if (!entry) return; // no store yet: memory-only; flushed on the next wired call
		withTransaction(entry.db, entry.path, () => {
			entry.stmts.anchorMetaUpsert(path, state.checksum, state.lineCount, Date.now());
			entry.stmts.anchorLinesDeletePath(path);
			for (const line of state.lines) {
				entry.stmts.anchorLineUpsert(
					path, line.line, line.anchor, line.contentKey, Date.now(),
				);
			}
		});
		entry.budget.writeCounter++;
	},
	putLines(path, lines) {
		const entry = currentStore();
		if (!entry || lines.length === 0) return;
		for (const line of lines) {
			withBusyRetry(() => {
				entry.stmts.anchorLineUpsert(
					path, line.line, line.anchor, line.contentKey, Date.now(),
				);
			});
		}
		entry.budget.writeCounter++;
	},
	putMeta(path, checksum, lineCount, dropLine) {
		const entry = currentStore();
		if (!entry) return; // memory-only until a store exists (same contract as put)
		// Deliberately NOT wrapped in withTransaction: the caller
		// (`anchorFor`) already opened one and commits it with the served
		// write. `withBusyRetry` is transaction-agnostic — on a busy lock the
		// whole outer group is replayed by its owner.
		withBusyRetry(() => {
			entry.stmts.anchorMetaUpsert(path, checksum, lineCount, Date.now());
			if (dropLine !== undefined) entry.stmts.anchorLineDelete(path, dropLine);
		});
		entry.budget.writeCounter++;
	},
};
// THE KEY IS THE CALLER'S SPELLING — the store treats a path as opaque, and
// that is a decision, not an oversight.
//
// It was tempting to `normalize()` here so that two spellings of one file would
// share one anchor set. Measured against CI: that rewrite FIXED one Windows
// failure and BROKE six, because it also rewrites keys that were never
// filesystem paths — `/proj/partial.ts` becomes `\proj\partial.ts` on Windows,
// and a caller that keyed by the value it passed no longer finds its rows.
//
// What actually keeps the keys canonical is upstream: every tool resolves its
// path (`toCwd` / `resolveTarget` / `path.resolve`) BEFORE it touches the store,
// so the spellings never diverge in production. The one place they did was a
// test that interpolated `${dir}/f.ts` while the tool had stored the resolved
// one — fixed in the test, where the mistake was.
//
// So: a caller owns its own path spelling. Pass a resolved path, as every tool
// does; do not expect the store to guess which spelling you meant.
registerAnchorPersistence(anchorStateAdapter);