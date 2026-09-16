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
import { splitLines } from "../infra/utils.js";
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
	/** Per-line contentKey — the diff basis for inheriting anchors across
	 * external changes / rewrites without re-allocation. */
	lineKeys: number[];
}

const store = new Map<string, PathState>();
const lru: string[] = [];
const MAX_PATHS = 256;

function upsert(path: string, checksum: string, anchors: string[], lineKeys: number[]) {
	const existing = store.get(path);
	if (!existing) {
		lru.push(path);
		store.set(path, { checksum, anchors, lineKeys });
		while (lru.length > MAX_PATHS) {
			const evict = lru.shift()!;
			store.delete(evict);
		}
	} else {
		existing.checksum = checksum;
		existing.anchors = anchors;
		existing.lineKeys = lineKeys;
	}
}

/** LRU is only useful if HITS refresh recency — the old FIFO let hot files
 *  be evicted while merely-recently-written cold ones stayed. */
function refreshLru(path: string): void {
	const at = lru.indexOf(path);
	if (at >= 0 && at !== lru.length - 1) {
		lru.splice(at, 1);
		lru.push(path);
	}
}

// ----------------------------------------------------------------------------
// THE unified anchor lifecycle gate.
//
// Allocation happens in EXACTLY two situations, and nowhere else:
//   1. a line is served for the FIRST time (no prior state for this path);
//   2. a line's CONTENT actually changed (alignment-paired survivor lines
//      keep their anchors — being inside an edit range is not enough).
//
// Any other call — a rewrite, an external modification, an LRU miss —
// INHERITS: prior state is diffed line-by-line (by contentKey alignment) and
// unchanged lines keep their anchors. There is no whole-file recompute for
// files that already carry anchors.
// ----------------------------------------------------------------------------
export function anchorsFor(path: string, content: string): string[] {
	// Content-base normalization (BOM + CRLF→LF), mirroring edit-diff's
	// stripBOM+toLF — kept here because hashline is the bottom layer and
	// cannot import render/. WITHOUT this, grep/lsp/ast (raw io.readText) and
	// read/edit (normalized) produce different anchors for the SAME file
	// depending on which tool served last (the raw-vs-normalized dual-source
	// bug), and the snapshot checksum flip-flops between the two bases.
	const bom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	content = bom.includes("\r\n") ? bom.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : bom;
	const checksum = contentChecksum(content);
	const lines = splitLines(content);
	const st = store.get(path);
	if (st) {
		if (st.checksum === checksum) {
			refreshLru(path);
			// issue #66/B4: same checksum with length drift means the snapshot
			// itself is corrupt (poisoned) — deterministic rebuild is the only
			// honest response. This is NOT the external-change path.
			if (st.anchors.length === lines.length) return st.anchors;
			const rebuilt = assignAnchors(lines);
			upsert(path, checksum, rebuilt, lines.map(contentKey));
			return rebuilt;
		}
		// Content changed since the last serve: inherit by alignment. Unchanged
		// lines KEEP their anchors; only genuinely new content allocates. This
		// is the rule for rewrites AND external modifications alike.
		const inherited = inheritAnchors(st, lines);
		if (inherited !== undefined) {
			upsert(path, checksum, inherited, lines.map(contentKey));
			return inherited;
		}
		// st exists but predates lineKeys (legacy in-process snapshot): the
		// inherited state is unavailable, so fall back to a deterministic pass.
		// Transitions once; every subsequent miss inherits.
	}
	// True first serve for this path: deterministic shortest-first allocation.
	const anchors = assignAnchors(lines);
	upsert(path, checksum, anchors, lines.map(contentKey));
	return anchors;
}

/** Deterministic whole-content anchors without session state (PURE path —
 *  test/dev and explicit no-session callers only; never for serving lines
 *  whose anchors the session has already handed out). */
export function anchorsPure(content: string): string[] {
	return assignAnchors(splitLines(content));
}

/**
 * Diff-inherit: pair old lines to new lines by contentKey (LCS, latest-first,
 * via {@link alignPreserved}); paired lines keep their anchors, unpaired new
 * lines allocate against the live pool (released + survivor-reserved), and
 * released-but-unreused anchors simply return to the pool.
 *
 * Returns `undefined` when the prior state carries no lineKeys (a legacy
 * in-process snapshot from before this field existed) — the caller then
 * falls back to a deterministic pass, once.
 */
function inheritAnchors(st: PathState, lines: string[]): string[] | undefined {
	if (st.anchors.length !== st.lineKeys.length) return undefined;
	const newKeys = lines.map(contentKey);
	const paired = alignPreserved(st.lineKeys, newKeys);
	const used = new Set(st.anchors);
	const reserved = new Set<string>();
	for (const oldIdx of paired.values()) {
		const anchor = st.anchors[oldIdx];
		if (anchor !== undefined) {
			reserved.add(anchor);
			used.add(anchor);
		}
	}
	const merged: string[] = [];
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	for (let k = 0; k < lines.length; k++) {
		const pairedOld = paired.get(k);
		const kept = pairedOld === undefined ? undefined : st.anchors[pairedOld];
		if (kept !== undefined && reserved.has(kept)) {
			merged.push(kept);
			continue;
		}
		const key = newKeys[k]!;
		let gc = cursorByKey.get(key);
		if (!gc) {
			gc = { offsets: {} };
			cursorByKey.set(key, gc);
		}
		const { anchor } = allocateAnchor(used, lines[k]!, gc);
		used.add(anchor);
		merged.push(anchor);
	}
	return merged;
}

/**
 * Re-attach a KNOWN anchor array to `content` — the undo path's door.
 *
 * `undo.hashes` were allocated (first-serve rule) for exactly these lines
 * before the edit; the revert restores that content, so re-seeding this state
 * keeps the anchors the revert diff just served the model. Not a recompute:
 * a validation (length must match) plus a state write.
 *
 * @returns false when `anchors` does not cover every line — caller falls back
 * to the normal lifecycle.
 */
export function seedAnchors(path: string, content: string, anchors: string[]): boolean {
	const lines = splitLines(content);
	if (anchors.length !== lines.length) return false;
	upsert(path, contentChecksum(content), anchors, lines.map(contentKey));
	return true;
}

/**
 * Incremental update after a tool-driven edit. Hunks must be sorted in
 * ascending original order; every anchor outside the hunks is preserved
 * verbatim (the session-internal immutability promise), removed lines release
 * their anchors for reuse, and inserted lines allocate against the released
 * pool (shortest-first, per spec §4.2/§4.5). Maintains the per-line
 * contentKeys the external-change diff-inheritance aligns on.
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
		// Lines that SURVIVED this hunk keep their anchors. Paired by ALIGNMENT
		// rather than by content alone (`alignPreserved`, latest-first): with two
		// identical lines a content-keyed match cannot say which survived, and
		// it handed the survivor its sibling's anchor. A `replace` keeps the
		// anchor of the line it closed with.
		//
		// RESERVE every anchor a survivor is about to reclaim, BEFORE any fresh
		// allocation: a changed line earlier in the hunk could otherwise allocate
		// straight onto the anchor a later survivor needs.
		const oldSeg = oldLines.slice(h.oldStart1 - 1, Math.min(h.oldEnd1, oldLines.length));
		const newSeg = newLines.slice(h.finalStart1 - 1, Math.min(h.finalEnd1, newLines.length));
		const preserved = alignPreserved(oldSeg, newSeg);
		const segStart = h.finalStart1 - 1;
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
			// dereferencing undefined into canon(). With correct bookkeeping these
			// hunks always land inside the file; a bad hunk now degrades to a
			// length-mismatched snapshot that anchorsFor() rebuilds instead of
			// crashing the next edit.
			if (k >= newLines.length) continue;
			const paired = preserved.get(k - segStart);
			const kept = paired === undefined ? undefined : oldAnchors[h.oldStart1 - 1 + paired];
			if (kept !== undefined && reserved.has(kept)) {
				merged.push(kept);
				continue;
			}
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
	upsert(path, contentChecksum(newContent), merged, merged.map(contentKey));
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
function alignPreserved(oldSeg: readonly unknown[], newSeg: readonly unknown[]): Map<number, number> {
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
