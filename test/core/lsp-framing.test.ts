/**
 * LSP wire framing. Every failure here looks like "the language server is
 * broken" from above, so the two cases that actually bite are pinned: byte
 * lengths (not character lengths) and arbitrary chunk boundaries.
 */
import { describe, expect, it } from "vitest";
import { encodeMessage, LspFramingError, MessageReader } from "../../src/lsp/framing.js";

function frame(body: string): Buffer {
	return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`, "ascii"), Buffer.from(body, "utf8")]);
}

describe("encoding", () => {
	it("counts BYTES, not characters", () => {
		// Four CJK characters: 4 code units, 12 UTF-8 bytes. A length taken from
		// String.length desynchronizes the stream silently.
		const encoded = encodeMessage({ jsonrpc: "2.0", method: "x", params: { s: "中文测试" } });
		const header = encoded.subarray(0, encoded.indexOf("\r\n\r\n")).toString("ascii");
		const declared = Number.parseInt(/Content-Length: (\d+)/.exec(header)![1]!, 10);
		const body = encoded.subarray(encoded.indexOf("\r\n\r\n") + 4);
		expect(declared).toBe(body.byteLength);
		expect(declared).toBeGreaterThan(JSON.stringify({ jsonrpc: "2.0", method: "x", params: { s: "中文测试" } }).length - 1);
	});

	it("round-trips through the reader", () => {
		const reader = new MessageReader();
		const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null } };
		expect(reader.push(encodeMessage(message))).toEqual([message]);
		expect(reader.pendingBytes).toBe(0);
	});
});

describe("chunk boundaries", () => {
	it("waits for a header that arrives in pieces", () => {
		const reader = new MessageReader();
		const full = frame('{"jsonrpc":"2.0","id":1,"result":null}');
		expect(reader.push(full.subarray(0, 5))).toEqual([]);
		expect(reader.push(full.subarray(5, 20))).toEqual([]);
		expect(reader.push(full.subarray(20))).toEqual([{ jsonrpc: "2.0", id: 1, result: null }]);
	});

	it("waits for a body that arrives in pieces", () => {
		const reader = new MessageReader();
		const full = frame('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}');
		const split = full.byteLength - 5;
		expect(reader.push(full.subarray(0, split))).toEqual([]);
		expect(reader.pendingBytes).toBeGreaterThan(0);
		expect(reader.push(full.subarray(split))).toEqual([{ jsonrpc: "2.0", id: 2, result: { ok: true } }]);
	});

	it("emits every message from one chunk, in order", () => {
		const reader = new MessageReader();
		const chunk = Buffer.concat([
			frame('{"jsonrpc":"2.0","id":1,"result":1}'),
			frame('{"jsonrpc":"2.0","id":2,"result":2}'),
			frame('{"jsonrpc":"2.0","id":3,"result":3}'),
		]);
		expect(reader.push(chunk).map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
		expect(reader.pendingBytes).toBe(0);
	});

	it("carries a partial trailer into the next push", () => {
		const reader = new MessageReader();
		const first = frame('{"jsonrpc":"2.0","id":1,"result":1}');
		const second = frame('{"jsonrpc":"2.0","id":2,"result":2}');
		// A chunk that ends in the middle of the second message's header.
		const chunk = Buffer.concat([first, second.subarray(0, 12)]);
		expect(reader.push(chunk).map((m) => (m as { id: number }).id)).toEqual([1]);
		expect(reader.push(second.subarray(12)).map((m) => (m as { id: number }).id)).toEqual([2]);
	});

	it("handles a multi-byte character split across chunks", () => {
		const reader = new MessageReader();
		const full = frame('{"jsonrpc":"2.0","id":1,"result":"中"}');
		// Cut inside the UTF-8 encoding of 中 (3 bytes).
		const cut = full.byteLength - 2;
		expect(reader.push(full.subarray(0, cut))).toEqual([]);
		expect(reader.push(full.subarray(cut))).toEqual([{ jsonrpc: "2.0", id: 1, result: "中" }]);
	});
});

describe("headers", () => {
	it("accepts extra headers and mixed case", () => {
		const reader = new MessageReader();
		const body = '{"jsonrpc":"2.0","id":1,"result":1}';
		const raw = Buffer.from(
			`content-length: ${Buffer.byteLength(body)}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
			"utf8",
		);
		expect(reader.push(raw)).toEqual([{ jsonrpc: "2.0", id: 1, result: 1 }]);
	});

	it("refuses a header block with no Content-Length", () => {
		const reader = new MessageReader();
		expect(() => reader.push(Buffer.from("X-Nothing: 1\r\n\r\n{}", "ascii"))).toThrow(LspFramingError);
	});

	it("refuses a non-integer Content-Length", () => {
		const reader = new MessageReader();
		expect(() => reader.push(Buffer.from("Content-Length: abc\r\n\r\n{}", "ascii"))).toThrow(/not a non-negative integer/);
	});

	it("refuses a body past the cap instead of buffering forever", () => {
		const reader = new MessageReader(16);
		expect(() => reader.push(Buffer.from("Content-Length: 999\r\n\r\n", "ascii"))).toThrow(/exceeds the 16-byte cap/);
	});

	it("refuses a stream that never produces a header terminator", () => {
		const reader = new MessageReader();
		expect(() => reader.push(Buffer.alloc(9 * 1024, 0x41))).toThrow(/not LSP/);
	});

	it("reports invalid JSON as a framing error, not a bare SyntaxError", () => {
		const reader = new MessageReader();
		expect(() => reader.push(frame("{not json"))).toThrow(LspFramingError);
	});
});
