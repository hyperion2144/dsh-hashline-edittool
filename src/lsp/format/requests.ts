/**
 * The formatting RPCs, and the one classification that matters.
 *
 * Both requests go through {@linkcode FormattingClient} — a structural
 * two-method view of `LspSession` — so the request layer carries no session
 * import and tests stub a plain object.
 *
 * The classification this module OWNS is `-32601` (method not found): R1
 * measured gopls and pyright advertising NO formatting provider field and
 * rejecting `textDocument/formatting` with `-32601`, while TLS accepts the
 * full-document method but not the range one. "The server rejected the
 * METHOD" is the same fact as "the capability table omitted the provider" —
 * no formatter for this document — so both spellings collapse into a single
 * {@link FormatUnsupportedError} here, and callers see ONE unsupported shape.
 *
 * @module dsh-hashline-edittool/lsp/format/requests
 */
import { LspSessionError } from "../session.js";
import { FormatEditError, FormatUnsupportedError } from "./errors.js";
import type { LspTextEdit } from "./text-edits.js";

/** The session surface the formatting requests need (structural, not nominal). */
export interface FormattingClient {
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/** The LSP `Range` a request is addressed to (0-based line/character). */
export interface FormatRange {
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

/** What a `-32601` rejection looks like after the session wraps it. */
function isMethodNotFound(error: unknown): boolean {
	if (!(error instanceof LspSessionError)) return false;
	if (error.code !== "E_LSP_REQUEST_FAILED") return false;
	try {
		const parsed = JSON.parse(error.message) as { code?: unknown };
		return parsed.code === -32601;
	} catch {
		return error.message.includes("-32601");
	}
}

/**
 * Coerce the response body into edits. `null` means "no changes" (the LSP
 * spec's own null-is-empty reading); any other non-array is a malformed
 * response and is refused in the [E_FORMAT_EDITS] family — it is NOT
 * "unsupported", which is a capability fact, not a protocol fact.
 */
function validateEdits(value: unknown): LspTextEdit[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new FormatEditError(`formatting response is not an edit list (${typeof value}).`);
	}
	return value as LspTextEdit[];
}

/**
 * Ask the server to format the whole document.
 *
 * @returns the server's TextEdits (possibly empty — empty means "already
 *   formatted", NOT unsupported).
 * @throws FormatUnsupportedError on `-32601`.
 * @throws LspSessionError unchanged otherwise (timeout, closed session, a
 *   server-side error that is NOT "method missing" — a real failure the
 *   caller reports as such).
 */
export async function requestFormatting(
	session: FormattingClient,
	uri: string,
	options: { insertSpaces: boolean; tabSize: number },
	timeoutMs: number,
): Promise<LspTextEdit[]> {
	try {
		return validateEdits(
			await session.request(
				"textDocument/formatting",
				{
					textDocument: { uri },
					options: { insertSpaces: options.insertSpaces, tabSize: options.tabSize },
				},
				timeoutMs,
			),
		);
	} catch (error) {
		if (isMethodNotFound(error)) throw new FormatUnsupportedError("this document's server");
		throw error;
	}
}

/**
 * Ask the server to format one range.
 *
 * The response may legitimately span MORE than the range (clangd expands to
 * the enclosing declaration, R1) — callers must apply the edits as given and
 * show what actually changed, not what was requested.
 */
export async function requestRangeFormatting(
	session: FormattingClient,
	uri: string,
	range: FormatRange,
	options: { insertSpaces: boolean; tabSize: number },
	timeoutMs: number,
): Promise<LspTextEdit[]> {
	try {
		return validateEdits(
			await session.request(
				"textDocument/rangeFormatting",
				{
					textDocument: { uri },
					range,
					options: { insertSpaces: options.insertSpaces, tabSize: options.tabSize },
				},
				timeoutMs,
			),
		);
	} catch (error) {
		if (isMethodNotFound(error)) throw new FormatUnsupportedError("this document's server");
		throw error;
	}
}
