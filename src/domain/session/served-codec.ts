/**
 * The served-anchor set's on-disk encoding (#176, spec #184).
 *
 * Why this exists: `served` answers one question per edit — "was this anchor
 * (this content identity) handed to the model?" (`served.has(anchor)` in the
 * anchor pipeline). It is not a cache, so nothing in it may be evicted: dropping
 * an entry silently revokes edit rights on a line whose content never changed.
 * What CAN change is its representation. The set used to be a JSON array, which
 * every serve re-read, re-parsed and re-wrote in full, and whose size grew with
 * the number of anchors served for a path.
 *
 * This codec stores the same set as: a format marker, then the anchors sorted
 * numerically (Base62 read as an integer), delta-encoded, written as varints and
 * base64'd. Deltas of sorted anchors are small, so a set of N anchors costs a
 * couple of bytes each instead of the ~7–10 bytes JSON spends on quoting and
 * commas, and decoding is a linear pass with no JSON parser in the middle.
 *
 * Bit-packing was considered and folded into the varint bytes: the deltas are
 * already a few bits wide, so a separate bit-stream would save a fraction of a
 * byte per anchor while making the format much harder to reason about.
 *
 * Lazy migration: {@link decodeServedAnchors} still understands every legacy
 * shape (the plain array, the v2 envelope, the dense `(string|null)[]`), and any
 * write replaces the row with the packed form. No migration pass runs, and a
 * store that is never written again keeps working as-is.
 * @module dsh-hashline-edittool/domain/session/served-codec
 */

/**
 * Marks a packed payload. JSON payloads start with `[`, `{`, or a scalar, so a
 * leading `~` cannot collide with anything a previous build wrote.
 */
const PACKED_PREFIX = "~";
/** The anchor shape this plugin mints — 1–8 Base62 characters. */
const anchorRe = /^[0-9A-Za-z]{1,8}$/;

/** The Base62 alphabet anchors are drawn from (matches `hash-assign`). */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const DIGIT = new Map<string, number>([...BASE62].map((ch, index) => [ch, index]));

/** Read a Base62 anchor as an integer, or undefined when it is not one. */
function anchorValue(anchor: string): number | undefined {
	// An empty string is not an anchor: encoding it would mint the value 0 and
	// decode as "0", inventing an anchor nobody ever served.
	if (anchor === "") return undefined;
	let value = 0;
	for (const ch of anchor) {
		const digit = DIGIT.get(ch);
		if (digit === undefined) return undefined;
		value = value * 62 + digit;
	}
	return value;
}

/** Write a Base62 anchor for an integer. */
function anchorFromValue(value: number): string {
	if (value === 0) return BASE62[0]!;
	let out = "";
	let rest = value;
	while (rest > 0) {
		out = BASE62[rest % 62]! + out;
		rest = Math.floor(rest / 62);
	}
	return out;
}

/** Append an unsigned varint (LEB128) to a byte array. */
function writeVarint(bytes: number[], value: number): void {
	let rest = value;
	while (rest >= 0x80) {
		bytes.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 0x80);
	}
	bytes.push(rest);
}

/** Read one varint from a byte array at an offset. */
function readVarint(
	bytes: Uint8Array,
	at: number,
): { value: number; next: number } | undefined {
	let value = 0;
	let shift = 1;
	let index = at;
	for (;;) {
		if (index >= bytes.length) return undefined;
		const byte = bytes[index]!;
		value += (byte & 0x7f) * shift;
		index += 1;
		if ((byte & 0x80) === 0) return { value, next: index };
		shift *= 0x80;
		if (shift > Number.MAX_SAFE_INTEGER) return undefined;
	}
}

/**
 * Encode a served set for storage.
 *
 * Anchors that are not Base62 (never produced by this plugin, but a hand-edited
 * store could hold them) are dropped rather than corrupting the payload: the
 * set's only consumer tests membership of anchors this plugin minted.
 *
 * @param anchors - the anchors served for one session+path; order and
 *   duplicates do not matter.
 * @returns the string to store in `served.hashes`.
 */
export function encodeServedAnchors(anchors: Iterable<string>): string {
	const values = new Set<number>();
	for (const anchor of anchors) {
		const value = anchorValue(anchor);
		if (value !== undefined) values.add(value);
	}
	const sorted = [...values].sort((a, b) => a - b);
	const bytes: number[] = [];
	let previous = 0;
	for (const value of sorted) {
		writeVarint(bytes, value - previous);
		previous = value;
	}
	return PACKED_PREFIX + Buffer.from(bytes).toString("base64");
}

/**
 * Decode a stored served set — packed by this build, or any legacy shape.
 *
 * @param raw - the stored `served.hashes` value.
 * @returns the anchors, or undefined when the payload is unreadable (the caller
 *   treats that as a corrupt row, exactly as it did for malformed JSON).
 */
export function decodeServedAnchors(raw: string): Set<string> | undefined {
	if (raw.startsWith(PACKED_PREFIX)) {
		const bytes = Buffer.from(raw.slice(PACKED_PREFIX.length), "base64");
		const out = new Set<string>();
		let at = 0;
		let previous = 0;
		while (at < bytes.length) {
			const read = readVarint(bytes, at);
			if (read === undefined) return undefined;
			previous += read.value;
			out.add(anchorFromValue(previous));
			at = read.next;
		}
		return out;
	}
	// Legacy shapes: a JSON array of anchor strings, the v2 envelope, or the
	// dense `(string|null)[]` array. Kept verbatim so a store written by an
	// older build keeps serving anchors until its next write — and validated
	// exactly as strictly as before (#176): an entry that is not an anchor this
	// plugin could have minted means the ROW is corrupt, not that the entry
	// should be quietly dropped. Returning undefined lets the caller heal it,
	// which is the behaviour the corrupt-row tests pin.
	const anchorsOf = (entries: unknown[]): Set<string> | undefined => {
		const out = new Set<string>();
		for (const entry of entries) {
			if (entry === null) continue;
			if (typeof entry !== "string" || !anchorRe.test(entry)) return undefined;
			out.add(entry);
		}
		return out;
	};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			// The plain array and the dense array differ only in allowing nulls;
			// `anchorsOf` accepts both, so one branch covers the legacy formats.
			return anchorsOf(parsed);
		}
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			(parsed as { v?: unknown }).v === 2 &&
			Array.isArray((parsed as { a?: unknown }).a)
		) {
			return anchorsOf((parsed as { a: unknown[] }).a);
		}
		return undefined;
	} catch {
		return undefined;
	}
}
