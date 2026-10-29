/**
 * The wrap switch's own vocabulary (#373).
 *
 * FIVE card kinds draw code-ish text — the read card, the search card, the diff
 * family (edit / write / undo / ast_edit / format), the diagnostics card and
 * the error card — and until now every one of them scrolled sideways for a
 * long line. A reader who wants to SEE the end of a 200-column line had to
 * drag a scrollbar, and the drag is easy to lose.
 *
 * The switch that fixes that is deliberately tiny: ONE state per card, ONE
 * button, and ONE attribute the stylesheet reads. This module owns the state
 * vocabulary and nothing else — no React, no DOM, no primitive — so the rule
 * ("wrapping is the default; the glyph says which way it is") is unit-testable
 * without a browser. The button and the sheet that reads the attribute live
 * in `wrap-button.tsx`.
 *
 * WHY THE STATE IS NOT PERSISTED. The switch is a reading aid, not a
 * preference: it says how THIS card is being read right now, and it resets
 * with the card. Persisting it would put a view mode into the plugin's
 * settings — a decision the settings surface does not own, and one a reader
 * would forget they had changed.
 *
 * @module dsh-hashline-edittool-client/wrap
 */

/**
 * The two states the switch has.
 *
 * `on` is the text folding inside the card; `off` is the card scrolling
 * sideways, the way it always did.
 */
export type WrapState = "on" | "off";

/** Every state, in the order a reader meets them. */
export const WRAP_STATES = ["on", "off"] as const;

/**
 * The state a card starts in: wrapping ON.
 *
 * The readable default is the one that needs no action — a reader who never
 * touches the button sees the whole line.
 */
export const DEFAULT_WRAP_STATE: WrapState = "on";

/**
 * The class the wrap button wears.
 *
 * One class for every card: the button is the same control everywhere, and a
 * second copy of these declarations is how two cards drift apart.
 */
export const WRAP_BUTTON_CLASS = "dshl-wrap-button";

/**
 * Which glyph the button draws.
 *
 * `wrap` is the folded-lines glyph, `nowrap` the filled one. They are the two
 * states' own pictures — the button says which way it is without a label.
 */
export type WrapIconName = "wrap" | "nowrap";

/** The button's whole shape in one state. */
export interface WrapButtonShape {
	/**
	 * The `aria-pressed` value: TRUE while the text wraps.
	 *
	 * A toggle button announces the state it is in, not the action it offers,
	 * so this is `true` in the default state.
	 */
	pressed: boolean;
	/** The glyph the button draws in this state. */
	icon: WrapIconName;
}

/**
 * The button's shape in a given state.
 *
 * @param state - the card's current wrap state.
 * @returns the pressed flag and the glyph.
 */
export function wrapButtonShape(state: WrapState): WrapButtonShape {
	return state === "on" ? { pressed: true, icon: "wrap" } : { pressed: false, icon: "nowrap" };
}

/**
 * The state the button flips TO.
 *
 * @param state - the card's current wrap state.
 * @returns the other state.
 */
export function nextWrapState(state: WrapState): WrapState {
	return state === "on" ? "off" : "on";
}

/**
 * The props a card's text container carries to say which state it is in.
 *
 * The stylesheet reads the attribute, so the state never becomes a second
 * source of truth in JavaScript: one attribute, one sheet, five card kinds.
 *
 * @param state - the card's current wrap state.
 * @returns the attribute to spread onto the container.
 */
export function wrapStateProps(state: WrapState): { "data-wrap": WrapState } {
	return { "data-wrap": state };
}
