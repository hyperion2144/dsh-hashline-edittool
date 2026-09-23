/**
 * One-time import of the legacy `hashline:` settings section into the
 * plugin's 0.1.7 profile entry.
 *
 * Why this exists: the host's `importLegacyDocument` moves a removed
 * `settings.yaml` into the active profile once, but its section→entry map
 * (`LEGACY_SECTION_ENTRIES`) knows only official sections — our `hashline:`
 * section fails the entry lookup and stays behind in the renamed
 * `settings.yaml.imported` file, silently losing effect. This migration
 * reads BOTH names (the host has not imported yet, or already renamed) and
 * writes the section into OUR entry through the settings service.
 *
 * Contract:
 * - fires at most once per plugin home (a marker file under the shared home);
 * - never overwrites: if our entry already carries a user section (the
 *   profile was configured on 0.1.7 before this ran), the legacy values lose
 *   and the marker is written — the user's newer choice stands;
 * - never writes another namespace — only the plugin's own entry;
 * - failures retry on the next boot: an absent settings service, a failing
 *   `describe`, or a rejected `update` all leave the marker unwritten, and
 *   the caller is expected to catch and warn (this module does not throw on
 *   its own past the point of no marker).
 *
 * @module dsh-hashline-edittool/infra/legacy-migration
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { errCode } from "./utils.js";
import { configDir } from "./paths.js";
import {
	HASHLINE_ENTRY_ID,
	parseSettingsYaml,
	settingsYamlPath,
	type HashlineSettings,
} from "../config.js";

/** The settings service as this module uses it — describe + update, duck-typed. */
interface SettingsServiceLike {
	describe(): Array<{ ns?: string; user?: unknown }>;
	update(ns: string, section: object): Promise<void>;
}

/** Marker filename inside the plugin's shared home. */
const MARKER_NAME = ".legacy-settings-migrated";

function markerPath(): string {
	return join(configDir(), MARKER_NAME);
}

/** Read a file if present; ENOENT maps to undefined, anything else throws. */
async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (errCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * The legacy `hashline:` section, from whichever settings document exists.
 *
 * The renamed `.imported` file wins: it is the pre-0.1.7 document by
 * definition. A live `settings.yaml` is the same document before the host
 * renames it (this boot races the host's one-time import); a live file that
 * coexists with an imported one belongs to something else and is ignored.
 */
async function readLegacySection(): Promise<HashlineSettings | undefined> {
	const imported = await readIfPresent(`${settingsYamlPath()}.imported`);
	const text =
		imported ?? (await readIfPresent(settingsYamlPath()));
	if (text === undefined) return undefined;
	return parseSettingsYaml(text);
}

/** Resolve the settings service from the context, or undefined. */
function settingsService(ctx: Context): SettingsServiceLike | undefined {
	const service = (ctx as unknown as { get(name: string): unknown }).get("settings");
	if (service === null || typeof service !== "object") return undefined;
	const candidate = service as Partial<SettingsServiceLike>;
	if (typeof candidate.describe !== "function" || typeof candidate.update !== "function") {
		return undefined;
	}
	return candidate as SettingsServiceLike;
}

/**
 * Whether our entry already carries a user section. `undefined` means "could
 * not tell" — the caller must NOT guess between overwriting fresh user
 * choices and skipping the import.
 */
function entryHasUserSection(service: SettingsServiceLike): boolean | undefined {
	try {
		const descriptor = service
			.describe()
			.find((entry) => entry?.ns === HASHLINE_ENTRY_ID);
		const user = descriptor?.user;
		if (user === undefined || user === null) return false;
		return typeof user === "object" && Object.keys(user).length > 0;
	} catch {
		return undefined;
	}
}

/** Write the marker (and its directory) so the migration never re-runs. */
async function writeMarker(): Promise<void> {
	const path = markerPath();
	mkdirSync(dirname(path), { recursive: true });
	await writeFile(path, `${new Date().toISOString()}\n`, "utf-8");
}

/**
 * Run the one-time legacy settings migration. Never throws for expected
 * shapes (missing files, absent service); an `update` rejection propagates
 * so the caller can warn — and the marker stays unwritten, retrying next boot.
 */
export async function migrateLegacyHashlineSettings(ctx: Context): Promise<void> {
	if (existsSync(markerPath())) return;
	const legacy = await readLegacySection();

	// No legacy document, or a `hashline:` section with nothing in it:
	// nothing to import, and never a reason to look again.
	if (legacy === undefined || Object.keys(legacy).length === 0) {
		await writeMarker();
		return;
	}

	const service = settingsService(ctx);
	// No settings service (a headless composition): settings never arrive
	// through the profile here, so retry on a boot that has one.
	if (service === undefined) return;

	const hasUserSection = entryHasUserSection(service);
	if (hasUserSection === undefined) return; // cannot tell — do not guess

	if (hasUserSection) {
		// The user already configured THIS entry on 0.1.7. Their values win.
		await writeMarker();
		return;
	}

	await service.update(HASHLINE_ENTRY_ID, legacy);
	await writeMarker();
}
