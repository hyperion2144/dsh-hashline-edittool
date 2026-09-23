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
 * @module dsh-hashline-edittool/hash-store
 */

import { existsSync } from "node:fs";
import { readFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../infra/paths.js";
import { workspaceCwd } from "../../infra/workspace.js";
import { errCode, splitLines } from "../../infra/utils.js";
import { contentChecksum, hashRe } from "../../hashline/hash-assign.js";
import {
	HASH_STORE_VERSION,
	HASH_STORE_BUSY_TIMEOUT,
	SERVED_TTL_MS,
	ANCHOR_STATE_TTL_MS,
	UNDO_STACK_DEPTH,
} from "../../infra/constants.js";
import {
	registerAnchorPersistence,
	type PersistedAnchorState,
} from "../../hashline/session-anchors.js";
// ---- validators (owned here; the store's corruption handling uses them) ----

/** The legacy JSON snapshot shape (pre-sqlite stores). */
export interface LegacySnapshot {
	content: string;
	hashes: string[];
}

export function isValidHashList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const hash of value) {
		if (typeof hash !== "string" || !hashRe().test(hash)) return false;
	}
	return true;
}

export function isValidSnapshot(value: unknown): value is LegacySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.content !== "string") return false;
	return isValidHashList(v.hashes);
}

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
}

// ---- the domain interface --------------------------------------------------

type SqlParams = (string | number)[];

interface Prepared {
	get: (...params: SqlParams) => Record<string, unknown> | undefined;
	allPaths: (...params: SqlParams) => Record<string, unknown>[];
	allHashes: (...params: SqlParams) => Record<string, unknown>[];
	deleteOne: (...params: SqlParams) => void;
	upsert: (...params: SqlParams) => void;
	undoPush: (...params: SqlParams) => void;
	undoPop: (...params: SqlParams) => void;
	undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	undoDepth: (...params: SqlParams) => number;
	undoDelete: (...params: SqlParams) => void;
	servedGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	servedUpsert: (...params: SqlParams) => void;
	servedReportedUpsert: (...params: SqlParams) => void;
	servedReportedClear: (...params: SqlParams) => void;
	servedDelete: (...params: SqlParams) => void;
	servedDeletePath: (...params: SqlParams) => void;
	servedWipe: (...params: SqlParams) => void;
	servedPruneOlderThan: (...params: SqlParams) => void;
	anchorGet: (...params: SqlParams) => Record<string, unknown> | undefined;
	anchorProbe: (...params: SqlParams) => Record<string, unknown> | undefined;
	anchorUpsert: (...params: SqlParams) => void;
	anchorDelete: (...params: SqlParams) => void;
	anchorPruneOlderThan: (...params: SqlParams) => void;
}

/**
 * The domain face of the hash store. Each row family gets a narrow API;
 * corruption healing (parse → validate → delete) happens inside the getters.
 */
export interface HashStore {
	readonly engine: "node:sqlite";

	// ---- hash snapshots (stable anchors keyed by path+checksum+line count) ----
	/** The stored hashes for a path+content, or undefined on a miss; a corrupt row is deleted (when deleteCorrupt) and treated as a miss. */
	getSnapshot(
		path: string,
		content: string,
		deleteCorrupt?: boolean,
	): string[] | undefined;
	upsertSnapshot(
		path: string,
		checksum: string,
		lineCount: number,
		hashes: string[],
	): void;
	/** Every path referenced by any row family (snapshots ∪ undo ∪ served). */
	allKnownPaths(): { path: string }[];
	/** Every snapshot's path and raw hashes JSON (for path-by-hash scans). */
	allSnapshotHashes(): { path: string; hashes: string }[];
	deleteSnapshot(path: string): void;
	/** Paths whose stored snapshot hashes contain every given anchor. */
	findSnapshotPaths(hashes: string[]): string[];

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

	// ---- served rows (what the model has seen, per session+path) ------------
	/** The served anchors set for a session+path, healing a corrupt row; empty when nothing was served. */
	getServed(sessionKey: string, path: string): Set<string>;
	/** The reported-drift hash set for a session+path (lenient parse, never deletes). */
	getServedReported(sessionKey: string, path: string): Set<string>;
	/** Persist the hashes JSON column for a session+path. */
	upsertServed(sessionKey: string, path: string, hashesJson: string): void;
	/** Persist the reported-drift JSON column for a session+path (inserting a fresh empty hashes row). */
	upsertServedReported(sessionKey: string, path: string, reportedJson: string): void;
	clearServedReported(sessionKey: string, path: string): void;
	deleteServed(sessionKey: string, path: string): void;
	deleteServedByPath(path: string): void;
	wipeServed(sessionKey: string): void;
	pruneServedOlderThan(ts: number): void;

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
	{ path: string; db: DatabaseSync; stmts: Prepared; store: HashStore }
>();
const openings = new Map<string, Promise<HashStore>>();
let exitHandlerRegistered = false;

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
 */
function withTransaction(db: DatabaseSync, fn: () => void): void {
	withBusyRetry(() => {
		db.exec("BEGIN IMMEDIATE");
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
		}
	});
}

function buildStore(db: DatabaseSync): { db: DatabaseSync; stmts: Prepared } {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec(
		"CREATE TABLE IF NOT EXISTS snapshots (" +
			"path TEXT PRIMARY KEY, " +
			"checksum TEXT NOT NULL, " +
			"line_count INTEGER NOT NULL, " +
			"hashes TEXT NOT NULL, " +
			"updated_at INTEGER NOT NULL" +
			")",
	);
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
	const versionRow = db
		.prepare("SELECT value FROM meta WHERE key = 'version'")
		.get() as { value?: string } | undefined;
	const versionChanged =
		versionRow !== undefined &&
		versionRow.value !== String(HASH_STORE_VERSION);
	if (versionChanged) {
		db.exec("DELETE FROM snapshots");
		db.exec("DELETE FROM undo");
		db.exec("DELETE FROM anchor_state");
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
	const getStmt = db.prepare(
		"SELECT hashes FROM snapshots WHERE path = ? AND checksum = ? AND line_count = ?",
	);
	const allStmt = db.prepare(
		"SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served UNION SELECT path FROM anchor_state",
	);
	const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots");
	const delStmt = db.prepare("DELETE FROM snapshots WHERE path = ?");
	const upsertStmt = db.prepare(
		"INSERT INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at",
	);
	// The newest entry is the one with the HIGHEST depth. `depth` is an append
	// counter, never renumbered: renumbering on push/pop collided with the
	// (path, depth) primary key mid-statement (`UNIQUE constraint failed`),
	// because SQLite checks the constraint row by row.
	const undoPushStmt = db.prepare(
		"INSERT INTO undo (path, depth, content, bom, ending, hashes, result_content, updated_at) " +
			"VALUES (?, COALESCE((SELECT MAX(depth) FROM undo WHERE path = ?), -1) + 1, ?, ?, ?, ?, ?, ?)",
	);
	const undoMaxStmt = db.prepare("SELECT MAX(depth) AS max FROM undo WHERE path = ?");
	const undoPruneStmt = db.prepare("DELETE FROM undo WHERE path = ? AND depth < ?");
	const undoGetStmt = db.prepare(
		"SELECT content, bom, ending, hashes, result_content FROM undo WHERE path = ? ORDER BY depth DESC LIMIT 1",
	);
	const undoPopStmt = db.prepare("DELETE FROM undo WHERE path = ? AND depth = ?");
	const undoDepthStmt = db.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?");
	const undoDelStmt = db.prepare("DELETE FROM undo WHERE path = ?");
	/** The highest depth stored for a path (the newest undo), or undefined. */
	const topDepth = (path: string | number): number | undefined => {
		const row = undoMaxStmt.get(path) as { max?: number | null } | undefined;
		return row?.max === null || row?.max === undefined ? undefined : Number(row.max);
	};
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
	const servedPruneOlderThanStmt = db.prepare(
		"DELETE FROM served WHERE updated_at < ?",
	);
	const anchorGetStmt = db.prepare(
		"SELECT checksum, anchors, line_keys FROM anchor_state WHERE path = ?",
	);
	const anchorProbeStmt = db.prepare("SELECT checksum FROM anchor_state WHERE path = ?");
	const anchorUpsertStmt = db.prepare(
		"INSERT INTO anchor_state (path, checksum, line_count, anchors, line_keys, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, anchors = excluded.anchors, line_keys = excluded.line_keys, updated_at = excluded.updated_at",
	);
	const anchorDeleteStmt = db.prepare("DELETE FROM anchor_state WHERE path = ?");
	const anchorPruneOlderThanStmt = db.prepare("DELETE FROM anchor_state WHERE updated_at < ?");
	const stmts: Prepared = {
		get: (...params) =>
			getStmt.get(...params) as Record<string, unknown> | undefined,
		allPaths: (...params) =>
			allStmt.all(...params) as Record<string, unknown>[],
		allHashes: (...params) =>
			allHashesStmt.all(...params) as Record<string, unknown>[],
		deleteOne: (...params) => {
			withBusyRetry(() => {
				delStmt.run(...params);
			});
		},
		upsert: (...params) => {
			withBusyRetry(() => {
				upsertStmt.run(...params);
			});
		},
		undoPush: (...params) => {
			// `params` = [path, content, bom, ending, hashesJson, resultContent, updatedAt];
			// the path appears TWICE in the INSERT — once for the row, once for the
			// MAX(depth) that numbers it. Insert and prune are ONE move: a crash between
			// them would leave the stack one deeper than advertised.
			withTransaction(db, () => {
				undoPushStmt.run(params[0], ...params);
				const top = topDepth(params[0]) ?? 0;
				undoPruneStmt.run(params[0], top - UNDO_STACK_DEPTH + 1);
			});
		},
		undoPop: (...params) => {
			// Read the top depth FIRST, then delete exactly that row: a
			// `depth = (SELECT MAX(depth) …)` in the DELETE re-evaluates as rows go
			// and would walk the whole stack out.
			withTransaction(db, () => {
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
		servedPruneOlderThan: (...params) => {
			withBusyRetry(() => {
				servedPruneOlderThanStmt.run(...params);
			});
		},
		anchorGet: (...params) =>
			anchorGetStmt.get(...params) as Record<string, unknown> | undefined,
		anchorProbe: (...params) =>
			anchorProbeStmt.get(...params) as Record<string, unknown> | undefined,
		anchorUpsert: (...params) => {
			withBusyRetry(() => {
				anchorUpsertStmt.run(...params);
			});
		},
		anchorDelete: (...params) => {
			withBusyRetry(() => {
				anchorDeleteStmt.run(...params);
			});
		},
		anchorPruneOlderThan: (...params) => {
			withBusyRetry(() => {
				anchorPruneOlderThanStmt.run(...params);
			});
		},
	};
	return { db, stmts };
}

/** Wire the domain methods over the prepared statements. */
function makeDomainStore(stmts: Prepared): HashStore {
	return {
		engine: "node:sqlite",

		getSnapshot(path, content, deleteCorrupt = true) {
			const checksum = contentChecksum(content);
			const lineCount = splitLines(content).length;
			const row = stmts.get(path, checksum, lineCount);
			if (!row) return undefined;
			try {
				const parsed = JSON.parse(row.hashes as string);
				if (isValidHashList(parsed)) return parsed;
				if (deleteCorrupt) stmts.deleteOne(path);
				return undefined;
			} catch {
				if (deleteCorrupt) stmts.deleteOne(path);
				return undefined;
			}
		},
		upsertSnapshot(path, checksum, lineCount, hashes) {
			stmts.upsert(
				path,
				checksum,
				lineCount,
				JSON.stringify(hashes),
				Date.now(),
			);
		},
		allKnownPaths() {
			return stmts.allPaths() as { path: string }[];
		},
		allSnapshotHashes() {
			return stmts.allHashes() as { path: string; hashes: string }[];
		},
		deleteSnapshot(path) {
			stmts.deleteOne(path);
		},
		findSnapshotPaths(hashes) {
			const rows = stmts.allHashes() as { path: string; hashes: string }[];
			const matches: string[] = [];
			for (const row of rows) {
				try {
					const parsed = JSON.parse(row.hashes) as unknown;
					if (!isValidHashList(parsed)) continue;
					if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
				} catch {
					// unparseable row → skip it
				}
			}
			return matches;
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
				Date.now(),
			);
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

		getServed(sessionKey, path) {
			const row = stmts.servedGet(sessionKey, path);
			if (!row) return new Set();
			try {
				const parsed = JSON.parse(row.hashes as string) as unknown;
				// New format: string[] (array of anchor strings)
				if (Array.isArray(parsed) && parsed.every((e) => typeof e === "string" && hashRe().test(e))) {
					return new Set(parsed as string[]);
				}
				// Legacy v2 envelope: { v: 2, a: anchors, k: contentKeys }
				if (
					parsed !== null && typeof parsed === "object" &&
					(parsed as { v?: unknown }).v === 2 && Array.isArray((parsed as { a?: unknown }).a)
				) {
					const anchors = (parsed as { a: unknown[] }).a;
					if (isValidServedList(anchors)) return new Set(anchors.filter((a): a is string => a !== null));
				}
				// Legacy format: (string | null)[]
				if (isValidServedList(parsed)) return new Set(parsed.filter((a): a is string => a !== null));
				stmts.servedDelete(sessionKey, path);
				return new Set();
			} catch {
				stmts.servedDelete(sessionKey, path);
				return new Set();
			}
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
		upsertServed(sessionKey, path, hashesJson) {
			stmts.servedUpsert(sessionKey, path, hashesJson, Date.now());
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

		async pruneMissing() {
			const rows = stmts.allPaths() as { path: string }[];
			const missing = await statMissing(rows);
			if (missing.length === 0) return;
			withStore(() => {
				for (const path of missing) {
					stmts.deleteOne(path);
					stmts.undoDelete(path);
					stmts.servedDeletePath(path);
					stmts.anchorDelete(path);
				}
			});
		},
	};
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

function shutdownDb(db: DatabaseSync): void {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// best-effort checkpoint before close
	}
	db.close();
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
	if (!isHealthy(opened.db)) {
		shutdownDb(opened.db);
		await quarantineStore(storePath);
		existed = false;
		opened = openDbWithBusyRetry(storePath);
	}
	const { db, stmts } = opened;

	if (!existed) {
		await migrateLegacy(db, storePath);
	}
	withBusyRetry(() => {
		stmts.servedPruneOlderThan(Date.now() - SERVED_TTL_MS);
	});
	withBusyRetry(() => {
		stmts.anchorPruneOlderThan(Date.now() - ANCHOR_STATE_TTL_MS);
	});
	const store = makeDomainStore(stmts);
	stores.set(storePath, { path: storePath, db, stmts, store });

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
	| { db: DatabaseSync; stmts: Prepared; store: HashStore }
	| undefined {
	const entry = stores.get(storePathFor());
	return entry?.db.isOpen ? entry : undefined;
}

/** Close every open store (process exit, HMR, tests). */
export function shutdownHashStore(): void {
	for (const [, entry] of stores) {
		shutdownDb(entry.db);
	}
	stores.clear();
	openings.clear();
}

/**
 * Run `fn` inside one BEGIN IMMEDIATE transaction on the active workspace's
 * store. Without an open store for this context the call runs bare (the
 * caller has already loaded the store in every in-process path).
 */
export function withStore(fn: () => void): void {
	const store = currentStore();
	if (store) {
		withBusyRetry(() => {
			store.db.exec("BEGIN IMMEDIATE");
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
			}
		});
	} else {
		fn();
	}
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

	const raw = parsed.snapshots;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

	const rows: [string, string, number, string, number][] = [];
	for (const [key, value] of Object.entries(raw)) {
		if (!isValidSnapshot(value)) continue;
		if (new Set(value.hashes).size !== value.hashes.length) {
			console.warn(
				`Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
			);
			continue;
		}
		rows.push([
			key,
			contentChecksum(value.content),
			splitLines(value.content).length,
			JSON.stringify(value.hashes),
			Date.now(),
		]);
	}
	if (rows.length > 0) {
		db.exec("BEGIN IMMEDIATE");
		try {
			const stmt = db.prepare(
				"INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			for (const row of rows) stmt.run(...row);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}

	try {
		await rename(legacyPath, `${legacyPath}.bak`);
	} catch (error) {
		console.error("Failed to rename legacy hash store after migration:", error);
	}
}

// ---- async convenience helpers (load the active store, then delegate) ------

/** Find files whose stored snapshot hashes contain every given anchor. */
export async function findSnapshotPathsByHashes(
	hashes: string[],
): Promise<string[]> {
	const store = await loadHashStore();
	return store.findSnapshotPaths(hashes);
}

/** Persist a hash snapshot for one path (async over the active store). */
export async function upsertSnapshotFor(
	path: string,
	checksum: string,
	lineCount: number,
	hashes: string[],
): Promise<void> {
	const store = await loadHashStore();
	store.upsertSnapshot(path, checksum, lineCount, hashes);
}

// ---- anchor-state persistence adapter (issue #136) -------------------------
//
// session-anchors (hashline layer) owns the anchor lifecycle; this module owns
// the sqlite rows. The adapter keeps the layering one-way: hashline defines
// the port, the domain wires it. Every call resolves the ACTIVE workspace's
// already-open store — never opening one — so store-less contexts (pure unit
// tests, the window before a tool call opens the db) simply run memory-only
// in session-anchors, and its write-behind flush persists the state on the
// first call after a store exists.
registerAnchorPersistence({
	probe(path) {
		const entry = currentStore();
		if (!entry) return undefined;
		const row = entry.stmts.anchorProbe(path);
		return row ? (row.checksum as string) : undefined;
	},
	get(path): PersistedAnchorState | undefined {
		const entry = currentStore();
		if (!entry) return undefined;
		const row = entry.stmts.anchorGet(path);
		if (!row) return undefined;
		try {
			const anchors = JSON.parse(row.anchors as string) as unknown;
			const lineKeys = JSON.parse(row.line_keys as string) as unknown;
			if (!isValidHashList(anchors) || !isValidLineKeyList(lineKeys)) {
				// Same corruption contract as every other row family: unparseable or
				// wrong-typed rows heal by delete. A length DRIFT between anchors and
				// line_keys is NOT corrupt — it is the partial-write shape
				// anchorsFor heals positionally (keep survivors, allocate gaps).
				entry.stmts.anchorDelete(path);
				return undefined;
			}
			return { checksum: row.checksum as string, anchors, lineKeys };
		} catch {
			entry.stmts.anchorDelete(path);
			return undefined;
		}
	},
	put(path, state) {
		const entry = currentStore();
		if (!entry) return; // no store yet: memory-only; flushed on the next wired call
		entry.stmts.anchorUpsert(
			path,
			state.checksum,
			state.anchors.length,
			JSON.stringify(state.anchors),
			JSON.stringify(state.lineKeys),
			Date.now(),
		);
	},
});

