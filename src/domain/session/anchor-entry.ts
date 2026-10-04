/**
 * The anchor ENTRY POINT — the two primitives every tool goes through (#223).
 *
 * The contract (`docs/anchor-entry-contract.md` §2) collapses anchor handling
 * into exactly two functions, and this module is where they live:
 *
 *  - {@link anchorFor} — mint-or-reuse anchors for the lines a tool is about to
 *    RETURN to the model, and record them as served in the SAME transaction.
 *    Allocation is a write; it must happen after the response is truncated, so
 *    that "the model has an anchor" stays equivalent to "the model saw the
 *    line".
 *  - {@link probeLines} — answer "may I write these anchors?", reading only.
 *    Per line, three things must hold; a file checksum is NOT one of them.
 *
 * Two primitives rather than one entry point with a mode: allocation creates
 * identity and changes persistent state, validation must never write. Merging
 * them would make every caller wonder whether it might allocate by accident.
 *
 * ### Why this is a separate module from `domain/session/anchor-state`
 *
 * The domain layer owns the anchor lifecycle and knows nothing about sessions,
 * sqlite, or workspaces. Serving is per-SESSION state, and it has to be written
 * in the same transaction as the allocation that produced it — that is the
 * whole point of the primitive. So the composition lives here, in the session
 * layer, and `tools/` calls only this.
 *
 * ### The release pool (§4.1)
 *
 * Releasing an anchor means three things at once: drop it from `anchor_lines`,
 * drop it from the RELEASING session's served set, and put it in the release
 * pool so the same call cannot hand it straight back to another line. The pool
 * is per-file, in memory, and lives exactly as long as one `edit` call — a
 * permanent retirement set would grow with session length and is explicitly not
 * wanted. It exists because the anchor state releases anchors inside
 * its own allocation path, where it cannot see a session.
 *
 * @module dsh-hashline-edittool/domain/session/anchor-entry
 */

import { contentKey } from "../../hashline/alloc.js";
import { contentChecksum } from "../../hashline/hash-assign.js";
import { splitLines } from "../../infra/utils.js";
import { allocateInto, type SparseState } from "../../hashline/alloc.js";
import { ensureAnchorState, normalizeContent, persistAnchorState, persistedAnchorChecksum, persistedAnchorLines, persistedAnchorsFor } from "./anchor-state.js";
import type { PersistedAnchorLine } from "./anchor-state.js";
import { loadHashStore, withStore, withStoreAsync } from "./hash-store.js";
import { loadServed } from "./served.js";

// --- types (contract §2.1 / §2.2) -------------------------------------------

/** One anchor the caller holds, with the line number it BELIEVES it is on. */
export interface AnchorRef {
	readonly anchor: string;
	/**
	 * The line number the model reported. INFORMATION, not evidence: it is only
	 * used to tell the model its number drifted, and never to accept or reject.
	 */
	readonly line?: number;
}

/** Input to {@link anchorFor}. */
export interface AnchorForInput {
	/** Absolute path; workspace scope is the caller's `withWorkspace`. */
	readonly path: string;
	/** 1-based lines that will ACTUALLY reach the model (after truncation). */
	readonly lines: readonly number[];
	/** The file's current normalized text. The caller has read it; we do not. */
	readonly content: string;
	/** dsh session key; served state is isolated per session. */
	readonly sessionKey: string;
}

/** Result of {@link anchorFor}. */
export interface AnchorForResult {
	/** One per input line, same order; `""` for a line outside the file. */
	readonly anchors: readonly string[];
	/** The anchors minted in this call (the rest were reused). */
	readonly minted: readonly string[];
}

/** Why {@link probeLines} refused, which picks the model-facing wording (§2.4). */
export type ProbeReason = "never-seen" | "line-changed" | "line-moved" | "not-live";

/** One line that failed validation, as the echo needs it. */
export interface InvalidRow {
	/** The line's CURRENT number. */
	readonly line: number;
	/** The anchor that line currently carries (`""` when it has none). */
	readonly current: string;
	/** The anchor the caller passed. */
	readonly given: string;
	readonly contentKey: number;
}

/** Input to {@link probeLines}. */
export interface ProbeInput {
	readonly path: string;
	readonly content: string;
	readonly refs: readonly AnchorRef[];
	readonly sessionKey: string;
}

/** Every ref resolved. */
export interface ProbeOk {
	readonly ok: true;
	/** One per input ref, same order. */
	readonly resolved: readonly { anchor: string; line: number }[];
	/** Resolved anchors that fell outside the probed range, anchor → line. */
	readonly mapped: ReadonlyMap<string, number>;
}

/** At least one ref failed; nothing is applied. */
export interface ProbeFail {
	readonly ok: false;
	/** The offending lines, in file order. */
	readonly rows: readonly InvalidRow[];
	readonly reason: ProbeReason;
}

// --- the release pool (§4.1) -------------------------------------------------

/**
 * Anchors released during the CURRENT edit call, keyed by path.
 *
 * Scope is one `edit` call × one file, in memory. A later call may hand these
 * anchors out again — that is allowed and intended; what must not happen is a
 * call releasing an anchor and then giving it to a different line in the same
 * breath, while the model still holds the old meaning.
 */
const releasePools = new Map<string, Set<string>>();

/** The anchors this call has released for `path` (never undefined). */
export function releasePoolFor(path: string): Set<string> {
	let pool = releasePools.get(path);
	if (!pool) {
		pool = new Set();
		releasePools.set(path, pool);
	}
	return pool;
}

/** Record `anchors` as released for `path` during this call. */
export function markReleased(path: string, anchors: Iterable<string>): void {
	const pool = releasePoolFor(path);
	for (const anchor of anchors) pool.add(anchor);
}

/**
 * Drop `path`'s release pool. Called when the edit call that owns it ends, so
 * the next call starts clean; also on the error path, so a failed edit cannot
 * leave anchors frozen past its own lifetime.
 */
export function clearReleasePool(path?: string): void {
	if (path === undefined) releasePools.clear();
	else releasePools.delete(path);
}

// --- the restore primitive (undo, contract §2 "undo") ----------------------

/**
 * Replace `path`'s anchor binding with a saved one — the state half of undo.
 *
 * Undo is specified as a SNAPSHOT ROLLBACK, not a remap: content, the
 * line → anchor binding, and the checksum all go back together to what they
 * were before the edit. Remapping (pairing the current anchors against the
 * restored content by content key) is the wrong tool here: it would keep the
 * anchors the undon edit minted, and lose the exact handles the model held
 * before — so a model that undoes and re-submits its previous edit would be
 * rejected for holding anchors "it never saw".
 *
 * `hashes` is the DENSE binding the edit path already saves (`UndoRecord`),
 * one entry per line, `""` meaning "this line has no anchor". Only non-empty
 * entries are seeded, so a line the model never saw stays unseen.
 *
 * The caller is responsible for having restored the CONTENT first: the pairs
 * written here are content keys computed from `content`, so a mismatched pair
 * would make the binding claim something the file does not say.
 *
 * @param input - path, the restored content, and the saved binding.
 * @returns how many lines were re-bound (0 when nothing was saved).
 */
export function restoreAnchorBinding(input: {
	readonly path: string;
	readonly content: string;
	readonly hashes: readonly string[];
}): number {
	const { path, content, hashes } = input;
	const lines = splitLines(content);
	const rebuilt = new Map<number, { anchor: string; contentKey: number }>();
	for (let i = 0; i < hashes.length && i < lines.length; i++) {
		const anchor = hashes[i];
		if (anchor === undefined || anchor === "") continue;
		rebuilt.set(i + 1, { anchor, contentKey: contentKey(lines[i]!) });
	}
	if (rebuilt.size === 0) return 0;
	// Built from the SNAPSHOT, not from `ensureState`.
	//
	// `ensureState` would first REALIGN the post-edit rows onto the reverted
	// content — work whose result this function overwrites two lines later, but
	// which it PERSISTS on the way: a wasted write, plus a window in which other
	// sessions can read a binding that is neither the pre- nor the post-undo one.
	// The whole point of the undo snapshot is that the answer is already known.
	//
	// Wholesale replacement, not a merge: the binding IS the snapshot, and keeping
	// an entry the snapshot does not have would leave a line anchored to something
	// the model was never shown.
	const state: SparseState = {
		checksum: contentChecksum(content),
		lineCount: lines.length,
		entries: rebuilt,
	};
	// ONE transaction for the whole rebind, per contract §7. `persistAnchorState`
	// deliberately does not open one (its sibling callers already have), so
	// without this every `putMeta`/`putLines` autocommitted on its own: a failure
	// midway left the file's binding half-restored — some lines carrying the
	// snapshot's anchors and the rest still carrying the post-edit ones, which is
	// a state neither the pre- nor the post-undo world can explain.
	withStore(() => {
		persistAnchorState(path, state);
	});
	// A restored anchor must not be treated as "released this call": the whole
	// point is that it is usable again, immediately.
	const pool = releasePools.get(path);
	if (pool) for (const anchor of rebuilt.values()) pool.delete(anchor.anchor);
	return rebuilt.size;
}

// --- the allocation primitive (§2.1) ----------------------------------------

/**
 * The used-set an allocation for `path` must not hand out.
 *
 * Exactly two sources (contract §2.1 item 3, as corrected):
 *
 *  1. every anchor the FILE currently has live, read from `anchor_lines`;
 *  2. the anchors released during THIS call (the release pool, §4.1).
 *
 * **No store-wide source.** Anchors are scoped to a file — two files may
 * legitimately carry the same anchor string — so avoiding another file's
 * anchors would forbid strings that are perfectly valid here, at the cost of a
 * full-table query. §2.1's "全库已分配锚点兜底" described no such thing; it is
 * the file's own rows, which source 1 already is.
 *
 * Exported so every allocate-capable call site builds it the same way: the
 * remap path (`updateAnchorsAfterEdit`) mints too, and minting there without the
 * pool would re-issue an anchor the same call just released (§9 invariant 5).
 *
 * @param path - the file being allocated for.
 * @returns the set to avoid: a private copy the caller may mutate.
 */
export function allocationUsedSet(path: string): Set<string> {
	return usedAnchorsFor(path, persistedAnchorsFor(path));
}

/**
 * The used-set for allocation, from the pieces already in hand.
 *
 * @param path - the file being allocated for.
 * @param live - the file's live anchors.
 * @returns the set to avoid: a private copy the caller may mutate.
 */
function usedAnchorsFor(path: string, live: Iterable<string>): Set<string> {
	// A COPY: `allocateInto` adds every successful mint to this set as it goes
	// (that is how it keeps one call's mints distinct), and mutating the pool
	// itself would leave those fresh anchors looking released.
	const used = new Set<string>(live);
	for (const anchor of releasePoolFor(path)) used.add(anchor);
	return used;
}

/**
 * Mint or reuse an anchor for each of `lines`, and mark them served in the
 * same transaction.
 *
 * Reuse is keyed by CONTENT: a line that already has an anchor whose recorded
 * content key matches the line's current text keeps that anchor — the model's
 * handle on an unchanged line therefore survives an edit elsewhere in the file.
 * A line whose content changed, or that was never served, gets a fresh anchor.
 *
 * Only `lines` is considered. A line truncated out of the response is not
 * allocated and not marked served, so it stays invisible to the model until
 * something actually returns it.
 *
 * @param input - path, the exact lines being returned, content, session key.
 * @returns the anchors, aligned with `input.lines`, plus which were minted.
 */
export async function anchorFor(input: AnchorForInput): Promise<AnchorForResult> {
	// §7: ONE transaction per file, wrapping the rows read, the allocation that
	// avoids them, and the write-back that records them.
	//
	// The read and the write cannot be separated: two sessions that read the
	// same used-set, mint the same anchor and write in sequence leave the second
	// caller holding a handle the first one also has (invariant 1). Joining an
	// ENCLOSING transaction (rather than opening a second `BEGIN`) is what keeps
	// the batch edit path — which already holds one — a single unit.
	await loadHashStore();
	let outcome: AnchorForResult = { anchors: [], minted: [] };
	await withStoreAsync(async () => {
		outcome = await anchorForInTransaction(input);
	});
	return outcome;
}

/**
 * `anchorFor`'s body, run inside the caller's transaction.
 *
 * Split out rather than re-indented so the body reads as it did: the wrapper
 * above owns the transaction, this owns the decision.
 *
 * @param input - path, the exact lines being returned, content, session key.
 * @returns the anchors, aligned with `input.lines`, plus which were minted.
 */
async function anchorForInTransaction(input: AnchorForInput): Promise<AnchorForResult> {
	const { path, sessionKey } = input;
	// NORMALIZED first, and everything below keys off this value.
	//
	// `ensureState` normalizes (BOM + CRLF→LF) to compute the file checksum, so
	// keying lines off the RAW text gave one file two spellings: a caller that
	// passed the un-normalized `io.readText` text minted anchors whose contentKey
	// disagreed with the rows the same call persisted, and the next call over the
	// normalized text re-minted every line. Measured: serving the BOM/CRLF
	// spelling and then the clean text for the SAME path produced different
	// anchors for line 1.
	const content = normalizeContent(input.content);
	const lines = [...input.lines];
	const state = ensureAnchorState(path, content);
	// Taken from the STATE, not recomputed here: loading the file may have
	// realigned the state (an external change), and a value captured before that
	// would be the pre-realign checksum. Writing it back would leave the row
	// claiming the file is unchanged when it is not — the staleness that turns
	// every later reader into a spurious remap.
	const checksum = state.checksum;
	const currentLines = splitLines(content);
	const lineCount = currentLines.length;

	// Reuse where the content still matches; everything else is a candidate for
	// a fresh mint. `allocateInto` below sees only the misses, so the reuse test
	// lives here — it is the one place that knows both the persisted key and the
	// current text.
	const anchors = new Array<string>(lines.length).fill("");
	const misses: number[] = [];
	const anchorRows = persistedAnchorLines(path);
	const rowsByLine = new Map<number, PersistedAnchorLine>();
	for (const row of anchorRows) rowsByLine.set(row.line, row);
	const used = usedAnchorsFor(path, anchorRows.map((row) => row.anchor));
	/** Line → freshly minted anchor, so a repeat request inside one call reuses it. */
	const mintedByLine = new Map<number, string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!Number.isInteger(line) || line < 1 || line > lineCount) continue;
		const key = contentKey(currentLines[line - 1]!);
		// §2.1 item 2: reuse when `anchor_lines` HAS the line and its recorded
		// content key still matches the current text.
		const existing = rowsByLine.get(line);
		if (existing && existing.contentKey === key) {
			anchors[i] = existing.anchor;
			// Keep the working state in step with the row just reused, or the
			// write-back at the end would persist a projection missing it.
			state.entries.set(line, { anchor: existing.anchor, contentKey: key });
			continue;
		}
		const alreadyMinted = mintedByLine.get(line);
		if (alreadyMinted !== undefined) {
			anchors[i] = alreadyMinted;
			continue;
		}
		misses.push(line);
	}

	const minted: string[] = [];
	if (misses.length > 0) {
		// `allocateInto` mints against `used` (which already carries the live set
		// and this call's release pool) and writes into `state.entries`.
		const fresh = allocateInto(state, content, misses, used);
		for (let i = 0; i < misses.length; i++) {
			const anchor = fresh[i]!;
			if (anchor !== "") {
				mintedByLine.set(misses[i]!, anchor);
				minted.push(anchor);
			}
		}
		for (let i = 0; i < lines.length; i++) {
			if (anchors[i] === "") anchors[i] = mintedByLine.get(lines[i]!) ?? "";
		}
	}

	await persist(path, state, checksum, lineCount, sessionKey, anchors);
	return { anchors, minted };
}
/**
 * Write the state back and record the served anchors, in ONE transaction.
 *
 * Two writes that must not be separable: an anchor that exists but was never
 * recorded as served is rejected on the next edit ("never seen"), and a served
 * anchor that was never minted is unreachable. Allocating without serving — or
 * serving without allocating — is how the "never served" rows were born, so
 * they commit together or not at all.
 *
 * @param path - the file's absolute path.
 * @param state - the sparse state after allocation.
 * @param checksum - the content checksum that state corresponds to.
 * @param lineCount - the file's current line count.
 * @param sessionKey - whose served set to extend.
 * @param anchors - the anchors that will be visible to the model.
 */
async function persist(
	path: string,
	state: SparseState,
	checksum: string,
	lineCount: number,
	sessionKey: string,
	anchors: readonly string[],
): Promise<void> {
	state.checksum = checksum;
	state.lineCount = lineCount;
	const store = await loadHashStore();
	withStore(() => {
		persistAnchorState(path, state);
		const visible = anchors.filter((anchor) => anchor !== "");
		if (visible.length === 0) return;
		const current = store.getServed(sessionKey, path);
		for (const anchor of visible) current.add(anchor);
		store.upsertServed(sessionKey, path, [...current]);
	});
}

// --- the release primitive (§4) ---------------------------------------------

/**
 * Release an anchor: three things must happen together, or none.
 *
 *  1. it stops being live (`anchor_lines` loses the row), so no later check can
 *     find it — this is what makes an old handle structurally unusable rather
 *     than merely discouraged;
 *  2. it leaves the RELEASING session's served set. Only that session's: the
 *     others never released anything, and their records are handled by the
 *     per-line verdict plus the echo (§2.4);
 *  3. it enters this call's release pool, so the same call cannot hand it
 *     straight to a different line.
 *
 * Missing (1) is the original silent-wrong-line defect (#217 §1): the anchor
 * came back for another line while the model still held it, and the served
 * check passed. Missing (3) leaves the same hole inside a single call.
 *
 * `anchor_lines` and the served row commit in ONE transaction — an anchor that
 * is dead but still recorded as served is a refusal waiting to confuse someone,
 * and one that is served but dead is exactly the state the defect needs.
 *
 * @param input - path, the lines whose anchors are going away, content, session.
 * @returns the anchors that were released (for the pool and for reporting).
 */
export async function releaseLines(input: {
	readonly path: string;
	readonly lines: readonly number[];
	readonly content: string;
	readonly sessionKey: string;
}): Promise<readonly string[]> {
	const { path, content, sessionKey } = input;
	const state = ensureAnchorState(path, content);
	const released: string[] = [];
	for (const line of [...new Set(input.lines)].sort((a, b) => a - b)) {
		const entry = state.entries.get(line);
		if (entry === undefined) continue;
		// (1) out of the live set. Deleting from the in-memory map is what makes
		// `persistAnchorState` drop the row: it diffs against the store.
		state.entries.delete(line);
		released.push(entry.anchor);
	}
	if (released.length === 0) return released;

	// (3) into this call's pool before anything can allocate.
	markReleased(path, released);
	// (2) out of the releasing session's served set, and (1) committed, together.
	const store = await loadHashStore();
	withStore(() => {
		persistAnchorState(path, state);
		const served = store.getServed(sessionKey, path);
		let changed = false;
		for (const anchor of released) {
			if (served.delete(anchor)) changed = true;
		}
		if (changed) store.upsertServed(sessionKey, path, [...served]);
	});
	return released;
}


// `lineKeyAt` and `servedFor` lived here. Both were exported and never called:
// the first re-derived a line's content key (the primitives compute it inline
// where they already hold the line), the second was a one-line wrapper over
// `loadServed`. Dead surface on a module whose whole point is TWO entry points
// is worse than no surface — a reader has to check whether it is a second path.

// --- the validation primitive (§2.2) ---------------------------------------

/**
 * Answer whether the caller may write the lines it named.
 *
 * Per line, three conditions, ALL of which must hold:
 *
 *  1. the anchor is LIVE — it is in `anchor_lines` for this path and the line
 *     it is bound to still carries the content key the anchor recorded;
 *  2. the anchor is in THIS session's served set;
 *  3. the line number the caller reported is treated as information only.
 *
 * **The file checksum is not a condition.** It is the signal that the file was
 * changed by someone else, and it triggers a remap (§5) — it never rejects by
 * itself. Rejecting on it would make a line the model legitimately read
 * uneditable the moment ANY other line in the file moved, which is exactly the
 * cross-session value this design exists to provide.
 *
 * Failure is ALL-OR-NOTHING: the caller gets every offending line and applies
 * none of them. There is no partial edit.
 *
 * Read-only by construction — it never allocates and never writes, which is why
 * it is a separate primitive from {@link anchorFor}.
 *
 * @param input - path, content, the caller's refs, and the session key.
 * @returns one resolution per ref, or the offending rows plus the reason.
 */
export async function probeLines(input: ProbeInput): Promise<ProbeOk | ProbeFail> {
	const { path, refs, sessionKey } = input;
	// Normalized for the same reason `anchorFor` is: the contentKey the verdict
	// compares against was recorded for the NORMALIZED line, so comparing the raw
	// spelling would report a spurious `line-changed` for a BOM/CRLF file.
	const content = normalizeContent(input.content);
	// §7: the three reads below are ONE snapshot. The verdict compares the rows
	// against THIS session's served set, so a write landing between them (an edit
	// in another task, a sweep) would let it answer about two different worlds —
	// and the answer it gives decides whether a write is allowed.
	//
	// Read-only in every sense: `withStoreAsync` joins an enclosing transaction or
	// opens one, and a transaction that only reads commits nothing. The contract's
	// "永不分配、永不落库" is about WRITES, and this makes none.
	await loadHashStore();
	let snapshot: {
		persistedChecksum: string | undefined;
		anchorRows: PersistedAnchorLine[];
		served: Set<string>;
	} = { persistedChecksum: undefined, anchorRows: [], served: new Set<string>() };
	await withStoreAsync(async () => {
		snapshot = {
			// Captured BEFORE anything realigns the rows: a realign moves the checksum
			// to the new content, so comparing afterwards would always say
			// "unchanged" — and §2.4 leans on this flag to choose between "you never
			// read it" and "it changed after you read it".
			persistedChecksum: persistedAnchorChecksum(path),
			// §2.2/§2.3: the facts come from `anchor_lines`, read LIVE. Not from an
			// in-process state object, and deliberately NOT via `ensureAnchorState` —
			// that call can REALIGN and WRITE, while this primitive's contract is
			// "永不分配、永不落库". Loading state also materialised the file's whole
			// anchor array, which §2.3 says the `(path, anchor)` index exists to avoid.
			anchorRows: persistedAnchorLines(path),
			served: await loadServed(sessionKey, path),
		};
	});
	const { persistedChecksum, anchorRows, served } = snapshot;
	const currentLines = splitLines(content);
	const lineCount = currentLines.length;
	const checksumChanged =
		persistedChecksum !== undefined && persistedChecksum !== contentChecksum(content);

	// An anchor names at most one line, so anchor → row is an exact reverse
	// lookup: build both directions once rather than scanning per ref.
	const byAnchor = new Map<string, PersistedAnchorLine>();
	const byLine = new Map<number, string>();
	for (const row of anchorRows) {
		byAnchor.set(row.anchor, row);
		byLine.set(row.line, row.anchor);
	}

	const resolved: { anchor: string; line: number }[] = [];
	const rows: InvalidRow[] = [];
	/**
	 * WHICH condition failed. The row shape cannot express it, and the four
	 * reasons need different recovery wording, so the distinction is kept here
	 * rather than guessed back out of the rows afterwards.
	 *
	 * Guessing is what the first version did — it asked "what anchor is on that
	 * line now?" — and that answers about the LINE, not about why the ref
	 * failed. A released anchor whose old line now carries someone else's anchor
	 * came back as `line-changed` ("the file moved under you") when the truth was
	 * `not-live` ("that anchor is gone"), which is the distinction §2.4 exists to
	 * make.
	 */
	const notLive = new Set<string>();
	/** Anchors that failed CONDITION 2 (not in this session's served set). */
	const notServed = new Set<string>();

	for (const ref of refs) {
		const row = byAnchor.get(ref.anchor);
		const line = row?.line;
		if (line === undefined) {
			// CONDITION 1 failed: the anchor is not in `anchor_lines` at all —
			// released by an edit, or never minted for this path. The echo still
			// needs somewhere to point, so fall back to the line the caller claimed
			// (when that is inside the file) and report what that line carries NOW.
			const claimed = ref.line;
			const at = claimed !== undefined && claimed >= 1 && claimed <= lineCount ? claimed : 1;
			notLive.add(ref.anchor);
			rows.push({
				line: at,
				current: byLine.get(at) ?? "",
				given: ref.anchor,
				contentKey: lineCount >= 1 ? contentKey(currentLines[at - 1]!) : 0,
			});
			continue;
		}
		const key = contentKey(currentLines[line - 1]!);
		if (row!.contentKey !== key) {
			// The anchor is still bound to its line, but that line no longer holds
			// the content the anchor was minted for: the anchor is stale.
			rows.push({ line, current: row!.anchor, given: ref.anchor, contentKey: key });
			continue;
		}
		if (!served.has(ref.anchor)) {
			// Condition 2 failed: the anchor is live and its content still matches —
			// this session was simply never shown it, so the recovery is "go read
			// it", not "take the new marker".
			notServed.add(ref.anchor);
			rows.push({ line, current: row!.anchor, given: ref.anchor, contentKey: key });
			continue;
		}
		// Condition 3: `ref.line` never decides anything. A mismatch is reported
		// as drift by the caller, not turned into a refusal.
		resolved.push({ anchor: ref.anchor, line });
	}

	if (rows.length > 0) {
		rows.sort((a, b) => a.line - b.line);
		const first = rows[0]!;
		// The reason is the CONDITION that failed, asked directly. The four
		// outcomes need different recovery wording (§2.4):
		//
		//   not-live    → the anchor is gone; take the current marker and re-submit
		//   never-seen  → this session was never shown it; go read it
		//   line-changed→ the file changed after you read it; take the new marker
		//   line-moved  → it points elsewhere now; take the current marker
		//
		// `checksumChanged` only ever separates "you never read it" from "it
		// changed after you read it" — it is never itself a rejection (§5).
		const reason: ProbeReason = notLive.has(first.given)
			? "not-live"
			: notServed.has(first.given)
				? checksumChanged
					? "line-changed"
					: "never-seen"
				: checksumChanged
					? "line-changed"
					: "line-moved";
		return { ok: false, rows, reason };
	}

	// Every live anchor with its position. "Outside the requested range" means
	// "not named in `refs`", which is what the diff and remap callers need.
	// §2.2: the file's live anchors for the positions the caller did NOT name —
	// `resolved` already carries the ones it did, so together the two cover every
	// live anchor exactly once. Returning the refs here too (as this first did)
	// made `mapped` a superset of `resolved`, so a caller could not use its size
	// to learn how many of the file's anchors sit outside the request.
	const named = new Set(resolved.map((r) => r.anchor));
	const mapped = new Map<string, number>();
	for (const row of anchorRows) {
		if (!named.has(row.anchor)) mapped.set(row.anchor, row.line);
	}
	return { ok: true, resolved, mapped };
}

