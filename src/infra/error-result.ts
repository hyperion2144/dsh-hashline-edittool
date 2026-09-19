/**
 * The structured error-value seam (map #137, decisions #138, spec #146, ADR-0007).
 *
 * Domain errors — failures carrying a bracketed `[E_*]` code from the tool's
 * own vocabulary — are caught at each tool's `execute` boundary and returned
 * as a SUCCESS-shaped value `{ modelText, error }` instead of thrown at dsh.
 * The model reads the same `[E_*]` text as before (text mode: the thrown
 * message verbatim); the client renders the error card from the persisted
 * `meta.error`. Aborts, sandbox denials and unexpected crashes carry no
 * `[E_*]` marker and are re-thrown untouched, so every host semantic keyed
 * to `isError` — interruption records, escalation offers, failure
 * accounting — stays intact (ADR-0007).
 *
 * @module dsh-hashline-edittool/infra/error-result
 */

import { isJsonOutput } from "./settings.js";

/** The persisted error projection (`presentationMeta.error`). One per failed call. */
export interface ErrorMeta {
	/** The `[E_*]` vocabulary code, WITHOUT the brackets ("E_STALE", "E_BAD_SHAPE"). */
	code: string;
	/** The failure's head message (echo tails are split into `context`). */
	message: string;
	/** The related file path, when the failure is about one. */
	path?: string;
	/** The echo / per-item block — the what-it-looks-like-now tail. */
	context?: string;
	/** The actionable recovery suggestion, when one is not already in `message`. */
	hint?: string;
}

/** The minimal canonical value of a failed call: what the model reads + the card's data. */
export interface ErrorResultValue {
	modelText: string;
	error: ErrorMeta;
}

/**
 * The shared output-schema fragment for the `error` field (spec #146 decision
 * 3): one definition, spread into every tool's `output.schema` properties.
 * Optional — a successful value never carries it. `additionalProperties: false`
 * is preserved, so validation strength does not move.
 */
export const errorFieldSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		code: { type: "string", required: true },
		message: { type: "string", required: true },
		path: { type: "string" },
		context: { type: "string" },
		hint: { type: "string" },
	},
} as const;

/** First bracketed `[E_*]` marker in a message — the domain-error whitelist shape. */
const E_CODE = /\[(E_[A-Z_]+)\]/;
/** The echo block's header phrase — the ±context rows a stale/declared rejection appends. */
const ECHO_MARKER = "Echo of the line you tried";

/**
 * Pull the related file path out of a tool call's args (`path`, falling back
 * to `file_path`), so a catch site can enrich the error card without knowing
 * the tool's parameter spelling.
 */
export function pathFromArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const a = args as { path?: unknown; file_path?: unknown };
	if (typeof a.path === "string") return a.path;
	if (typeof a.file_path === "string") return a.file_path;
	return undefined;
}

/**
 * Compose the canonical error value from structured parts.
 *
 * Text mode renders the house message format — `[CODE] message`, then the
 * context block after a blank line, then a `Hint:` line — which is what keeps
 * a converted thrown message byte-identical (the recognizer feeds the pieces
 * back in the exact shape they were parsed from). JSON mode emits a pure JSON
 * error object (map #137 Q1c: the model channel follows the output mode).
 */
export function buildErrorResult(opts: {
	code: string;
	message: string;
	path?: string;
	context?: string;
	hint?: string;
	mode: "json" | "text";
}): ErrorResultValue {
	const error: ErrorMeta = {
		code: opts.code,
		message: opts.message,
		...(opts.path !== undefined ? { path: opts.path } : {}),
		...(opts.context !== undefined ? { context: opts.context } : {}),
		...(opts.hint !== undefined ? { hint: opts.hint } : {}),
	};
	const modelText =
		opts.mode === "json"
			? JSON.stringify({ error: true, ...error })
			: `[${opts.code}] ${opts.message}` +
				(opts.context !== undefined ? `\n\n${opts.context}` : "") +
				(opts.hint !== undefined ? `\n\nHint: ${opts.hint}` : "");
	return { modelText, error };
}

/**
 * Convert one thrown domain error into an error value; re-throw anything
 * outside the `[E_*]` whitelist. The text-mode model text is the thrown
 * message VERBATIM — never recomposed from the parts, so no message format
 * can break byte-identity. The meta split is card-only and best-effort:
 * the echo block ("Echo of the line you tried…", the stale/declared
 * rejections' ±context rows — indented or not) becomes `context`, falling
 * back to the first blank line, falling back to no context.
 *
 * @param err - whatever the pipeline threw.
 * @param opts.path - the related file path, when the call site knows one.
 * @returns the canonical error value for the active output mode.
 * @throws the original error when it carries no `[E_*]` marker.
 */
export function thrownErrorResult(err: unknown, opts?: { path?: string }): ErrorResultValue {
	const message = err instanceof Error ? err.message : String(err);
	const match = E_CODE.exec(message);
	if (match === null) throw err;
	const code = match[1]!;
	const head = message.slice(match.index + match[0].length).replace(/^ /, "");
	// The echo header opens the ±context rows block the stale/declared
	// rejections attach; the two composers indent it differently, so the
	// marker phrase — not its whitespace — is the seam.
	const echoAt = head.indexOf(ECHO_MARKER);
	const split = echoAt !== -1 ? echoAt : head.indexOf("\n\n");
	const body = split === -1 ? head : head.slice(0, split).replace(/\s+$/, "");
	const context = split === -1 ? undefined : head.slice(split).replace(/^\s+/, "");
	const error: ErrorMeta = {
		code,
		message: body,
		...(opts?.path !== undefined ? { path: opts.path } : {}),
		...(context !== undefined && context.trim() !== "" ? { context } : {}),
	};
	return {
		modelText:
			isJsonOutput()
				? JSON.stringify({ error: true, ...error })
				: message,
		error,
	};
}
