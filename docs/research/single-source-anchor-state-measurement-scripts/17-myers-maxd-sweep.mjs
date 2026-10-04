// Myers cost vs maxD cap. argv: N shape maxD
const N = Number(process.argv[2]), SHAPE = process.argv[3], MAXD = Number(process.argv[4]);
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { diffLinesBoundedResult } = await import(`${ROOT}/lib/render/line-diff.js`);
import { getHeapStatistics } from "node:v8";
function base(n){const a=new Array(n);for(let i=0;i<n;i++)a[i]=`line ${i} :: value ${i*3+1}`;return a;}
function shape(n,s){const a=base(n);
 if(s==="ins"){const h=Math.floor(n/2);const add=[];for(let i=0;i<n;i++)add.push(`INSERTED-${1e6+i} :: payload`);return [...a.slice(0,h),...add,...a.slice(h)];}
 if(s==="del"){const h=Math.floor(n/2);return [...a.slice(0,Math.floor(h/2)),...a.slice(Math.floor(h/2)+h)];}
 return a.map((l,i)=>i%2===0?`CHANGED ${i} :: replaced :: ${i*7}`:l);}
const oldT = base(N).join("\n")+"\n";
const newT = shape(N,SHAPE).join("\n")+"\n";
const h0 = getHeapStatistics();
const t0 = process.hrtime.bigint();
const r = diffLinesBoundedResult(oldT, newT, MAXD);
const ms = Number(process.hrtime.bigint()-t0)/1e6;
const h1 = getHeapStatistics(); const m = process.memoryUsage();
console.log("RESULT " + JSON.stringify({N,SHAPE,MAXD,ms,degraded:r.degraded,parts:r.parts.length,
  heapUsed:m.heapUsed, totalHeap:h1.total_heap_size, arrayBuffers:m.arrayBuffers}));
