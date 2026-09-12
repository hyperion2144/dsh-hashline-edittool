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
	const oldLines = splitLines(oldContent);
	for (const h of ordered) {
		// Lines that SURVIVED this hunk keep their anchors. Releasing the whole
		// hunk and re-allocating every line made a row whose text had not
		// changed come back with a different anchor — sometimes a duplicate
		// sibling's old one, because both were free at the same moment.
		//
		// Paired by ALIGNMENT rather than by content alone: with two identical
		// lines a content-keyed match cannot say which survived, and it handed
		// the survivor its sibling's anchor. `alignPreserved` pairs latest-first,
		// so a `replace` keeps the anchor of the line it closed with.
		const oldSeg = oldLines.slice(h.oldStart1 - 1, Math.min(h.oldEnd1, oldLines.length));
		const newSeg = newLines.slice(h.finalStart1 - 1, Math.min(h.finalEnd1, newLines.length));
		const preserved = alignPreserved(oldSeg, newSeg);
		const segStart = h.finalStart1 - 1;
		//
		// RESERVE every anchor a survivor is about to reclaim, BEFORE any fresh
		// allocation. The whole hunk's anchors were released above, so a changed
		// line earlier in the hunk could otherwise allocate straight onto the
		// anchor a later survivor needs — and that survivor would then fail its
		// reclaim and be re-anchored. Rare, but the property is meant to be a
		// GUARANTEE: a line that is not in the diff keeps its anchor.
		//
		const reserved = new Set<string>();
		for (const oldIdx of preserved.values()) {
			const anchor = oldAnchors[h.oldStart1 - 1 + oldIdx];
			if (anchor !== undefined) {
				reserved.add(anchor);
				used.add(anchor);
			}
		}
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
			// A surviving line reclaims its own anchor. `used` still guards the
			// A survivor claims the anchor reserved for it above. No `used` check:
			// the reservation put it there, and a valid alignment never pairs two
			// lines onto one old index.
			const paired = preserved.get(k - segStart);
			const kept = paired === undefined ? undefined : oldAnchors[h.oldStart1 - 1 + paired];
			if (kept !== undefined && reserved.has(kept)) {
				merged.push(kept);
				continue;
			}
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
/**
 * Pair a hunk's old and new lines by content, latest-first.
 *
 * Content alone cannot name the survivor when a line appears twice: a bucket
 * keyed by content handed the survivor its SIBLING's anchor. Alignment fixes
 * that by using relative order, and the walk runs from the END so the trailing
 * match wins — which is what a `replace` means, since its closing line is the
 * one being kept.
 *
 * @param oldSeg - the hunk's old lines.
 * @param newSeg - the hunk's new lines.
 * @returns new index -> old index, for the lines worth carrying an anchor over.
 */
function alignPreserved(oldSeg: readonly string[], newSeg: readonly string[]): Map<number, number> {
	const m = oldSeg.length;
	const n = newSeg.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i]![j] =
				oldSeg[i - 1] === newSeg[j - 1]
					? dp[i - 1]![j - 1]! + 1
					: Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
		}
	}
	const pairs = new Map<number, number>();
	let i = m;
	let j = n;
	while (i > 0 && j > 0) {
		if (oldSeg[i - 1] === newSeg[j - 1]) {
			pairs.set(j - 1, i - 1);
			i -= 1;
			j -= 1;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	return pairs;
}
