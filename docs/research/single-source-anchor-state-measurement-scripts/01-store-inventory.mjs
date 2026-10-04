import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";

const dbs = process.argv.slice(2);
for (const db of dbs) {
  console.log("=".repeat(72));
  console.log("DB:", db);
  try { console.log("  file bytes (main only):", statSync(db).size); } catch { console.log("  stat failed"); }
  const d = new DatabaseSync(db, { readOnly: false });
  const names = d.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name").all();
  console.log("  page_size:", d.prepare("PRAGMA page_size").get().page_size,
              " page_count:", d.prepare("PRAGMA page_count").get().page_count,
              " freelist:", d.prepare("PRAGMA freelist_count").get().freelist_count);
  const live = d.prepare("SELECT (page_count - freelist_count) * page_size AS bytes FROM pragma_page_count(), pragma_page_size(), pragma_freelist_count()").get();
  console.log("  storeBytes metric (pc-fl)*ps =", live.bytes);
  const tbls = names.filter(n=>n.type==="table").map(n=>n.name);
  console.log("  tables:", tbls.join(", "));
  console.log("  indexes:", names.filter(n=>n.type==="index").map(n=>n.name).join(", "));
  for (const t of ["meta","snapshots","undo","served","anchor_meta","anchor_lines","anchor_state"]) {
    if (!tbls.includes(t)) continue;
    const cols = d.prepare(`PRAGMA table_info(${t})`).all().map(c=>`${c.name}:${c.type}`);
    // per-table byte accounting via dbstat if available, else sum of LENGTH over all cols
    let dbstat = null;
    try {
      dbstat = d.prepare("SELECT SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat WHERE name = ?").get(t);
    } catch (e) { dbstat = { err: String(e.message).slice(0,80) }; }
    let approx = null;
    try {
      const collist = d.prepare(`PRAGMA table_info(${t})`).all().map(c=>`LENGTH(CAST(${c.name} AS BLOB))`).join(" + ");
      approx = d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${collist}),0) b FROM ${t}`).get();
    } catch (e) { approx = { err: String(e.message).slice(0,80) }; }
    console.log(`  [${t}] cols(${cols.length}): ${cols.join(", ")}`);
    console.log(`     rows=${approx.n} sumLenBytes=${approx.b}  dbstat=${JSON.stringify(dbstat)}`);
  }
  d.close();
}
