/**
 * HashAssign — deep module owning hash derivation.
 *
 * hash = a content-derived DETERMINISTIC signature (cyrb53 folded into a
 * 3-char (configurable) base62 string). It is deliberately NOT collision-free
 * and NOT unique:
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
 * Shape (hash length / separator) is configurable via
 * `applyHashlineShape({hashLength, separator})` and affects every derived
 * regex, the header line and the row renderer. Defaults: 3 chars, ':' —
 * the shape adopted by the current contract.
 *
 * All exported values that depend on the shape are FUNCTIONS (e.g.
 * `lineHashRe()`) so a live config change recompiles everything without
 * callers holding stale constants.
 *
 * @module dsh-hashline-edittool/hashline/hash-assign
 */
import { splitLines } from "../utils.js";

// --- alphabet ---
export const ALPH =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPH_SAFE = ALPH.replace(/-/g, "\\-");

function placeholderSpaces(len: number): string {
	return " ".repeat(len);
}

export const ALPH_RE = new RegExp(`^[${ALPH_SAFE}]+$`);

/** Separator inside an anchor between the absolute 1-indexed line number and the hash. */
export const LINE_HASH_SEP = "#";
/** Number of context rows to echo around a stale or ambiguous anchor (read format). */
export const STALE_CONTEXT_LINES = 3;

// --- shape (live-configurable) ---
export interface HashlineShape {
	/** Hash length in characters (default 3; hash space = 62^len). */
	hashLength: number;
	/** Column separator between marker and content (default ":"). */
	separator: string;
}

const DEFAULT_SHAPE: HashlineShape = { hashLength: 3, separator: ":" };

let shape: HashlineShape = { ...DEFAULT_SHAPE };
let compiled: CompiledShape | undefined;

interface CompiledShape {
	hashClassSource: string; // "[A-Za-z0-9]{4}"
	hashRe: RegExp;
	lineHashRe: RegExp;
	hashSpace: number;
	plusRe: RegExp;
	minusRe: RegExp;
	bareRe: RegExp;
	header: string;
}

function escapeReChar(ch: string): string {
	return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

function compileShape(s: HashlineShape): CompiledShape {
	const sepSafe = escapeReChar(s.separator);
	const hashClassSource = `[${ALPH_SAFE}]{${s.hashLength}}`;
	const seps = `[${sepSafe}│]`; // legacy '│' rows still parse
	const placeholder = " ".repeat(s.hashLength);
	return {
		hashClassSource,
		hashRe: new RegExp(`^${hashClassSource}$`),
		lineHashRe: new RegExp(
			`^(\\d+)${LINE_HASH_SEP}([A-Za-z0-9]{${s.hashLength}})$`,
		),
		hashSpace: ALPH.length ** s.hashLength,
		plusRe: new RegExp(`^\\+\\d+${LINE_HASH_SEP}${hashClassSource}\\s*${seps}`),
		minusRe: new RegExp(
			`^-(?:\\d+${LINE_HASH_SEP}${hashClassSource}\\s*${seps}|\\d+${LINE_HASH_SEP}${placeholder}\\s*${seps})`,
		),
		bareRe: new RegExp(
			`^\\s*(\\d+${LINE_HASH_SEP})(${hashClassSource})\\s*${seps}`,
		),
		header: `ANCHOR${s.separator}FILELINE — each row is <line>${LINE_HASH_SEP}<hash>${s.separator}<content>; edit uses the LEFT "line${LINE_HASH_SEP}hash" marker as its anchor; everything after "${s.separator}" is the verbatim file content; to modify the file, pass the content after "${s.separator}" — never the anchor part.`,
	};
}

function getCompiled(): CompiledShape {
	if (!compiled) compiled = compileShape(shape);
	return compiled;
}

/** Reconfigure hash length / separator; recompiles all derived regexes. */
export function applyHashlineShape(next: HashlineShape): void {
	shape = { ...DEFAULT_SHAPE, ...next };
	compiled = undefined;
}

/** Current shape (length + separator). */
export function getHashlineShape(): HashlineShape {
	return { ...shape };
}

// --- shape-dependent exports (functions; see module doc) ---
export function hashLength(): number {
	return shape.hashLength;
}
export function hashSep(): string {
	return shape.separator;
}
export function hashClassSource(): string {
	return getCompiled().hashClassSource;
}
export function hashRe(): RegExp {
	return getCompiled().hashRe;
}
export function lineHashRe(): RegExp {
	return getCompiled().lineHashRe;
}
export function hashSpace(): number {
	return getCompiled().hashSpace;
}
export function hashlineHeader(): string {
	return getCompiled().header;
}
export function hlPrefixPlusRe(): RegExp {
	return getCompiled().plusRe;
}
export function hlPrefixMinusRe(): RegExp {
	return getCompiled().minusRe;
}
export function hlBarePrefixRe(): RegExp {
	return getCompiled().bareRe;
}

// --- default-shape compatibility constants ---
// Static values for the DEFAULT shape (3 chars, ':'). Dynamic code paths
// (rendering, parsing, validation) must use the shape-aware FUNCTIONS above;
// these constants exist for legacy consumers and tests running on defaults.
export const HASH_SEP = DEFAULT_SHAPE.separator;
export const HASH_LEN = DEFAULT_SHAPE.hashLength;
export const ANCHOR_LEN = HASH_LEN;
export const HASH_SPACE = ALPH.length ** HASH_LEN;
export const HASH_CLASS = `[${ALPH_SAFE}]{${HASH_LEN}}`;
export const HASH_RE = new RegExp(`^${HASH_CLASS}$`);
export const LINE_HASH_RE = /^(\d+)#([A-Za-z0-9]{3})$/;
export const HASHLINE_HEADER = `ANCHOR${HASH_SEP}FILELINE — each row is <line>${LINE_HASH_SEP}<hash>${HASH_SEP}<content>; edit uses the LEFT "line${LINE_HASH_SEP}hash" marker as its anchor; everything after "${HASH_SEP}" is the verbatim file content; to modify the file, pass the content after "${HASH_SEP}" — never the anchor part.`;
export const HL_PREFIX_PLUS_RE = new RegExp(`^\\+\\d+${LINE_HASH_SEP}${HASH_CLASS}\\s*[:│]`);
export const HL_PREFIX_MINUS_RE = new RegExp(
	`^-(?:\\d+${LINE_HASH_SEP}${HASH_CLASS}\\s*[:│]|\\d+${LINE_HASH_SEP} ${placeholderSpaces(HASH_LEN)}\\s*[:│])`,
);
export const HL_BARE_PREFIX_RE = new RegExp(
	`^\\s*(\\d+${LINE_HASH_SEP})(${HASH_CLASS})\\s*[:│]`,
);

// --- hashing (private) ---
/**
 * cyrb53 — fast, dependency-free, well-distributed 53-bit string hash.
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

function idxToHash(idx: number, len: number): string {
	let out = "";
	for (let j = 0; j < len; j++) {
		out = ALPH[idx % ALPH.length]! + out;
		idx = Math.floor(idx / ALPH.length);
	}
	return out;
}

/** Hash of one canonicalized line under the CURRENT shape's hash length. */
export function hashOf(canonLine: string): string {
	const c = getCompiled();
	return idxToHash(cyrb53(canonLine) % c.hashSpace, shape.hashLength);
}

/** Whole-content fingerprint (hash-store snapshot key). 53-bit → 14 hex. */
export function contentChecksum(content: string): string {
	return cyrb53(content).toString(16).padStart(14, "0");
}

/**
 * Snapshot-canon version. Bumped when canonicalization or the hashing rule
 * changes so stale hash-store rows are invalidated without a separate flag.
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
	return `${prefix}${anchor.padStart(width)}${shape.separator} ${content}`;
}

/** Width of the anchor column for a block of `line#hash` anchors. */
export function anchorWidth(anchors: readonly string[]): number {
	let w = 0;
	for (const a of anchors) {
		if (a.length > w) w = a.length;
	}
	return w;
}