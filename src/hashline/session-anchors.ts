/**
 * SessionAnchorStore — per-path anchor state for the dynamic-hashline contract.
 *
 * Owns the "session state" decision (spec §4.4): per-path snapshots keyed by
 * content checksum, kept in memory only (no disk persistence). First read /
 * external change → deterministic full recompute; tool-driven edits →
 * incremental update (unchanged lines keep their anchors; removed lines
 * release theirs; inserted lines allocate fresh ones), preserving the
 * "session-internal anchors never change" promise.
 *
 * @module dsh-hashline-edittool/hashline/session-anchors
 */
import { splitLines } from "../utils.js";
import { assignAnchors, allocateAnchor, contentKey } from "./alloc.js";
import { contentChecksum } from "./hash-assign.js";

export interface EditHunk {
  /** 1-indexed first line of the hunk's range in the ORIGINAL snapshot. */
  oldStart1: number;
  /** 1-indexed last line of the hunk's range in the ORIGINAL snapshot. */
  oldEnd1: number;
  /** 1-indexed first line of the hunk's replacement in the FINAL file. */
  finalStart1: number;
  /** 1-indexed last line of the hunk's replacement in the FINAL file (oldStart1 when empty). */
  finalEnd1: number;
}

interface PathState {
  checksum: string;
  anchors: string[];
}

const store = new Map<string, PathState>();
const lru: string[] = [];
const MAX_PATHS = 256;

function upsert(path: string, checksum: string, anchors: string[]) {
  if (!store.has(path)) {
    lru.push(path);
    store.set(path, { checksum, anchors });
    while (lru.length > MAX_PATHS) {
      const evict = lru.shift()!;
      store.delete(evict);
    }
  } else {
    store.get(path)!.checksum = checksum;
    store.get(path)!.anchors = anchors;
  }
}

/**
 * Anchors for `path` at `content`: returns the cached snapshot when the
 * checksum matches, otherwise recomputes deterministically (first read or
 * external change) and stores it.
 */
export function anchorsFor(path: string, content: string): string[] {
  const checksum = contentChecksum(content);
  const st = store.get(path);
  if (st && st.checksum === checksum) {
    // issue #66/B4: a poisoned snapshot (length drift vs the actual lines) used
    // to be trusted forever, surfacing later as "fileAnchors.length must match
    // fileLines.length" on the next edit. Length-mismatch ⇒ treat as stale and
    // deterministically recompute; the session anchor-preservation promise only
    // holds for consistent snapshots anyway.
    if (st.anchors.length === splitLines(content).length) return st.anchors;
  }
  const anchors = assignAnchors(splitLines(content));
  upsert(path, checksum, anchors);
  return anchors;
}

/** Deterministic whole-content anchors without session state (pure path). */
export function anchorsPure(content: string): string[] {
  return assignAnchors(splitLines(content));
}

/**
 * Incremental update after a tool-driven edit. Hunks must be sorted in
 * ascending original order; every anchor outside the hunks is preserved
 * verbatim (the session-internal immutability promise), removed lines release
 * their anchors for reuse, and inserted lines allocate against the released
 * pool (shortest-first, per spec §4.2/§4.5).
 */
export function updateAnchorsAfterEdit(args: {
  path: string;
  oldContent: string;
  newContent: string;
  oldAnchors: string[];
  hunks: EditHunk[];
}): string[] {
	const { path, oldContent, newContent, oldAnchors, hunks } = args;
	// Batch paths report hunks in APPLICATION order (descending); the merge
	// requires ascending original order — normalize defensively.
	const ordered = [...hunks].sort((a, b) => a.oldStart1 - b.oldStart1);
	const newLines = splitLines(newContent);
	const used = new Set(oldAnchors);
	for (const h of ordered) {
		for (let i = h.oldStart1 - 1; i < h.oldEnd1; i++) used.delete(oldAnchors[i]!);
	}
	// Per-content probe continuity (same design as assignAnchors) so batches
	// of identical inserted lines don't spill prematurely on the probe cap.
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	const merged: string[] = [];
	let cursor = 0;
	for (const h of ordered) {
		merged.push(...oldAnchors.slice(cursor, h.oldStart1 - 1));
		for (let k = h.finalStart1 - 1; k < h.finalEnd1; k++) {
			// issue #66/B4: defensively skip out-of-range rows instead of
			// dereferencing undefined into canon() ("cannot read properties of
			// undefined (reading 'replace')"). With correct bookkeeping these
			// hunks always land inside the file; a bad hunk now degrades to a
			// length-mismatched snapshot that anchorsFor() recomputes instead of
			// crashing the next edit.
			if (k >= newLines.length) continue;
			const key = contentKey(newLines[k]!);
			let gc = cursorByKey.get(key);
			if (!gc) {
				gc = { offsets: {} };
				cursorByKey.set(key, gc);
			}
			const { anchor } = allocateAnchor(used, newLines[k]!, gc);
			used.add(anchor);
			merged.push(anchor);
		}
		cursor = h.oldEnd1;
	}
	merged.push(...oldAnchors.slice(cursor));
	upsert(path, contentChecksum(newContent), merged);
	return merged;
}