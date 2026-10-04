import { DatabaseSync } from "node:sqlite";
const dbs = process.argv.slice(2);
for (const db of dbs) {
  console.log("=".repeat(72));
  console.log("DB:", db);
  const d = new DatabaseSync(db, { readOnly: false });
  console.log("-- served --");
  console.log(d.prepare("SELECT COUNT(*) n, SUM(LENGTH(hashes)) hl, SUM(COALESCE(LENGTH(reported),0)) rl, MIN(LENGTH(hashes)) minh, MAX(LENGTH(hashes)) maxh, AVG(LENGTH(hashes)) avgh FROM served").get());
  console.log(d.prepare("SELECT session_id, path, LENGTH(hashes) hlen, substr(hashes,1,24) hpref, LENGTH(reported) rlen, updated_at, typeof(hashes) th FROM served ORDER BY LENGTH(hashes) DESC LIMIT 5").all());
  console.log("-- distinct sessions --");
  console.log(d.prepare("SELECT session_id, COUNT(*) n, SUM(LENGTH(hashes)) bytes FROM served GROUP BY session_id ORDER BY n DESC LIMIT 10").all());
  console.log("-- anchor_lines --");
  console.log(d.prepare("SELECT COUNT(*) n, COUNT(DISTINCT path) paths, MIN(LENGTH(anchor)) mina, MAX(LENGTH(anchor)) maxa, AVG(LENGTH(anchor)) avga FROM anchor_lines").get());
  console.log(d.prepare("SELECT LENGTH(anchor) len, COUNT(*) n FROM anchor_lines GROUP BY len ORDER BY len").all());
  console.log("-- anchor_meta --");
  console.log(d.prepare("SELECT COUNT(*) n, SUM(line_count) totlines, AVG(line_count) avgl, MAX(line_count) maxl FROM anchor_meta").get());
  console.log("-- meta --");
  console.log(d.prepare("SELECT * FROM meta").all());
  console.log("-- time range --");
  console.log("anchor_lines:", d.prepare("SELECT MIN(updated_at) mn, MAX(updated_at) mx FROM anchor_lines").get());
  console.log("served:", d.prepare("SELECT MIN(updated_at) mn, MAX(updated_at) mx FROM served").get());
  console.log("undo:", d.prepare("SELECT MIN(updated_at) mn, MAX(updated_at) mx FROM undo").get());
  d.close();
}
