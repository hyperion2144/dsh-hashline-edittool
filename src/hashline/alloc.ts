/**
 * AnchorAlloc — pure variable-length Base62 anchor allocation.
 *
 * Implements the v2.0 dynamic-hashline contract (docs/dynamic-hashline-spec.md):
 * shortest-first layered allocation (2..MAX depth), double-hash probing with a
 * coprime step, a bounded probe count with immediate spill, and per-line
 * uniqueness (identical content is a "conflict" like any hash collision — the
 * second occurrence probes onward).
 *
 * #441: probing is INTEGER-ONLY against a batch-built slot space (a Uint8Array
 * bitset per layer ≤ 4, a Set<number> above) — encodeAnchor runs once, on the
 * hit; the digits-only exclusion is a digit-box check (every base-62 digit
 * < 10), and a layer with no free slot left is skipped outright. The probe
 * order and every skip predicate are byte-identical to the string era, so
 * the same inputs pick the same anchors they always did.
 *
 * The module is a pure function of (used-set, canonical content). It owns the
 * allocator AND the per-file sparse state it walks (`SparseState` /
 * `allocateInto`): both take values and return values, with no state of their
 * own. Everything that touches the store — the persistence port, the
 * transaction, served — lives in `domain/session/anchor-state.ts`, which calls
 * these.
 *
 * @module dsh-hashline-edittool/hashline/alloc
 */
import { splitLines } from "../infra/utils.js";
/**
 * cyrb53 — canonical implementation kept in sync with hash-assign.ts::cyrb53
 * (the two must stay identical for deterministic recomputation; the duplicate
 * avoids a module cycle).
 */
function cyrb53(str: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Canonical line key (whitespace folded) — same rule as hash-assign.ts::canon. */
const CANON_RE = /[ \t\r\n]+/g;
function canon(line: string): string {
	return line.replace(CANON_RE, "");
}

export const MIN_ANCHOR_DEPTH = 2;
/** Practical ceiling; layers above this keep probing (62^5 ≈ 9.16e8, …). */
export const MAX_ANCHOR_DEPTH = 8;
export const PROBE_LIMIT = 64;

/** Base62 digits, col 0 = '0' (matches the research scripts' alphabet). */
const ALPH_O =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function encodeAnchor(idx: number, depth: number): string {
  let out = "";
  for (let j = 0; j < depth; j++) {
    out = ALPH_O[idx % 62]! + out;
    idx = Math.floor(idx / 62);
  }
  return out;
}

/**
 * Whether an anchor is digits only, and therefore unusable as one.
 *
 * The alphabet leads with `0`-`9`, so a small index encodes to something like
 * `36`. A row is `<line>:<anchor>` and the marker may be passed back with or
 * without its line part — so `36` on its own is ambiguous with line 36, and the
 * ambiguity resolves to a WRONG EDIT rather than a rejected one. Allocation
 * therefore steps over such candidates.
 *
 * @param anchor - an encoded anchor.
 * @returns true when every character is a digit.
 */
export function isNumericAnchor(anchor: string): boolean {
	return /^[0-9]+$/.test(anchor);
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * Double-hash probe step. The v2.0 spec's correction: a step sharing a factor
 * with `total = 62^d` would only visit a coset of the slot ring; reject it and
 * fall back to linear probing (step 1).
 */
export function probeStep(hash: number, total: number): number {
	const step = (hash % (total - 1)) + 1;
	return gcd(step, total) === 1 ? step : 1;
}

/**
 * The occupancy structure probing runs against (#441). Layers ≤
 * `BITSET_MAX_DEPTH` get a lazily allocated `Uint8Array` bitset (62⁴/8 =
 * 1.85 MB is the cutoff); sparser high layers get a `Set<number>`. Built once
 * per batch from the used-set's decoded anchors, then marked per mint.
 */
const BITSET_MAX_DEPTH = 4;

class SlotSpace {
	private readonly bitsets = new Map<number, Uint8Array>();
	private readonly sparse = new Map<number, Set<number>>();
	private readonly marked = new Map<number, number>();

	static from(used: ReadonlySet<string>): SlotSpace {
		const space = new SlotSpace();
		for (const anchor of used) space.markAnchor(anchor);
		return space;
	}

	/** Build from a state's own live anchors (the #446 cached spelling). */
	static fromEntries(entries: Iterable<[number, AnchorEntry]> | Iterable<AnchorEntry>): SlotSpace {
		const space = new SlotSpace();
		for (const entry of entries) space.markAnchor(entry instanceof Array ? entry[1].anchor : entry.anchor);
		return space;
	}

	markAnchor(anchor: string): void {
		const decoded = decodeAnchorIndex(anchor);
		// A digits-only string is never an allocated anchor; marking its slot
		// anyway would inflate the saturation count and skip a live layer.
		if (decoded !== undefined && !isNumericIdx(decoded.idx, decoded.depth)) {
			this.markIdx(decoded.depth, decoded.idx);
		}
	}

	markIdx(depth: number, idx: number): void {
		this.marked.set(depth, (this.marked.get(depth) ?? 0) + 1);
		if (depth <= BITSET_MAX_DEPTH) {
			let bits = this.bitsets.get(depth);
			if (bits === undefined) {
				bits = new Uint8Array(Math.ceil(62 ** depth / 8));
				this.bitsets.set(depth, bits);
			}
			bits[idx >> 3] |= 1 << (idx & 7);
			return;
		}
		let taken = this.sparse.get(depth);
		if (taken === undefined) {
			taken = new Set<number>();
			this.sparse.set(depth, taken);
		}
		taken.add(idx);
	}

	has(depth: number, idx: number): boolean {
		if (depth <= BITSET_MAX_DEPTH) {
			const bits = this.bitsets.get(depth);
			if (bits === undefined) return false;
			return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
		}
		return this.sparse.get(depth)?.has(idx) === true;
	}

	/**
	 * #441 item 3: a layer with every usable slot marked has nothing a probe
	 * can find — skipping it is byte-identical to burning PROBE_LIMIT failed
	 * probes (marks only grow, so saturated stays saturated). `usable` = total
	 * − 10^depth: exactly 10^depth of the layer's slots encode digits-only.
	 */
	saturated(depth: number, usable: number): boolean {
		return (this.marked.get(depth) ?? 0) >= usable;
	}
}

/**
 * Drop a state's cached slot space (#446). Every mutation of `entries` that
 * is NOT a mint-through-the-space (realign reassign, edit shift, release,
 * out-of-band seed) must call this — a stale cache could hand out an anchor
 * that is no longer live, or miss one that became live.
 */
export function invalidateSlotSpace(state: SparseState): void {
	state.slotSpace = undefined;
}

/**
 * Whether an index encodes to digits only (an unusable anchor): every
 * base-62 digit must be < 10 — a digit BOX, not an interval ("36" is
 * idx 3·62+6 = 192 > 10², yet digits-only). Exact integer analogue of
 * `isNumericAnchor(encodeAnchor(idx, depth))` (#441).
 */
function isNumericIdx(idx: number, depth: number): boolean {
	for (let i = 0; i < depth; i++) {
		if (idx % 62 >= 10) return false;
		idx = Math.floor(idx / 62);
	}
	return true;
}

/** Decode an anchor string back to (depth, idx); `undefined` when it is not one. */
function decodeAnchorIndex(anchor: string): { depth: number; idx: number } | undefined {
	const depth = anchor.length;
	if (depth < MIN_ANCHOR_DEPTH || depth > MAX_ANCHOR_DEPTH) return undefined;
	let idx = 0;
	for (let i = 0; i < depth; i++) {
		const digit = ALPH_O.indexOf(anchor[i]!);
		if (digit < 0) return undefined;
		idx = idx * 62 + digit;
	}
	return { depth, idx };
}

/** Canonical content key (cyrb53 of the whitespace-folded line) — the slot-space identity of a line. */
export function contentKey(content: string): number {
	return cyrb53(canon(content));
}

export interface AllocStats {
  depth: number;
  probes: number;
}

/**
 * Allocate one anchor for `content` (canonicalized inside) against the given
 * used-set. Never returns an anchor in `used`; layers 2..MAX are probed
 * shortest-first with PROBE_LIMIT attempts per layer, then the next layer up.
 *
 * `groupCursor` lets a caller keep per-content probe continuity: identical
 * content lines share the same natural slot and step, so without a cursor
 * every additional same-content line would re-probe the same PROBE_LIMIT
 * slots and spill prematurely (~64 rows per layer for repeated blank lines
 * etc.). The cursor stores the last probe offset used for this content key
 * and the next allocation continues from there — 3,844 identical lines fit
 * the 2-char layer with ~1 probe each. The cursor is a pure function of the
 * allocation order, so determinism is preserved.
 */
export function allocateAnchor(
	used: ReadonlySet<string>,
	content: string,
	groupCursor?: { offsets: Record<number, number> },
): { anchor: string; stats: AllocStats } {
	// #441: one transient slot space per call — the batch callers
	// (`assignAnchors`, `allocateIntoRows`, `anchorsPure`) build theirs once
	// and mark as they go; this path serves single-shot callers (tests, v2
	// support), where decoding the used-set once beats a string probe per slot.
	return allocateInSpace(SlotSpace.from(used), content, groupCursor);
}

/**
 * The allocation kernel over a prebuilt slot space (#441). Identical probe
 * order and skip predicates to the string-era `allocateAnchor` — the same
 * inputs pick the same anchors — but every probe is integer arithmetic and
 * one occupancy check; `encodeAnchor` runs once, on the hit.
 */
function allocateInSpace(
	space: SlotSpace,
	content: string,
	groupCursor?: { offsets: Record<number, number> },
	/** Per-call extras (the caller's `used` — live ∪ release pool), checked
	 * only on a slot the cached space says is FREE: a few encodes per mint at
	 * most, never per probe (#446). */
	extras?: ReadonlySet<string>,
): { anchor: string; stats: AllocStats } {
	const h = contentKey(content);
	for (let depth = MIN_ANCHOR_DEPTH; depth <= MAX_ANCHOR_DEPTH; depth++) {
		const total = 62 ** depth;
		// #441: "encodes to digits only" ⟺ every base-62 digit < 10 — checked
		// with integer digit extraction, replacing the per-probe regex (and the
		// encode that fed it). Why digits are skipped at all: a row is
		// `<line>:<anchor>` and the marker may come back without its line part,
		// so `36` alone is ambiguous with line 36 — a wrong edit rather than a
		// rejected one.
		const usable = total - 10 ** depth;
		const start = h % total;
		const step = probeStep(h, total);
		// Per-layer cursor: spills must NOT reset it, or a repeated-content
		// stream would re-probe the already-consumed head of each layer and
		// stall at PROBE_LIMIT collisions (~64 rows per layer).
		const beginOffset = (groupCursor?.offsets[depth] ?? 0) % total;
		if (space.saturated(depth, usable)) continue;
		for (let probe = 0; probe < PROBE_LIMIT; probe++) {
			const offset = (beginOffset + probe) % total;
			const idx = (start + offset * step) % total;
			// The cursor advances FIRST, whatever happens next. Skipping before it
			// left `beginOffset` untouched, so every following line of the same
			// content re-probed from the same place and burned the whole PROBE_LIMIT
			// before reaching a slot that was free anyway.
			if (groupCursor) groupCursor.offsets[depth] = (offset + 1) % total;
			if (isNumericIdx(idx, depth)) continue;
			if (!space.has(depth, idx)) {
				const candidate = encodeAnchor(idx, depth);
				if (extras !== undefined && extras.has(candidate)) continue;
				space.markIdx(depth, idx);
				return { anchor: candidate, stats: { depth, probes: probe + 1 } };
			}
		}
	}
	// Unreachable in practice (62^6 ≈ 5.7e10 slots); defensive fallback.
	throw new Error(
		"[E_HASH_SPACE] Anchor space exhausted (lines > 62^8). This file is too large for dynamic hashline.",
	);
}

/**
 * Deterministic full-file allocation: same content, same order → same anchors.
 * Used ONLY for a path's true first serve and for poisoned-snapshot rebuilds.
 * Rewrites and external (non-tool) changes do NOT run this — they inherit via
 * anchor-state's diff alignment (unchanged lines keep their anchors); the
 * tests in anchor-lifecycle-invariants pin that contract.
 */
export function assignAnchors(lines: string[]): string[] {
	const space = new SlotSpace();
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	const anchors = new Array<string>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const key = contentKey(lines[i]!);
		let cursor = cursorByKey.get(key);
		if (!cursor) {
			cursor = { offsets: {} };
			cursorByKey.set(key, cursor);
		}
		const { anchor } = allocateInSpace(space, lines[i]!, cursor);
		anchors[i] = anchor;
	}
	return anchors;
}

// ---- the per-file sparse state, and allocation INTO it ----------------------
//
// These live here, not in `domain/session/`, because they are PURE: the input
// is a value (rows + content + the lines to mint) and the output is anchors.
// No store, no scope, no session, no state of its own — the caller owns the
// persistence port and the transaction (contract §3).

/** One allocated line: its anchor and the content key it was minted for. */
export interface AnchorEntry {
	anchor: string;
	contentKey: number;
}

/**
 * The working value the allocator walks for ONE file.
 *
 * `entries` holds only ALLOCATED lines (#169: lazy, sparse) — a line the model
 * has never seen has no entry and costs nothing.
 */
export interface SparseState {
	checksum: string;
	lineCount: number;
	/** line (1-based) → {anchor, contentKey} for every ALLOCATED line. */
	entries: Map<number, AnchorEntry>;
	/**
	 * The cached slot occupancy for THIS state's live anchors (#446) — built
	 * lazily by `allocateIntoRows`, marked per mint, invalidated by every
	 * non-mint mutation of `entries` (realign, shift, release, out-of-band
	 * seed) via `invalidateSlotSpace`. `undefined` = not built / stale.
	 */
	slotSpace?: SlotSpace;
}

/**
 * Get-or-allocate against a GIVEN state (no load, no persist).
 *
 * `used` is supplied by the caller so the used-set can carry sources a pure
 * function cannot see — the session layer adds the CURRENT CALL's release pool,
 * which is what stops a call from releasing an anchor and handing it straight
 * to another line (§4.1 / #223). Omitting it keeps the old behaviour: every
 * anchor the file currently has live.
 *
 * @param state - the sparse state to allocate into (mutated).
 * @param content - the file's current normalized text.
 * @param lines - 1-based lines to mint or reuse anchors for.
 * @param used - anchors to avoid; defaults to the state's own live set.
 * @returns one anchor per line, `""` outside the file's range.
 */
export function allocateInto(
	state: SparseState,
	content: string,
	lines: number[],
	used?: Set<string>,
): string[] {
	// The content ADAPTER (#414): callers that already hold the whole text
	// (read / edit / ast / lsp) keep this shape; it splits once and hands the
	// kernel the rows it asked for.
	const currentLines = splitLines(content);
	const rows = new Map<number, string>();
	for (const line of lines) {
		if (line >= 1 && line <= currentLines.length) rows.set(line, currentLines[line - 1]!);
	}
	return allocateIntoRows(state, rows, currentLines.length, used);
}

/**
 * The allocator KERNEL (#414): mint or reuse anchors for lines given as text.
 *
 * The caller supplies the rows and the file's line count — no whole-file text
 * is needed, which is what lets `grep` mint from ripgrep records. There is ONE
 * implementation of the reuse/mint rule; `allocateInto` above is the adapter
 * that builds these rows from a content string.
 *
 * @param state - the sparse state to allocate into (mutated).
 * @param rows - line number → the line's current text.
 * @param lineCount - the file's current line count (bounds check).
 * @param used - anchors to avoid; defaults to the state's own live set.
 * @returns one anchor per row, in ascending line order; `""` out of range.
 */
export function allocateIntoRows(
	state: SparseState,
	rows: ReadonlyMap<number, string>,
	lineCount: number,
	used?: Set<string>,
): string[] {
	const avoid = used ?? new Set<string>();
	if (used === undefined) {
		for (const [, entry] of state.entries) avoid.add(entry.anchor);
	}
	// #446: the slot space follows the state — built once from its live
	// anchors, marked per mint, reused by the next call. The caller's `used`
	// (live ∪ this call's release pool) rides as `extras`, checked only on
	// candidate slots, so the skip-set is exactly entries ∪ used — the same
	// set the per-call rebuild avoided, at O(1) build instead of O(live).
	const space = state.slotSpace ?? SlotSpace.fromEntries(state.entries);
	state.slotSpace = space;
	// Per-content probe continuity (same design as assignAnchors): a run of
	// identical lines probes CONTIGUOUSLY instead of re-walking the used set
	// for every copy — without the cursor, a long duplicate run degenerates to
	// O(k²) probes and can exhaust the probe cap.
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	const out: string[] = [];
	for (const line of [...rows.keys()].sort((a, b) => a - b)) {
		if (line < 1 || line > lineCount) {
			out.push("");
			continue;
		}
		const text = rows.get(line)!;
		const key = contentKey(text);
		const existing = state.entries.get(line);
		if (existing && existing.contentKey === key) {
			out.push(existing.anchor);
			continue;
		}
		// The line's content changed (or it was never served): mint a fresh
		// anchor. The OLD one is deliberately NOT freed for reuse inside this
		// call — it stays in `avoid` even though its line is gone. Reusing it a
		// few lines later would hand the model an anchor that still carries the
		// meaning it had when it was served (#217 §1), and the model cannot tell
		// the two apart. The caller may put it in the release pool; either way it
		// is available again on the NEXT call.
		let gc = cursorByKey.get(key);
		if (!gc) {
			gc = { offsets: {} };
			cursorByKey.set(key, gc);
		}
		const { anchor } = allocateInSpace(space, text, gc, used);
		avoid.add(anchor);
		state.entries.set(line, { anchor, contentKey: key });
		out.push(anchor);
	}
	return out;
}

/**
 * Whole-content allocation for callers without a path (tests, previews).
 * Never persists — the caller's anchors are transient.
 */
export function anchorsPure(content: string): string[] {
	const lines = splitLines(content);
	const space = new SlotSpace();
	const out: string[] = [];
	for (const text of lines) {
		const { anchor } = allocateInSpace(space, text);
		out.push(anchor);
	}
	return out;
}