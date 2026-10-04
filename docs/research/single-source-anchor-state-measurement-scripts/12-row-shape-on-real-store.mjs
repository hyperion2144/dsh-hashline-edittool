import { DatabaseSync } from "node:sqlite";
import { copyFileSync, rmSync, existsSync } from "node:fs";
import { decodeServed } from "./decode.mjs";

const SRC = process.argv[2], TAG = process.argv[3];
const TMP = `/tmp/hashm/real-${TAG}.sqlite`;
for (const f of [TMP, TMP + "-wal", TMP + "-shm"]) if (existsSync(f)) rmSync(f);
copyFileSync(SRC, TMP);

function bytes(db) { return Number(db.prepare("SELECT (page_count - freelist_count) * page_size AS b FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()").get().b); }
function pages(db) { return Number(db.prepare("PRAGMA page_count").get().page_count); }

const db = new DatabaseSync(TMP);
db.exec("PRAGMA journal_mode = DELETE");
db.exec("VACUUM");
const base = bytes(db), basePages = pages(db);
console.log(`\n=== ${TAG} ===`);
console.log(`baseline after VACUUM: ${base} B (${basePages} pages)`);

const served = db.prepare("SELECT session_id, path, hashes FROM served").all();
const q = db.prepare("SELECT LENGTH(hashes) l FROM served WHERE session_id=? AND path=?");
let payload = 0, slots = 0, dropped = 0;
const rows = [];
for (const s of served) {
  const l = Number((q.get(s.session_id, s.path) ?? {}).l ?? 0);
  payload += l;
  const dec = decodeServed(s.hashes);
  if (!dec?.anchors) { dropped++; continue; }
  slots += dec.anchors.length;
  for (const a of dec.anchors) rows.push([s.session_id, s.path, a, Date.now()]);
}
console.log(`served rows=${served.length} (unreadable=${dropped}); decoded anchor slots=${slots}; current payload bytes=${payload}`);
console.log(`current shape: ${(payload / Math.max(1, slots)).toFixed(2)} B per anchor-slot`);
const pathLens = rows.map((r) => r[1].length).sort((a, b) => a - b);
console.log(`path length: min=${pathLens[0]} median=${pathLens[pathLens.length >> 1]} max=${pathLens[pathLens.length - 1]} mean=${(pathLens.reduce((a, b) => a + b, 0) / pathLens.length).toFixed(1)}`);

db.exec("CREATE TABLE served_rowshape (session_id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path, anchor))");
const ins = db.prepare("INSERT INTO served_rowshape (session_id, path, anchor, updated_at) VALUES (?, ?, ?, ?)");
db.exec("BEGIN IMMEDIATE");
for (const r of rows) ins.run(...r);
db.exec("COMMIT");
db.exec("VACUUM");
const grown = bytes(db), grownPages = pages(db);
console.log(`after new-shape table + VACUUM: ${grown} B (${grownPages} pages)`);
console.log(`DELTA: ${grown - base} B for ${rows.length} rows => ${((grown - base) / rows.length).toFixed(2)} B/row`);
db.close();
