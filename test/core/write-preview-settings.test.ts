/**
 * The `write.preview` setting seam (map #354, ticket #361): the schema-legal
 * values, the snapshot default, and the defensive fallback a hand-written YAML
 * or a bypassing caller gets. `applyEffective` is the one place every consumer
 * reads the effective value through, so the test drives it and nothing lower.
 *
 * @module test/core/write-preview-settings.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective, writePreviewMode } from "../../src/config.js";

afterEach(() => {
	applyEffective(undefined);
});

describe("write.preview (map #354)", () => {
	it("defaults to diff — the update echo is the map #354 decision", () => {
		applyEffective(undefined);
		expect(writePreviewMode()).toBe("diff");
	});

	it("accepts confirmation", () => {
		applyEffective({ write: { preview: "confirmation" } });
		expect(writePreviewMode()).toBe("confirmation");
	});

	it("accepts diff", () => {
		applyEffective({ write: { preview: "diff" } });
		expect(writePreviewMode()).toBe("diff");
	});

	it("falls back to diff for a value the schema never named", () => {
		applyEffective({ write: { preview: "sideways" as never } });
		expect(writePreviewMode()).toBe("diff");
	});

	it("falls back to diff when the namespace is absent or empty", () => {
		applyEffective({});
		expect(writePreviewMode()).toBe("diff");
		applyEffective({ write: {} });
		expect(writePreviewMode()).toBe("diff");
	});

	it("hot-applies: a later apply replaces the effective value", () => {
		applyEffective({ write: { preview: "confirmation" } });
		expect(writePreviewMode()).toBe("confirmation");
		applyEffective(undefined);
		expect(writePreviewMode()).toBe("diff");
	});
});
