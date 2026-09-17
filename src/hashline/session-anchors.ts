/**
 * SessionAnchorStore — per-path anchor state for the dynamic-hashline contract.
 *
 * Owns the "session state" decision (spec §4.4 as amended by issue #136):
 * per-path snapshots keyed by content checksum, cached in memory and
 * PERSISTED per cwd + path in the sqlite hash-store (the `anchor_state` row
 * family, wired in by domain/session/hash-store through the persistence port
 * below). True first reads allocate; a cache miss recovers from sqlite;
 * external changes diff-inherit line by line; tool-driven edits update
 * incrementally (unchanged lines keep their anchors; removed lines release
 * theirs; inserted lines allocate fresh ones), preserving the
 * "session-internal anchors never change" promise.
 *
 * THERE IS NO FULL RECOMPUTE for a path that already carries anchors — not
 * after a cache eviction (the cache is a sqlite front-end; eviction only
 * ever loses the COPY), not after an external change (diff-inherit), and not
 * for a poisoned snapshot (positional heal that keeps surviving anchors).
 * `assignAnchors` runs exactly once per path: its true first serve.
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


/**
 * Persistence port — the sqlite hash-store registers an implementation at
 * import time (domain/session/hash-store). All three calls are synchronous
 * (`node:sqlite` is sync). When no store is open for the active workspace
 * yet, `probe`/`get` answer undefined and `put` is a no-op: the state then
 * lives in the cache alone until the first `anchorsFor` call after a store
 * exists flushes it (write-behind, at most once per path).
 */
export interface AnchorStatePersistence {
	/** The persisted state's checksum for a path, or undefined. */
	probe(path: string): string | undefined;
	/** The full persisted state for a path, or undefined. */
	get(path: string): PersistedAnchorState | undefined;
	/** Write the path's state through to the store. */
	put(path: string, state: PersistedAnchorState): void;
}

export interface PersistedAnchorState {
	checksum: string;
	anchors: string[];
	/** Per-line contentKey — the diff basis for inheriting anchors across
	 * external changes / rewrites without re-allocation. */
	lineKeys: number[];
}

let persistence: AnchorStatePersistence | undefined;

/** Wire the persistence backend (hash-store does this at import time;
 * passing undefined reverts to memory-only — a store-less environment). */
export function registerAnchorPersistence(impl: AnchorStatePersistence | undefined): void {
	persistence = impl;
}

/** Memory cache in front of sqlite — NEVER the source of truth. The cap is
 *  * memory hygiene only: an evicted path is recovered from the store, so the
 *  * cap cannot change what any caller sees (that was the #136 bug). */
const store = new Map<string, PersistedAnchorState>();
const lru: string[] = [];
export const ANCHOR_CACHE_LIMIT = 1024;

function setCached(path: string, state: PersistedAnchorState): void {
	const existing = store.get(path);
	if (existing) {
		existing.checksum = state.checksum;
		existing.anchors = state.anchors;
		existing.lineKeys = state.lineKeys;
	} else {
		lru.push(path);
		store.set(path, state);
		while (lru.length > ANCHOR_CACHE_LIMIT) {
			const evict = lru.shift()!;
			store.delete(evict);
		}
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

function dropCached(path: string): void {
	store.delete(path);
	const at = lru.indexOf(path);
	if (at >= 0) lru.splice(at, 1);
}

/**
 * Commit a new state: STORE FIRST, cache second. If the store write throws,
 * the cache is left untouched — the store stays the authority and the caller
 * sees the failure instead of silently running on a state no other process
 * will ever see (issue #136: persistence failures are loud, never swallowed).
 */
function commit(path: string, checksum: string, anchors: string[], lineKeys: number[]): void {
	const state: PersistedAnchorState = { checksum, anchors, lineKeys };
	persistence?.put(path, state);
	setCached(path, state);
}
// ----------------------------------------------------------------------------
// THE unified anchor lifecycle gate.
//
// Allocation happens in EXACTLY two situations, and nowhere else:
//   1. a line is served for the FIRST time — no cache entry AND no persisted
//      state for this path (its true first serve, project-wide);
//   2. a line's CONTENT actually changed (alignment-paired survivor lines
//      keep their anchors — being inside an edit range is not enough).
//
// Every other acquisition INHERITS: the state — from the cache or, after a
// miss, recovered from the persisted store (issue #136: an eviction used to
// recompute the whole file, silently re-anchoring unchanged lines) — is
// diffed line-by-line by contentKey alignment and unchanged lines keep their
// anchors. A state too damaged to inherit from heals positionally (keep
// every anchor that exists, allocate only the gaps) and says so loudly.
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

	// Cross-process invalidation: the cache is trusted only while the store
	// agrees with it. A probe checksum that differs means another session or
	// process moved the file state forward — drop the cache and reload.
	let cached = store.get(path);
	if (cached && persistence) {
		const diskChecksum = persistence.probe(path);
		if (diskChecksum === undefined) {
			// The state predates this workspace's store (the store-less window
			// at the start of a process): flush it once, so every other session
			// sees the same anchors — an anchor is a property of the file, not
			// of a session.
			persistence.put(path, cached);
		} else if (diskChecksum !== cached.checksum) {
			dropCached(path);
			cached = undefined;
		}
	}
	let st = cached;
	if (!st && persistence) {
		const disk = persistence.get(path);
		if (disk) {
			st = disk;
			setCached(path, disk); // backfill — recovery, not recompute
		}
	}
	if (st) {
		refreshLru(path);
		if (st.checksum === checksum) {
			if (st.anchors.length === lines.length && st.lineKeys.length === lines.length) {
				return st.anchors;
			}
			// issue #66/B4 + #136: a same-checksum length drift means the
			// STORED state itself is damaged (partial write / updater bug).
			// The honest response keeps every anchor that exists and allocates
			// only the gaps — a full rebuild would silently re-anchor lines the
			// model was already served.
			return healState(path, st, lines, checksum, "E_ANCHOR_STATE_POISONED");
		}
		// Content changed since the last serve: inherit by alignment. Unchanged
		// lines KEEP their anchors; only genuinely new content allocates. This
		// is the rule for rewrites AND external modifications alike.
		const inherited = inheritAnchors(st, lines);
		if (inherited !== undefined) {
			commit(path, checksum, inherited, lines.map(contentKey));
			return inherited;
		}
		// st exists but predates usable lineKeys (a legacy snapshot): heal
		// positionally. Unreachable for every state this module writes — kept
		// as the loud terminal fallback, with NO recompute path.
		return healState(path, st, lines, checksum, "E_ANCHOR_STATE_LEGACY");
	}
	// True first serve for this path: deterministic shortest-first allocation.
	const anchors = assignAnchors(lines);
	commit(path, checksum, anchors, lines.map(contentKey));
	return anchors;
}

/**
 * Terminal fallback for a state too damaged to inherit from (anchors and
 * lineKeys disagree, or the legacy no-lineKeys shape). Positional heal:
 * keep each stored anchor that is still unique at its position, allocate
 * fresh anchors only for the gaps. NEVER a full recompute — every anchor
 * the model may still hold keeps meaning the same line it meant before.
 */
function healState(
	path: string,
	st: PersistedAnchorState,
	lines: string[],
	checksum: string,
	code: string,
): string[] {
	console.error(
		`[${code}] ${path}: stored anchor state is inconsistent ` +
			`(anchors ${st.anchors.length}, lineKeys ${st.lineKeys.length}, content ${lines.length} lines); ` +
			`healing positionally — surviving anchors keep their lines, gaps allocate fresh.`,
	);
	const merged: (string | undefined)[] = new Array(lines.length);
	const used = new Set<string>();
	const keep = Math.min(st.anchors.length, lines.length);
	for (let i = 0; i < keep; i++) {
		const anchor = st.anchors[i]!;
		if (!used.has(anchor)) {
			merged[i] = anchor;
			used.add(anchor);
		}
	}
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	for (let i = 0; i < lines.length; i++) {
		if (merged[i] !== undefined) continue;
		const key = contentKey(lines[i]!);
		let gc = cursorByKey.get(key);
		if (!gc) {
			gc = { offsets: {} };
			cursorByKey.set(key, gc);
		}
		const { anchor } = allocateAnchor(used, lines[i]!, gc);
		used.add(anchor);
		merged[i] = anchor;
	}
	const anchors = merged as string[];
	commit(path, checksum, anchors, lines.map(contentKey));
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
function inheritAnchors(st: PersistedAnchorState, lines: string[]): string[] | undefined {
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
	commit(path, contentChecksum(content), anchors, lines.map(contentKey));
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
	commit(path, contentChecksum(newContent), merged, newLines.map(contentKey));
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
