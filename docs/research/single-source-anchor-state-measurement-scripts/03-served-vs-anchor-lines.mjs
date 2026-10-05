import { DatabaseSync } from "node:sqlite";
for (const db of process.argv.slice(2)) {
  console.log("=".repeat(72)); console.log("DB:", db);
  const d = new DatabaseSync(db, { readOnly: false });
  console.log("-- anchor_meta --");
  console.log(d.prepare("SELECT COUNT(*) n, SUM(line_count) totlines, AVG(line_count) avgl, MAX(line_count) maxl FROM anchor_meta").get());
  console.log("-- updated_at range --");
  for (const t of ["anchor_lines","anchor_meta","served","undo"]) {
    const r = d.prepare(`SELECT MIN(updated_at) mn, MAX(updated_at) mx, COUNT(*) n FROM ${t}`).get();
    console.log(`  ${t}: n=${r.n} min=${r.mn} (${r.mn?new Date(r.mn).toISOString():"-"}) max=${r.mx} (${r.mx?new Date(r.mx).toISOString():"-"})`);
  }
  console.log("-- meta --"); console.log(d.prepare("SELECT * FROM meta").all());
  console.log("-- distinct updated_at values in anchor_lines --");
  console.log(d.prepare("SELECT COUNT(DISTINCT updated_at) distinct_ts FROM anchor_lines").get());
  console.log("-- anchor_lines per path distribution --");
  console.log(d.prepare("SELECT COUNT(*) paths, SUM(n) rows, AVG(n) avgn, MAX(n) maxn FROM (SELECT path, COUNT(*) n FROM anchor_lines GROUP BY path)").get());
  console.log("-- top 5 paths by rows --");
  console.log(d.prepare("SELECT path, COUNT(*) n FROM anchor_lines GROUP BY path ORDER BY n DESC LIMIT 5").all());
  console.log("-- served coverage vs anchor_lines: how many served anchors still exist as anchor_lines --");
  const rows = d.prepare("SELECT session_id, path, hashes FROM served").all();
  let totServed=0, missing=0, present=0, noMeta=0;
  for (const r of rows) {
    const meta = d.prepare("SELECT checksum FROM anchor_meta WHERE path=?").get(r.path);
    if (!meta) { noMeta++; continue; }
    const set = new Set(d.prepare("SELECT anchor FROM anchor_lines WHERE path=?").all(r.path).map(x=>x.anchor));
    // decode packed ~1
    const raw = r.hashes;
    if (!raw.startsWith("~1")) { console.log("  legacy payload", r.path, raw.slice(0,20)); continue; }
    const bytes = Buffer.from(raw.slice(2), "base64");
    let at=0; const rv=()=>{let v=0,s=1;for(;;){const b=bytes[at++];v+=(b&0x7f)*s;if(!(b&0x80))return v;s*=0x80;}};
    const A="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const groups=rv();
    for(let g=0;g<groups;g++){const len=rv();const cnt=rv();let prev=0;
      for(let i=0;i<cnt;i++){prev+=rv();let out="",rest=prev;for(let j=0;j<len;j++){out=A[rest%62]+out;rest=Math.floor(rest/62);}
        totServed++; if(set.has(out)) present++; else missing++;}}
  }
  console.log(`  served anchors decoded=${totServed} still-in-anchor_lines=${present} MISSING=${missing} paths-without-anchor_meta=${noMeta}`);
  d.close();
}
