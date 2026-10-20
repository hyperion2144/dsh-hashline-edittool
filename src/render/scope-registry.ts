/**
 * The seam between the diff renderer and the scope detector.
 *
 * The detector lives in `./scope/` — a pure function over source text, with
 * no dependency on the renderer. The renderer asks this registry for a
 * provider, and the registry hands over the real detector by default: a
 * block header's scope name must appear without anybody registering
 * anything first.
 *
 * The registry exists for the OTHER direction — a caller that wants a
 * different detector (a test, a host that knows more about the language than
 * the syntactic scanner does) registers one, and every later lookup uses it.
 *
 * A detector that cannot name the line returns `undefined` and the header
 * simply carries no name (spec §3.3): the name is information, never a
 * correctness input.
 *
 * @module dsh-hashline-edittool/render/scope-registry
 */

import { scopeLabelAt as detectScopeLabelAt } from "./scope/index.js";

/**
 * The lookup a block header's scope name comes from: the named symbol
 * enclosing a line, or `undefined` when there is none.
 *
 * @param text - the POST-edit source text.
 * @param line - the 1-based line the name should enclose.
 * @param path - the path of the file the text came from; the language the
 *   text is read with is taken from it.
 */
export type ScopeLabelAt = (text: string, line: number, path?: string) => string | undefined;

let provider: ScopeLabelAt | undefined;

/**
 * Register a detector explicitly — the default is the real one.
 *
 * @param fn - the detector, or `undefined` to fall back to the real one.
 */
export function setScopeLabelAt(fn: ScopeLabelAt | undefined): void {
	provider = fn;
}

/**
 * The detector in use: the registered one, else the real syntactic detector.
 *
 * @returns the scope lookup.
 */
export function currentScopeLabelAt(): ScopeLabelAt {
	return provider ?? detectScopeLabelAt;
}
