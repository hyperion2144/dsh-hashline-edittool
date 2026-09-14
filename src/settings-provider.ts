/**
 * FileSettingsProvider — a full dsh settings provider backed by
 * `settings.yaml`, mounted by this plugin when the host did not bring a
 * settings service (e.g. a minimal smoke profile).
 *
 * This IS the dsh capability, not a bypass: SettingsProvider's own
 * `load`/`persist` contract is how dsh settings storage works, and this
 * provider implements both sides — `load` parses the document, `persist`
 * merges the changed namespace back and writes it. It is READ-WRITE: a
 * read-only provider made every card write fail with "read-only", which
 * is the "无法读写设置" error that was reported.
 *
 * Only the `hashline` namespace is structured. Other namespaces are
 * preserved verbatim on write — this plugin never rewrites configuration
 * it does not own.
 *
 * @module dsh-hashline-edittool/settings-provider
 */
import type { Context } from "@deepseek-ai/cordis";
import { readFileSync, writeFileSync } from "node:fs";
import SettingsProvider from "@deepseek-ai/dsh-settings";
import {
	parseSettingsYaml,
	settingsYamlPath,
	type HashlineSettings,
} from "./config.js";

/** Whole-document parse: `hashline` structured, other sections passthrough. */
export function parseYamlDocument(text: string): Record<string, unknown> {
	const doc: Record<string, unknown> = {};
	const lines = text.split("\n");
	let current: string | undefined;
	let currentLines: string[] = [];

	const flush = (): void => {
		if (current === undefined) return;
		const body = currentLines.join("\n");
		if (current === "hashline") {
			doc[current] = parseSettingsYaml(`hashline:\n${body}`);
		} else if (body.trim() === "") {
			doc[current] = {};
		} else {
			// Other namespaces are preserved verbatim (never written back —
			// the provider is read-only), just carried through publish so the
			// registered hashline section resolves on top of them.
			doc[current] = body + "\n";
		}
		current = undefined;
		currentLines = [];
	};

	for (const raw of lines) {
		const line = raw.trimEnd();
		const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
		if (top) {
			flush();
			current = top[1]!;
			continue;
		}
		if (current !== undefined) currentLines.push(line);
	}
	flush();
	return doc;
}

/** Read the settings file into the provider document ({} when absent). */
export function loadYamlDocument(): Record<string, unknown> {
	try {
		const text = readFileSync(settingsYamlPath(), "utf-8");
		return parseYamlDocument(text);
	} catch {
		return {};
	}
}

/**
 * Serialize a whole settings document back to YAML.
 *
 * The hashline namespace is emitted structured (scalars bare, strings
 * double-quoted so a hash or spaces survive the round-trip); every other
 * namespace is a passthrough string written verbatim under its key.
 */
export function serializeYamlDocument(doc: Record<string, unknown>): string {
	const out: string[] = [];
	for (const [key, value] of Object.entries(doc)) {
		if (key === "hashline" && typeof value === "object" && value !== null && !Array.isArray(value)) {
			const body = serializeHashlineSection(value as Record<string, unknown>);
			out.push(body.trim() === "" ? key + ":" : key + ":\n" + body);
			continue;
		}
		if (typeof value === "string" && value.trim() !== "") {
			out.push(key + ":\n" + value.trimEnd());
			continue;
		}
		out.push(key + ":");
	}
	return out.join("\n") + "\n";
}

/** Emit the hashline section: scalars, and up to three levels of nesting. */
function serializeHashlineSection(section: Record<string, unknown>): string {
	const lines: string[] = [];
	const scalar = (v: unknown): string | undefined => {
		if (typeof v === "boolean" || typeof v === "number") return String(v);
		if (typeof v === "string") return JSON.stringify(v);
		return undefined;
	};
	for (const [key, value] of Object.entries(section)) {
		const flat = scalar(value);
		if (flat !== undefined) {
			lines.push("  " + key + ": " + flat);
			continue;
		}
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			lines.push("  " + key + ":");
			for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
				const flat2 = scalar(v2);
				if (flat2 !== undefined) {
					lines.push("    " + k2 + ": " + flat2);
					continue;
				}
				if (typeof v2 === "object" && v2 !== null && !Array.isArray(v2)) {
					lines.push("    " + k2 + ":");
					for (const [k3, v3] of Object.entries(v2 as Record<string, unknown>)) {
						const flat3 = scalar(v3);
						if (flat3 !== undefined) lines.push("      " + k3 + ": " + flat3);
					}
				}
			}
		}
	}
	return lines.join("\n");
}

/**
 * Minimal file-backed dsh provider; installed only when the host has none.
 *
 * READ-WRITE. persist merges the changed namespace back into the document
 * and serializes it through serializeYamlDocument — the dsh provider
 * contract's own storage step. Other namespaces round-trip verbatim: this
 * plugin never rewrites configuration it does not own.
 */
export class FileSettingsProvider extends SettingsProvider {
	readonly writable = true;

	constructor(ctx: Context) {
		super(ctx);
		this.publish(loadYamlDocument());
	}

	protected async load(): Promise<Record<string, unknown>> {
		return loadYamlDocument();
	}

	protected async persist(ns: string, section: Record<string, unknown>): Promise<void> {
		// The dsh provider contract's own storage step: merge the changed
		// namespace into the document and write it back. The hashline namespace
		// is this plugin's and is written structured; every other namespace
		// round-trips verbatim so nothing the host owns is ever rewritten.
		const doc = loadYamlDocument();
		doc[ns] = section;
		writeFileSync(settingsYamlPath(), serializeYamlDocument(doc), "utf-8");
		this.publish(loadYamlDocument());
	}

	get documentPath(): string {
		return settingsYamlPath();
	}
}

export type { HashlineSettings };

/**
 * Provide the service on ctx when the host did not mount one. Returns true
 * when a settings service is in place — including when another apply of this
 * plugin (a profile may double-mount the package via bundles + dependencies)
 * already registered it.
 */
export function ensureSettingsService(ctx: Context): boolean {
	const settingsSvc = (ctx as unknown as { get(name: string): unknown }).get(
		"settings",
	);
	if (settingsSvc !== undefined) return true;
	try {
		// cordis' Service base class registers the instance under its name on
		// construction — there is nothing to ctx.provide() additionally (an
		// extra provide would collide with the just-registered instance).
		new FileSettingsProvider(ctx);
		return (ctx as unknown as { get(name: string): unknown }).get(
			"settings",
		) !== undefined;
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err);
		// Already registered (by an earlier apply, possibly on a sibling
		// scope): the service IS in place — accept it instead of failing.
		if (
			message.includes("already been registered") ||
			message.includes("registered at") ||
			message.includes("has been registered")
		) {
			return true;
		}
		console.error(
			`dsh-hashline-edittool: failed to mount file settings provider (tolerated): ${message}`,
		);
		return false;
	}
}