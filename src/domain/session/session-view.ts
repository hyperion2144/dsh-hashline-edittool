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
import { anchorsFor, allocateForLines } from "../../hashline/session-anchors.js";
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
export { loadHashStore, shutdownHashStore, withStore, takeRebuildWarning } from "./hash-store.js";
export type { HashStore } from "./hash-store.js";

// --- served state (owned here) ---
export type ServedEntry = { position: number; anchor: string | null; key?: string | null };

/**
 * Persist the served anchor set after an edit. With the Set-based mirror,
 * no migration is needed — anchors are content identities, not positions.
 * The diff's served anchors are simply added to the set.
 *
 * issue #136/#143: persistence failures PROPAGATE (a served mirror that silently
 * failed to record is how "never served" rows are born).
 */
export async function recordServedAfterEdit(
  sessionKey: string,
  path: string,
  diffServedRows: ServedEntry[],
): Promise<void> {
  try {
    const store = await loadHashStore();
    withStore(() => {
      const current = store.getServed(sessionKey, path);
      for (const entry of diffServedRows) {
        if (entry.anchor !== null) current.add(entry.anchor);
      }
      store.upsertServed(sessionKey, path, [...current]);
    });
  } catch (error) {
    console.error("Failed to record served rows after edit:", error);
  }
}

export async function loadServed(sessionKey: string, path: string): Promise<Set<string>> {
  const store = await loadHashStore();
  return store.getServed(sessionKey, path);
}

export async function recordServed(sessionKey: string, path: string, rows: ServedEntry[], _lineCount?: number): Promise<void> {
  if (rows.length === 0) return;
  const store = await loadHashStore();
  // issue #136/#143: no silent catch. A failed serve record must reach the caller
  // — an echo the model saw but the mirror lost is the never-served bug.
  withStore(() => {
    const current = store.getServed(sessionKey, path);
    for (const entry of rows) {
      if (entry.anchor !== null) current.add(entry.anchor);
    }
    store.upsertServed(sessionKey, path, [...current]);
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

/**
 * Allocate anchors for the rows a tool is about to serve, INSIDE the workspace
 * scope and with the workspace store OPEN.
 *
 * Two traps this closes, both found by a live probe (#171):
 *  - the anchor store is per-project, and a tool without its own
 *    `withWorkspace` body (`ast_grep`, `lsp`) writes the SHARED `$DSH_HOME`
 *    store — where nothing reads it (the same trap
 *    {@link serveRowsInWorkspace} closes on the served side);
 *  - the anchor port writes ONLY to an already-open store (`currentStore()`
 *    never opens one), so an allocation that runs before anything opened this
 *    workspace's store is dropped — the rows render with anchors that were
 *    never persisted, and a restart loses them.
 *
 * @param cwd - the workspace root for this execution.
 * @param absolutePath - the file the rows belong to.
 * @param content - the file's current normalized text.
 * @param lines - the 1-based lines the tool is about to render.
 * @returns the allocated anchors, aligned with `lines`.
 */
export async function allocateInWorkspace(
  cwd: string,
  absolutePath: string,
  content: string,
  lines: number[],
): Promise<string[]> {
  return withWorkspace(cwd, async () => {
    await loadHashStore(cwd);
    return allocateForLines(absolutePath, content, lines);
  });
}

/**
 * Open this workspace's store before a tool serves or allocates rows.
 *
 * The anchor port and the served mirror both write ONLY to an already-open
 * store (`currentStore()` never opens one), so a tool whose FIRST action
 * allocates — a read, grep, edit or undo before anything else in the session
 * touched this workspace — must open it first, or the rows it renders carry
 * anchors that were never persisted (#171 probe: `read` persisted 0 rows).
 *
 * Scope-aware, so the opened store is the one the workspace's writes resolve
 * to; idempotent, so calling it from several seams costs nothing.
 *
 * @param cwd - the workspace root for this execution.
 */
export async function openWorkspaceStore(cwd: string): Promise<void> {
  await withWorkspace(cwd, async () => {
    await loadHashStore(cwd);
  });
}

/**
 * Drop served anchors that are no longer LIVE for this path.
 *
 * The served mirror is a growing SET of anchors the model has seen, but an
 * edit RELEASES the anchors of the lines it replaced — and a released anchor
 * lingering in the mirror is what made the served set one entry larger than
 * `anchor_lines` after every edit and undo (#171 probe). A dead anchor is
 * unusable anyway (an edit with it fails as stale), so the mirror is
 * reconciled to the live set: served == persisted == visible.
 *
 * @param sessionKey - the session whose mirror to prune.
 * @param path - the absolute path the anchors belong to.
 * @param content - the path's CURRENT text (the live state's source).
 */
export async function reconcileServed(
  sessionKey: string,
  path: string,
  content: string,
): Promise<void> {
  const live = new Set(anchorsFor(path, content).filter((anchor) => anchor !== ""));
  const store = await loadHashStore();
  withStore(() => {
    const current = store.getServed(sessionKey, path);
    let removed = false;
    for (const anchor of [...current]) {
      if (!live.has(anchor)) {
        current.delete(anchor);
        removed = true;
      }
    }
    if (removed) store.upsertServed(sessionKey, path, [...current]);
  });
}

export async function recordServedTruncated(sessionKey: string, path: string, rows: ServedEntry[], _lineCount: number, _clearFrom = 0): Promise<void> {
  if (rows.length === 0) return;
  const store = await loadHashStore();
  // issue #136/#143: no silent catch (same contract as recordServed).
  withStore(() => {
    const current = store.getServed(sessionKey, path);
    for (const entry of rows) {
      if (entry.anchor !== null) current.add(entry.anchor);
    }
    store.upsertServed(sessionKey, path, [...current]);
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

// --- drift (owned here) ---
export const DRIFT_NOTICE_HEADING = "Drift notice:";

export interface DriftRow {
  anchor: string;
  drifted: boolean;
}

export interface ComputeDriftInput {
  served: Set<string>;
  resultHashes: string[];
  resultLines: string[];
  range: ResolvedRange;
  /** The anchor array BEFORE the edit — used to exclude the edit range's old anchors from drift. */
  originalHashes: string[];
  reported: Set<string>;
  cap?: number;
}

export interface DriftNoticeResult {
  text: string;
  rows: DriftRow[];
  total: number;
  allAlreadyReported: boolean;
}

/**
 * Which of `served` no longer name a line in the result — excluding the edit's
 * own range, whose lines were meant to change.
 *
 * The CALLER decides what to offer as `served`. A session's served set is an
 * accumulator of everything the model was ever shown, so `scanDrift` narrows it
 * to the anchors that were live immediately before the edit: what this function
 * reports is then what the EDIT invalidated, not the session's whole stale
 * history (#151/P4).
 */
export function computeDrift(input: ComputeDriftInput): DriftNoticeResult | undefined {
  const { served, resultHashes, range, originalHashes, reported } = input;
  const resultHashSet = new Set(resultHashes);
  // Anchors that were in the edit range before the edit — expected to disappear, not drift.
  const editRangeAnchors = new Set(originalHashes.slice(range.startLine - 1, range.endLine));
  const driftedAnchors: string[] = [];
  let anyNotReported = false;
  for (const anchor of served) {
    if (resultHashSet.has(anchor)) continue;       // still in file → not drifted
    if (editRangeAnchors.has(anchor)) continue;    // in edit range → expected change
    driftedAnchors.push(anchor);
    if (!reported.has(anchor)) anyNotReported = true;
  }
  const total = driftedAnchors.length;
  if (total === 0) return undefined;
  const countLabel = `${total} anchor(s)`;
  if (!anyNotReported) {
    return {
      text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range are no longer valid and were already reported — call read to refresh.`,
      rows: [],
      total,
      allAlreadyReported: true,
    };
  }
  const rows: DriftRow[] = driftedAnchors.map((anchor) => ({ anchor, drifted: true }));
  return {
    text: `${DRIFT_NOTICE_HEADING} ${countLabel} outside the edited range are no longer valid — call read to refresh.`,
    rows,
    total,
    allAlreadyReported: false,
  };
}

export async function scanDrift(input: { sessionKey: string; served: Set<string>; resultHashes: string[]; resultLines: string[]; range: ResolvedRange; originalHashes: string[]; path: string; io?: FileIO; exec?: ToolExecution }): Promise<string | undefined> {
  const reported = await driftReported(input.sessionKey, input.path);
  // Narrowing `served` is THIS layer's job, not `computeDrift`'s: what the
  // model was served is a session fact, and the session is what accumulates it
  // (#151/P4). `computeDrift` stays the pure walk it always was — "which of
  // these anchors no longer name a line" — so its contract (and its own tests)
  // do not change under a caller that offers it a different set.
  //
  // Only an anchor LIVE immediately before this edit can have been invalidated
  // BY it. The accumulated set still holds the ones an earlier edit (or an
  // external rewrite) already released; re-reporting those on every later edit
  // claimed that anchors had drifted when nothing had moved, and bought the
  // model a pointless re-read. What survives is the real signal: an anchor
  // that was valid, sits outside the edited range, and is gone after the edit
  // — which a healthy incremental update never does, so the notice now says
  // something whenever it appears.
  const liveBefore = new Set(input.originalHashes);
  const served = new Set<string>();
  for (const anchor of input.served) if (liveBefore.has(anchor)) served.add(anchor);
  const result = computeDrift({ ...input, served, reported });
  if (!result || result.allAlreadyReported) return result?.text;
  let servedNote = "";
  try {
    await recordServed(
      input.sessionKey,
      input.path,
      result.rows.map((row) => ({ position: 0, anchor: row.anchor })),
      input.resultLines.length,
    );
  } catch (error) {
    console.error("[E_SERVED_RECORD] failed to record drift rows:", error);
    servedNote = `\n[E_SERVED_RECORD] drift rows could not be recorded (${
      error instanceof Error ? error.message : String(error)
    }); re-read before editing them.`;
  }
  if (input.io !== undefined) await input.io.emitObserved(input.path, input.exec);
  await markDriftReported(input.sessionKey, input.path, result.rows.filter((row) => row.drifted).map((row) => row.anchor));
  return result.text + servedNote;
}
