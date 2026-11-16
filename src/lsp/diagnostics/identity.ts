/**
 * A diagnostic's IDENTITY (#429, ADR-0039) — the pure half of the regression
 * signal.
 *
 * Two diagnostics are THE SAME when severity, `source`, `code` and the
 * normalized message all agree. The LINE NUMBER is deliberately excluded: an
 * unrelated edit that shifts lines down must not re-report the same sentence,
 * and "same sentence, new line" is exactly the noise this module exists to
 * suppress. Missing `source` / `code` compare as empty strings — most servers
 * fill them, some never do, and both kinds must sit in one ledger. The same
 * sentence appearing twice on a line stays TWO entries (a multiset, counted —
 * the repetition itself is a fact, never folded away).
 *
 * Pure by contract: no IO, no clock, no ledger — the suppression ledger (see
 * `./ledger.js`) consumes these identities; nothing here touches it.
 *
 * @module dsh-hashline-edittool/lsp/diagnostics/identity
 */

/** One pushed LSP diagnostic, narrowed to the fields identity reads. */
export interface RawDiagnostic {
	severity?: unknown;
	source?: unknown;
	code?: unknown;
	message?: unknown;
}

/**
 * Collapse every whitespace run to a single space and trim the ends.
 *
 * Case is PRESERVED (`Foo` and `foo` are different sentences — a server that
 * distinguishes them means it), and line breaks inside one message fold away:
 * only the WORDS are the identity, not the wrap that carried them.
 */
export function normalizeDiagnosticMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

/**
 * The identity string. JSON of the field tuple, so no separator a message
 * could contain can forge a collision.
 */
export function diagnosticIdentity(d: RawDiagnostic): string {
	const severity = typeof d.severity === "number" ? d.severity : 0;
	const source = typeof d.source === "string" ? d.source : "";
	const code = typeof d.code === "string" || typeof d.code === "number" ? String(d.code) : "";
	const message = typeof d.message === "string" ? normalizeDiagnosticMessage(d.message) : "";
	return JSON.stringify([severity, source, code, message]);
}

/** The severity WORD a label speaks: 1 = error, 2 = warning, anything else "diagnostic". */
function severityWord(severity: number): string {
	return severity === 1 ? "error" : severity === 2 ? "warning" : "diagnostic";
}

/**
 * The one row label every face speaks (#429): the severity word, the server's
 * `source` and `code` beside it when the server supplied them, the message
 * verbatim after.
 *
 * Three degradations, exactly as the spec fixes them:
 * - source + code → `error(pyright/2322): …`
 * - only code     → `error(2322): …`
 * - neither       → `error: …` (today's shape, unchanged)
 *
 * NO classification lives here: "type vs syntax vs lint" is not a protocol
 * dimension, and the raw handles are the honest substitute (#429).
 */
export function diagnosticLabel(
	severity: number,
	source: string | undefined,
	code: string | number | undefined,
	message: string,
): string {
	const word = severityWord(severity);
	const origin =
		source !== undefined && source !== ""
			? code !== undefined && code !== ""
				? `(${source}/${code})`
				: `(${source})`
			: code !== undefined && code !== ""
				? `(${code})`
				: "";
	return `${word}${origin}: ${message}`;
}
