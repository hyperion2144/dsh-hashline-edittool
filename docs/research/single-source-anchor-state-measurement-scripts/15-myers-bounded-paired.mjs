/**
 * One measurement, in its own process. argv: <N> <shape> [repeat]
 * shapes: ins | del | mix
 */
import { getHeapStatistics } from "node:v8";
const N = Number(process.argv[2]);
const SHAPE = process.argv[3];
const REPEAT = Number(process.argv[4] ?? 1);
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { diffLinesBoundedResult } = await import(`${ROOT}/lib/render/line-diff.js`);
const { alignPreservedBounded } = await import(`${ROOT}/lib/hashline/align-bounded.js`);

function base(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = `line ${i} :: value ${i * 3 + 1}`; return a; }
function shapeText(n, shape) {
  const a = base(n);
  if (shape === "ins") {
    const half = Math.floor(n / 2);
    const add = []; for (let i = 0; i < n; i++) add.push(`INSERTED-${1000000 + i} :: payload`);
    return [...a.slice(0, half), ...add, ...a.slice(half)];
  }
  if (shape === "del") {
    const half = Math.floor(n / 2);
    return [...a.slice(0, Math.floor(half / 2)), ...a.slice(Math.floor(half / 2) + half)];
  }
  // mix: 50% of the lines replaced
  return a.map((l, i) => (i % 2 === 0 ? `CHANGED ${i} :: replaced :: ${i * 7}` : l));
}
const oldUnits = base(N);
const newUnits = shapeText(N, SHAPE);
const oldText = oldUnits.join("\n") + "\n";
const newText = newUnits.join("\n") + "\n";
const oldKeys = oldUnits.map((_, i) => i);
const newKeys = newUnits.map((l, i) => (l.startsWith("line ") ? Number(l.slice(5, l.indexOf(" ::"))) : 900000 + i));

function heap() { const h = getHeapStatistics(); const m = process.memoryUsage(); return { used: m.heapUsed, peak: h.peak_malloced_memory, total: h.total_heap_size, ab: m.arrayBuffers }; }

const out = { N, shape: SHAPE, repeat: REPEAT };
// warm the JIT on a small input
{
  diffLinesBoundedResult("a\nb\nc\n", "a\nx\nc\n");
  alignPreservedBounded([1, 2, 3], [1, 9, 3], { effective: 10 });
}
for (const which of ["myers", "bounded"]) {
  let best = Infinity, res = null, heapAfter = null, heapBefore = null;
  global.gc?.();
  heapBefore = heap();
  for (let r = 0; r < REPEAT; r++) {
    const t0 = process.hrtime.bigint();
    if (which === "myers") { const x = diffLinesBoundedResult(oldText, newText); res = { parts: x.parts.length, degraded: x.degraded }; }
    else { const x = alignPreservedBounded(oldKeys, newKeys); res = { pairs: x.pairs.size, degraded: x.degraded }; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  heapAfter = heap();
  out[which] = { ms: best, res, usedBefore: heapBefore.used, usedAfter: heapAfter.used, heapTotalAfter: heapAfter.total, peakMalloc: heapAfter.peak, arrayBuffers: heapAfter.ab };
}
console.log("RESULT " + JSON.stringify(out));
