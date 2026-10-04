// Per-row byte model at realistic path lengths, physical sqlite measurement.
import { DatabaseSync } from "node:sqlite";
import { rmSync, existsSync } from "node:fs";
const P = "/tmp/hashm/scale.sqlite";
for (const f of [P, P+"-wal", P+"-shm"]) if (existsSync(f)) rmSync(f);
const db = new DatabaseSync(P);
const B = () => Number(db.prepare("SELECT (page_count - freelist_count) * page_size AS b FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()").get().b);
const A = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const anchors = []; const seen = new Set();
for (let i = 0; anchors.length < 20000; i++) { let v = i, s = ""; do { s = A[v%62]+s; v = Math.floor(v/62);} while (v>0); if (/^[0-9]+$/.test(s)||seen.has(s)) continue; seen.add(s); anchors.push(s); }
const results = {};
for (const plen of [30, 66, 121]) {
  const path = "/Users/mutou/projects/dsh-tool-hashline/" + "d".repeat(Math.max(0, plen - 44)) + "/hash-store.sqlite";
  const realLen = path.length;
  db.exec("DROP TABLE IF EXISTS heap; DROP TABLE IF EXISTS keyed");
  db.exec("VACUUM");
  const b0 = B();
  db.exec("CREATE TABLE heap (session_id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const b1 = B();
  const ins = db.prepare("INSERT INTO heap VALUES (?,?,?,?)");
  db.exec("BEGIN IMMEDIATE"); for (const a of anchors) ins.run("session-6f5206bd-a630-441f-a648-1c008d4c0168", path, a, 1791084753785); db.exec("COMMIT");
  const b2 = B();
  db.exec("CREATE TABLE keyed (session_id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path, anchor))");
  const ins2 = db.prepare("INSERT INTO keyed VALUES (?,?,?,?)");
  db.exec("BEGIN IMMEDIATE"); for (const a of anchors) ins2.run("session-6f5206bd-a630-441f-a648-1c008d4c0168", path, a, 1791084753785); db.exec("COMMIT");
  const b3 = B();
  db.exec("VACUUM");
  const b4 = B();
  db.exec("DROP TABLE heap; DROP TABLE keyed;");
  results[realLen] = { heapOnly: (b2-b1)/anchors.length, keyed: (b3-b2)/anchors.length, heapUnvacuumed: b2-b0, keyedUnvacuumed: b3-b0 };
  console.log(`path=${realLen}B  heap-only ${((b2-b1)/anchors.length).toFixed(2)} B/row (+${b2-b1} B)   with PK+autoindex ${((b3-b2)/anchors.length).toFixed(2)} B/row (+${b3-b2} B)`);
}
console.log(JSON.stringify(results));
db.close();
