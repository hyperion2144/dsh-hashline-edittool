// Run one shape under a bounded V8 heap. argv: N shape maxOldSpaceMB tool
import { getHeapStatistics } from "node:v8";
const N = Number(process.argv[2]), SHAPE = process.argv[3], MB = Number(process.argv[4]), TOOL = process.argv[5] ?? "myers";
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { diffLinesBoundedResult } = await import(`${ROOT}/lib/render/line-diff.js`);
const { alignPreservedBounded } = await import(`${ROOT}/lib/hashline/align-bounded.js`);
function base(n){const a=new Array(n);for(let i=0;i<n;i++)a[i]=`line ${i} :: value ${i*3+1}`;return a;}
function shape(n, s){
  const a = base(n);
  if (s === "ins") { const h=Math.floor(n/2); const add=[]; for(let i=0;i<n;i++)add.push(`INSERTED-${1e6+i} :: payload`); return [...a.slice(0,h),...add,...a.slice(h)]; }
  if (s === "del") { const h=Math.floor(n/2); return [...a.slice(0,Math.floor(h/2)),...a.slice(Math.floor(h/2)+h)]; }
  return a.map((l,i)=> i%2===0 ? `CHANGED ${i} :: replaced :: ${i*7}` : l);
}
const oldU = base(N), newU = shape(N, SHAPE);
const oldT = oldU.join("\n")+"\n", newT = newU.join("\n")+"\n";
const oldK = oldU.map((_,i)=>i), newK = newU.map((l,i)=> l.startsWith("line ")?Number(l.slice(5,l.indexOf(" ::"))):900000+i);
const t0 = process.hrtime.bigint();
let out;
if (TOOL === "myers") { const r = diffLinesBoundedResult(oldT, newT, Number(process.argv[6] ?? 256)); out = { parts: r.parts.length, degraded: r.degraded }; }
else { const r = alignPreservedBounded(oldK, newK); out = { pairs: r.pairs.size, degraded: r.degraded }; }
const ms = Number(process.hrtime.bigint()-t0)/1e6;
const h = getHeapStatistics(), m = process.memoryUsage();
console.log("RESULT " + JSON.stringify({ N, SHAPE, MB, TOOL, ms, out, heapUsed: m.heapUsed, totalHeap: h.total_heap_size, peakMalloc: h.peak_malloced_memory }));
