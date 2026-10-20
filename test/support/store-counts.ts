/**
 * Shared helpers for the store's MAINTAINED counts (issue #305, #311).
 *
 * Both count suites need the same three things: a second connection to the
 * store's database (so a write really lands where the store's triggers can see
 * it), a way to record every statement that runs, and access to the maintained
 * value in `meta`. They live here so the two suites cannot drift apart.
 *
 * @module dsh-hashline-edittool/test-support/store-counts
 */
import { DatabaseSync } from "node:sqlite";
import { storeDbPath } from "./fixtures.js";

/**
 * Run `fn` over the store's database through a SECOND connection.
 *
 * The store keeps its own connection open; a second one writes to the same
 * file, so a row seeded here is really in the database and the store's
 * triggers really see it.
 *
 * @param home - the temporary home the store was opened in.
 * @param fn - what to do with the second connection.
 */
export function withDb(home: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(storeDbPath(home));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/**
 * Record the SQL every statement EXECUTES.
 *
 * The prototype is taken from a live statement rather than from the exported
 * class, so this works the same on Node's `node:sqlite` and on Bun's.
 *
 * @returns the recorded SQL and a `restore` that puts the prototype back.
 */
export function recordStatements(): { sql: string[]; restore(): void } {
  const probeDb = new DatabaseSync(":memory:");
  const probe = probeDb.prepare("SELECT 1");
  const proto = Object.getPrototypeOf(probe) as Record<string, unknown>;
  const seen: string[] = [];
  const originals: Record<string, unknown> = {};
  for (const method of ["get", "run", "all"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    originals[method] = original;
    proto[method] = function(this: { sourceSQL?: string }, ...args: unknown[]): unknown {
      seen.push(String(this.sourceSQL ?? ""));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  probeDb.close();
  return {
    sql: seen,
    restore: () => {
      for (const [method, original] of Object.entries(originals)) proto[method] = original;
    },
  };
}

/**
 * The maintained value for `key`, as it is stored.
 *
 * @param home - the temporary home the store was opened in.
 * @param key - the meta key the count lives under.
 */
export function maintainedValue(home: string, key: string): string | undefined {
  let value: string | undefined;
  withDb(home, (db) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    value = row?.value;
  });
  return value;
}

/**
 * Overwrite the maintained value for `key` — a well-formed but WRONG number.
 *
 * A store that still counted its tables would report the real number; one
 * that reads the maintained value reports this one, which is the observable
 * proof that no scan happened.
 *
 * @param home - the temporary home the store was opened in.
 * @param key - the meta key the count lives under.
 * @param value - the value to store.
 */
export function setMaintained(home: string, key: string, value: string): void {
  withDb(home, (db) => {
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
  });
}

/**
 * Drop the maintained value for `key` — what a store written before the count
 * existed looks like.
 *
 * @param home - the temporary home the store was opened in.
 * @param key - the meta key the count lives under.
 */
export function clearMaintained(home: string, key: string): void {
  withDb(home, (db) => {
    db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  });
}
