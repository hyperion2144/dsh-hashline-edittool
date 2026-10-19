/**
 * Reading a server's formatting capability out of its advertised
 * `ServerCapabilities`.
 *
 * Two facts from the field research (map #275 R1) shape this module:
 * 1. The provider fields are the SPEC's `documentFormattingProvider` and
 *    `documentRangeFormattingProvider`, each `boolean | { options } | undefined`
 *    — TS servers send `true`, clangd sends an options object, gopls and
 *    pyright omit the field entirely. Absent means NO, anything present means
 *    YES. (A real TLS 6.0 handshake — the smoke test — caught an earlier
 *    draft reading a `textDocumentFormattingProvider` name that no server
 *    sends.)
 * 2. Range support has one SPEC field (`documentRangeFormattingProvider`) and
 *    one de-facto EXTRA: clangd also sends the top-level `rangesSupport`.
 *    Either being present counts. rust-analyzer sends `false` and rejects the
 *    request with `-32600` — the explicit negative is honoured here, not read
 *    as "present"; a server that advertises true but rejects anyway falls
 *    back via the `-32601`-means-no rule in the request layer.
 *
 * Everything is read defensively: a capability object is untrusted data, and
 * a server that sends `null` or a string where an object was promised must
 * degrade to "unsupported", never throw.
 *
 * @module dsh-hashline-edittool/lsp/format/capability
 */

/** Whether a server can format the whole document and/or a requested range. */
export interface FormattingCapability {
	/** `textDocument/formatting` is available. */
	readonly full: boolean;
	/** `textDocument/rangeFormatting` is available (spec field or clangd's extra). */
	readonly range: boolean;
}

/**
 * LSP provider fields arrive as `true`, an options object, or nothing.
 * `false` and absence both mean "not offered"; ANY other present value means
 * "offered". A `null` counts as absent — some servers send it.
 */
function providerPresent(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	return true;
}

/**
 * Detect what this server can format.
 *
 * @param capabilities - the object the server's `initialize` result carried
 *   (already unwrapped from `result.capabilities`); anything non-object
 *   degrades to "supports nothing".
 */
export function detectFormattingCapability(
	capabilities: unknown,
): FormattingCapability {
	if (typeof capabilities !== "object" || capabilities === null) {
		return { full: false, range: false };
	}
	const caps = capabilities as Record<string, unknown>;
	return {
		full: providerPresent(caps.documentFormattingProvider),
		range:
			providerPresent(caps.documentRangeFormattingProvider) || providerPresent(caps.rangesSupport),
	};
}
