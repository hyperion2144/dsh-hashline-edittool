/**
 * The settings card's pure model layer: the two views the plugin manager asks
 * of a configuration entry, and the text of the one-liner view.
 *
 * Kept apart from the component so the view decision stays testable without
 * dragging `@deepseek-ai/dsh-client-ui-primitives` (a browser-only import
 * graph) into the unit suite — the same split that keeps the tool-row models
 * in models.js.
 *
 * @module dsh-hashline-edittool-client/settings-model
 */

/** What the card says this governs — the one-liner a summary view shows. */
export const CARD_DESCRIPTION = "read / edit / grep 的行为与语言支持。";

/** The views the plugin manager asks of a configuration entry. */
export type SettingsCardView = "summary" | "page";

/** Resolve the view the card owes; an absent prop asks for the page form. */
export function requestedView(view: SettingsCardView | undefined): SettingsCardView {
	return view === "summary" ? "summary" : "page";
}

/** The one-liner the bundle page shows for this card's summary view. */
export function settingsSummaryText(): string {
	return CARD_DESCRIPTION;
}
