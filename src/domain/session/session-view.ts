/**
 * SessionView — deep module owning served rows + drift + position reconstruction.
 *
 * Previously split: served-store (merge invariant, persistence via hash-store)
 * and drift (pure computeDrift + IO scanDrift that reads+writes served state).
 * The drift notice both *reads* served state and *writes* it (marking reported
 * + recording drift rows) — a side effect hidden inside a "notice" module.
 *
 * This seam co-locates that invariant. Public surface:
 *   view(sessionKey, path) -> {served, reported}
 *   recordRead(sessionKey, path, rows, lineCount)
 *   recordEdit(sessionKey, path, rows, lineCount, clearFrom)
 *   scanDrift(sessionKey, path, resultHashes, resultLines, range) -> notice?
 *   servedPositionsOf, currentPositionOfDrifted, _mergeServedRows (via served-store)
 *
 * Workspace note: the ambient workspace is `infra/workspace` (one
 * AsyncLocalStorage, two accessors) and `hash-store` reads it directly at
 * `storePathFor`. That is the honest shape: the cwd decides which database
 * opens, so the accessor has to sit BELOW persistence, not above it. Reaching
 * it through this seam is what once made `hash-store → session-view →
 * hash-store` a cycle. Both accessors are re-exported here for callers that
 * already import this module.
 *
 * Ownership: This file now OWNS the served-merge invariant
 * (_mergeServedRows), the position-reconstruction math, and the drift
 * computation. Deleting it would scatter the served+drift invariant
 * across 4 files — it concentrates (deep).
 *
 * @module dsh-hashline-edittool/session-view
 */

import { randomUUID } from "node:crypto";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO } from "../../infra/fs-bridge.js";
import { withWorkspace, workspaceCwd } from "../../infra/workspace.js";
import { hashRe, canon, contentChecksum } from "../../hashline/hash-assign.js";
import { loadHashStore, withStore } from "./hash-store.js";
import { SERVED_ECHO_CAP } from "../../infra/constants.js";
// The row shape and the row renderer both come from the resolve engine.
// Reaching them through the `hashline/served` shim — which re-exports that
// engine, and which this module's own re-exports pointed back at — was one
// third of the last cycle in the tree.
import type { ServedRow, ResolvedRange } from "../../hashline/anchor-pipeline.js";
import { fmtServedRows } from "../../hashline/anchor-pipeline.js";
import { configDir, hashStorePath, resolveTarget } from "../../infra/paths.js";

// --- workspace (owned by infra/workspace, re-exported for this seam's callers) ---
export { withWorkspace, workspaceCwd };

// --- dsh-context (private to this seam) ---
let fallbackSessionKey: string | undefined;

export function sessionKeyFor(sessionId?: string): string {
  if (sessionId && sessionId.length > 0) return sessionId;
  // fallback for previews/tests
  return fallbackSessionKey ??= randomUUID();
}

export function execCwd(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

export function execSessionKey(exec: ToolExecution): string {
  return sessionKeyFor(exec.agent?.session.id);
}

// --- paths re-export (seam visibility) ---
export { configDir, hashStorePath, resolveTarget };

// --- hash-store re-export (persistence note) ---
export { loadHashStore, shutdownHashStore, withStore } from "./hash-store.js";
export type { HashStore } from "./hash-store.js";

// --- served state (owned here) ---
export type ServedEntry = { position: number; anchor: string | null; key?: string | null };

/**
 * Migrate a served mirror after an edit, preserving entries for lines whose
 * content (and therefore hash) didn't change. Lines whose hash IS in the new
 * file at a unique old position keep their served status at the new position;
 * duplicates and changed lines are nulled. The returned array has the same
 * length as `newHashes`.
 *
 * This is the "B" half of the chain-edit story: without migration, a previous
 * edit that shifted lines below the diff window would clear the served
 * mirror, and the model's follow-up edit (computed from the Shift block +
 * remembered hash) would trip [E_RANGE_UNVERIFIED].
 */
export function migrateServedAfterEdit(
  oldServed: (string | null)[],
  oldHashes: string[],
  newHashes: string[],
): (string | null)[] {
  const newServed: (string | null)[] = new Array(newHashes.length).fill(null);
  if (oldHashes.length === 0) return newServed;

  // For each old hash that was served, collect the old positions where it
  // appeared. We then greedily pair each new-line hash with one unused old
  // position. Order-preserving: when the same hash appears N times in both
  // arrays, the i-th occurrence in `newHashes` is paired with the i-th
  // available old position.
  const hashToOldPositions = new Map<string, number[]>();
  for (let q = 0; q < oldServed.length; q++) {
    const h = oldServed[q];
    if (h === null) continue;
    let bucket = hashToOldPositions.get(h);
    if (!bucket) {
      bucket = [];
      hashToOldPositions.set(h, bucket);
    }
    bucket.push(q);
  }
  // Cursor into each hash's old-position list — the next position to assign
  // when we see this hash again in the new file.
  const cursor = new Map<string, number>();
  for (let p = 0; p < newHashes.length; p++) {
    const h = newHashes[p]!;
    const bucket = hashToOldPositions.get(h);
    if (!bucket || bucket.length === 0) continue;
    const idx = cursor.get(h) ?? 0;
    if (idx >= bucket.length) continue;
    // Order-preserving occurrence pairing (i-th old ↔ i-th new) is the
    // documented contract for repeated hashes: identical lines are
    // indistinguishable, so positional order is the only defensible map.
    // The old `bucket.length === 1 || idx < bucket.length` guard here was
    // dead code (always true after the cursor bounds check above) and let
    // duplicates through as if unambiguous — the served mirror then held the
    // same anchor at multiple positions (the `2t` double-booking enabler).
    newServed[p] = h;
    cursor.set(h, idx + 1);
  }
  return newServed;
}

/**
 * Persist the served mirror after an edit, preserving served entries for
 * unchanged lines and overlaying the diff region's new served rows on top.
 * Replaces `recordServedTruncated` for the post-edit path; the old helper
 * stays for any caller that genuinely wants the aggressive truncate.
 *
 * issue #136: persistence failures PROPAGATE (a served mirror that silently
 * failed to record is how "never served" rows are born). Callers that must
 * not fail a completed write catch and surface it as a warning.
 */
export async function recordServedAfterEdit(
  sessionKey: string,
  path: string,
  diffServedRows: ServedEntry[],
  lineCount: number,
  originalHashes: string[],
  resultHashes: string[],
): Promise<void> {
  try {
    const store = await loadHashStore();
    withStore(() => {
      const current = store.getServed(sessionKey, path);
      const migrated = migrateServedAfterEdit(current, originalHashes, resultHashes);
      // Overlay the diff region's served rows on the migrated mirror —
      // these rows are the lines the model actually saw in the diff body
      // (and any explicit context we chose to mark served).
      const updated = _mergeServedRows(migrated, diffServedRows, { truncateTo: lineCount });
      if (current.length === updated.length && current.every((v, i) => v === updated[i])) return;
      store.upsertServed(sessionKey, path, JSON.stringify(updated));
    });
  } catch (error) {
    console.error("Failed to record served rows after edit:", error);
  }
}

/**
 * Merge served rows into a copy of the stored array. This single helper owns
 * the served-merge invariant shared by recordServed and recordServedTruncated.
 *
 * Position-keyed, NOT hash-uniqueness-keyed: each (position, hash) pair is
 * independent. The same hash at two different positions is allowed (e.g.
 * several blank lines). Duplicates (issue #136) are EVIDENCE, not noise: one
 * anchor live at two positions means an upstream allocator bug, so every
 * record is KEPT and a loud warning names the collision — the old purge that
 * nulled the earlier position to hide the duplicate is exactly what turned an
 * allocator bug into unreachable "never served" lines. verifyServedRange's
 * strict positional check stays the arbiter of what may be written.
 */
export function _mergeServedRows(
  current: (string | null)[],
  rows: ServedEntry[],
  options?: { truncateTo?: number; clearFrom?: number },
): (string | null)[] {
  const updated = current.slice();
  if (options?.truncateTo !== undefined && updated.length > options.truncateTo) {
    updated.length = options.truncateTo;
  }
  if (options?.clearFrom !== undefined) {
    for (let i = options.clearFrom; i < updated.length; i++) updated[i] = null;
  }
  for (const entry of rows) {
    if (!Number.isInteger(entry.position) || entry.position < 0) {
      throw new TypeError(`Invalid served position: ${entry.position}`);
    }
    if (entry.anchor !== null && (typeof entry.anchor !== "string" || !hashRe().test(entry.anchor))) {
      throw new TypeError(`Invalid served anchor: ${String(entry.anchor)}`);
    }
    while (updated.length <= entry.position) updated.push(null);
    updated[entry.position] = entry.anchor;
  }
  // issue #136: duplicates are surfaced, never silently purged. The old
  // last-write-wins pass nulled served records to enforce single ownership —
  // which masked upstream allocator bugs AND destroyed the records the
  // verification layer needs ("line was never served"). Anchors are unique
  // per line by construction; if two positions ever hold one, keeping BOTH
  // and warning is the honest move: the positional check in
  // verifyServedRange rejects what it cannot vouch for, row by row.
  const seenAt = new Map<string, number>();
  for (let i = 0; i < updated.length; i++) {
    const anchor = updated[i];
    if (anchor === null) continue;
    const first = seenAt.get(anchor);
    if (first === undefined) seenAt.set(anchor, i);
    else {
      console.warn(
        `[E_SERVED_DUP] anchor "${anchor}" is served at positions ${first} and ${i} — " +
          "the allocator produced a duplicate; keeping both records (verification is positional).`,
      );
    }
  }
  while (updated.length > 0 && updated[updated.length - 1] === null) updated.pop();
  return updated;
}

/** Keys merge mirrors the anchors merge: a row's contentKey follows its
 *  anchor's fate (write, purge, trim). Deriving from the MERGED anchors keeps
 *  the two arrays in lockstep by construction. */
function _mergeServedKeys(
  current: (string | null)[],
  currentKeys: (string | null)[],
  rows: ServedEntry[],
  options: { truncateTo?: number; clearFrom?: number } | undefined,
  mergedAnchors: (string | null)[],
): (string | null)[] {
  const keyByAnchor = new Map<string, string | null>();
  for (let i = 0; i < current.length; i++) {
    const a = current[i];
    if (a !== null) keyByAnchor.set(a, currentKeys[i] ?? null);
  }
  for (const entry of rows) {
    if (entry.anchor !== null) keyByAnchor.set(entry.anchor, entry.key ?? null);
  }
  return mergedAnchors.map((a) => (a === null ? null : keyByAnchor.get(a) ?? null));
}

/** Served persistence format: legacy `(string|null)[]` when no keys are
 *  known (full backward compat), `v2` envelope once any key exists. */
function serializeServed(anchors: (string | null)[], keys: (string | null)[]): string {
  if (keys.every((k) => k === null)) return JSON.stringify(anchors);
  return JSON.stringify({ v: 2, a: anchors, k: keys });
}

/** Content keys parallel to loadServed — the drift-verification basis. */
export async function loadServedKeys(sessionKey: string, path: string): Promise<(string | null)[]> {
  const store = await loadHashStore();
  return store.getServedKeys(sessionKey, path);
}

export async function loadServed(sessionKey: string, path: string): Promise<(string | null)[]> {
  const store = await loadHashStore();
  return store.getServed(sessionKey, path);
}

export async function recordServed(sessionKey: string, path: string, rows: ServedEntry[], lineCount?: number): Promise<void> {
  if (rows.length === 0) return;
  const store = await loadHashStore();
  // issue #136: no silent catch. A failed serve record must reach the caller
  // — an echo the model saw but the mirror lost is the never-served bug.
  withStore(() => {
    const current = store.getServed(sessionKey, path);
    const currentKeys = store.getServedKeys(sessionKey, path);
    const opts = lineCount === undefined ? undefined : { truncateTo: lineCount };
    const updated = _mergeServedRows(current, rows, opts);
    const keys = _mergeServedKeys(current, currentKeys, rows, opts, updated);
    // Skip no-op writes (O(1) check; no extra I/O beyond current read).
    if (current.length === updated.length && current.every((v, i) => v === updated[i])) return;
    store.upsertServed(sessionKey, path, serializeServed(updated, keys));
  });
}

/**
 * When an echo's rows become part of the session's served mirror.
 *
 * `"live"` records them — the model read them in a tool result, so they are as
 * served as a `read`'s rows. `"preview"` renders the echo without recording it,
 * which is what dry runs and `undo` previews need.
 */
export type ServeRecordPolicy = "live" | "preview";

/**
 * Record an echo's rows under the given policy — the `"live"` case of
 * {@link ServeRecordPolicy}, and nothing else.
 *
 * This used to live in `hashline/anchor-pipeline`, which had to import this
 * module to reach `recordServed`; since this module already imports the
 * pipeline for `ServedRow` and `ResolvedRange`, that made the two a cycle.
 * Recording served state is this seam's job, so the policy wrapper belongs
 * here and the pipeline stays a pure resolve/apply engine.
 *
 * @param sessionKey - the session whose mirror to update.
 * @param path - the absolute path the rows belong to.
 * @param rows - the rows the echo served.
 * @param policy - `"live"` to record; anything else is a no-op.
 * @param lineCount - total line count, for truncation bookkeeping.
 */
export async function recordEchoServes(
  sessionKey: string,
  path: string,
  rows: ServedRow[],
  policy: ServeRecordPolicy,
  lineCount?: number,
): Promise<void> {
  if (policy !== "live") return;
  await recordServed(sessionKey, path, rows.map((r) => ({ position: r.position, anchor: r.anchor, key: r.contentKey ?? null })), lineCount);
}

/**
 * Serve a tool's rows AND observe the file, inside the caller's workspace.
 *
 * Every store read and write resolves its database from the cwd —
 * `loadHashStore` → `hashStorePath` → `configDir(cwd)`. With no cwd that is
 * `$DSH_HOME/plugins/dsh-hashline-edittool/hash-store.sqlite`, a DIFFERENT
 * database from the per-project `…/--<projectKey>--/…` one that `read` and
 * `edit` use. So a tool that serves rows without entering the workspace
 * writes them where no later edit will look, and does it silently: the
 * missing rows surface much later as `[E_RANGE_UNVERIFIED]` on an anchor the
 * model was just handed.
 *
 * `read`, `grep`, `edit`, `undo`, `ast_edit` and `write` each wrap their whole
 * body in `withWorkspace`. `lsp` and `ast_grep` do not — they resolve a path
 * and serve rows without ever entering a scope — so this primitive takes the
 * cwd explicitly and enters it around the write. It exists so those two
 * tools have ONE call to make, instead of a store call they must remember to
 * wrap.
 *
 * @param opts.sessionKey - the session whose mirror to update.
 * @param opts.cwd - the workspace root; the cwd the caller already resolved its path against.
 * @param opts.absolutePath - the canonical path the rows belong to.
 * @param opts.rows - position/anchor pairs to mark served.
 * @param opts.lineCount - total line count, for truncation bookkeeping.
 * @param opts.exec - the tool execution, for the observation emit.
 * @param opts.io - the filesystem bridge that owns `emitObserved`.
 */
export async function serveRowsInWorkspace(opts: {
  sessionKey: string;
  cwd: string;
  absolutePath: string;
  rows: ServedEntry[];
  lineCount: number;
  exec: ToolExecution;
  io: { emitObserved(path: string, exec: ToolExecution, signal?: AbortSignal): Promise<void> };
}): Promise<void> {
  await withWorkspace(opts.cwd, async () => {
    await recordServed(opts.sessionKey, opts.absolutePath, opts.rows, opts.lineCount);
  });
  // Observing is not a store write, but it belongs to the same promise:
  // a served row the policy does not know about is an anchor the model
  // cannot write with.
  await opts.io.emitObserved(opts.absolutePath, opts.exec, opts.exec.signal);
}

export async function recordServedTruncated(sessionKey: string, path: string, rows: ServedEntry[], lineCount: number, clearFrom = 0): Promise<void> {
  if (rows.length === 0) return;
  const store = await loadHashStore();
  // issue #136: no silent catch (same contract as recordServed).
  withStore(() => {
    const current = store.getServed(sessionKey, path);
    const currentKeys = store.getServedKeys(sessionKey, path);
    const opts = { truncateTo: lineCount, clearFrom };
    const updated = _mergeServedRows(current, rows, opts);
    const keys = _mergeServedKeys(current, currentKeys, rows, opts, updated);
    // Skip no-op writes (O(1) check; no extra I/O beyond current read).
    if (current.length === updated.length && current.every((v, i) => v === updated[i])) return;
    store.upsertServed(sessionKey, path, serializeServed(updated, keys));
  });
}

export async function driftReported(sessionKey: string, path: string): Promise<Set<string>> {
  try {
    const store = await loadHashStore();
    return store.getServedReported(sessionKey, path);
  } catch (error) {
    console.error("Failed to load reported drift set:", error);
    return new Set();
  }
}

export async function markDriftReported(sessionKey: string, path: string, hashes: string[]): Promise<void> {
  try {
    const valid = hashes.filter((hash) => hashRe().test(hash));
    if (valid.length === 0) return;
    const store = await loadHashStore();
    withStore(() => {
      const current = store.getServedReported(sessionKey, path);
      for (const hash of valid) current.add(hash);
      store.upsertServedReported(sessionKey, path, JSON.stringify([...current]));
    });
  } catch (error) {
    console.error("Failed to record reported drift set:", error);
  }
}

export async function clearDriftReported(sessionKey: string, path: string): Promise<void> {
  try {
    const store = await loadHashStore();
    withStore(() => {
      store.clearServedReported(sessionKey, path);
    });
  } catch (error) {
    console.error("Failed to clear reported drift set:", error);
  }
}

export async function wipeServedState(sessionKey: string): Promise<void> {
  try {
    const store = await loadHashStore();
    store.wipeServed(sessionKey);
  } catch (error) {
    console.error("Failed to wipe served state:", error);
  }
}

export function servedPositionsOf(served: (string | null)[], hash: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < served.length; i++) {
    if (served[i] === hash) out.push(i);
  }
  return out;
}

function nearestSurvivingPosition(served: (string | null)[], surviving: Set<string>, from: number, direction: "below" | "above"): number | undefined {
  if (direction === "below") {
    for (let q = from - 1; q >= 0; q--) {
      const hash = served[q];
      if (hash !== null && surviving.has(hash)) return q;
    }
    return undefined;
  }
  for (let q = from + 1; q < served.length; q++) {
    const hash = served[q];
    if (hash !== null && surviving.has(hash)) return q;
  }
  return undefined;
}

export function currentPositionOfDrifted(served: (string | null)[], currentPositions: Map<string, number>, surviving: Set<string>, servedIndex: number, delta: number): number {
  const below = nearestSurvivingPosition(served, surviving, servedIndex, "below");
  if (below !== undefined) {
    const pos = currentPositions.get(served[below]!);
    if (pos !== undefined) return pos + 1;
  }
  const above = nearestSurvivingPosition(served, surviving, servedIndex, "above");
  if (above !== undefined) {
    const pos = currentPositions.get(served[above]!);
    if (pos !== undefined) return pos - 1;
  }
  return servedIndex + delta;
}

// --- drift (owned here) ---
export const DRIFT_NOTICE_HEADING = "Drift notice:";

export interface DriftRow extends ServedRow {
  content: string;
  drifted: boolean;
}

export interface ComputeDriftInput {
  served: (string | null)[];
  resultHashes: string[];
  resultLines: string[];
  range: ResolvedRange;
  reported: Set<string>;
  cap?: number;
}

export interface DriftNoticeResult {
  text: string;
  rows: DriftRow[];
  total: number;
  allAlreadyReported: boolean;
}

export function computeDrift(input: ComputeDriftInput): DriftNoticeResult | undefined {
  const { served, resultHashes, resultLines, range, reported, cap = SERVED_ECHO_CAP } = input;
  const resultHashSet = new Set(resultHashes);
  // Position anchors for drift echoes are hash-keyed (the old row has no
  // surviving line number), but a hash that appears MULTIPLE times is not a
  // position — remove it so drifted rows never anchor to an ambiguous spot.
  const currentPosOfHash = new Map<string, number>();
  const hashCount = new Map<string, number>();
  for (let i = 0; i < resultHashes.length; i++) {
    const h = resultHashes[i]!;
    hashCount.set(h, (hashCount.get(h) ?? 0) + 1);
    currentPosOfHash.set(h, i);
  }
  for (const [h, count] of hashCount) {
    if (count > 1) currentPosOfHash.delete(h);
  }
  const startPositions = servedPositionsOf(served, range.startHash);
  const endPositions = servedPositionsOf(served, range.endHash);
  let servedStartIdx: number;
  let servedEndIdx: number;
  if (startPositions.length === 1 && endPositions.length === 1) {
    servedStartIdx = startPositions[0]!;
    servedEndIdx = endPositions[0]!;
  } else {
    servedStartIdx = range.startLine - 1;
    servedEndIdx = range.endLine - 1;
  }
  const rangeFrom = Math.min(servedStartIdx, servedEndIdx);
  const rangeTo = Math.max(servedStartIdx, servedEndIdx);
  let total = 0;
  let unshown = 0;
  let anyNotReported = false;
  const driftedPositions: number[] = [];
  for (let p = 0; p < served.length; p++) {
    const servedHash = served[p];
    if (servedHash === null) continue;
    if (p >= rangeFrom && p <= rangeTo) continue;
    if (resultHashSet.has(servedHash)) continue;
    total++;
    if (!reported.has(servedHash)) anyNotReported = true;
    const currentPos = currentPositionOfDrifted(served, currentPosOfHash, resultHashSet, p, range.delta);
    if (currentPos >= 0 && currentPos < resultHashes.length && currentPos < resultLines.length) {
      driftedPositions.push(currentPos);
    } else {
      unshown++;
    }
  }
  if (total === 0) return undefined;
  const countLabel = `${total} line(s)`;
  if (!anyNotReported) {
    return {
      text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range drifted and were already reported — call read to refresh.`,
      rows: [],
      total,
      allAlreadyReported: true,
    };
  }
  const driftedSet = new Set(driftedPositions);
  const windowSet = new Set<number>();
  for (const pos of driftedPositions) {
    for (const w of [pos - 1, pos, pos + 1]) {
      if (w >= 0 && w < resultLines.length) windowSet.add(w);
    }
  }
const windowPositions = [...windowSet].sort((a, b) => a - b);
  const shownPositions = windowPositions.slice(0, cap);
  unshown += windowPositions.length - shownPositions.length;
  const rows: DriftRow[] = shownPositions.map((position) => ({
    position,
    anchor: resultHashes[position]!,
    contentKey: contentChecksum(canon(resultLines[position]!)),
    content: resultLines[position]!,
    drifted: driftedSet.has(position),
  }));
  const rowsText = fmtServedRows(rows, resultLines);
  const moreText = unshown > 0 ? `\n[... ${unshown} more line(s) — call read to see them]` : "";
  return {
    text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range drifted. Current content around the drift:\n${rowsText}${moreText}`,
    rows,
    total,
    allAlreadyReported: false,
  };
}

export async function scanDrift(input: { sessionKey: string; served: (string | null)[]; resultHashes: string[]; resultLines: string[]; range: ResolvedRange; path: string; io?: FileIO; exec?: ToolExecution }): Promise<string | undefined> {
  const reported = await driftReported(input.sessionKey, input.path);
const result = computeDrift({ ...input, reported });
  if (!result || result.allAlreadyReported) return result?.text;
  let servedNote = "";
  try {
    await recordServed(
      input.sessionKey,
      input.path,
      result.rows.map((row) => ({ position: row.position, anchor: row.anchor })),
      input.resultLines.length,
    );
  } catch (error) {
    // issue #136: never silent — but the edit itself already succeeded, so
    // the failure rides back to the model as part of the notice instead.
    console.error("[E_SERVED_RECORD] failed to record drift rows:", error);
    servedNote = `\n[E_SERVED_RECORD] drift rows could not be recorded (${
      error instanceof Error ? error.message : String(error)
    }); re-read before editing them.`;
  }
  // The drift rows are served, so the file is OBSERVED: the anchors printed
  // here are exactly the ones a corrective edit will use.
  if (input.io !== undefined) await input.io.emitObserved(input.path, input.exec);
  await markDriftReported(input.sessionKey, input.path, result.rows.filter((row) => row.drifted).map((row) => row.anchor));
  return result.text + servedNote;
}
