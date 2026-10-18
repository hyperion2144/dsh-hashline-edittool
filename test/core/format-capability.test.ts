/**
 * Capability detection — the field research's shape table, pinned.
 *
 * The field names are the SPEC's (`documentFormattingProvider` /
 * `documentRangeFormattingProvider`) — pinned by the real-server smoke test,
 * which caught an earlier draft reading a `textDocumentFormattingProvider`
 * name no server sends. The shape table is R1's, corrected where the wire
 * disagreed: TLS advertises BOTH providers as `true` and no `rangesSupport`;
 * clangd adds the top-level `rangesSupport` OBJECT side; rust-analyzer sends
 * the explicit `false`; gopls and pyright send NOTHING. The detector must
 * read all of it the way a formatter client would.
 */
import { describe, expect, it } from "vitest";
import { detectFormattingCapability } from "../../src/lsp/format/capability.js";

describe("detectFormattingCapability", () => {
	it("reads the boolean spelling (TypeScript servers)", () => {
		expect(
			detectFormattingCapability({ documentFormattingProvider: true }),
		).toEqual({ full: true, range: false });
	});

	it("reads the object spelling (clangd) including rangesSupport", () => {
		expect(
			detectFormattingCapability({
				documentFormattingProvider: { afterEdits: true },
				rangesSupport: true,
			}),
		).toEqual({ full: true, range: true });
	});

	it("honours the explicit negative (rust-analyzer's rangesSupport: false)", () => {
		expect(
			detectFormattingCapability({
				documentFormattingProvider: true,
				rangesSupport: false,
			}),
		).toEqual({ full: true, range: false });
	});

	it("reads absence as absence (gopls, pyright)", () => {
		expect(detectFormattingCapability({})).toEqual({ full: false, range: false });
	});

	it("reads null as absence — some servers send it", () => {
		expect(
			detectFormattingCapability({ documentFormattingProvider: null }),
		).toEqual({ full: false, range: false });
	});

	it("degrades a non-object capability set to supports-nothing", () => {
		expect(detectFormattingCapability(undefined)).toEqual({ full: false, range: false });
		expect(detectFormattingCapability("yes")).toEqual({ full: false, range: false });
		expect(detectFormattingCapability(null)).toEqual({ full: false, range: false });
	});
});
