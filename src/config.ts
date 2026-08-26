/**
 * Hashline settings — namespace, schema, live snapshot, and wiring into the
 * hash shape.
 *
 * Settings live under the `hashline` namespace of the dsh settings service
 * (persisted to ~/.dsh/settings.yaml by the settings-file layer):
 *
 * ```yaml
 * hashline:
 *   separator: ":"        # column separator (default ":")
 *   hash_length: 3        # anchor hash length, 1..6 (default 3; space = 62^len)
 *   output_format: text   # "text" (hashline rows) | "json" (pure JSON)
 * ```
 *
 * The install follows the dsh-plugin-subagent-director pattern:
 * `installSettingsSection` captures the live SettingsScope getter via the
 * snapshot hooks, so settings.yaml edits (and any settings UI writes) are
 * visible immediately — each commit re-applies the effective config, which
 * recompiles the hash shape (separator / hash length) and flips the output
 * format for subsequent tool calls.
 *
 * @module dsh-hashline-edittool/config
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
import { applyHashlineShape } from "./hashline/hash-assign.js";

export const HASHLINE_SETTINGS_NAMESPACE = "hashline";

export interface HashlineSettings {
	separator?: string;
	hash_length?: number;
	output_format?: "text" | "json";
}

/** Permissive schema — unknown keys tolerated so newer versions don't break older builds. */
export const HashlineSettingsSchema: z<HashlineSettings> = z
	.object({
		separator: z.string().min(1).max(4),
		hash_length: z.number().min(1).max(6),
		output_format: z.union(["text", "json"]),
	})
	.loose() as unknown as z<HashlineSettings>;

export type OutputFormat = "text" | "json";

export interface EffectiveHashlineConfig {
	separator: string;
	hashLength: number;
	outputFormat: OutputFormat;
}

const DEFAULT_CONFIG: EffectiveHashlineConfig = {
	separator: ":",
	hashLength: 3,
	outputFormat: "text",
};

let effective: EffectiveHashlineConfig = { ...DEFAULT_CONFIG };

/** Effective runtime config (module singleton; defaults = current contract). */
export function getEffectiveConfig(): EffectiveHashlineConfig {
	return { ...effective };
}

export function isJsonOutput(): boolean {
	return effective.outputFormat === "json";
}

/** Validate + apply a settings object onto the effective config and hash shape. */
export function applyEffective(settings: HashlineSettings | undefined): void {
	const sep =
		typeof settings?.separator === "string" && settings.separator.length > 0
			? settings.separator
			: DEFAULT_CONFIG.separator;
	const len =
		typeof settings?.hash_length === "number" &&
		Number.isInteger(settings.hash_length) &&
		settings.hash_length >= 1 &&
		settings.hash_length <= 6
			? settings.hash_length
			: DEFAULT_CONFIG.hashLength;
	const fmt =
		settings?.output_format === "json" ? "json" : DEFAULT_CONFIG.outputFormat;
	effective = { separator: sep, hashLength: len, outputFormat: fmt };
	applyHashlineShape({ hashLength: len, separator: sep });
}

interface SettingsSnapshotHooks {
	setSource(current: () => HashlineSettings): void;
	onChange(): void;
}

function createSnapshot(
	initial: HashlineSettings,
): { hooks: SettingsSnapshotHooks; get(): HashlineSettings } {
	let source: (() => HashlineSettings) | undefined;
	let snapshot: HashlineSettings = initial;
	return {
		hooks: {
			setSource(getter) {
				source = getter;
				snapshot = getter();
			},
			onChange() {
				if (source !== undefined) snapshot = source();
			},
		},
		get: () => snapshot,
	};
}

/**
 * Register the `hashline` settings namespace and keep the effective config in
 * sync. No-op when the deployment has no settings service (headless profile).
 */
export function installHashlineSettings(ctx: Context): void {
	const settingsSvc = (ctx as unknown as { get(name: string): unknown }).get(
		"settings",
	);
	if (settingsSvc === undefined) return;
	const snapshot = createSnapshot({});
	let installed = false;
	const sync = (): void => {
		try {
			applyEffective(snapshot.get());
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err);
			console.error(`dsh-hashline-edittool: settings apply failed: ${message}`);
		}
	};
	try {
		installSettingsSection(
			ctx,
			HASHLINE_SETTINGS_NAMESPACE as never,
			HashlineSettingsSchema,
			{} as HashlineSettings,
			snapshot.hooks,
		);
		installed = true;
	} catch (err) {
		// Namespace already registered (double mount / hot reload): reuse the
		// existing section via a fresh installSettingsSection is not possible,
		// so fall back to reading the raw getter below if available.
		const message =
			err instanceof Error ? err.message : String(err);
		console.error(
			`dsh-hashline-edittool: settings install failed (tolerated): ${message}`,
		);
	}
	if (installed) {
		sync(); // apply whatever the section resolved on registration
	} else {
		applyEffective({}); // defaults
	}
}