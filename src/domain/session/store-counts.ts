/**
 * The store's maintained counts.
 *
 * Two numbers the store needs on every budget decision: how many `anchor_lines`
 * rows it holds (#305) and how many distinct paths it holds across `undo`,
 * `served` and `anchor_meta` (#311). Both are **maintained** values — SQLite
 * triggers move them in the same transaction as the row write — so reading one
 * costs a meta lookup instead of a scan, whatever the library size (spec #184's
 * "与库体量无关").
 *
 * This module owns the whole mechanism: the meta keys, the trigger DDL, the
 * reader and the one-statement repair. The store owns the tables the counts
 * describe.
 *
 * @module dsh-hashline-edittool/store-counts
 */
import { DatabaseSync } from "node:sqlite";

/**
 * The meta key the maintained `anchor_lines` row count lives under.
 *
 * This is the canonical explanation of the row count; the places that implement
 * it (the triggers, the repair, the read) point back here.
 */
export const ANCHOR_LINES_ROWS_KEY = "anchor_lines_rows";

/**
 * The maintained PATH count (#311): how many distinct paths the store holds
 * across `undo`, `served` and `anchor_meta` — the same number the UNION
 * counted, kept up to date by the triggers instead of computed on every read.
 */
export const ANCHOR_PATHS_COUNT_KEY = "anchor_paths_count";

/**
 * The row families that hold a path. A path held by several of them is still
 * ONE path, which is what the count says.
 */
export const ANCHOR_PATH_TABLES = ["undo", "served", "anchor_meta"] as const;

/** One of the row families that hold a path. */
export type AnchorPathTable = (typeof ANCHOR_PATH_TABLES)[number];

/**
 * The SQL that lists every distinct path — the union over the families.
 *
 * ONE source: the path-count statement, the repair statement and the "all
 * paths" query all read from it, so a new family is added in one place.
 */
export const PATH_UNION_SQL = ANCHOR_PATH_TABLES.map(
	(table) => `SELECT path FROM ${table}`,
).join(" UNION ");

/**
 * Whether a stored count is a plain decimal — the only shape the triggers know
 * how to move and the only one a reader trusts.
 *
 * A value that is not (empty, left over, tampered with) is left alone by the
 * triggers rather than being arithmetically mangled into a wrong number; the
 * open path re-establishes it from the table.
 */
export function isDecimalCount(value: string | undefined): value is string {
	return value !== undefined && /^[0-9]+$/.test(value);
}

/**
 * The clause that moves a maintained count by one.
 *
 * Guarded to decimal values: a count that is not a number is left alone rather
 * than mangled into a wrong number, and the open path re-establishes it.
 */
function countMoveClause(key: string, delta: "+ 1" | "- 1"): string {
	return (
		`UPDATE meta SET value = CAST(CAST(value AS INTEGER) ${delta} AS TEXT) ` +
		`WHERE key = '${key}' AND value <> '' AND value NOT GLOB '*[^0-9]*'`
	);
}

/**
 * The DDL for one `anchor_lines` row-count trigger.
 *
 * INVARIANT: an `anchor_lines` row is written with `ON CONFLICT DO UPDATE`,
 * never with `INSERT OR REPLACE`. A REPLACE suppresses the DELETE trigger, so
 * replacing an existing row would leave the count one too high. The one place
 * that REPLACEs (the legacy migration) drops the maintained counts first, so
 * the open path re-establishes them from the tables.
 */
export function anchorLinesRowCountTriggerSql(event: "insert" | "delete"): string {
	const delta = event === "insert" ? "+ 1" : "- 1";
	return (
		`CREATE TRIGGER IF NOT EXISTS anchor_lines_rows_${event} ` +
		`AFTER ${event.toUpperCase()} ON anchor_lines ` +
		`BEGIN ${countMoveClause(ANCHOR_LINES_ROWS_KEY, delta)}; END`
	);
}

/**
 * The DDL for one path-count trigger.
 *
 * A row appeared in (or vanished from) `table`, and the count moves by one
 * only when the PATH itself appeared (or vanished) — a path held by several row
 * families counts once, and the count must not depend on the order in which
 * the families are touched.
 *
 * The membership tests are written for the moment the trigger runs: on INSERT
 * the new row is already visible (so the table's own test has to exclude it),
 * on DELETE the row is already gone.
 *
 * INVARIANT: a row of these three tables is written with `ON CONFLICT DO
 * UPDATE`, never with `INSERT OR REPLACE` — a REPLACE suppresses the DELETE
 * trigger and would drift the count.
 */
export function anchorPathCountTriggerSql(
	table: AnchorPathTable,
	event: "insert" | "delete",
): string {
	const ref = event === "insert" ? "NEW" : "OLD";
	const selfTest =
		event === "insert"
			? `NOT EXISTS (SELECT 1 FROM ${table} WHERE path = ${ref}.path AND rowid <> ${ref}.rowid)`
			: `NOT EXISTS (SELECT 1 FROM ${table} WHERE path = ${ref}.path)`;
	const otherTests = ANCHOR_PATH_TABLES.filter((other) => other !== table).map(
		(other) => `NOT EXISTS (SELECT 1 FROM ${other} WHERE path = ${ref}.path)`,
	);
	const delta = event === "insert" ? "+ 1" : "- 1";
	return (
		`CREATE TRIGGER IF NOT EXISTS ${table}_paths_count_${event} ` +
		`AFTER ${event.toUpperCase()} ON ${table} ` +
		"BEGIN " +
		`${countMoveClause(ANCHOR_PATHS_COUNT_KEY, delta)} ` +
		`AND ${[selfTest, ...otherTests].join(" AND ")}; ` +
		"END"
	);
}

/**
 * A count the store keeps up to date instead of recomputing.
 */
export interface MaintainedCount {
	/**
	 * The count.
	 *
	 * The maintained value when it can be vouched for; otherwise the count is
	 * taken from the tables ONCE and written back, so the triggers take over
	 * from that point. A read never trusts a value it cannot vouch for, and
	 * never keeps scanning.
	 */
	read(): number;
	/**
	 * Whether the maintained value is present and decimal — the shape the
	 * triggers can move and the reader trusts.
	 */
	hasTrustedValue(): boolean;
	/**
	 * Re-establish the maintained value from the tables.
	 *
	 * ONE statement, so the count and the write cannot disagree: SQLite takes
	 * the write lock for the statement, so a writer that commits while this runs
	 * either committed BEFORE the count (and is counted) or waits for the lock
	 * (and its trigger moves the count afterwards).
	 */
	repair(): void;
}

/**
 * Create a maintained count over `countSql` — a SELECT that returns the count
 * under the column name `n`.
 */
export function createMaintainedCount(
	db: DatabaseSync,
	key: string,
	countSql: string,
): MaintainedCount {
	const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
	const metaSet = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?) " +
			"ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	);
	const count = db.prepare(countSql);
	const repairStmt = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, (SELECT CAST(n AS TEXT) FROM (" +
			countSql +
			"))) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	);
	const maintainedValue = (): string | undefined =>
		(metaGet.get(key) as { value?: string } | undefined)?.value;
	return {
		read: (): number => {
			const raw = maintainedValue();
			if (isDecimalCount(raw)) return Number(raw);
			const counted = Number((count.get() as { n?: number } | undefined)?.n ?? 0);
			try {
				metaSet.run(key, String(counted));
			} catch {
				// Best-effort: a store that cannot be written to still gets the right
				// number for this call; the next open re-establishes the value.
			}
			return counted;
		},
		hasTrustedValue: (): boolean => isDecimalCount(maintainedValue()),
		repair: (): void => {
			repairStmt.run(key);
		},
	};
}
