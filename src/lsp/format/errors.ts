/**
 * Error vocabulary for the formatting capability.
 *
 * Bracketed `[E_*]` codes are the plugin's error contract (`infra/error-result`
 * recognises them in thrown messages, and `test/core/error-codes.test.ts`
 * enforces that every code emitted here is documented in both READMEs — adding
 * a code without a README row breaks CI, by design).
 *
 * `E_FORMAT_UNSUPPORTED` means the server IS up and answered, but advertises
 * no document formatting provider. It is distinct from `E_LSP_NO_SERVER`
 * (nothing running) and from a request that timed out (`E_LSP_TIMEOUT`): the
 * model can act on the difference — unsupported means "formatting will not
 * happen for this language until a formatter is installed", while a timeout
 * may simply mean "try again".
 *
 * A server that answers `-32601` (method not found) for a formatting request
 * is treated as "no formatter" too (measured on gopls and pyright, which
 * advertise no provider field and reject the method): it converts to
 * {@link FormatUnsupportedError} at the request layer, not to a protocol error.
 *
 * @module dsh-hashline-edittool/lsp/format/errors
 */

/** The server is running but offers no document formatting provider. */
export const E_FORMAT_UNSUPPORTED = "[E_FORMAT_UNSUPPORTED]";

/**
 * The language server has no formatter for this document.
 *
 * Raised by the request layer for BOTH spellings of "no": a capability set
 * without `documentFormattingProvider`, and a live request answered with
 * `-32601`. The manual `format` tool maps it to `E_FORMAT_UNSUPPORTED`; the
 * automatic path treats it as a silent skip (G3: an absent formatter is the
 * NORMAL case, not a failure).
 */
export class FormatUnsupportedError extends Error {
	constructor(languageDisplay: string) {
		super(
			`${E_FORMAT_UNSUPPORTED} The language server for ${languageDisplay} has no document formatting provider.`,
		);
		this.name = "FormatUnsupportedError";
	}
}

/**
 * A server's TextEdits could not be applied to the document text.
 *
 * R1 measured the failure mode this guards: a range outside the document, or
 * two edits sharing text, silently DELETES characters when applied naively.
 * The plugin refuses instead — a misreported span must fail loudly, because
 * the result would be written to disk and served back with anchors.
 */
export class FormatEditError extends Error {
	constructor(message: string) {
		super(`[E_FORMAT_EDITS] ${message}`);
		this.name = "FormatEditError";
	}
}
