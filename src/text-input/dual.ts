/**
 * Dual-channel tool wrapper (spec #85 / research #51).
 *
 * A hashline tool is normally built with `defineTool`, which compiles the
 * parameter schema AND embeds an argument validator in `execute` — that
 * validator rejects a string payload before the body ever runs. The text
 * channel therefore wraps the compiled tool definition:
 *
 *   - `execute` first checks `typeof args === "string"`; a string payload is
 *     parsed through the tool's text-DSL parser into the JSON-equivalent
 *     object and the SAME body runs (payload equivalence is the parity
 *     contract of spec #85). Object payloads pass through untouched.
 *   - `presentCall` / `presentResult` do the same parse so replay and the
 *     web UI see a structured call view for text-channel invocations; when
 *     the payload cannot be parsed they fall back to `undefined` (generic
 *     card), never throwing.
 *
 * Everything else (compiled `parameters`, `output`, guidance projection)
 * stays exactly as `defineTool` produced it — the wrapper deliberately does
 * NOT re-register a raw definition, it only widens the execute entrance.
 *
 * @module dsh-hashline-edittool/text-input/dual
 */

/** A text-DSL parser: payload string → JSON-equivalent tool args. */
export type TextParser = (text: string) => object;

/** Narrow interface the wrapper touches; extra fields pass through. */
interface WrappableTool {
	execute(args: unknown, exec: unknown): Promise<unknown>;
	presentCall?(args: unknown): unknown;
	presentResult?(args: unknown, result: unknown): unknown;
}

/**
 * Wrap a compiled tool definition for the dual JSON/text channel.
 * The returned object shares every field of `tool` except the wrapped
 * `execute` / `presentCall` / `presentResult`.
 */
export function asDualChannel<T extends WrappableTool>(tool: T, parseText: TextParser): T {
	const { execute, presentCall, presentResult } = tool;

	const resolvedArgs = (args: unknown): unknown => {
		if (typeof args === "string") {
			try {
				return parseText(args);
			} catch {
				// Unparseable text: the body raises the E_PARSE_* error with the
				// full echo; presenters just fall back to the generic card.
				return undefined;
			}
		}
		return args;
	};

	return {
		...tool,
		async execute(args, exec) {
			if (typeof args === "string") {
				// Text channel: parse once here, then run the same body. A parse
				// error propagates as E_PARSE_* (whole-call abort semantics).
				return execute(parseText(args), exec);
			}
			return execute(args, exec);
		},
		presentCall(args) {
			if (presentCall === undefined) return undefined;
			const resolved = resolvedArgs(args);
			if (resolved === undefined) return undefined;
			return presentCall(resolved);
		},
		presentResult(args, result) {
			if (presentResult === undefined) return undefined;
			const resolved = resolvedArgs(args);
			if (resolved === undefined) return undefined;
			return presentResult(resolved, result);
		},
	} as T;
}
