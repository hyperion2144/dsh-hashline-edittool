import { DatabaseSync } from "node:sqlite";
import { statSync, existsSync } from "node:fs";
const rows = [];
for (const [tag, base] of [["dsh-tool-hashline","/Users/mutou/.dsh/plugins/dsh-hashline-edittool/--Users-mutou-projects-dsh-tool-hashline--"],["dsh-desktop-app","/Users/mutou/.dsh/plugins/dsh-hashline-edittool/--Users-mutou-projects-dsh-desktop-app--"]]) {
  const src = base + "/hash-store.sqlite";
  const wal = src + "-wal";
  const d = new DatabaseSync(src, { readOnly: true });
  const B = () => Number(d.prepare("SELECT (page_count - freelist_count) * page_size AS b FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()").get().b);
  const one = (sql) => { try { return d.prepare(sql).get(); } catch (e) { return { err: String(e.message).slice(0,60) }; } };
  const r = {
    tag,
    mainBytes: statSync(src).size,
    walBytes: existsSync(wal) ? statSync(wal).size : 0,
    storeMetricBytes: B(),
    pageSize: d.prepare("PRAGMA page_size").get().page_size,
    pageCount: d.prepare("PRAGMA page_count").get().page_count,
    freelist: d.prepare("PRAGMA freelist_count").get().freelist_count,
    anchor_lines: one("SELECT COUNT(*) rows, COUNT(DISTINCT path) paths, SUM(LENGTH(CAST(path AS BLOB))+LENGTH(anchor)+LENGTH(CAST(content_key AS BLOB))) contentBytes, MIN(LENGTH(anchor)) minA, MAX(LENGTH(anchor)) maxA FROM anchor_lines"),
    anchor_meta: one("SELECT COUNT(*) rows, SUM(line_count) servedLines, MIN(updated_at) first, MAX(updated_at) last FROM anchor_meta"),
    served: one("SELECT COUNT(*) rows, COUNT(DISTINCT session_id) sessions, COUNT(DISTINCT path) paths, SUM(LENGTH(CAST(hashes AS BLOB))) payloadBytes, SUM(LENGTH(hashes)) hashesLen, MIN(LENGTH(hashes)) minLen, MAX(LENGTH(hashes)) maxLen FROM served"),
    undo: one("SELECT COUNT(*) rows, COUNT(DISTINCT path) paths, SUM(LENGTH(content)+LENGTH(result_content)) textBytes FROM undo"),
    snapshots: one("SELECT COUNT(*) rows FROM snapshots"),
    dbstat: (() => { try { return d.prepare("SELECT name, SUM(pgsize) bytes, COUNT(*) pages FROM dbstat GROUP BY name ORDER BY bytes DESC").all(); } catch (e) { return [{ err: String(e.message).slice(0,60) }]; } })(),
    meta: d.prepare("SELECT key, value FROM meta").all(),
  };
  d.close();
  rows.push(r);
}
console.log(JSON.stringify(rows, null, 1));
