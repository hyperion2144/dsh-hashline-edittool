/**
 * The `format` settings subtree — schema admission, effective snapshot,
 * getters, defaults.
 *
 * Three contracts pin here (#315): the settings survive the volatile-ref unwrap
 * the runtime hands `apply`; the tri-state `format.auto` migrates legacy
 * booleans (true → full, false → off); and every switch defaults OFF (an edit
 * must never re-shape text uninvited — G3's reason the defaults are what they
 * are).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEffective,
	getEffectiveConfig,
	isEditorconfigEnabled,
	autoFormatMode,
	formatFallbackFullFile,
	resolveSettings,
	HashlineSettingsSchema,
} from "../../src/config.js";

afterEach(() => {
	applyEffective({});
});

describe("format settings (#315)", () => {
	it("defaults: mode off, fallback off, editorconfig off", () => {
		applyEffective(undefined);
		expect(autoFormatMode()).toBe("off");
		expect(formatFallbackFullFile()).toBe(false);
		expect(isEditorconfigEnabled()).toBe(false);
	});

	it("legacy booleans migrate: true → full, false → off", () => {
		applyEffective({ format: { auto: true } });
		expect(autoFormatMode()).toBe("full");
		expect(getEffectiveConfig().autoFormatMode).toBe("full");
		applyEffective({ format: { auto: false } });
		expect(autoFormatMode()).toBe("off");
	});

	it("the schema itself admits legacy booleans and refuses garbage (#179 semantics)", () => {
		// The write gate validates through HashlineSettingsSchema — pin both
		// directions so the union cannot silently tighten or loosen.
		const validateSchema = HashlineSettingsSchema as unknown as (value: unknown) => unknown;
		// The volatile() wrapper exposes values as getters, so the pin is the
		// ADMISSION direction: what passes, what throws.
		expect(() => validateSchema({ format: { auto: true } })).not.toThrow();
		expect(() => validateSchema({ format: { auto: "range" } })).not.toThrow();
		expect(() => validateSchema({ format: { auto: "Full" } })).toThrow();
		expect(() => validateSchema({ format: { auto: 1 } })).toThrow();
	});

	it("applies the three enum values + the fallback switch", () => {
		applyEffective({ format: { auto: "range", fallback_full_file: true, editorconfig: true } });
		expect(autoFormatMode()).toBe("range");
		expect(formatFallbackFullFile()).toBe(true);
		expect(isEditorconfigEnabled()).toBe(true);
		applyEffective({ format: { auto: "full" } });
		expect(autoFormatMode()).toBe("full");
		applyEffective({ format: { auto: "off" } });
		expect(autoFormatMode()).toBe("off");
	});

	it("absent format keys reset on the next apply", () => {
		applyEffective({ format: { auto: "range", fallback_full_file: true } });
		expect(autoFormatMode()).toBe("range");
		expect(formatFallbackFullFile()).toBe(true);
		applyEffective({});
		expect(autoFormatMode()).toBe("off");
		expect(formatFallbackFullFile()).toBe(false);
	});

	it("ignores wrong-typed values instead of crashing", () => {
		applyEffective({ format: { auto: "yes" as unknown as boolean } });
		expect(autoFormatMode()).toBe("off");
		applyEffective({ format: { fallback_full_file: "on" as unknown as boolean } });
		expect(formatFallbackFullFile()).toBe(false);
	});

	it("survives the volatile-ref unwrap (the runtime's shape)", () => {
		const settings = resolveSettings({
			format: {
				auto: { get: () => "range" },
				fallback_full_file: { get: () => true },
				editorconfig: { get: () => true },
			},
		});
		expect(settings?.format?.auto).toBe("range");
		expect(settings?.format?.fallback_full_file).toBe(true);
		expect(settings?.format?.editorconfig).toBe(true);
	});
});
