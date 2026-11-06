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
import { truncateServedKey } from "../../hashline/hash-assign.js";

/**
 * Marks a packed payload and names its version.
 *
 * `~2` is the length-grouped form plus a per-anchor fingerprint (#420): the
 * served verdict compares fingerprints, so the wire carries them.
 *
 * `~1` is the length-grouped form without fingerprints. A bare `~` was the
 * first attempt, which dropped leading zeros; it is deliberately NOT decodable
 * — a wrong served set is worse than a missing one, because it makes anchors
 * the model legitimately holds unusable and the rejection blames the model.
 * Treating it as unreadable lets the caller heal the row, and the next read
 * re-serves correctly.
 */
const PACKED_PREFIX = "~1";

/** `~2` — the length-grouped form WITH a per-anchor fingerprint (#420). */
const PACKED_PREFIX_V2 = "~2";

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
 * Encode a served mirror for storage (#420).
 *
 * Each entry is an anchor plus the truncated fingerprint of the binding the
 * session saw. Anchors that are not Base62 (never produced by this plugin,
 * but a hand-edited store could hold them) are dropped rather than corrupting
 * the payload: the mirror's only consumer probes anchors this plugin minted.
 *
 * @param entries - `(anchor, fingerprint)` pairs for one session+path; order
 *   does not matter, and a duplicate anchor's last pair wins.
 * @returns the string to store in `served.hashes`.
 */
export function encodeServedAnchors(entries: Iterable<readonly [string, string]>): string {
	// Group by length first: within a group every anchor has the same character
	// count, so the length is written once and the values carry only their rank.
	const byLength = new Map<number, Map<number, string>>();
	for (const [anchor, key] of entries) {
		const value = anchorValue(anchor);
		if (value === undefined) continue;
		const fingerprint = truncateServedKey(key);
		const group = byLength.get(anchor.length);
		if (group === undefined) byLength.set(anchor.length, new Map([[value, fingerprint]]));
		else group.set(value, fingerprint);
	}
	const lengths = [...byLength.keys()].sort((a, b) => a - b);
	const bytes: number[] = [];
	writeVarint(bytes, lengths.length);
	for (const length of lengths) {
		const values = [...byLength.get(length)!].sort((a, b) => a[0] - b[0]);
		writeVarint(bytes, length);
		writeVarint(bytes, values.length);
		let previous = 0;
		for (const [value, fingerprint] of values) {
			writeVarint(bytes, value - previous);
			previous = value;
			const keyBytes = Buffer.from(fingerprint, "hex");
			writeVarint(bytes, keyBytes.length);
			for (const byte of keyBytes) bytes.push(byte);
		}
	}
	return PACKED_PREFIX_V2 + Buffer.from(bytes).toString("base64");
}

/**
 * Decode a stored served mirror — packed by this build, or any legacy shape.
 *
 * A payload from before #420 carries no fingerprints; its anchors decode with
 * the empty fingerprint — seen, binding unknown. The verdict REFUSES such a
 * row (a stale-binding rejection) until its echo re-fingerprints it, which is
 * the same one-round-trip self-heal a session restart pays; nothing is
 * silently revoked.
 *
 * @param raw - the stored `served.hashes` value.
 * @returns `(anchor → fingerprint)` pairs, or undefined when the payload is
 *   unreadable (the caller treats that as a corrupt row, exactly as it did for
 *   malformed JSON).
 */
export function decodeServedAnchors(raw: string): Map<string, string> | undefined {
	if (raw.startsWith(PACKED_PREFIX_V2)) {
		const bytes = Buffer.from(raw.slice(PACKED_PREFIX_V2.length), "base64");
		const out = new Map<string, string>();
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
				const keyLength = readVarint(bytes, at);
				if (keyLength === undefined) return undefined;
				at = keyLength.next;
				if (at + keyLength.value > bytes.length) return undefined;
				const fingerprint = keyLength.value === 0 ? "" : Buffer.from(bytes.subarray(at, at + keyLength.value)).toString("hex");
				at += keyLength.value;
				out.set(anchorOfLength(previous, length.value), fingerprint);
			}
		}
		return out;
	}
	// The length-grouped form before #420: anchors only, no fingerprints.
	// Every anchor decodes with the empty fingerprint — seen, binding unknown;
	if (raw.startsWith(PACKED_PREFIX)) {
		const bytes = Buffer.from(raw.slice(PACKED_PREFIX.length), "base64");
		const out = new Map<string, string>();
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
				out.set(anchorOfLength(previous, length.value), "");
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
	const anchorsOf = (entries: unknown[]): Map<string, string> | undefined => {
		const out = new Map<string, string>();
		for (const entry of entries) {
			if (entry === null) continue;
			if (typeof entry !== "string" || !anchorRe.test(entry)) return undefined;
			out.set(entry, "");
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
