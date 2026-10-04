/**
 * Measurement 1b — is "released anchor re-minted onto DIFFERENT content" reachable
 * through the REAL allocator, inside ONE session?
 * Run: node --experimental-strip-types /tmp/hashm/m1_rebind_reach.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HOME = "/tmp/hashm/home1"; const WS = "/tmp/hashm/ws1";
process.env.HOME = HOME; process.env.DSH_HOME = join(HOME, ".dsh");
const ROOT = "/Users/mutou/projects/dsh-tool-hashline";
const { loadHashStore, shutdownHashStore } = await import(`${ROOT}/lib/domain/session/hash-store.js`);
const { withWorkspace } = await import(`${ROOT}/lib/infra/workspace.js`);
const { allocateForLines, updateAnchorsAfterEdit, anchorsFor } = await import(`${ROOT}/lib/hashline/session-anchors.js`);
const { contentKey, allocateAnchor } = await import(`${ROOT}/lib/hashline/alloc.js`);

rmSync(join(HOME), { recursive: true, force: true });
mkdirSync(WS, { recursive: true });

const FILE = join(WS, "reach.ts");
const N = 1000;
const lines: string[] = [];
for (let i = 1; i <= N; i++) lines.push(`const marker_${i} = table[${i}] + step(${i});`);
let text = lines.join("\n") + "\n";
writeFileSync(FILE, text);

await withWorkspace(WS, () => loadHashStore(WS));

// warm the whole file (the model read it)
const anchorsAll = await withWorkspace(WS, async () => allocateForLines(FILE, text, Array.from({ length: N }, (_, i) => i + 1)));
console.log(`warmed ${anchorsAll.length} anchors; depth-2 count = ${anchorsAll.filter(a => a.length === 2).length}`);

// Find target content keys c3 whose natural depth-2 slot (h % 3844) equals a free slot.
// Strategy: sweep candidate new-content strings and, for each, run the real allocator
// against the SAME used-set the plugin would have AFTER releasing line L's anchor.
const usedAfterRelease = new Set(anchorsAll);
const released = anchorsAll[400]; // line 401's anchor
usedAfterRelease.delete(released);
console.log(`released anchor at line 401: ${released}`);

let collisions = 0, tried = 0, firstExample: any = null;
for (let k = 0; k < 20000 && collisions < 5; k++) {
  const candidate = `const injected_${k} = alpha(${k}) * beta_${k % 13};`;
  const key = contentKey(candidate);
  tried++;
  const got = allocateAnchor(usedAfterRelease, candidate).anchor;
  if (got === released) {
    collisions++;
    if (!firstExample) firstExample = { candidate, key, got };
  }
}
console.log(`candidate strings tried for the released slot ${released}: ${tried}`);
console.log(`allocator returned the RELEASED anchor for a DIFFERENT content: ${collisions} time(s)`);
console.log(`first example: ${JSON.stringify(firstExample)}`);

// ---- end-to-end: does the SESSION end up with a re-bound (anchor -> other content) pair?
rmSync(join(HOME), { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
const FILE2 = join(WS, "reach2.ts");
const M = 400;
const l2: string[] = [];
for (let i = 1; i <= M; i++) l2.push(`const row_${i} = fn_${i % 17}(${i});`);
let t2 = l2.join("\n") + "\n";
writeFileSync(FILE2, t2);
await withWorkspace(WS, () => loadHashStore(WS));
const a0 = await withWorkspace(WS, () => allocateForLines(FILE2, t2, Array.from({ length: M }, (_, i) => i + 1)));
// replicate the runtime state: session-anchors keeps the state in memory
const statePath = FILE2;
const before = await withWorkspace(WS, () => anchorsFor(statePath, t2));
const victimLine = 201, victimAnchor = before[victimLine - 1]!;
console.log(`\n[session repro] line ${victimLine} holds anchor ${victimAnchor} (content "${l2[victimLine-1]}")`);
// an edit replaces line 201 with new content, and a later op serves OTHER lines
const l2b = [...l2]; l2b[victimLine - 1] = `const row_${victimLine} = TOTALLY_DIFFERENT(${victimLine});`;
const t2b = l2b.join("\n") + "\n";
const after = await withWorkspace(WS, () => updateAnchorsAfterEdit({
  path: statePath, oldContent: t2, newContent: t2b, oldAnchors: before,
  hunks: [{ oldStart1: victimLine, oldEnd1: victimLine, finalStart1: victimLine, finalEnd1: victimLine }],
}));
console.log(`after the edit, line ${victimLine} holds anchor ${after[victimLine - 1]} (the old anchor was released)`);
console.log(`is the released anchor ${victimAnchor} still anywhere in the file? ${after.includes(victimAnchor) ? "YES" : "no"}`);
console.log(`depth-2 anchors in use after the edit: ${after.filter(a=>a.length===2).length} of ${after.length}`);
shutdownHashStore();
