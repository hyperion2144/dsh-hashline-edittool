/**
 * HashAssign — deep module owning hash derivation.
 *
 * hash = a content-derived DETERMINISTIC signature (cyrb53 folded into
 * 3-char base62). It is deliberately NOT collision-free and NOT unique:
 *
 *   - identical content always yields the same hash (so a line keeps its
 *     hash across edits without any stable-mapping pass);
 *   - different content MAY collide — that is fine, because the `line`
 *     is the only locator; the hash merely verifies that the line's
 *     content signature matches what the model claims.
 *
 * There is no allocation invariant, no bitset, no probe stride and no
 * size ceiling — recomputing hashes after an edit is a single O(n) pass.
 *
 * Public surface: lineHashesPure, HASH_* separators, canon, HASH_CLASS,
 * hashOf, contentChecksum. Deleting this module would scatter the hash
 * derivation rule across every caller.
 *
 * @module dsh-hashline-edittool/hashline/hash-assign
 */
import { splitLines } from "../utils.js";

// --- alphabet ---
export const HASH_LEN = 3;
export const ALPH =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPH_SAFE = ALPH.replace(/-/g, "\\-");
export const ALPH_RE = new RegExp(`^[${ALPH_SAFE}]+$`);
export const HASH_CLASS = `[${ALPH_SAFE}]{${HASH_LEN}}`;
export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);

/** Encoding space (62^3) — a folding modulus, NOT a file-size limit. */
export const HASH_SPACE = ALPH.length ** HASH_LEN;

// --- separators ---
export const ANCHOR_LEN = HASH_LEN;
export const HASH_SEP = ":";
/** Separator inside an anchor between the absolute 1-indexed line number and the 3-char hash. */
export const LINE_HASH_SEP = "#";
/** Regex for the `line#hash` anchor form (group 1 = line, group 2 = hash). */
export const LINE_HASH_RE = /^(\d+)#([A-Za-z0-9]{3})$/;
/** Number of context rows to echo around a stale or ambiguous anchor (read format). */
export const STALE_CONTEXT_LINES = 3;
/**
 * Header line that opens every hashline-producing tool response (read, grep,
 * post-edit diff, stale echo). Marks the boundary between model-facing marker
 * columns and verbatim file content.
 */
export const HASHLINE_HEADER = `ANCHOR${HASH_SEP}FILELINE`;

// --- hashing (private) ---
/**
 * cyrb53 — fast, dependency-free, well-distributed 53-bit string hash.
 * Replaces the previous xxhash-wasm + unique-allocation pipeline: no WASM
 * initialization, no async setup, pure JS, deterministic across runs.
 * Collisions are accepted by design (see module doc) — the line locates,
 * the hash only verifies content.
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

function idxToHash(idx: number): string {
	let out = "";
	for (let j = 0; j < HASH_LEN; j++) {
		out = ALPH[idx % ALPH.length]! + out;
		idx = Math.floor(idx / ALPH.length);
	}
	return out;
}

/** Hash of one canonicalized line: `lineHashesPure`'s per-row core. */
export function hashOf(canonLine: string): string {
	return idxToHash(cyrb53(canonLine) % HASH_SPACE);
}

/** Whole-content fingerprint (hash-store snapshot key). 53-bit → 14 hex. */
export function contentChecksum(content: string): string {
	return cyrb53(content).toString(16).padStart(14, "0");
}

/**
 * Snapshot-canon version. Bumped when canonicalization or the hashing rule
 * changes so stale hash-store rows are invalidated without a separate flag.
 * The upstream ADR-0005 rule: `canon` strips every run of `[ \t\r\n]`, so a
 * line that differs only by whitespace is the same line semantically and
 * must keep its hash.
 */
export const CANON_VERSION = 3;

const CANON_RE = /[ \t\r\n]+/g;

export function canon(line: string): string {
	return line.replace(CANON_RE, "");
}

/**
 * Memoized canon keyed by the raw input string. One cache lives per
 * `lineHashesPure` call; entries are discarded when the call returns.
 */
function getCanon(cache: Map<string, string>, line: string): string {
	const cached = cache.get(line);
	if (cached !== undefined) return cached;
	const v = canon(line);
	cache.set(line, v);
	return v;
}

/** Deterministic per-line hashes for whole content. O(n), no allocation state. */
export function lineHashesPure(content: string): string[] {
	const lines = splitLines(content);
	const hashes = new Array<string>(lines.length);
	const canonCache = new Map<string, string>();
	for (let i = 0; i < lines.length; i++) {
		hashes[i] = hashOf(getCanon(canonCache, lines[i]!));
	}
	return hashes;
}

// Marker stripping matches ONLY the full anchor form: `line#hash:` rows
// (optionally with +/- diff markers). A bare `hash:` content prefix is NOT
// stripped — the line locates, and line#hash is the only anchor form; the
// legacy `│` separator still parses.
export const HL_PREFIX_PLUS_RE = new RegExp(`^\\+\\d+#${HASH_CLASS}\\s*[:│]`);
export const HL_PREFIX_MINUS_RE = new RegExp(
	`^-(?:\\d+#${HASH_CLASS}\\s*[:│]|\\d+# {${ANCHOR_LEN}}\\s*[:│])`,
);
export const HL_BARE_PREFIX_RE = new RegExp(
	`^\\s*(\\d+#)(${HASH_CLASS})\\s*[:│]`,
);


/**
 * Render one hashline row with a right-aligned anchor column: the anchor
 * (`line#hash`) is padded to `width` (the longest anchor in the current
 * output block) so every read/grep/diff echo shares one visual column and
 * the model copies exactly the left marker. Content stays verbatim.
 */
export function fmtHashlineRow(
	prefix: string,
	anchor: string,
	content: string,
	width: number,
): string {
	return `${prefix}${anchor.padStart(width)}${HASH_SEP} ${content}`;
}

/** Width of the anchor column for a block of `line#hash` anchors. */
export function anchorWidth(anchors: readonly string[]): number {
	let w = 0;
	for (const a of anchors) {
		if (a.length > w) w = a.length;
	}
	return w;
}

