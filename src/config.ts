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
import { readFileSync, watch as watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type SettingsProvider from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { ensureSettingsService } from "./settings-provider.js";
import { applyHashlineShape } from "./hashline/hash-assign.js";

export const HASHLINE_SETTINGS_NAMESPACE = "hashline";

export interface HashlineSettings {
	separator?: string;
	output_format?: "text" | "json";
	context_lines?: number;
}

/** Permissive schema — unknown keys tolerated so newer versions don't break older builds. */
export const HashlineSettingsSchema: z<HashlineSettings> = z
	.object({
		separator: z.string().min(1).max(4),
		output_format: z.union(["text", "json"]),
		context_lines: z.number().min(0).max(20),
	})
	.loose() as unknown as z<HashlineSettings>;
	// NOTE: the legacy `hash_length` key is accepted (loose schema) and
	// deliberately IGNORED — v2.0 anchors are variable-length by construction
	// (spec §7); existing settings survive without error.

export type OutputFormat = "text" | "json";

export interface EffectiveHashlineConfig {
	separator: string;
	outputFormat: OutputFormat;
	contextLines: number;
}

const DEFAULT_CONFIG: EffectiveHashlineConfig = {
	separator: ":",
	outputFormat: "text",
	contextLines: 3,
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
	const fmt =
		settings?.output_format === "json" ? "json" : DEFAULT_CONFIG.outputFormat;
	const nctx =
		typeof settings?.context_lines === "number" &&
		Number.isInteger(settings.context_lines) &&
		settings.context_lines >= 0 &&
		settings.context_lines <= 20
			? settings.context_lines
			: DEFAULT_CONFIG.contextLines;
	effective = { separator: sep, outputFormat: fmt, contextLines: nctx };
	applyHashlineShape({ separator: sep, contextLines: nctx });
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
		else if (key === "output_format") {
			if (value === "json" || value === "text") {
				out.output_format = value;
			}
		}
		// NOTE: legacy `hash_length` key is parsed but ignored (v2.0 variable-length).
		else if (key === "context_lines") {
			const n = Number(value);
			if (Number.isInteger(n) && n >= 0 && n <= 20) out.context_lines = n;
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
/**
 * Direct-file fallback for topologies where the settings service is
 * registered but NOT visible from this context (issue #69: observed on a
 * symlinked dev deployment with dual cordis instances / plugin double-mount).
 * Reads `settings.yaml` once, applies it, then watches the file so live edits
 * keep working without the host service. The watcher is disposed with ctx.
 */
export function startDirectFileFallback(ctx: Context): void {
	const apply = (): void => {
			try {
				applyEffective(parseSettingsYaml(readFileSync(settingsYamlPath(), "utf-8")));
			} catch (err) {
				const code = (err as { code?: unknown })?.code;
				if (code === "ENOENT") {
					// Absent settings.yaml — defaults apply, nothing to log.
					applyEffective({});
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				console.error(`dsh-hashline-edittool: direct settings.yaml fallback failed: ${message}`);
			}
	};
	apply();
	let watcher: ReturnType<typeof watchFile> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		watcher = watchFile(settingsYamlPath(), { persistent: false }, () => {
			// chokidar-style debounce: editors write in multiple chunks.
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(apply, 100);
		});
	} catch {
		// settings.yaml absent — defaults apply; no watch without a file.
	}
	try {
		ctx.effect(() => () => {
			watcher?.close();
			if (timer !== undefined) clearTimeout(timer);
		});
	} catch {
		// effect registration unavailable — leak the watcher; process-lifetime only.
	}
}

export function installHashlineSettings(ctx: Context): void {
	// The settings service must exist for installSection to run. If
	// the host did not mount one (minimal profile / smoke), provide our own
	// read-only file-backed provider — the settings.yaml file is the source
	// of truth in every deployment.
	if (!ensureSettingsService(ctx)) {
		// Do NOT reset the effective config here: a sibling apply of this
		// plugin may have already installed a working service (profiles can
		// double-mount via bundles + dependencies) — resetting would wipe
		// its resolved value back to defaults.
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
	const hooks = snapshot.hooks;
	// installSection drives its inject callback ASYNCHRONOUSLY: our
	// own sync() below may run before the section ever pushes its value into
	// the snapshot. Re-apply on every onChange (attach + every commit) so the
	// resolved value always lands.
	const hookedOnChange = hooks.onChange;
	hooks.onChange = () => {
		hookedOnChange();
		sync();
	};
	const settingsSvc = (ctx as unknown as { get(name: string): unknown }).get("settings") as SettingsProvider | undefined;
	if (settingsSvc === undefined) {
		// ensureSettingsService reported success (e.g. the "already registered"
		// elsewhere" tolerance) but the service is not resolvable from THIS
		// context. Never silent — and never dead: fall back to the documented
		// direct settings.yaml reads so config still works in any topology.
		console.error(
			"dsh-hashline-edittool: settings service unreachable from this context — hashline section NOT registered; falling back to direct settings.yaml reads. Please report this.",
		);
		startDirectFileFallback(ctx);
		return;
	}
	try {
		settingsSvc?.installSection(
			ctx,
			HASHLINE_SETTINGS_NAMESPACE as never,
			HashlineSettingsSchema,
			{} as HashlineSettings,
			hooks,
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