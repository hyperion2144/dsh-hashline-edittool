/**
 * The anchor store's live budget limits — the one place the settings layer and
 * the store layer agree on.
 *
 * Why a leaf module: the settings layer (`config.ts`, which validates and warns)
 * and the store layer (`domain/session/hash-store.ts`, which enforces) must not
 * import each other — the store pulls in the anchor lifecycle, and the settings
 * layer is imported by the anchor lifecycle. A tiny module with no imports
 * beyond the constants keeps both sides acyclic, and keeps the "unset means the
 * host-side constant" rule in exactly one place.
 *
 * Semantics (decided in #179):
 *  - a limit is set by the plugin settings (`store.max_bytes_mb`, `max_paths`,
 *    `max_lines`); unset or out-of-range falls back to the constant;
 *  - a change applies from the NEXT sweep — the settings card writes the value,
 *    the sweep reads it. Nothing evicts synchronously from a settings write;
 *  - the store reads these at gate time, so an existing open store picks up a
 *    lowered budget on its next write-triggered sweep.
 * @module dsh-hashline-edittool/domain/session/store-budget
 */
import {
	HASH_STORE_MAX_BYTES,
	HASH_STORE_MAX_PATHS,
	HASH_STORE_MAX_ROWS,
} from "../../infra/constants.js";

/** The three budgets a sweep enforces. */
export interface StoreBudgetLimits {
	/** Main-store byte budget, measured as `(page_count − freelist_count) × page_size`. */
	readonly bytes: number;
	/** Distinct absolute paths with anchor state. */
	readonly paths: number;
	/** `anchor_lines` rows. */
	readonly rows: number;
}

/** Limits as the settings layer resolves them; absent fields keep the constant. */
export interface StoreBudgetOverrides {
	readonly bytes?: number;
	readonly paths?: number;
	readonly rows?: number;
}

let overrides: StoreBudgetOverrides = {};

/**
 * Publish the effective limits. Called by the settings layer on every apply —
 * including an apply with no `store` subtree, which resets to the constants.
 * @param next - validated values; a field left out reverts to its constant.
 */
export function setStoreBudgetLimits(next: StoreBudgetOverrides): void {
	overrides = {
		...(next.bytes === undefined ? {} : { bytes: next.bytes }),
		...(next.paths === undefined ? {} : { paths: next.paths }),
		...(next.rows === undefined ? {} : { rows: next.rows }),
	};
}

/**
 * The limits a sweep and the open-time gate must enforce right now.
 * @returns the effective limits; constants wherever nothing is configured.
 */
export function storeBudgetLimits(): StoreBudgetLimits {
	return {
		bytes: overrides.bytes ?? HASH_STORE_MAX_BYTES,
		paths: overrides.paths ?? HASH_STORE_MAX_PATHS,
		rows: overrides.rows ?? HASH_STORE_MAX_ROWS,
	};
}

/** Test seam: drop any published overrides so suites do not leak into each other. */
export function resetStoreBudgetLimits(): void {
	overrides = {};
}
