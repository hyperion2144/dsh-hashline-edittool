/**
 * AnchorAlloc — pure variable-length Base62 anchor allocation.
 *
 * Implements the v2.0 dynamic-hashline contract (docs/dynamic-hashline-spec.md):
 * shortest-first layered allocation (2..MAX depth), double-hash probing with a
 * coprime step, a bounded probe count with immediate spill, and per-line
 * uniqueness (identical content is a "conflict" like any hash collision — the
 * second occurrence probes onward).
 *
 * The module is a pure function of (used-set, canonical content): no state,
 * no IO. Session state lives in session-anchors.ts, which calls allocate /
 * assignAnchors.
 *
 * @module dsh-hashline-edittool/hashline/alloc
 */
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
	const h = contentKey(content);
	for (let depth = MIN_ANCHOR_DEPTH; depth <= MAX_ANCHOR_DEPTH; depth++) {
		const total = 62 ** depth;
		const start = h % total;
		const step = probeStep(h, total);
		// Per-layer cursor: spills must NOT reset it, or a repeated-content
		// stream would re-probe the already-consumed head of each layer and
		// stall at PROBE_LIMIT collisions (~64 rows per layer).
		const beginOffset = (groupCursor?.offsets[depth] ?? 0) % total;
		for (let probe = 0; probe < PROBE_LIMIT; probe++) {
			const offset = (beginOffset + probe) % total;
			const idx = (start + offset * step) % total;
			const candidate = encodeAnchor(idx, depth);
			if (groupCursor) groupCursor.offsets[depth] = (offset + 1) % total;
			if (!used.has(candidate)) {
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
 * Used for first read and after external (non-tool) changes.
 */
export function assignAnchors(lines: string[]): string[] {
	const used = new Set<string>();
	const cursorByKey = new Map<number, { offsets: Record<number, number> }>();
	const anchors = new Array<string>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const key = contentKey(lines[i]!);
		let cursor = cursorByKey.get(key);
		if (!cursor) {
			cursor = { offsets: {} };
			cursorByKey.set(key, cursor);
		}
		const { anchor } = allocateAnchor(used, lines[i]!, cursor);
		used.add(anchor);
		anchors[i] = anchor;
	}
	return anchors;
}