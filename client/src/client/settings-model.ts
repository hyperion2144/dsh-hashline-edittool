/**
 * The settings card's pure model layer: the two views the plugin manager asks
 * of a configuration entry, the text of the one-liner view, and the field-op
 * construction the card's write path is built on.
 *
 * Kept apart from the component so the view decision and the op semantics
 * stay testable without dragging `@deepseek-ai/dsh-client-ui-primitives`
 * (a browser-only import graph) into the unit suite — the same split that
 * keeps the tool-row models in models.js.
 *
 * @module dsh-hashline-edittool-client/settings-model
 */

import type { SettingsPathOpView } from "./types.js";
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

/**
 * Build the path-op for one field edit: a VALUE sets the field, no value
 * CLEARS it (the field re-inherits the composition base) — the same
 * "empty means revert" semantics the card's drafts already use.
 *
 * Pure on purpose: the set-vs-unset boundary is the one bit of the write
 * path that a unit test can pin without a live form.
 */
export function buildFieldOp(field: string, value?: unknown): SettingsPathOpView {
	if (value === undefined) return { op: "unset", path: [field] };
	return { op: "set", path: [field], value };
}
