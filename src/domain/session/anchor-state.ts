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
 * @module dsh-hashline-edittool/domain/session/anchor-state
 */
import { splitLines } from "../../infra/utils.js";
import { allocateInto, contentKey, type AnchorEntry, type SparseState } from "../../hashline/alloc.js";
import { contentChecksum } from "../../hashline/hash-assign.js";
import { alignPreservedBounded } from "../../hashline/align-bounded.js";
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
	/**
	 * Write the file-level row (checksum + line count) and remove a line row.
	 *
	 * Both are called from INSIDE a transaction owned by the session layer
	 * (`anchorFor` commits the anchor rows and the session's served set
	 * together, contract §7), so they must not open one of their own —
	 * SQLite has no nested `BEGIN`.
	 *
	 * @param path - the file's absolute path.
	 * @param checksum - the content checksum the rows now correspond to.
	 * @param lineCount - the file's current line count.
	 * @param dropLine - a line whose row must be removed, if any.
	 */
	putMeta(path: string, checksum: string, lineCount: number, dropLine?: number): void;
}

let persistence: AnchorStatePersistence | undefined;

export function registerAnchorPersistence(impl: AnchorStatePersistence | undefined): void {
	persistence = impl;
}

// ---- the per-path sparse state ---------------------------------------------

/** Content-base normalization (BOM + CRLF→LF): raw io.readText (grep/lsp/ast)
 * and normalized read text must produce the SAME state — without this the two
 * spellings of one file checksum differently and thrash the state.
 */
export function normalizeContent(content: string): string {
	const bom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	return bom.includes("\r\n") ? bom.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : bom;
}

/**
 * The file's sparse state for `content`, read LIVE from `anchor_lines`,
 * realigned when the file changed underneath it.
 *
 * **No in-process cache, deliberately.** The rows are the record; a cached
 * copy is a second source that can disagree with them, and §2.3 is explicit
 * that the `(path, anchor)` index exists so a question about an anchor does
 * not need the file's anchors materialised first. One path's rows are a small
 * indexed read — correctness is worth more here than the cache was.
 *
 * Realigning is a WRITE, so this belongs to the allocate path (`anchorFor`,
 * §2.1 item 1). Readers read `persistedAnchorLines` directly instead.
 *
 * @param path - absolute path the state belongs to.
 * @param rawContent - the file's current text (already read by the caller).
 * @returns the state, realigned to `content` when it had drifted.
 */
function ensureState(path: string, rawContent: string): SparseState {
	const content = normalizeContent(rawContent);
	const checksum = contentChecksum(content);
	const currentLines = splitLines(content);
	const lineCount = currentLines.length;
	// Store-less window (pure unit tests, a mount with no store): nothing to read
	// and nowhere to write back to.
	if (!persistence) return { checksum, lineCount, entries: new Map() };

	const disk = persistence.get(path);
	if (!disk) {
		// A file the store has never seen. NOT persisted here: the caller's
		// single write-back commits rows + meta + served together (§2.1 item 5).
		return { checksum, lineCount, entries: new Map<number, AnchorEntry>() };
	}

	// THE allocator invariant, enforced at the state-entry gate: one anchor
	// names at most ONE line — a persisted row set that repeats an anchor is
	// upstream corruption. Heal it by dropping ONLY the later duplicates and
	// repairing the projection, never by discarding the file's whole state: a
	// wholesale wipe turns one bad row into `[E_STALE]` for every anchor the
	// session legitimately holds (reported from a live session as "an anchor I
	// just read no longer exists"), which is a far worse failure than losing one
	// duplicated line's anchor. First occurrence wins: rows are keyed by line,
	// so the keeper is deterministic.
	const seen = new Set<string>();
	const kept = disk.lines.filter((line) => {
		if (seen.has(line.anchor)) return false;
		seen.add(line.anchor);
		return true;
	});
	if (kept.length !== disk.lines.length) {
		console.error(
			`[E_ANCHOR_STATE_DUP] ${path}: persisted anchor rows repeat an anchor — dropped ${disk.lines.length - kept.length} duplicate row(s), kept the rest.`
		);
		persistence.put(path, { checksum: disk.checksum, lineCount: disk.lineCount, lines: kept });
	}
	const state: SparseState = {
		checksum: disk.checksum,
		lineCount: disk.lineCount,
		entries: new Map(kept.map((l) => [l.line, { anchor: l.anchor, contentKey: l.contentKey }])),
	};

	// The content changed since the rows were written (an EXTERNAL change —
	// tool edits go through the hunk-aware updateAnchorsAfterEdit instead):
	// pair served entries to their surviving content by contentKey (LCS over
	// served lines only) so a served line keeps its anchor at its new
	// position; content that vanished releases its anchor for reuse.
	if (state.checksum !== checksum || state.lineCount !== lineCount) {
		const ordered = [...state.entries].sort((a, b) => a[0] - b[0]);
		const aligned = alignPreservedBounded(
			ordered.map(([, e]) => e.contentKey),
			currentLines.map(contentKey),
		);
		// A whole-file realign is the one call that can degrade (#182): the DP is
		// bounded, and past the bound a low-similarity rewrite returns an empty
		// mapping — every anchor this session holds for the file is gone. Record
		// it so the next tool result can say so instead of leaving the model with
		// anchors that silently stopped existing.
		if (aligned.degraded) noteAlignmentDegraded(path);
		const paired = aligned.pairs;
		const realigned = new Map<number, AnchorEntry>();
		for (const [newIdx, oldIdx] of paired) {
			realigned.set(newIdx + 1, ordered[oldIdx]![1]);
		}
		state.entries = realigned;
		state.checksum = checksum;
		state.lineCount = lineCount;
		persistProjection(path, state);
	}
	return state;
}

// The per-path cache and its LRU are GONE (contract §3, map #214's destination).
//
// They made this module hold mutable store-scoped state, and they let two
// questions that only `anchor_lines` may answer be
// answered from memory instead: "which anchors does this file have allocated"
// (§2.1 item 3) and "is this anchor still live" (§2.2 condition 1). A cache that
// can disagree with the rows is a second source of truth by definition, which is
// the thing this whole refactor removes.
//
// `dropAllAnchorState` is gone with them: there is no cache to drop when the
// store disappears, so the store's shutdown drops the port registration instead.

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
 * The dense VIEW of the file's anchor rows: a line with an allocated anchor
 * carries it, every other line carries `""`.
 *
 * A READ, in every sense: it projects `anchor_lines` and writes nothing. It
 * deliberately does NOT realign on a checksum mismatch — realigning is a write,
 * §2.1 item 1 puts it on the allocate path (`anchorFor`), and §5 gives the tool
 * layer the explicit remap. A renderer that silently rewrote anchor rows was a
 * second writer for one fact.
 *
 * **NOT an allocation entry point.** It mints nothing, serves nothing and
 * records nothing, so a caller may render a view it has not served. Everything
 * that MINTS goes through `anchorFor` (directly, or through the scope-aware
 * `anchorForInWorkspace`), which is what keeps the used-set, the release pool
 * and the served record in one place. Read this name for what to SHOW; reach
 * for the mint for what the model may WRITE with.
 *
 * @param path - absolute path to project.
 * @param rawContent - the file's current text (supplies the length only).
 * @returns one anchor per line, `""` where none is allocated.
 */
export function anchorsFor(path: string, rawContent: string): string[] {
	const content = normalizeContent(rawContent);
	const out = new Array<string>(splitLines(content).length).fill("");
	for (const row of persistedAnchorLines(path)) {
		if (row.line >= 1 && row.line <= out.length) out[row.line - 1] = row.anchor;
	}
	return out;
}





/**
 * Load (or initialize) the sparse state for `content`, realigning on change.
 *
 * Exposed for the session layer's anchor entry point (#223), which composes
 * allocation with the per-session served write in one transaction: it needs the
 * state, the checksum/line-count it corresponds to, and a way to persist the
 * projection — without this module having to know what a session is.
 *
 * @param path - absolute path the state belongs to.
 * @param rawContent - the file's current text (normalized inside).
 * @returns the live sparse state, realigned if the file changed underneath.
 */
export function ensureAnchorState(path: string, rawContent: string): SparseState {
	return ensureState(path, rawContent);
}

/**
 * Commit a sparse state's projection, DIFFED against what is already stored.
 *
 * Named rather than inlined so `domain/session/anchor-entry` can commit anchor
 * rows and the session's served set inside ONE store transaction (contract §7).
 *
 * Diffing matters twice over. Correctness: a full rewrite is DELETE-all +
 * INSERT-all, and doing that inside a transaction the caller also uses is both
 * wasteful and impossible to compose (see `putMeta`). Cost: the measured write
 * amplification of the rewrite is ~187× at the anchor counts this store
 * reaches (#217), and re-inserting 600 untouched rows to record one mint is
 * exactly that.
 *
 * Every write here opens NO transaction of its own: `putMeta` and `putLines`
 * are transaction-agnostic by contract, so this composes inside the caller's.
 *
 * @param path - absolute path the state belongs to.
 * @param state - the state to project.
 */
export function persistAnchorState(path: string, state: SparseState): void {
	if (!persistence) return;
	// What is on disk NOW, so only the difference is written. `probe` and `get`
	// read the stored rows; they never trigger a realign (this is not
	// `ensureState`).
	const stored = persistence.get(path);
	const previous = new Map<number, PersistedAnchorLine>();
	for (const row of stored?.lines ?? []) previous.set(row.line, row);
	const next = projectionOf(path, state);
	const nextByLine = new Map<number, PersistedAnchorLine>();
	for (const row of next.lines) nextByLine.set(row.line, row);

	// A line whose row disappeared (released, or its content changed) must have
	// its row deleted — `putLines` only upserts, so a stale row would linger and
	// keep the anchor alive in a table that is supposed to hold only live ones.
	const dropped: number[] = [];
	for (const [line, row] of previous) {
		const now = nextByLine.get(line);
		if (!now || now.anchor !== row.anchor || now.contentKey !== row.contentKey) dropped.push(line);
	}
	for (const line of dropped) persistence.putMeta(path, next.checksum, next.lineCount, line);

	const upserts: PersistedAnchorLine[] = [];
	for (const row of next.lines) {
		const was = previous.get(row.line);
		if (!was || was.anchor !== row.anchor || was.contentKey !== row.contentKey) upserts.push(row);
	}
	persistence.putLines(path, upserts);
	// The meta row always carries the current checksum/line count: it is what
	// tells the next reader the file is in sync, including when every change in
	// this write was a deletion.
	persistence.putMeta(path, next.checksum, next.lineCount);
}

/**
 * The checksum PERSISTED for `path`, or `undefined` when the file has never
 * been served (or no store is wired yet).
 *
 * Distinct from the live state's checksum on purpose: the validation primitive
 * needs to know whether the file changed since the state was written, and
 * loading the state overwrites that answer with the current content.
 *
 * @param path - absolute path to query.
 * @returns the stored checksum, or `undefined` when there is no row.
 */
export function persistedAnchorChecksum(path: string): string | undefined {
	return persistence?.probe(path);
}
/**
 * The anchor ROWS the store holds for `path` — one per line, in line order.
 *
 * THE anchor facts. `anchor_lines` is the anchor table (contract §8), and
 * §2.2/§2.3 make it the authority for both questions the primitives ask: "is
 * this anchor live, and on which line, bound to which content key" (§2.1.2's
 * reuse test, §2.2 condition 1's liveness test).
 *
 * Read live, per call. There is no in-process cache of the answer: a cached
 * copy is a second source that can disagree with the rows, and §2.3 is explicit
 * that the `(path, anchor)` index is there so the answer does NOT need the
 * file's anchors materialised first.
 *
 * A READER, not a second allocation path: minting still happens in exactly one
 * place (`allocateInto`, reached only through `anchorFor`).
 *
 * @param path - absolute path to read the anchor rows of.
 * @returns the rows, in line order; empty when the store holds none.
 */
export function persistedAnchorLines(path: string): PersistedAnchorLine[] {
	return persistence?.get(path)?.lines ?? [];
}

/**
 * The anchors of {@link persistedAnchorLines}, without the line keys.
 *
 * The "already allocated anchors" set that allocation must avoid (contract
 * §2.1 item 3, first source; §8: "集合就是 `anchor_lines` 本身").
 *
 * @param path - absolute path to read the allocated anchors of.
 * @returns the anchors, in line order.
 */
export function persistedAnchorsFor(path: string): string[] {
	return persistedAnchorLines(path).map((row) => row.anchor);
}
/**
 * The single write path for anchor state: `persistAnchorState` above.
 *
 * Kept as a named indirection so the lifecycle call sites (`ensureState`'s
 * realign, `applyEditToState`, `updateAnchorsAfterEdit`) read the same way they
 * always did, while the store only ever sees ONE writer. Two writers over the
 * same rows is how a stale checksum gets written back on top of a fresh one:
 * the realign inside `ensureState` refreshes the checksum first, and a caller
 * that captured the pre-realign value then overwrote it.
 *
 * @param path - absolute path the state belongs to.
 * @param state - the state to project.
 */
function persistProjection(path: string, state: SparseState): void {
	persistAnchorState(path, state);
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
	/**
	 * OUT: the 1-based lines whose anchors this transform DROPPED, appended in
	 * place.
	 *
	 * An out-parameter rather than a changed return type because this function
	 * has ~40 call sites in the suite that only want the hashes. The caller
	 * that owns a session (the edit engine) passes an array and then completes
	 * the release — see `releaseLines` in `domain/session/anchor-entry` (#223).
	 *
	 * Dropping a row here is only ONE third of a release: it says nothing to the
	 * releasing session's served set and puts nothing in the call's release
	 * pool. Anything not paired through this array is the silent-wrong-line
	 * window #217 §1 describes.
	 */
	released?: number[];
	/**
	 * The anchors this allocation must avoid: the file's live rows **∪ the
	 * session's release pool** (contract §2.1 item 3, §4.1).
	 *
	 * Passed IN rather than derived here, because the pool is session state and
	 * this module is the pure layer (§3): the caller owns it. It must be passed
	 * by every caller that has a session — minting the hunk's fresh lines against
	 * the file's rows ALONE would reissue an anchor this same call just released,
	 * which is §9 invariant 5 (本轮不重发) and the window §4.2 exists to close.
	 */
	used?: Set<string>;
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
	// §7: the "is it already advanced?" question is answered from the ROWS, not
	// from a cache. `runFileEdits` calls this per edit (applyOne) and once more
	// from the original coordinates for the whole batch; the old dense model was a
	// pure rebuild so the double call was harmless, while this one ADVANCES the
	// rows, so re-applying the hunks would double-shift.
	const persisted = persistence?.get(args.path);
	if (
		persisted !== undefined &&
		persisted.checksum === newChecksum &&
		persisted.lineCount === newLineCount
	) {
		// Already advanced by the per-edit call: nothing is dropped HERE, so
		// `released` is deliberately left untouched. The caller that passes the
		// array must therefore pass the SAME array to every call for one edit, not
		// a fresh one per call — otherwise this early return silently swallows the
		// releases the first call recorded.
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
	/**
	 * Original 1-based lines whose anchor SURVIVED an in-hunk content pairing.
	 *
	 * Tracked explicitly because `shifted` is keyed by the FINAL position, so
	 * "did this line survive?" cannot be read back out of it from the original
	 * coordinates (the hunk that dropped a line may have moved the ones after
	 * it). Needed to tell a survivor from a release (#223).
	 */
	const survivors = new Set<number>();
	for (const h of ordered) {
		const oldSeg = oldLines.slice(h.oldStart1 - 1, Math.min(h.oldEnd1, oldLines.length));
		const newSeg = newLines.slice(h.finalStart1 - 1, Math.min(h.finalEnd1, newLines.length));
		const hunkAligned = alignPreservedBounded(oldSeg, newSeg);
		// The hunk path can degrade too (a hunk is usually small, but a whole-file
		// rewrite arrives as one huge hunk). Same one-shot notice as the realign.
		if (hunkAligned.degraded) noteAlignmentDegraded(args.path);
		const preserved = hunkAligned.pairs;
		// release the replaced (non-surviving) in-hunk entries: they simply do
		// not carry over into `shifted`
		for (const [newIdx, oldIdx] of preserved) {
			const oldLine = h.oldStart1 + oldIdx;
			const entry = state.entries.get(oldLine);
			if (entry) {
				shifted.set(h.finalStart1 + newIdx, entry);
				survivors.add(oldLine);
			}
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
		if (inHunk) {
			// Inside a replaced range. It survives only if the in-hunk content pairing
			// kept it; otherwise its anchor is going away and the caller has to
			// COMPLETE the release — dropping the row here says nothing to the
			// releasing session's served set and nothing to this call's release pool
			// (#223, contract §4).
			if (!survivors.has(line)) args.released?.push(line);
		} else {
			shifted.set(newPos, entry);
		}
	}
	state.entries = shifted;
	state.checksum = newChecksum;
	state.lineCount = newLineCount;
	// The edit response serves the changed region: the hunk new lines that
	// did not keep a survivor's anchor allocate fresh (each is a line the
	// model is about to see).
	//
	// The avoid-set is the UNION of two things, and both are needed:
	//
	//  * the caller's `used` — the file's live rows ∪ the session's release pool
	//    (§2.1 item 3, §4.1). Minting WITHOUT it re-issues an anchor this same call
	//    just released, which is §9 invariant 5 (本轮不重发) and the window §4.2
	//    exists to close; a caller that has a session must pass it.
	//  * this state's own anchors. The state is seeded from `oldAnchors` and may
	//    hold a row the store does not yet (a direct caller with no store, or a
	//    line whose row lands with the write-back), and handing one of those out
	//    twice would break uniqueness — invariant 1.
	const avoid = new Set<string>(args.used ?? []);
	for (const [, entry] of state.entries) {
		if (entry.anchor !== "") avoid.add(entry.anchor);
	}
	allocateInto(state, newContent, freshLines, avoid);
	persistProjection(args.path, state);
	return anchorsFor(args.path, newContent);
}

/**
 * Alignment-degradation notices, one per path, drained by the tool layer.
 *
 * A degraded realign (#182) returns an empty mapping: every anchor the model
 * holds for that file stops existing. Shipping that silently is the failure
 * this registry exists to prevent — the model would keep editing with anchors
 * that are simply gone. The tool layer drains the notice into its warnings
 * (model-visible, one line, no new error code), and draining CLEARS it so the
 * same degradation is not repeated at every later call.
 */
const alignmentNotices = new Map<string, string>();

/** What the model is told when an alignment degraded and dropped its anchors. */
export const ALIGNMENT_DEGRADED_NOTICE =
  "\u8be5\u6587\u4ef6\u6539\u52a8\u8fc7\u5927\uff0c\u65e7\u951a\u70b9\u5df2\u4f5c\u5e9f\uff1b\u8bf7\u91cd\u65b0 read \u8be5\u6587\u4ef6\u83b7\u53d6\u65b0\u951a\u70b9\u3002";

/**
 * Record that a file's realign degraded. Idempotent per path until drained.
 * @param path - the absolute path whose anchors were invalidated.
 */
export function noteAlignmentDegraded(path: string): void {
  alignmentNotices.set(path, ALIGNMENT_DEGRADED_NOTICE);
}

/**
 * Take (and clear) the pending degradation notice for a path — if any.
 * @param path - the absolute path about to be rendered in a tool result.
 * @returns the one-line notice, or undefined when nothing degraded.
 */
export function takeAlignmentNotice(path: string): string | undefined {
  const notice = alignmentNotices.get(path);
  if (notice !== undefined) alignmentNotices.delete(path);
  return notice;
}

/** Test seam: forget every pending notice (suites must not leak into each other). */
export function resetAlignmentNotices(): void {
  alignmentNotices.clear();
}
/**
 * Signature-compatible wrapper around the bounded aligner (ADR-0011).
 *
 * The original call sites — `ensureState`'s whole-file realign and the hunk
 * survivor pairing in `updateAnchorsAfterEdit` — iterate the returned Map
 * and don't care about the degradation channel. They keep the same
 * signature; the bounded aligner lives in `./align-bounded.ts` and is the
 * exported test seam (see its module header for the memory bound formula).
 *
 * Degradation is logged once per process via the bounded module's own
 * one-shot `[alignPreserved]` log line — that is sufficient today; if a
 * caller later needs the boolean, expose `alignPreservedBounded` directly.
 */
function alignPreserved(
	oldSeg: readonly unknown[],
	newSeg: readonly unknown[],
): Map<number, number> {
	return alignPreservedBounded(oldSeg, newSeg).pairs;
}
