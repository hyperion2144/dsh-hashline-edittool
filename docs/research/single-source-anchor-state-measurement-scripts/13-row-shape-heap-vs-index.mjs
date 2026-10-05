import { DatabaseSync } from "node:sqlite";
import { copyFileSync, rmSync, existsSync } from "node:fs";
import { decodeServed } from "./decode.mjs";
const SRC = process.argv[2], TAG = process.argv[3];
const TMP = `/tmp/hashm/split-${TAG}.sqlite`;
for (const f of [TMP, TMP+"-wal", TMP+"-shm"]) if (existsSync(f)) rmSync(f);
copyFileSync(SRC, TMP);
const db = new DatabaseSync(TMP);
db.exec("PRAGMA journal_mode = DELETE"); db.exec("VACUUM");
const B = () => Number(db.prepare("SELECT (page_count - freelist_count) * page_size AS b FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()").get().b);
const rows = [];
for (const s of db.prepare("SELECT session_id, path, hashes FROM served").all()) {
  const dec = decodeServed(s.hashes); if (!dec?.anchors) continue;
  for (const a of dec.anchors) rows.push([s.session_id, s.path, a, 1791084753785]);
}
const b0 = B();
db.exec("CREATE TABLE served_rowshape (session_id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path, anchor))");
const b1 = B();
let pk = 0;
{ const info = db.prepare("PRAGMA index_list(served_rowshape)").all(); pk = info.length; }
const ins = db.prepare("INSERT INTO served_rowshape (session_id, path, anchor, updated_at) VALUES (?, ?, ?, ?)");
db.exec("BEGIN IMMEDIATE"); for (const r of rows) ins.run(...r); db.exec("COMMIT");
const b2 = B();
// rowid table footprint alone: drop the autoindex by rebuilding without a PK
db.exec("CREATE TABLE flat (session_id TEXT, path TEXT, anchor TEXT, updated_at INTEGER)");
const ins2 = db.prepare("INSERT INTO flat VALUES (?, ?, ?, ?)");
db.exec("BEGIN IMMEDIATE"); for (const r of rows) ins2.run(...r); db.exec("COMMIT");
const b3 = B();
console.log(`\n=== ${TAG} === rows=${rows.length}`);
console.log(`base ${b0}`);
console.log(`CREATE TABLE (with PK): ${b1-b0} B; index_list=${pk}`);
console.log(`INSERT ${rows.length} rows: ${b2-b1} B  => ${((b2-b1)/rows.length).toFixed(2)} B/row (PK + autoindex)`);
console.log(`flat heap table (no PK, same cols): ${b3-b2} B => ${((b3-b2)/rows.length).toFixed(2)} B/row (row payload only)`);
db.exec("VACUUM");
const b4 = B();
console.log(`after VACUUM: ${b4}`);
db.close();
