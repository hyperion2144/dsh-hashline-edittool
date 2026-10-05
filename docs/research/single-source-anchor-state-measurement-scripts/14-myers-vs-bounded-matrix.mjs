/**
 * Final comparison table, one measurement per process: argv N shape repeat
 */
import { getHeapStatistics } from "node:v8";
const N = Number(process.argv[2]), SHAPE = process.argv[3], REPEAT = Number(process.argv[4] ?? 3);
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { diffLinesBoundedResult } = await import(`${ROOT}/lib/render/line-diff.js`);
const { alignPreservedBounded } = await import(`${ROOT}/lib/hashline/align-bounded.js`);
function base(n){const a=new Array(n);for(let i=0;i<n;i++)a[i]=`line ${i} :: value ${i*3+1}`;return a;}
function shape(n,s){const a=base(n);
 if(s==="ins"){const h=Math.floor(n/2);const add=[];for(let i=0;i<n;i++)add.push(`INSERTED-${1e6+i} :: payload`);return [...a.slice(0,h),...add,...a.slice(h)];}
 if(s==="del"){const h=Math.floor(n/2);return [...a.slice(0,Math.floor(h/2)),...a.slice(Math.floor(h/2)+h)];}
 return a.map((l,i)=>i%2===0?`CHANGED ${i} :: replaced :: ${i*7}`:l);}
const oldU = base(N), newU = shape(N,SHAPE);
const oldT = oldU.join("\n")+"\n", newT = newU.join("\n")+"\n";
const oldK = oldU.map((_,i)=>i);
// oldK/newK must correspond position-wise to how each tool would compute its keys:
const oldKeys = oldU.map((_,i)=>i);
const newKeys = newU.map((l,i)=> l.startsWith("line ") ? Number(l.slice(5,l.indexOf(" ::"))) : 900000+i);
// warmup
diffLinesBoundedResult("a\nb\nc\n","a\nx\nc\n");
alignPreservedBounded([1,2,3],[1,9,3],{effective:10});
function run(fn){ global.gc?.(); const h0=getHeapStatistics(), m0=process.memoryUsage();
  let best=Infinity, out=null;
  for(let r=0;r<REPEAT;r++){ const t=process.hrtime.bigint(); out=fn(); const ms=Number(process.hrtime.bigint()-t)/1e6; if(ms<best)best=ms; }
  const h1=getHeapStatistics(), m1=process.memoryUsage();
  return { ms:best, out, heapUsedAfter:m1.heapUsed, arrayBuffers:m1.arrayBuffers, totalHeap:h1.total_heap_size }; }
const A = run(()=>{const r=diffLinesBoundedResult(oldT,newT);return {parts:r.parts.length,degraded:r.degraded};});
const B = run(()=>{const r=alignPreservedBounded(oldKeys,newKeys);return {pairs:r.pairs.size,degraded:r.degraded};});
console.log("RESULT "+JSON.stringify({N,SHAPE,repeat:REPEAT,myers:A,bounded:B}));
