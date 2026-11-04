/**
 * The `apply_patch.enabled` setting seam (map #401): the snapshot default, the
 * explicit opt-out and the hot apply. `applyEffective` is the one place every
 * consumer reads the effective value through, so the test drives it and
 * nothing lower.
 *
 * @module test/core/apply-patch-settings.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective, isApplyPatchEnabled } from "../../src/config.js";

afterEach(() => {
	applyEffective(undefined);
});

describe("apply_patch.enabled (map #401)", () => {
	it("defaults to ON — the change-set tool is part of the surface", () => {
		applyEffective(undefined);
		expect(isApplyPatchEnabled()).toBe(true);
	});

	it("an explicit false turns the capability off", () => {
		applyEffective({ apply_patch: { enabled: false } });
		expect(isApplyPatchEnabled()).toBe(false);
	});

	it("an explicit true turns it back on", () => {
		applyEffective({ apply_patch: { enabled: false } });
		applyEffective({ apply_patch: { enabled: true } });
		expect(isApplyPatchEnabled()).toBe(true);
	});

	it("falls back to ON when the namespace is absent or empty", () => {
		applyEffective({});
		expect(isApplyPatchEnabled()).toBe(true);
		applyEffective({ apply_patch: {} });
		expect(isApplyPatchEnabled()).toBe(true);
	});

	it("hot-applies: a later apply replaces the effective value", () => {
		applyEffective({ apply_patch: { enabled: false } });
		expect(isApplyPatchEnabled()).toBe(false);
		applyEffective(undefined);
		expect(isApplyPatchEnabled()).toBe(true);
	});

	it("ignores wrong-typed values instead of crashing", () => {
		applyEffective({ apply_patch: { enabled: "yes" as unknown as boolean } });
		expect(isApplyPatchEnabled()).toBe(true);
	});
});
