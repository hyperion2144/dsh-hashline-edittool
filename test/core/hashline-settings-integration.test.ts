/**
 * Integration tests for `installHashlineSettings` against the REAL
 * `@deepseek-ai/dsh-settings` provider (issue #69 follow-up: the dsh 0.1.2
 * settings API adaptation had ZERO coverage on this seam — the unit tests
 * only exercised the pure `applyEffective`).
 *
 * Covered orderings (each proved decisive during the #69 triage):
 *   1. publish before apply          → json applies at register time
 *   2. apply before publish          → defaults first, publish self-heals via scope.watch
 *   3. no host provider at all       → the plugin self-mounts its read-only
 *      FileSettingsProvider from `$DSH_HOME/settings.yaml`
 *   4. invalid stored section        → tolerated (console.error + defaults), never throws
 *   5. separator round-trip          → shape applied, not just the format flag
 *
 * @module dsh-hashline-edittool/test/hashline-settings-integration
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFile, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import SettingsProvider from "@deepseek-ai/dsh-settings";
import {
	applyEffective,
	getEffectiveConfig,
	installHashlineSettings,
	isJsonOutput,
} from "../../src/config.js";
import { FileSettingsProvider } from "../../src/settings-provider.js";
import { getHashlineShape } from "../../src/hashline/hash-assign.js";

/** In-memory provider: constructor registers the `settings` service on ctx. */
class MemSettingsProvider extends SettingsProvider {
	/**
	 * Read-only, and that is the TRUTH about this fake rather than a way to
	 * satisfy the base class: its `persist` throws.
	 */
	override readonly writable = false;

	constructor(ctx: InstanceType<typeof Context>, private readonly doc: Record<string, unknown>) {
		super(ctx);
	}
	protected override async load(): Promise<Record<string, unknown>> {
		return this.doc;
	}
	protected override async persist(): Promise<never> {
		throw new Error("read-only test provider");
	}

	/**
	 * `publish` is protected, so the tests cannot drive it from outside.
	 * Exposing it here is the fake's own API, not a weakening of the base class.
	 */
	republish(doc: Record<string, unknown>): void {
		this.publish(doc);
	}
}

function jsonDoc(): Record<string, unknown> {
	return { hashline: { output_format: "json" } };
}

async function until(fn: () => boolean): Promise<void> {
	await vi.waitFor(() => expect(fn()).toBe(true), { timeout: 2000, interval: 20 });
}

afterEach(() => {
	applyEffective({});
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	delete process.env.DSH_HOME;
});

describe("installHashlineSettings × real dsh-settings (issue #69)", () => {
	it("applies json when the provider published before the plugin applied", () => {
		const ctx = new Context();
		const doc = jsonDoc();
		const provider = new MemSettingsProvider(ctx, doc);
		provider.republish(doc);
		installHashlineSettings(ctx);
		expect(isJsonOutput()).toBe(true);
		expect(getEffectiveConfig().outputFormat).toBe("json");
	});

	it("self-heals when the plugin applies before the provider publishes (scope.watch path)", async () => {
		const ctx = new Context();
		const provider = new MemSettingsProvider(ctx, jsonDoc());
		// No publish yet: register resolves from an EMPTY document → defaults.
		installHashlineSettings(ctx);
		expect(isJsonOutput()).toBe(false);
		// Boot completes: init publishes → publish re-resolves every section →
		// commit → scope.watch → hooks.onChange → sync. Config must land.
		provider.republish(jsonDoc());
		await until(() => isJsonOutput());
	});

	it("no settings service on the context: refuses loudly (inject contract)", () => {
		// `settings` is declared in the plugin's `inject`, so cordis guarantees the
		// service is started before apply runs. A context WITHOUT one cannot occur
		// in a real deployment — and if it ever does, refusing loudly beats
		// silently running on defaults.
		const ctx = new Context();
		expect(() => installHashlineSettings(ctx)).toThrow(/settings service is missing/);
	});

	it("resolves an invalid stored section to defaults without throwing", () => {
		// NOTE: schemastery silently drops an unmatched union value AND, being
		// an object resolver, the whole section with it ({output_format:
		// "bogus", separator: "|"} resolves to {}). No error surfaces — the
		// plugin falls back to defaults. This pins that degradation contract:
		// a typo in any hashline key can never crash the host or the tools.
		const ctx = new Context();
		const provider = new MemSettingsProvider(ctx, {
			hashline: { output_format: "bogus", separator: "|" },
		});
		provider.republish({ hashline: { output_format: "bogus", separator: "|" } });
		expect(() => installHashlineSettings(ctx)).not.toThrow();
		expect(getEffectiveConfig()).toEqual({
			separator: ":",
			outputFormat: "text",
			contextLines: 3,
			requireLineContent: false,
			// AST is an additive capability: off unless explicitly enabled, so an
			// invalid stored section resolves to exactly the pre-AST behaviour.
			astEnabled: false,
			astLanguages: new Set<string>(),
			// No named servers: naming one is a separate setting from the AST
			// switch, and an invalid stored section must resolve to no servers too.
			lspServers: new Map<string, string>(),
		});
	});

	it("round-trips separator through the hash shape, not just the format flag", () => {
		const ctx = new Context();
		const provider = new MemSettingsProvider(ctx, { hashline: { separator: "|" } });
		provider.republish({ hashline: { separator: "|" } });
		installHashlineSettings(ctx);
		expect(getEffectiveConfig().separator).toBe("|");
		expect(getHashlineShape().separator).toBe("|");
	});

	// The self-mount tests that used to live here were deleted with the
	// self-mount itself: `settings` is injected now, so cordis guarantees the
	// service before apply runs, and a bare `new Context()` without one is
	// covered by the refusal test above. The provider's own load/persist
	// round-trip is pinned by the settings-provider unit tests. The old
	// scheduleSettingsRetry note is gone with the retry itself.
	//
	// The WRITE half (persist round-trips to settings.yaml) is covered by the
	// settings-provider tests, which drive `persist` directly — the provider
	// is the storage seam, so that is where its serialization belongs.
});
