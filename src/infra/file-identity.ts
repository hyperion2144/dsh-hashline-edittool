/**
 * Streaming file identity for the anchor store (#414).
 *
 * The anchor store keys a file's rows by `{checksum, lineCount}`. `read` and
 * `edit` derive that pair from the text they already hold; `grep` must derive
 * it WITHOUT holding the file — a 2 GB build artifact and a two-line source
 * file have to cost the same heap. This module is that second derivation, and
 * it must be the SAME value: the store compares the two, so a checksum that
 * disagreed with `contentChecksum(normalizeContent(text))` would make every
 * later read think the file changed.
 *
 * The fold is the read line space's fold (ADR-0035): strip a leading BOM, turn
 * CRLF into LF, leave a lone CR alone. Only the chunk-boundary cases need
 * care — a `\r` at the end of a chunk whose `\n` starts the next one, and a
 * BOM split across the decoder's first read (the decoder buffers that itself).
 *
 * @module dsh-hashline-edittool/infra/file-identity
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** The identity the anchor store keys a file's rows by. */
export interface FileIdentity {
	readonly checksum: string;
	readonly lineCount: number;
}

/** How much one read returns. Large enough to amortise, small enough to bound. */
const CHUNK_BYTES = 64 * 1024;

/**
 * Compute a file's anchor identity without holding the file in memory.
 *
 * @param absolutePath - the file to read (the host's real path; ripgrep reads
 *   the same one).
 * @param signal - optional abort; checked once per chunk.
 * @returns the sha256 of the normalized text and that text's line count.
 */
export async function readFileIdentity(
	absolutePath: string,
	signal?: AbortSignal,
): Promise<FileIdentity> {
	const hash = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	/** A trailing `\r` whose partner may open the next chunk. */
	let carry = "";
	let started = false;
	let sawText = false;
	let newlines = 0;
	let lastWasNewline = false;

	const consume = (normalized: string): void => {
		if (normalized.length === 0) return;
		sawText = true;
		const folded = normalized.replace(/\r\n/g, "\n");
		hash.update(folded, "utf8");
		for (let i = 0; i < folded.length; i++) {
			if (folded.charCodeAt(i) === 10) newlines++;
		}
		lastWasNewline = folded.endsWith("\n");
	};

	for await (const chunk of createReadStream(absolutePath, { highWaterMark: CHUNK_BYTES })) {
		signal?.throwIfAborted();
		let text = decoder.decode(chunk as Buffer, { stream: true });
		if (!started) {
			started = true;
			if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		}
		let normalized = carry + text;
		carry = "";
		if (normalized.endsWith("\r")) {
			carry = "\r";
			normalized = normalized.slice(0, -1);
		}
		consume(normalized);
	}

	let tail = decoder.decode();
	if (!started && tail.charCodeAt(0) === 0xfeff) tail = tail.slice(1);
	// At EOF the carried CR has no partner to fold with, so it is a character
	// in the text — `consume` hashes it as one.
	consume(carry + tail);

	// `splitLines("")` is one empty line; otherwise a trailing newline does not
	// open a new line, but any text that does not end with one does.
	const lineCount = !sawText ? 1 : newlines + (lastWasNewline ? 0 : 1);
	return { checksum: hash.digest("hex"), lineCount };
}
