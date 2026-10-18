/**
 * The `format` settings subtree — schema admission, effective snapshot,
 * getters, defaults.
 *
 * Two contracts pin here: the settings survive the volatile-ref unwrap the
 * runtime hands `apply`, and BOTH switches default OFF (an edit must never
 * re-shape text uninvited — G3's reason the defaults are what they are).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEffective,
	getEffectiveConfig,
	isEditorconfigEnabled,
	isAutoFormatEnabled,
	resolveSettings,
} from "../../src/config.js";

afterEach(() => {
	applyEffective({});
});

describe("format settings", () => {
	it("defaults both switches off", () => {
		applyEffective(undefined);
		expect(isAutoFormatEnabled()).toBe(false);
		expect(isEditorconfigEnabled()).toBe(false);
	});

	it("applies explicit true values", () => {
		applyEffective({ format: { auto: true, editorconfig: true } });
		expect(isAutoFormatEnabled()).toBe(true);
		expect(isEditorconfigEnabled()).toBe(true);
		expect(getEffectiveConfig().autoFormat).toBe(true);
		expect(getEffectiveConfig().editorconfig).toBe(true);
	});

	it("absent format keys reset to off on the next apply", () => {
		applyEffective({ format: { auto: true } });
		expect(isAutoFormatEnabled()).toBe(true);
		applyEffective({});
		expect(isAutoFormatEnabled()).toBe(false);
	});

	it("ignores wrong-typed values instead of crashing", () => {
		applyEffective({ format: { auto: "yes" as unknown as boolean } });
		expect(isAutoFormatEnabled()).toBe(false);
	});

	it("survives the volatile-ref unwrap (the runtime's shape)", () => {
		const settings = resolveSettings({
			format: { auto: { get: () => true }, editorconfig: { get: () => true } },
		});
		expect(settings?.format?.auto).toBe(true);
		expect(settings?.format?.editorconfig).toBe(true);
	});
});
