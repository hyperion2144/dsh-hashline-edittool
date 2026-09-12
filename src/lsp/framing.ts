/**
 * JSON-RPC framing for the LSP wire: `Content-Length`-delimited messages over
 * a raw byte stream.
 *
 * This is the layer that has to be exactly right, because every failure above
 * it looks like "the language server is broken". Two details earn their tests:
 *
 * 1. **`Content-Length` counts BYTES, not characters.** A payload containing
 *    CJK or an emoji is longer in bytes than in code units, so a length
 *    computed from `String.length` desynchronizes the stream — and it
 *    desynchronizes it *silently*, because the reader then slices the next
 *    message out of the middle of this one. The failure surfaces far away, as
 *    a parse error in an unrelated request.
 * 2. **Chunk boundaries are arbitrary.** One physical read may carry half a
 *    header, a whole message plus the start of the next, or a body split
 *    anywhere. The reader therefore buffers bytes and only emits complete
 *    messages, which is why it is a class and not a function.
 *
 * @module dsh-hashline-edittool/lsp/framing
 */

/** The header/body separator required by the protocol. */
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "ascii");
/** Upper bound on a header block, so a malformed stream cannot grow forever. */
const MAX_HEADER_BYTES = 8 * 1024;

/** A framing failure the caller can report as a protocol error. */
export class LspFramingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspFramingError";
	}
}

/**
 * Encode one JSON-RPC message with its `Content-Length` header.
 *
 * @param payload - the message object.
 * @returns the bytes to write to the server's stdin.
 */
export function encodeMessage(payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii");
	return Buffer.concat([header, body]);
}

/**
 * Incremental reader for a `Content-Length`-framed stream.
 *
 * Feed it whatever arrives; it returns the messages that are now complete and
 * keeps the remainder buffered.
 */
export class MessageReader {
	#buffer: Buffer = Buffer.alloc(0);
	/** Beyond this the stream is not LSP; refuse rather than buffer forever. */
	#maxBodyBytes: number;

	constructor(maxBodyBytes = 64 * 1024 * 1024) {
		this.#maxBodyBytes = maxBodyBytes;
	}

	/** Bytes currently held back waiting for the rest of their message. */
	get pendingBytes(): number {
		return this.#buffer.byteLength;
	}

	/**
	 * Feed a chunk and collect every message it completed.
	 *
	 * @param chunk - raw bytes from the server's stdout.
	 * @returns parsed messages, in arrival order.
	 * @throws {LspFramingError} on a malformed header or an over-large body.
	 */
	push(chunk: Buffer | Uint8Array): unknown[] {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.#buffer = this.#buffer.byteLength === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);
		const out: unknown[] = [];

		for (;;) {
			const headerEnd = this.#buffer.indexOf(HEADER_TERMINATOR);
			if (headerEnd === -1) {
				if (this.#buffer.byteLength > MAX_HEADER_BYTES) {
					throw new LspFramingError(
						`No header terminator within ${MAX_HEADER_BYTES} bytes — this stream is not LSP (or the server is writing garbage).`,
					);
				}
				return out; // the header itself is still arriving
			}

			const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
			const length = parseContentLength(header);
			const bodyStart = headerEnd + HEADER_TERMINATOR.byteLength;
			if (length > this.#maxBodyBytes) {
				throw new LspFramingError(`Content-Length ${length} exceeds the ${this.#maxBodyBytes}-byte cap.`);
			}
			// Only emit once the WHOLE body is here: a partial body parsed as
			// JSON would throw a confusing syntax error instead of waiting.
			if (this.#buffer.byteLength < bodyStart + length) return out;

			const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.#buffer = this.#buffer.subarray(bodyStart + length);
			try {
				out.push(JSON.parse(body));
			} catch (error) {
				throw new LspFramingError(
					`Message body was not valid JSON (${error instanceof Error ? error.message : String(error)}): ${body.slice(0, 200)}`,
				);
			}
		}
	}
}

/**
 * Read `Content-Length` out of a header block.
 *
 * Header names are case-insensitive per HTTP convention, and a server may send
 * extra headers (`Content-Type` is common), so the block is scanned rather
 * than matched positionally.
 */
function parseContentLength(header: string): number {
	let value: number | undefined;
	for (const line of header.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (name !== "content-length") continue;
		const raw = line.slice(colon + 1).trim();
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isInteger(parsed) || parsed < 0) {
			throw new LspFramingError(`Content-Length is not a non-negative integer: "${raw}"`);
		}
		value = parsed;
	}
	if (value === undefined) {
		throw new LspFramingError(`Header block has no Content-Length: ${JSON.stringify(header)}`);
	}
	return value;
}
