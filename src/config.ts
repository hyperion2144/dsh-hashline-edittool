/**
 * Hashline settings — namespace, schema, live snapshot, and wiring into the
 * hash shape.
 *
 * Settings live under the `hashline` namespace of the dsh settings service
 * (persisted to ~/.dsh/settings.yaml by the settings-file layer). As a
 * fallback — and as the ONLY path when the deployment has no settings
 * service (e.g. a minimal smoke profile) — the same file is read directly
 * so `separator` / `hash_length` / `output_format` always take effect:
 *
 * ```yaml
 * hashline:
 *   separator: ":"        # column separator (default ":")
 *   hash_length: 3        # anchor hash length, 1..6 (default 3; space = 62^len)
 *   output_format: text   # "text" (hashline rows) | "json" (pure JSON)
 * ```
 *
 * Precedence: registered settings service (live getter + settings/updated)
 * > direct settings.yaml read (any deployment) > defaults.
 *
 * @module dsh-hashline-edittool/config
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
import { ensureSettingsService } from "./settings-provider.js";
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

/** Default settings.yaml location (same file the dsh settings layer uses). */
/** Default settings.yaml location: $DSH_HOME when set, else ~/.dsh. */
export function settingsYamlPath(): string {
	const dshHome = process.env.DSH_HOME;
	const base = dshHome && dshHome.length > 0 ? dshHome : join(homedir(), ".dsh");
	return join(base, "settings.yaml");
}

/**
 * Minimal YAML extractor for the `hashline:` section:
 *
 * ```yaml
 * hashline:
 *   separator: "|"
 *   hash_length: 4
 *   output_format: json
 * ```
 *
 * Handles quoted/unquoted scalars and `#` comments; anything unexpected
 * falls back to that key being unset (defaults apply). Separately exported
 * for tests.
 */
export function parseSettingsYaml(text: string): HashlineSettings {
	const out: HashlineSettings = {};
	let inSection = false;
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (!inSection) {
			if (/^hashline:\s*(#.*)?$/.test(line)) {
				inSection = true;
			}
			continue;
		}
		if (!/^\s/.test(line) && line.trim() !== "") break; // next top-level key
		const m = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1]!;
		let value = m[2]!.trim();
		value = value.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
		if (value === "") continue;
		if (key === "separator") out.separator = value;
		else if (key === "hash_length") {
			const n = Number(value);
			if (Number.isInteger(n)) out.hash_length = n;
		} else if (key === "output_format") {
			if (value === "json" || value === "text") {
				out.output_format = value;
			}
		}
	}
	return out;
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
 * Register the `hashline` settings namespace (when a settings service
 * exists) and ALWAYS sync the effective config — from the service when
 * available, otherwise by reading the settings file directly. Listens to
 * `settings/updated` so live edits take effect immediately.
 */
export function installHashlineSettings(ctx: Context): void {
	// The settings service must exist for installSettingsSection to run. If
	// the host did not mount one (minimal profile / smoke), provide our own
	// read-only file-backed provider — the settings.yaml file is the source
	// of truth in every deployment.
	if (!ensureSettingsService(ctx)) {
		applyEffective({}); // defaults; installation failed
		return;
	}
	const snapshot = createSnapshot({});
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
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err);
		console.error(
			`dsh-hashline-edittool: settings install failed (tolerated): ${message}`,
		);
	}
	// Apply whatever the section resolved at registration, and re-apply on
	// every committed change (service commit + file reload path both emit).
	sync();
	try {
		ctx.on("settings/updated", sync);
	} catch {
		// event already subscribed or unknown — the section's own watch/onChange
		// hooks still deliver live updates.
	}
}