/**
 * SessionAnchorStore — per-path anchor state for the dynamic-hashline contract.
 *
 * LAZY, SPARSE allocation (#169): anchors exist only for lines a tool has
 * SERVED to the model. A line the model has never seen has no anchor and
 * costs nothing — grep/read on a huge file no longer pay whole-file
 * allocation, and the size gates that papered over that cost go away.
 *
 * Uniqueness is guaranteed against the path's PERSISTED allocated-anchor set
 * (fetched from the store before probing), never by whole-file
 * pre-allocation — that is what lets an anchor be minted late without
 * colliding.
 *
 * A minted anchor is bound to its line's content (contentKey): when the file
 * changes, served lines whose content survived keep their anchors, and lines
 * whose content changed release theirs. The #151/P1 class of order-dependent
 * mis-binding is structurally impossible: the anchor names the line, not an
 * allocation order.
 *
 * @module dsh-hashline-edittool/hashline/session-anchors
 */
import { splitLines } from "../infra/utils.js";
import { allocateAnchor, contentKey } from "./alloc.js";
import { contentChecksum } from "./hash-assign.js";

// ---- types -----------------------------------------------------------------

export interface EditHunk {
	/** 1-indexed first line of the hunk's range in the ORIGINAL snapshot. */
	oldStart1: number;
	/**
	 * 1-indexed last line of the hunk's range in the ORIGINAL snapshot.
	 *
	 * `oldEnd1 < oldStart1` is an EMPTY range — a pure insertion (`op:"ins"`),
	 * whose anchor line sits OUTSIDE the hunk and therefore keeps its anchor.
	 */
	oldEnd1: number;
	/** 1-indexed first line of the hunk's replacement in the FINAL file. */
	finalStart1: number;
	/** 1-indexed last line of the hunk's replacement in the FINAL file (oldStart1 when empty). */
	finalEnd1: number;
}

export interface PersistedAnchorLine {
	line: number;
	anchor: string;
	contentKey: number;
}

export interface PersistedAnchorState {
	checksum: string;
	lineCount: number;
	lines: PersistedAnchorLine[];
}

export interface AnchorStatePersistence {
	probe(path: string): string | undefined;
	get(path: string): PersistedAnchorState | undefined;
	put(path: string, state: PersistedAnchorState): void;
	putLines(path: string, lines: PersistedAnchorLine[]): void;
}

let persistence: AnchorStatePersistence | undefined;

export function registerAnchorPersistence(impl: AnchorStatePersistence | undefined): void {
	persistence = impl;
}

// ---- the per-path sparse state ---------------------------------------------

interface AnchorEntry {
	anchor: string;
	contentKey: number;
}


interface SparseState {
	checksum: string;
	lineCount: number;
	/** line (1-based) → {anchor, contentKey} for every ALLOCATED line. */
	entries: Map<number, AnchorEntry>;
}
/** Content-base normalization (BOM + CRLF→LF): raw io.readText (grep/lsp/ast)
 * and normalized read text must produce the SAME state — without this the two
 * spellings of one file checksum differently and thrash the state.
 */
function normalizeContent(content: string): string {
	const bom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	return bom.includes("\r\n") ? bom.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : bom;
}

/** Load (or initialize) the sparse state for `content`, realigning on change. */
function ensureState(path: string, rawContent: string): SparseState {
	const content = normalizeContent(rawContent);
	const checksum = contentChecksum(content);
	const currentLines = splitLines(content);
	const lineCount = currentLines.length;
	let cached = store.get(path);
	if (cached && persistence) {
		const diskChecksum = persistence.probe(path);
		if (diskChecksum === undefined) {
			// Store-less window: flush once so other sessions agree.
			persistence.put(path, projectionOf(path, cached));
		} else if (diskChecksum !== cached.checksum) {
			dropCached(path);
			cached = undefined;
		}
	}
	if (!cached && persistence) {
		const disk = persistence.get(path);
		if (disk) {
			// THE allocator invariant, enforced at the state-entry gate: one
			// anchor names at most ONE line — a persisted row set that repeats
			// an anchor is upstream corruption. Heal loudly by refusing the rows
			// (wipe + fresh start), never trust them.
			const seen = new Set<string>();
			for (const line of disk.lines) {
				if (seen.has(line.anchor)) {
					console.error(
						`[E_ANCHOR_STATE_DUP] ${path}: persisted anchor rows repeat an anchor — healing by re-seeding fresh.`,
					);
					persistence.put(path, { checksum: disk.checksum, lineCount: disk.lineCount, lines: [] });
					cached = { checksum, lineCount, entries: new Map() };
					setCached(path, cached);
					return cached;
				}
				seen.add(line.anchor);
			}
			cached = { checksum: disk.checksum, lineCount: disk.lineCount, entries: new Map(disk.lines.map((l) => [l.line, { anchor: l.anchor, contentKey: l.contentKey }])) };
			setCached(path, cached);
		}
	}
	if (!cached) {
		cached = { checksum, lineCount, entries: new Map() };
		setCached(path, cached);
		return cached;
	}
	// The content changed since the state was written (an EXTERNAL change —
	// tool edits go through the hunk-aware updateAnchorsAfterEdit instead):
	// pair served entries to their surviving content by contentKey (LCS over
	// served lines only) so a served line keeps its anchor at its new
	// position; content that vanished releases its anchor for reuse.
	if (cached.checksum !== checksum || cached.lineCount !== lineCount) {
		const ordered = [...cached.entries].sort((a, b) => a[0] - b[0]);
		const paired = alignPreserved(
			ordered.map(([, e]) => e.contentKey),
			currentLines.map(contentKey),
		);
		const realigned = new Map<number, AnchorEntry>();
		for (const [newIdx, oldIdx] of paired) {
			realigned.set(newIdx + 1, ordered[oldIdx]![1]);
		}
		cached.entries = realigned;
		cached.checksum = checksum;
		cached.lineCount = lineCount;
		persistProjection(path, cached);
	}
	return cached;
}

const store = new Map<string, SparseState>();
const lru: string[] = [];
export const ANCHOR_CACHE_LIMIT = 1024;

function setCached(path: string, state: SparseState): void {
	if (!store.has(path)) lru.push(path);
	store.set(path, state);
	while (lru.length > ANCHOR_CACHE_LIMIT) {
		const evict = lru.shift()!;
		store.delete(evict);
	}
}

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

// ---- the lifecycle ---------------------------------------------------------


/** The persistence projection of a sparse state (allocated lines only). */
function projectionOf(path: string, state: SparseState): PersistedAnchorState {
	const lines: PersistedAnchorLine[] = [];
	for (const [line, entry] of [...state.entries].sort((a, b) => a[0] - b[0])) {
		lines.push({ line, anchor: entry.anchor, contentKey: entry.contentKey });
	}
	return { checksum: state.checksum, lineCount: state.lineCount, lines };
}

/**
 * The dense VIEW of the path's sparse state: served lines carry their
 * allocated anchors, never-served lines carry "".
 *
 * This is the compatibility shim for callers that index a whole-file array.
 * It materializes per call (transient) and does NOT allocate.
 */
export function anchorsFor(path: string, rawContent: string): string[] {
	const content = normalizeContent(rawContent);
	const state = ensureState(path, content);
	const out = new Array<string>(splitLines(content).length).fill("");
	for (const [line, entry] of state.entries) {
		if (line >= 1 && line <= out.length) out[line - 1] = entry.anchor;
	}
	return out;
}

/**
 * Get-or-allocate anchors for exactly the requested lines (#169).
 *
 * Each requested line: if the sparse state already holds an entry whose
 * contentKey matches the CURRENT content, the existing anchor is returned —
 * the line is unchanged and its anchor is still valid. Otherwise a fresh
 * anchor is allocated against the path's used-anchor set (all anchors the
 * file has already given out), persisted immediately, and returned.
 *
 * Lines outside the file's range get `""` — there is nothing to name.
 */
/** Get-or-allocate against a GIVEN state (no load, no persist). */
function allocateInto(
	state: SparseState,
	content: string,
	lines: number[],
): string[] {
	const currentLines = splitLines(content);
	const used = new Set<string>();
	for (const [, entry] of state.entries) used.add(entry.anchor);
	// Per-content probe continuity (same design as assignAnchors): a run of
	// identical lines probes CONTIGUOUSLY instead of re-walking the used set
	// for every copy — without the cursor, a long duplicate run degenerates to
	// O(k²) probes and can exhaust the probe cap.
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	const out: string[] = [];
	for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
		if (line < 1 || line > currentLines.length) {
			out.push("");
			continue;
		}
		const text = currentLines[line - 1]!;
		const key = contentKey(text);
		const existing = state.entries.get(line);
		if (existing && existing.contentKey === key) {
			out.push(existing.anchor);
			continue;
		}
		// The line's content changed (or it was never served): release the old
		// anchor and mint a fresh one.
		if (existing) used.delete(existing.anchor);
		let gc = cursorByKey.get(key);
		if (!gc) {
			gc = { offsets: {} };
			cursorByKey.set(key, gc);
		}
		const { anchor } = allocateAnchor(used, text, gc);
		used.add(anchor);
		state.entries.set(line, { anchor, contentKey: key });
		out.push(anchor);
	}
	return out;
}

export function allocateForLines(
	path: string,
	rawContent: string,
	lines: number[],
): string[] {
	const content = normalizeContent(rawContent);
	const state = ensureState(path, content);
	const out = allocateInto(state, content, lines);
	persistProjection(path, state);
	return out;
}

/**
 * Apply a line-range edit to the sparse state: entries in the changed range
 * are released (their content changed), entries below shift by `delta`.
 */
export function applyEditToState(
	path: string,
	changeStart: number,
	changeEnd: number,
	delta: number,
): void {
	const state = store.get(path);
	if (!state) return;
	const shifted = new Map<number, AnchorEntry>();
	for (const [line, entry] of state.entries) {
		if (line < changeStart) {
			shifted.set(line, entry);
		} else if (line > changeEnd) {
			shifted.set(line + delta, entry);
		}
		// entries in [changeStart, changeEnd] are dropped: their content changed
	}
	state.entries = shifted;
	persistProjection(path, state);
}

function persistProjection(path: string, state: SparseState): void {
	if (!persistence) return;
	persistence.put(path, projectionOf(path, state));
}


/**
 * Whole-content allocation for callers without a path (tests, previews).
 * Never persists — the caller's anchors are transient.
 */
export function anchorsPure(content: string): string[] {
	const lines = splitLines(content);
	const used = new Set<string>();
	const out: string[] = [];
	for (const text of lines) {
		const { anchor } = allocateAnchor(used, text);
		used.add(anchor);
		out.push(anchor);
	}
	return out;
}

/**
 * Post-edit anchor update — the HUNK-AWARE transform (#169).
 *
 * The edit's own hunks define the mapping, so the session-internal promise
 * (#151) holds exactly: served lines OUTSIDE the hunks keep their anchors at
 * their shifted positions; served lines INSIDE a hunk's old range are
 * released (their content was replaced); the hunks' new lines allocate
 * fresh (the response serves them). Whole-file LCS cannot tell an inserted
 * block ending with the same line from a moved line — hunk boundaries can.
 */
export function updateAnchorsAfterEdit(args: {
	path: string;
	oldContent: string;
	newContent: string;
	oldAnchors: string[];
	hunks: EditHunk[];
}): string[] {
	const newContent = normalizeContent(args.newContent);
	const oldContent = normalizeContent(args.oldContent);
	const newChecksum = contentChecksum(newContent);
	const newLineCount = splitLines(newContent).length;
	// runFileEdits calls this per edit (applyOne) AND once more from the
	// original coordinates for the whole batch. The old dense model was a
	// pure rebuild so the double call was harmless; the sparse state is
	// ADVANCED by each call, so re-applying the hunks would double-shift.
	// The per-edit calls' incremental composition is already correct — if
	// the state reflects newContent, materialize and return.
	const current = store.get(args.path);
	if (current && current.checksum === newChecksum && current.lineCount === newLineCount) {
		return anchorsFor(args.path, newContent);
	}
	const state = ensureState(args.path, oldContent);
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	// Seed from `oldAnchors` — the caller's pre-edit materialization. Fills a
	// state with no entries for these lines (direct callers, unit tests) and
	// is a no-op when the state already carries them (the real flow:
	// oldAnchors was materialized FROM the state). "" never seeds — an
	// unallocated line stays unallocated.
	for (let i = 0; i < args.oldAnchors.length && i < oldLines.length; i++) {
		const anchor = args.oldAnchors[i]!;
		if (anchor === "" || state.entries.has(i + 1)) continue;
		state.entries.set(i + 1, { anchor, contentKey: contentKey(oldLines[i]!) });
	}
	const ordered = [...args.hunks].sort((a, b) => a.oldStart1 - b.oldStart1);
	const shifted = new Map<number, AnchorEntry>();
	// In-hunk SURVIVOR pairing (issue #122): a replaced line whose content
	// survives keeps its anchor — the invariant is "not in the diff", not
	// "outside the hunk". A pure ins/del has an empty side and pairs nothing
	// (#151): the anchor line stays outside the hunk, every inserted line is
	// fresh.
	const freshLines: number[] = [];
	for (const h of ordered) {
		const oldSeg = oldLines.slice(h.oldStart1 - 1, Math.min(h.oldEnd1, oldLines.length));
		const newSeg = newLines.slice(h.finalStart1 - 1, Math.min(h.finalEnd1, newLines.length));
		const preserved = alignPreserved(oldSeg, newSeg);
		const survivingOld = new Set(preserved.values());
		// release the replaced (non-surviving) in-hunk entries: they simply do
		// not carry over into `shifted`
		for (const [newIdx, oldIdx] of preserved) {
			const entry = state.entries.get(h.oldStart1 + oldIdx);
			if (entry) shifted.set(h.finalStart1 + newIdx, entry);
		}
		for (let k = 0; k < newSeg.length; k++) {
			if (!preserved.has(k)) freshLines.push(h.finalStart1 + k);
		}
	}
	// Entries OUTSIDE all hunks shift by the accumulated delta of the hunks
	// above them — the session-internal immutability promise.
	for (const [line, entry] of state.entries) {
		let inHunk = false;
		let newPos = line;
		for (const h of ordered) {
			if (line >= h.oldStart1 && line <= h.oldEnd1) {
				inHunk = true;
				break;
			}
			if (h.oldEnd1 < line) {
				newPos += (h.finalEnd1 - h.finalStart1 + 1) - (h.oldEnd1 - h.oldStart1 + 1);
			}
		}
		if (!inHunk) shifted.set(newPos, entry);
	}
	state.entries = shifted;
	state.checksum = newChecksum;
	state.lineCount = newLineCount;
	// The edit response serves the changed region: the hunk new lines that
	// did not keep a survivor's anchor allocate fresh (each is a line the
	// model is about to see).
	allocateInto(state, newContent, freshLines);
	persistProjection(args.path, state);
	return anchorsFor(args.path, newContent);
}

/**
 * Pair old lines to new lines by content (LCS, latest-first) — the EXTERNAL
 * change path's alignment (no hunk structure exists there). A pure insert
 * or delete has nothing to pair on one side; the walk is skipped.
 */
function alignPreserved(
	oldSeg: readonly unknown[],
	newSeg: readonly unknown[],
): Map<number, number> {
	const m = oldSeg.length;
	const n = newSeg.length;
	if (m === 0 || n === 0) return new Map();
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
