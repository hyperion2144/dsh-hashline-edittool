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

import type { ConfigForm, ConfigFormSnapshot } from "./types.js";
import type { SettingsPathOpView } from "./types.js";
/** What the card says this governs — the one-liner a summary view shows. */
export const CARD_DESCRIPTION = "read / edit / grep 的行为与语言支持。";

/** The views the plugin manager asks of a configuration entry. */
export type SettingsCardView = "summary" | "page";

/**
 * The form face the card drives — its OWN controller (#171), not a page prop.
 *
 * The bundle-level `plugins.bundle.config` slot renders with `{ view }` and
 * NO form (the row page is the one that hands one), so the card sources its
 * settings from the `configForms` service and subscribes for updates the
 * page no longer pushes. The face is exactly what the card needs to render
 * and write: the snapshot, its change notifications, and the atomic write.
 */
export interface SettingsControllerFace {
	getSnapshot(): ConfigFormSnapshot;
	subscribe(listener: () => void): () => void;
	mutate: ConfigForm["mutate"];
}

/**
 * The snapshot a card with NO controller renders: the same not-ready shape
 * the page-prop path degraded to, so the "设置尚未就绪" gate keeps working.
 */
export const NOT_READY_SNAPSHOT: ConfigFormSnapshot = {
	status: "unavailable",
	value: undefined,
	base: undefined,
	user: undefined,
	revision: undefined,
	writable: false,
	mode: "host",
};

/**
 * Wrap one settings form as the card's controller face.
 *
 * The `configForms` service owns the controller (its namespace, its write
 * queue, its revision fence); this adapter only narrows it to the two reads
 * and the one write the card performs, so the card never reaches into the
 * service and the model stays testable without one.
 *
 * @param form - the entry's form from `configForms.get(entryId)`.
 * @returns the face the card renders from.
 */
export function formFace(form: ConfigForm): SettingsControllerFace {
	return {
		getSnapshot: () => form.getSnapshot(),
		subscribe: (listener) => form.subscribe(listener),
		mutate: (ops, revision) => form.mutate(ops, revision),
	};
}

/**
 * The snapshot to render, given an optional controller: its own snapshot, or
 * the not-ready shape when the slot handed none.
 *
 * @param controller - the face the slot injected, when it did.
 * @returns a snapshot, never undefined.
 */
export function controllerSnapshot(
	controller: SettingsControllerFace | undefined,
): ConfigFormSnapshot {
	return controller?.getSnapshot() ?? NOT_READY_SNAPSHOT;
}

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
