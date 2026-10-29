/**
 * The client's half of the host-text contract (ADR-0024).
 *
 * THE HOST SENDS FACTS, NEVER PROSE. It cannot read the reader's language — the
 * locale seat is a CLIENT service (#369) — so a host that has a sentence for a
 * card names the WORDING with a stable key and hands over the values that fill
 * it. This module is where that contract is ENFORCED: the shape gate that
 * accepts a wire text, and the resolution that turns one into the reader's
 * sentence.
 *
 * THREE SHAPES, ONE RULE:
 *
 *  - a LEGACY sentence — an old host's plain string — renders verbatim;
 *  - a WIRE TEXT — a key plus its params — renders through `t()`, in the
 *    language the reader chose;
 *  - an UNKNOWN key is REFUSED, so nothing ever paints a key literal on screen
 *    (#369 — the exact failure the shipped `conversation` seat had).
 *
 * The shape is the same wherever the text travelled: a persisted meta field
 * (`rowTitle`, `lossyNote`) or a ROUTE's JSON payload (the language-server
 * routes, #377). ONE gate for both is what keeps them from drifting apart.
 *
 * @module dsh-hashline-edittool-client/wire-text
 */
import { WIRE_TEXT_KEYS, type CardLocaleKey } from "./locale.js";
import type { WireText, WireTextKey } from "./types.js";

/** The vocabulary seat, narrowed to this namespace's keys. */
export type CardTranslate = (key: CardLocaleKey, params?: Record<string, unknown>) => string;

/**
 * Is this key one the host may put on the wire?
 *
 * The gate is the wire's OWN list (`WIRE_TEXT_KEYS`), not the whole vocabulary:
 * a key the dictionary carries but the wire never carries is not a wire text,
 * and accepting it would let a card draw a wording the host never asked for.
 *
 * @param key - the key the host sent.
 * @returns whether the wire may carry it.
 */
function isWireTextKey(key: string): key is WireTextKey {
	return Object.hasOwn(WIRE_TEXT_KEYS, key);
}

/**
 * One wire text the host sent: a stable key plus the params that fill it.
 *
 * The key must be one the wire may carry: a key this client does not know would
 * render as its own NAME on screen — the exact failure the shipped `conversation`
 * seat had (#369). An unknown key is refused, so the row falls back to its own
 * label instead of showing a key literal.
 *
 * @param value - the raw value the host sent.
 * @returns the wire text, or `undefined` when the value is not one.
 */
export function wireTextFromValue(value: unknown): WireText | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { key, params } = value as Record<string, unknown>;
	if (typeof key !== "string" || !isWireTextKey(key)) return undefined;
	if (params !== undefined) {
		if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
		for (const entry of Object.values(params as Record<string, unknown>)) {
			if (typeof entry !== "string" && typeof entry !== "number") return undefined;
		}
	}
	return {
		key,
		...(params === undefined ? {} : { params: params as Record<string, string | number> }),
	};
}

/**
 * One host text, resolved for the reader.
 *
 * @param t - the vocabulary seat.
 * @param value - what the host sent: a sentence, a wire text, or nothing.
 * @returns the sentence the card shows, or `undefined` when there is none.
 */
export function resolveHostText(t: CardTranslate, value: string | WireText | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	const wire = wireTextFromValue(value);
	if (wire === undefined) return undefined;
	return t(wire.key, wire.params);
}
