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
export function buildFieldOp(path: string | readonly string[], value?: unknown): SettingsPathOpView {
	const segments = typeof path === "string" ? [path] : path;
	if (value === undefined) return { op: "unset", path: segments };
	return { op: "set", path: segments, value };
}

//
// Store-budget draft validation (#179 / #180 — the card's first line of defence).
//
// The server-side schema in `src/config.ts` defines the same three ranges;
// the spec below is the client-side mirror so the card's `onBlur` check can
// refuse a bad value BEFORE `mutate` is even called. A divergence between
// this spec and the schema is a real risk — the host-side test asserts the
// schema throws for the same boundary values, so the two sides stay in sync
// as long as the host tests run against this project's canonical numbers.
//

/** The settings key the card writes for one store-budget field. */
export type StoreBudgetField = "max_bytes_mb" | "max_paths" | "max_lines";

/**
 * The bounded-store budgets with the same ranges the schema enforces on the
 * wire (#179 / #180). The `unit` is what the card shows next to the number
 * AND what the inline error names — both belong to this spec.
 */
export interface StoreBudgetSpec {
	readonly field: StoreBudgetField;
	/** The two-segment path the card's mutate op sends. */
	readonly path: readonly ["store", StoreBudgetField];
	/** Inclusive lower bound, matching the schema's `z.number().min(...)`. */
	readonly min: number;
	/** Inclusive upper bound, matching the schema's `z.number().max(...)`. */
	readonly max: number;
	/** The unit the card and the inline error render (Chinese for the latter). */
	readonly unit: string;
}

export const STORE_BUDGET_SPECS: readonly StoreBudgetSpec[] = [
	{ field: "max_bytes_mb", path: ["store", "max_bytes_mb"], min: 8, max: 2048, unit: "MiB" },
	{ field: "max_paths", path: ["store", "max_paths"], min: 100, max: 100000, unit: "个" },
	{ field: "max_lines", path: ["store", "max_lines"], min: 10000, max: 10000000, unit: "行" },
];

/**
 * The outcome of validating one store-budget DRAFT (the raw text in the
 * input before it ever reaches the wire).
 *
 * `unset` is the legitimate "empty input" signal — the user wants to revert
 * to the host-side constant, which is the unset op the 恢复默认 button also
 * sends. `valid` carries the integer to write. `error` carries a Chinese
 * sentence the card renders verbatim below the input.
 */
export type StoreBudgetDraftResult =
	| { readonly kind: "unset" }
	| { readonly kind: "valid"; readonly value: number }
	| { readonly kind: "error"; readonly message: string };

/**
 * Classify one store-budget draft against its spec.
 *
 * Pure on purpose — the component imports this and tests pin each branch
 * without a live form.
 *
 * @param spec - the field's range + unit.
 * @param raw - the input's current text (NOT the trimmed value: the
 *   distinction matters for what we surface to the user).
 */
export function validateStoreBudgetDraft(
	spec: StoreBudgetSpec,
	raw: string,
): StoreBudgetDraftResult {
	const text = raw.trim();
	if (text === "") return { kind: "unset" };
	// parseInt returns NaN for "" or non-numeric; the Integer check is the gate.
	// Float values (e.g. "64.5") also fail: the schema is integer-only.
	const parsed = Number.parseInt(text, 10);
	if (!Number.isInteger(parsed) || parsed.toString() !== text) {
		return {
			kind: "error",
			message: `请输入 ${spec.min}–${spec.max} ${spec.unit} 之间的整数`,
		};
	}
	if (parsed < spec.min || parsed > spec.max) {
		return {
			kind: "error",
			message: `超出允许范围 ${spec.min}–${spec.max} ${spec.unit}`,
		};
	}
	return { kind: "valid", value: parsed };
}
