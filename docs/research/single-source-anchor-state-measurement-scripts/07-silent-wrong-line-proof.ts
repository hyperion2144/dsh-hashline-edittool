/**
 * Measurement 1d — the FULL consequence: a model-held anchor is re-minted onto a
 * DIFFERENT LINE, the served check still accepts it, and the model's edit lands
 * on the wrong line (overwriting different content).
 * Run: node --experimental-strip-types /tmp/hashm/m1_silent_wrongline.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HOME = "/tmp/hashm/home2"; const WS = "/tmp/hashm/ws2";
process.env.HOME = HOME; process.env.DSH_HOME = join(HOME, ".dsh");
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { loadHashStore, shutdownHashStore } = await import(`${ROOT}/lib/domain/session/hash-store.js`);
const { withWorkspace } = await import(`${ROOT}/lib/infra/workspace.js`);
const { allocateForLines, updateAnchorsAfterEdit } = await import(`${ROOT}/lib/hashline/session-anchors.js`);
const { contentKey } = await import(`${ROOT}/lib/hashline/alloc.js`);
const { recordServed } = await import(`${ROOT}/lib/domain/session/session-view.js`);
const { verifyServedRange } = await import(`${ROOT}/lib/hashline/anchor-pipeline.js`);

rmSync(HOME, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
const FILE = join(WS, "wrongline.ts");
const N = 400;
const ls: string[] = [];
for (let i = 1; i <= N; i++) ls.push(`const row_${i} = fn_${i % 17}(${i});`);
let text = ls.join("\n") + "\n";
writeFileSync(FILE, text);
await withWorkspace(WS, () => loadHashStore(WS));
const a0 = await withWorkspace(WS, () => allocateForLines(FILE, text, Array.from({ length: N }, (_, i) => i + 1)));
await withWorkspace(WS, () => recordServed("SESSION-A", FILE, a0.map((a, i) => ({ position: i, anchor: a, key: null })), N));

const L1 = 201, L2 = 350;
const aL1 = a0[L1 - 1], aL2 = a0[L2 - 1];
console.log(`model read the file. line ${L1} -> anchor ${aL1}; line ${L2} -> anchor ${aL2}`);
console.log(`the model intends to edit line ${L1} (content: "${ls[L1-1]}")`);

const A = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const val = (a: string) => { let v = 0; for (const ch of a) v = v * 62 + A.indexOf(ch); return v; };
const target = val(aL1);

// the content a later op will write onto line L2, chosen so the allocator's first
// depth-2 probe for it is exactly aL1's slot
let repl = "", k = -1;
for (let i = 0; i < 6_000_000; i++) {
  const c = `const REASSIGNED_${i} = shard(${i}) + "${i}";`;
  if (contentKey(c) % 3844 === target) { repl = c; k = i; break; }
}

// ---- edit #1: the model edits line L1 -> its anchor is released ----
const step1 = ls.map((l, i) => i === L1 - 1 ? `const row_${L1} = EDITED_BY_MODEL();` : l);
const text1 = step1.join("\n") + "\n";
const a1 = await withWorkspace(WS, () => updateAnchorsAfterEdit({
  path: FILE, oldContent: text, newContent: text1, oldAnchors: a0,
  hunks: [{ oldStart1: L1, oldEnd1: L1, finalStart1: L1, finalEnd1: L1 }],
}));
console.log(`\nedit #1 (line ${L1}): the old anchor ${aL1} was released; line ${L1} now holds ${a1[L1-1]}`);
console.log(`  is ${aL1} still somewhere in the file? ${a1.includes(aL1) ? "yes" : "no (its slot is free)"}`);

// ---- edit #2: a later op writes new content onto a DIFFERENT line, L2 ----
const step2 = step1.map((l, i) => i === L2 - 1 ? repl : l);
const text2 = step2.join("\n") + "\n";
const a2 = await withWorkspace(WS, () => updateAnchorsAfterEdit({
  path: FILE, oldContent: text1, newContent: text2, oldAnchors: a1,
  hunks: [{ oldStart1: L2, oldEnd1: L2, finalStart1: L2, finalEnd1: L2 }],
}));
console.log(`\nedit #2 (line ${L2}): searched ${k} candidates for the matching slot; line ${L2} now holds ${a2[L2-1]} (was ${aL2})`);

const where = a2.reduce((acc, a, i) => (a === aL1 ? [...acc, i + 1] : acc), [] as number[]);
console.log(`\n>>> the model's remembered anchor ${aL1} is now bound to line(s) ${JSON.stringify(where)}; the model believes it is line ${L1}`);
console.log(`    content at line ${where[0]}: "${step2[where[0]! - 1]}"`);

// ---- the consequence: is that stale anchor still accepted as served? ----
const store = await withWorkspace(WS, () => loadHashStore(WS));
const served = await withWorkspace(WS, () => store.getServed("SESSION-A", FILE));
console.log(`served set still contains "${aL1}": ${served.has(aL1)}`);
let accepted = false;
try {
  await withWorkspace(WS, () => {
    verifyServedRange({ served, startAnchor: aL1, endAnchor: aL1, startLine: where[0]!, endLine: where[0]!,
      fileAnchors: a2, fileLines: step2, filePath: FILE, statePath: FILE, content: text2 });
  });
  accepted = true;
} catch (e) { console.log(`verifyServedRange rejected: ${(e as Error).message.slice(0,160)}`); }
console.log(accepted
  ? `verifyServedRange ACCEPTED an edit naming ${aL1}: it resolves to line ${where[0]}, while the model means line ${L1}. SILENT WRONG-LINE EDIT.`
  : `verifyServedRange rejected the stale anchor.`);
shutdownHashStore();
