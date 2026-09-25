/**
 * The served-anchor set's on-disk encoding (#176, spec #184).
 *
 * Why this exists: `served` answers one question per edit — "was this anchor
 * (this content identity) handed to the model?" (`served.has(anchor)` in the
 * anchor pipeline). It is not a cache, so nothing in it may be evicted: dropping
 * an entry silently revokes edit rights on a line whose content never changed.
 * What CAN change is its representation. The set used to be a JSON array, which
 * every serve re-read, re-parsed and re-wrote in full.
 *
 * This codec stores the same set as: a version marker, then the anchors grouped
 * by LENGTH and sorted numerically inside each group, deltas written as varints
 * and base64'd. Deltas of sorted anchors are small, so a set of N anchors costs a
 * couple of bytes each instead of the ~7–10 bytes JSON spends on quoting and
 * commas, and decoding is a linear pass with no JSON parser in the middle.
 *
 * **The length group is not an optimisation — it is correctness.** Anchors are
 * minted by padding to a fixed depth (`encodeAnchor` writes exactly `depth`
 * characters, so `0h`, `00x` and `0` are ordinary anchors). The STRING is the
 * identity and the integer is not: encoding `0h` as the number 17 decodes back as
 * `h`, and every edit using the anchor the model was actually shown is then
 * rejected as never served. Storing the length and re-padding on decode
 * round-trips every anchor byte for byte.
 *
 * That failure is not hypothetical: the first version of this codec shipped
 * without the group, and a live session hit it exactly — `read` returned
 * `0h:345`, and the very next `edit` on that line was refused with "anchor 0h not
 * in served set", while the persisted anchor state still held `0h` at line 345.
 * The lesson is recorded here rather than in a commit message because the next
 * person to touch this file needs to know why the length is on the wire.
 *
 * Bit-packing was considered and folded into the varint bytes: the deltas are
 * already a few bits wide, so a separate bit-stream would save a fraction of a
 * byte per anchor while making the format much harder to reason about.
 *
 * Lazy migration: {@link decodeServedAnchors} still understands every legacy JSON
 * shape (the plain array, the v2 envelope, the dense `(string|null)[]`), and any
 * write replaces the row with the packed form. No migration pass runs, and a
 * store that is never written again keeps working as-is.
 * @module dsh-hashline-edittool/domain/session/served-codec
 */

/**
 * Marks a packed payload and names its version.
 *
 * `~1` is the length-grouped form. A bare `~` was the first attempt, which
 * dropped leading zeros; it is deliberately NOT decodable — a wrong served set
 * is worse than a missing one, because it makes anchors the model legitimately
 * holds unusable and the rejection blames the model. Treating it as unreadable
 * lets the caller heal the row, and the next read re-serves correctly.
 */
const PACKED_PREFIX = "~1";

/** A payload written by the first, leading-zero-dropping version. */
const DEFECTIVE_PREFIX = "~";

/** The Base62 alphabet anchors are drawn from (matches `hash-assign`). */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const DIGIT = new Map<string, number>([...BASE62].map((ch, index) => [ch, index]));

/** The anchor shape this plugin mints — 1–8 Base62 characters. */
const anchorRe = /^[0-9A-Za-z]{1,8}$/;

/** Read a Base62 anchor as an integer, or undefined when it is not one. */
function anchorValue(anchor: string): number | undefined {
	// An empty string is not an anchor: encoding it would mint the value 0.
	if (anchor === "") return undefined;
	let value = 0;
	for (const ch of anchor) {
		const digit = DIGIT.get(ch);
		if (digit === undefined) return undefined;
		value = value * 62 + digit;
	}
	return value;
}

/**
 * Write a Base62 anchor of an exact length, zero-padded — the inverse of the
 * padding `encodeAnchor` applies when minting.
 * @param value - the anchor's integer value.
 * @param length - the character count to reproduce.
 * @returns the anchor, exactly `length` characters.
 */
function anchorOfLength(value: number, length: number): string {
	let out = "";
	let rest = value;
	for (let i = 0; i < length; i++) {
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
	// Group by length first: within a group every anchor has the same character
	// count, so the length is written once and the values carry only their rank.
	const byLength = new Map<number, Set<number>>();
	for (const anchor of anchors) {
		const value = anchorValue(anchor);
		if (value === undefined) continue;
		const group = byLength.get(anchor.length);
		if (group === undefined) byLength.set(anchor.length, new Set([value]));
		else group.add(value);
	}
	const lengths = [...byLength.keys()].sort((a, b) => a - b);
	const bytes: number[] = [];
	writeVarint(bytes, lengths.length);
	for (const length of lengths) {
		const values = [...byLength.get(length)!].sort((a, b) => a - b);
		writeVarint(bytes, length);
		writeVarint(bytes, values.length);
		let previous = 0;
		for (const value of values) {
			writeVarint(bytes, value - previous);
			previous = value;
		}
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
		const groups = readVarint(bytes, at);
		if (groups === undefined) return undefined;
		at = groups.next;
		for (let group = 0; group < groups.value; group++) {
			const length = readVarint(bytes, at);
			if (length === undefined) return undefined;
			at = length.next;
			const count = readVarint(bytes, at);
			if (count === undefined) return undefined;
			at = count.next;
			let previous = 0;
			for (let i = 0; i < count.value; i++) {
				const delta = readVarint(bytes, at);
				if (delta === undefined) return undefined;
				previous += delta.value;
				at = delta.next;
				out.add(anchorOfLength(previous, length.value));
			}
		}
		return out;
	}
	// The first version of this codec: readable in principle, but its sets lost
	// leading zeros, so every set it wrote is WRONG. Healing the row is the only
	// safe answer — the session re-serves on its next read.
	if (raw.startsWith(DEFECTIVE_PREFIX)) return undefined;
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
