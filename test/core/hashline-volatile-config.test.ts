/**
 * Tests for the 0.1.7 Config seam: volatile refs in, effective settings out.
 *
 * dsh 0.1.7 hands the plugin's Config to `apply(ctx, config)` with every
 * `.volatile()` field as a LIVE reference (`.get()`), and re-apply rides the
 * `settings/document-updated` event. These tests pin both halves against the
 * same duck-typed shapes the runtime produces — plus the plain-value shape a
 * composition (or a test) may hand over instead.
 *
 * @module dsh-hashline-edittool/test/hashline-volatile-config
 */
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
	applyEffective,
	getEffectiveConfig,
	installHashlineSettings,
	isJsonOutput,
	resolveSettings,
} from "../../src/config.js";

/** A volatile reference with the runtime's duck shape: a `get` member. */
const ref = <T>(value: T): { get(): T } => ({
	get: () => value,
});

afterEach(() => {
	applyEffective({});
});

describe("resolveSettings (volatile refs)", () => {
	it("unwraps refs at every level, unknown keys carried along", () => {
		const settings = resolveSettings({
			separator: ref("|"),
			output_format: ref("json"),
			// A ref on a whole sub-object, with refs inside it — both depths
			// must unwrap (the runtime may hand either shape).
			ast: ref({
				enabled: ref(true),
				languages: { typescript: ref({ enabled: ref(false) }) },
			}),
			lsp: {
				servers: { python: ref("pylsp") },
				auto_diagnostics: ref(false),
			},
			future_key: ref("whatever the loose schema admits"),
		});
		expect(settings?.separator).toBe("|");
		expect(settings?.output_format).toBe("json");
		expect(settings?.ast?.enabled).toBe(true);
		expect(settings?.ast?.languages?.typescript).toEqual({ enabled: false });
		expect(settings?.lsp?.servers).toEqual({ python: "pylsp" });
		expect(settings?.lsp?.auto_diagnostics).toBe(false);
		// Loose: unknown keys survive the unwrap untouched (validation is
		// applyEffective's contract, not this resolver's).
		expect((settings as Record<string, unknown>)?.future_key).toBe("whatever the loose schema admits");
	});

	it("passes plain values through unchanged — non-ref shapes are first-class", () => {
		const settings = resolveSettings({ separator: "|", output_format: "json" });
		expect(settings).toEqual({ separator: "|", output_format: "json" });
	});

	it("returns undefined for absent config so defaults apply downstream", () => {
		expect(resolveSettings(undefined)).toBeUndefined();
		expect(resolveSettings(null)).toBeUndefined();
	});
});

describe("installHashlineSettings × 0.1.7 Config seam", () => {
	it("applies the resolved config at install time", () => {
		const ctx = new Context();
		installHashlineSettings(ctx, { output_format: ref("json") });
		expect(isJsonOutput()).toBe(true);
		expect(getEffectiveConfig().outputFormat).toBe("json");
	});

	it("re-applies on settings/document-updated by re-reading live refs", () => {
		const ctx = new Context();
		// The ref's underlying value moves AFTER install — only a live
		// re-read can see it, exactly like a settings-page write in 0.1.7.
		let separator = "|";
		installHashlineSettings(ctx, { separator: { get: () => separator } });
		expect(getEffectiveConfig().separator).toBe("|");

		separator = "::";
		(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(
			"settings/document-updated",
			"some-other-entry",
			7,
		);
		expect(getEffectiveConfig().separator).toBe("::");
	});

	it("absent config applies the built-in defaults (plain composition)", () => {
		const ctx = new Context();
		installHashlineSettings(ctx, undefined);
		expect(getEffectiveConfig()).toEqual({
			separator: ":",
			outputFormat: "text",
			contextLines: 3,
			requireLineContent: false,
			astEnabled: false,
			astLanguages: new Set<string>(),
			lspServers: new Map<string, string>(),
			autoDiagnostics: true,
		});
	});
});
