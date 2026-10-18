/**
 * Formatting request classification.
 *
 * The one classification that matters: `-32601` (method not found) is the
 * SAME fact as "no provider in the capability table" — gopls and pyright
 * have no formatter field and reject the method, TLS accepts the full
 * method but rejects the range one. Both must surface as ONE unsupported
 * shape; everything else passes through unchanged.
 */
import { describe, expect, it } from "vitest";
import {
	requestFormatting,
	requestRangeFormatting,
	type FormattingClient,
} from "../../src/lsp/format/requests.js";
import { FormatEditError, FormatUnsupportedError } from "../../src/lsp/format/errors.js";
import { LspSessionError } from "../../src/lsp/session.js";

const OPTIONS = { insertSpaces: true, tabSize: 4 };

/** A session stub whose `request` fails/succeeds per test. */
function client(impl: (method: string, params: unknown) => unknown): FormattingClient {
	return {
		request: async (method, params) => impl(method, params),
	};
}

describe("requestFormatting / requestRangeFormatting", () => {
	it("returns the server's edits", async () => {
		const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }];
		const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
		const session = client((method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return edits;
		});
		expect(await requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).toEqual(edits);
		expect(seen[0]!.method).toBe("textDocument/formatting");
		expect(seen[0]!.params.options).toEqual(OPTIONS);
		expect(seen[0]!.params.textDocument).toEqual({ uri: "file:///a.ts" });
	});

	it("sends the range for range formatting", async () => {
		const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 4 } };
		const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
		const session = client((method, params) => {
			seen.push({ method, params: params as Record<string, unknown> });
			return [];
		});
		await requestRangeFormatting(session, "file:///a.ts", range, OPTIONS, 1000);
		expect(seen[0]!.method).toBe("textDocument/rangeFormatting");
		expect(seen[0]!.params.range).toEqual(range);
	});

	it("classifies -32601 as unsupported, not a protocol failure", async () => {
		const session = client(() => {
			throw new LspSessionError("E_LSP_REQUEST_FAILED", JSON.stringify({ code: -32601, message: "method not found" }));
		});
		await expect(requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).rejects.toBeInstanceOf(
			FormatUnsupportedError,
		);
		await expect(
			requestRangeFormatting(session, "file:///a.ts", { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, OPTIONS, 1000),
		).rejects.toBeInstanceOf(FormatUnsupportedError);
	});

	it("passes a timeout through unchanged", async () => {
		const session = client(() => {
			throw new LspSessionError("[E_LSP_TIMEOUT]", "textDocument/formatting did not answer within 1000 ms.");
		});
		await expect(requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).rejects.toBeInstanceOf(
			LspSessionError,
		);
	});

	it("passes a non-32601 server error through unchanged", async () => {
		const session = client(() => {
			throw new LspSessionError("E_LSP_REQUEST_FAILED", JSON.stringify({ code: -32600, message: "invalid request" }));
		});
		await expect(requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).rejects.toThrow(
			/-32600/,
		);
	});

	it("reads a null answer as no changes", async () => {
		const session = client(() => null);
		expect(await requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).toEqual([]);
	});

	it("refuses a malformed non-array answer in the [E_FORMAT_EDITS] family", async () => {
		const session = client(() => "edits?");
		await expect(requestFormatting(session, "file:///a.ts", OPTIONS, 1000)).rejects.toBeInstanceOf(
			FormatEditError,
		);
	});
});
