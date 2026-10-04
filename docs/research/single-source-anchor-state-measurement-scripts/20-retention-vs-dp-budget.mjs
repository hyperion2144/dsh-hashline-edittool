// Retention of alignPreservedBounded vs the DP budget (`effective`).
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { alignPreservedBounded, effectiveDpBudget } = await import(`${ROOT}/lib/hashline/align-bounded.js`);
const N = Number(process.argv[2] ?? 10000);
function base(n){const a=new Array(n);for(let i=0;i<n;i++)a[i]=`line ${i} :: value ${i*3+1}`;return a;}
const oldU = base(N), newU = oldU.map((l,i)=>i%2===0?`CHANGED ${i} :: replaced :: ${i*7}`:l);
const oldKeys = oldU.map((_,i)=>i), newKeys = newU.map((l,i)=> l.startsWith("line ") ? Number(l.slice(5,l.indexOf(" ::"))) : 900000+i);
const identical = oldU.filter((l,i)=>newU[i]===l).length;
console.log(`default effectiveDpBudget() = ${effectiveDpBudget()}`);
for (const eff of [1e4, 1e5, 1e6, 1e7, 5e7, 1e8]) {
  const t0 = process.hrtime.bigint();
  const r = alignPreservedBounded(oldKeys, newKeys, { effective: eff });
  const ms = Number(process.hrtime.bigint()-t0)/1e6;
  console.log(`effective=${eff.toExponential(0)}  pairs=${r.pairs.size}/${identical} (${(100*r.pairs.size/identical).toFixed(1)}% retention)  degraded=${r.degraded}  ${ms.toFixed(1)} ms`);
}
