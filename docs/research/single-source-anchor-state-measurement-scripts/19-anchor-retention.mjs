// Retention: how many old→new line pairs each tool keeps, on identical inputs.
const N = Number(process.argv[2]), SHAPE = process.argv[3];
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
const r = diffLinesBoundedResult(oldT, newT);
let equalLines = 0; for (const p of r.parts) if (!p.added && !p.removed) equalLines += p.count;
const oldKeys = oldU.map((_,i)=>i);
const newKeys = newU.map((l,i)=> l.startsWith("line ") ? Number(l.slice(5,l.indexOf(" ::"))) : 900000+i);
const b = alignPreservedBounded(oldKeys, newKeys);
console.log(JSON.stringify({N,SHAPE,oldLines:oldU.length,newLines:newU.length,
  myersEqualLines:equalLines, myersDegraded:r.degraded,
  boundedPairs:b.pairs.size, boundedDegraded:b.degraded,
  identicalLines: oldU.filter((l,i)=> i < newU.length && newU[i] === l).length}));
