/**
 * Tests for the one-time legacy settings migration (#157): the host's
 * `importLegacyDocument` cannot map third-party namespaces, so this plugin
 * imports its own `hashline:` section from either settings document name.
 *
 * Every case runs in its own throwaway $DSH_HOME so the marker, the
 * documents, and the plugin home are fully isolated.
 *
 * @module dsh-hashline-edittool/test/legacy-migration
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyHashlineSettings } from "../../src/infra/legacy-migration.js";
import { configDir } from "../../src/infra/paths.js";
import { HASHLINE_ENTRY_ID, settingsYamlPath } from "../../src/config.js";

interface FakeService {
	describe: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
}

function makeCtx(service?: FakeService | { describe(): unknown[]; update?(): Promise<void> }) {
	return {
		get: (name: string) => (name === "settings" ? service : undefined),
		logger: { warn: vi.fn() },
	} as never;
}

function makeService(user?: unknown, updateImpl?: () => Promise<void>): FakeService {
	return {
		describe: vi.fn(() => [
			{ ns: "some-other-entry", user: { a: 1 } },
			{ ns: HASHLINE_ENTRY_ID, ...(user !== undefined ? { user } : {}) },
		]),
		update: vi.fn(
			updateImpl ??
				(async () => {
					/* accepted by default */
				}),
		),
	};
}

let home: string | undefined;

function stubHome(): string {
	home = mkdtempSync(join(tmpdir(), "dshl-legacy-"));
	vi.stubEnv("DSH_HOME", home);
	return home;
}

function writeSettings(name: string, body: string): void {
	writeFileSync(join(home!, name), body, "utf-8");
}

function markerExists(): boolean {
	return existsSync(join(configDir(), ".legacy-settings-migrated"));
}

afterEach(() => {
	vi.unstubAllEnvs();
	home = undefined;
});

describe("legacy settings migration (#157)", () => {
	it("imports the hashline section from the renamed .imported document", async () => {
		stubHome();
		writeSettings(
			"settings.yaml.imported",
			['llm-deepseek:', "  apiKey: 'x'", "hashline:", '  separator: "|"', "  output_format: json", ""].join("\n"),
		);
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).toHaveBeenCalledTimes(1);
		expect(service.update).toHaveBeenCalledWith(HASHLINE_ENTRY_ID, {
			separator: "|",
			output_format: "json",
		});
		expect(markerExists()).toBe(true);
	});

	it("prefers .imported over a live settings.yaml when both exist", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		writeSettings("settings.yaml", ["hashline:", '  separator: "#"', ""].join("\n"));
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).toHaveBeenCalledWith(HASHLINE_ENTRY_ID, { separator: "|" });
	});

	it("falls back to the live settings.yaml before the host renames it", async () => {
		stubHome();
		writeSettings("settings.yaml", ["hashline:", "  context_lines: 7", ""].join("\n"));
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).toHaveBeenCalledWith(HASHLINE_ENTRY_ID, { context_lines: 7 });
	});

	it("writes the marker and skips when no hashline section exists", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["llm-deepseek:", "  apiKey: 'x'", ""].join("\n"));
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).not.toHaveBeenCalled();
		expect(markerExists()).toBe(true);
	});

	it("writes the marker even when no settings document exists at all", async () => {
		stubHome();
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).not.toHaveBeenCalled();
		expect(markerExists()).toBe(true);
	});

	it("never overwrites an existing user section — the newer choice wins", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		const service = makeService({ separator: "::" });
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).not.toHaveBeenCalled();
		expect(markerExists()).toBe(true);
	});

	it("is idempotent: the marker stops a second run before any service call", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		const service = makeService();
		await migrateLegacyHashlineSettings(makeCtx(service));
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.describe).toHaveBeenCalledTimes(1);
		expect(service.update).toHaveBeenCalledTimes(1);
	});

	it("retries on the next boot when the update is rejected (no marker)", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		let failing = true;
		const service = makeService(undefined, async () => {
			if (failing) throw new Error("boom");
		});
		await expect(migrateLegacyHashlineSettings(makeCtx(service))).rejects.toThrow("boom");
		expect(markerExists()).toBe(false);

		failing = false;
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).toHaveBeenCalledTimes(2);
		expect(markerExists()).toBe(true);
	});

	it("skips without a marker when the settings service is absent (headless)", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		await migrateLegacyHashlineSettings(makeCtx(undefined));
		expect(markerExists()).toBe(false);
	});

	it("skips without a marker when describe cannot be trusted", async () => {
		stubHome();
		writeSettings("settings.yaml.imported", ["hashline:", '  separator: "|"', ""].join("\n"));
		const service = makeService();
		service.describe.mockImplementation(() => {
			throw new Error("describe exploded");
		});
		await migrateLegacyHashlineSettings(makeCtx(service));
		expect(service.update).not.toHaveBeenCalled();
		expect(markerExists()).toBe(false);
	});

	it("records the migration timestamp in the marker", async () => {
		stubHome();
		await migrateLegacyHashlineSettings(makeCtx(makeService()));
		const text = readFileSync(join(configDir(), ".legacy-settings-migrated"), "utf-8").trim();
		expect(new Date(text).toString()).not.toBe("Invalid Date");
	});

	it("resolves the settings path under $DSH_HOME (parity with the host)", () => {
		const h = stubHome();
		expect(settingsYamlPath()).toBe(join(h, "settings.yaml"));
	});
});
