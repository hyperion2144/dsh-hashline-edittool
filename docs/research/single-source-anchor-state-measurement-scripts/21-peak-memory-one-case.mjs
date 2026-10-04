// Peak-ish memory for one call, one process per case. argv: tool N shape [effective|maxD]
import { getHeapStatistics } from "node:v8";
const TOOL = process.argv[2], N = Number(process.argv[3]), SHAPE = process.argv[4], OPT = process.argv[5] ? Number(process.argv[5]) : undefined;
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { diffLinesBoundedResult } = await import(`${ROOT}/lib/render/line-diff.js`);
const { alignPreservedBounded } = await import(`${ROOT}/lib/hashline/align-bounded.js`);
function base(n){const a=new Array(n);for(let i=0;i<n;i++)a[i]=`line ${i} :: value ${i*3+1}`;return a;}
function shape(n,s){const a=base(n);
 if(s==="ins"){const h=Math.floor(n/2);const add=[];for(let i=0;i<n;i++)add.push(`INSERTED-${1e6+i} :: payload`);return [...a.slice(0,h),...add,...a.slice(h)];}
 if(s==="del"){const h=Math.floor(n/2);return [...a.slice(0,Math.floor(h/2)),...a.slice(Math.floor(h/2)+h)];}
 if(s==="small"){const b=base(n);for(let i=0;i<30;i++)b[Math.floor(n/2)+i]=`CHANGED-${i} :: new`;return b;}
 return a.map((l,i)=>i%2===0?`CHANGED ${i} :: replaced :: ${i*7}`:l);}
const oldU = base(N), newU = shape(N,SHAPE);
const oldT = oldU.join("\n")+"\n", newT = newU.join("\n")+"\n";
const oldK = oldU.map((_,i)=>i), newK = newU.map((l,i)=> l.startsWith("line ") ? Number(l.slice(5,l.indexOf(" ::"))) : 900000+i);
global.gc?.();
const before = process.memoryUsage();
const h0 = getHeapStatistics();
const t0 = process.hrtime.bigint();
let out;
if (TOOL === "myers") { const r = diffLinesBoundedResult(oldT, newT, OPT); out = { parts: r.parts.length, degraded: r.degraded }; }
else { const r = alignPreservedBounded(oldK, newK, OPT ? { effective: OPT } : {}); out = { pairs: r.pairs.size, degraded: r.degraded }; }
const ms = Number(process.hrtime.bigint()-t0)/1e6;
const after = process.memoryUsage(); const h1 = getHeapStatistics();
console.log(JSON.stringify({TOOL,N,SHAPE,OPT,ms:Number(ms.toFixed(1)),out,
  heapDeltaMB:Number(((after.heapUsed-before.heapUsed)/1048576).toFixed(1)),
  heapUsedMB:Number((after.heapUsed/1048576).toFixed(1)),
  totalHeapMB:Number((h1.total_heap_size/1048576).toFixed(1)),
  peakMallocMB:Number((h1.peak_malloced_memory/1048576).toFixed(1))}));
