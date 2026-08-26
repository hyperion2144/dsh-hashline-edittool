/**
 * FileSettingsProvider — a minimal dsh settings provider backed by the
 * settings.yaml file, so hashline configuration works even in deployments
 * without a host-mounted settings service (e.g. a minimal smoke profile).
 *
 * dsh-settings' `installSettingsSection` is inert without a `settings`
 * service on the context; instead of falling back to ad-hoc file reads, we
 * PROVIDE the service ourselves when the host did not: the file stays the
 * single source of truth (`writable: false`, so in-process UI writes are
 * refused and the document is only ever read from disk).
 *
 * @module dsh-hashline-edittool/settings-provider
 */
import type { Context } from "@deepseek-ai/cordis";
import { readFileSync } from "node:fs";
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

/** Minimal read-only file provider; install it only when the host has none. */
export class FileSettingsProvider extends SettingsProvider {
	readonly writable = false;

	constructor(ctx: Context) {
		super(ctx);
		this.publish(loadYamlDocument());
	}

	protected async load(): Promise<Record<string, unknown>> {
		return loadYamlDocument();
	}

	protected async persist(): Promise<void> {
		// writable: false — never reached; the file is the source of truth.
		throw new Error("dsh-hashline-edittool: file settings provider is read-only");
	}

	get documentPath(): string {
		return settingsYamlPath();
	}
}

export type { HashlineSettings };

/** Provide the service on ctx when the host did not mount one. */
export function ensureSettingsService(ctx: Context): boolean {
	const settingsSvc = (ctx as unknown as { get(name: string): unknown }).get(
		"settings",
	);
	if (settingsSvc !== undefined) return true;
	try {
		ctx.provide("settings", new FileSettingsProvider(ctx));
		return true;
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err);
		console.error(
			`dsh-hashline-edittool: failed to mount file settings provider (tolerated): ${message}`,
		);
		return false;
	}
}