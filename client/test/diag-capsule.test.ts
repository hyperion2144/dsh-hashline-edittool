/**
 * S3 (#429): the client half of the regression signal — the capsule meta
 * reader's tolerance and the capsule's own words.
 *
 * @module dsh-hashline-edittool/client/test/diag-capsule
 */
import { describe, expect, it } from "vitest";
import { diagCapsulesFromMeta } from "../src/client/models.js";
import { diagCapsuleLabels } from "../src/client/labels.js";

const meta = (diagnostics: unknown): unknown => ({ diagnostics });

describe("diagCapsulesFromMeta (#429)", () => {
	const row = { number: 3, hash: "ab", text: "const x = 1;", messages: ["error(pyright/2322): bad"], severities: [1] };

	it("keeps a PURE-SUPPRESSION entry: no rows, but an unchanged count", () => {
		const capsules = diagCapsulesFromMeta(meta([{ path: "a.ts", rows: [], suppressedCount: 50 }]));
		expect(capsules).toHaveLength(1);
		expect(capsules[0]!.rows).toHaveLength(0);
		expect(capsules[0]!.suppressedCount).toBe(50);
	});

	it("still drops the old row-less CLEAN entry (no count to show)", () => {
		expect(diagCapsulesFromMeta(meta([{ path: "a.ts", rows: [] }]))).toEqual([]);
	});

	it("tolerates a LEGACY meta without sources / codes — no error, no fields", () => {
		const capsules = diagCapsulesFromMeta(meta([{ path: "a.ts", rows: [row], suppressedCount: 2 }]));
		expect(capsules).toHaveLength(1);
		// #429 tolerance: absent handles degrade to EMPTY arrays, never a crash.
		expect(capsules[0]!.rows[0]!.sources).toEqual([]);
		expect(capsules[0]!.rows[0]!.codes).toEqual([]);
		expect(capsules[0]!.suppressedCount).toBe(2);
	});

	it("carries sources / codes when a CURRENT meta provides them", () => {
		const withHandles = { ...row, sources: ["pyright"], codes: ["2322"] };
		const capsules = diagCapsulesFromMeta(meta([{ path: "a.ts", rows: [withHandles] }]));
		expect(capsules[0]!.rows[0]!.sources).toEqual(["pyright"]);
		expect(capsules[0]!.rows[0]!.codes).toEqual(["2322"]);
	});
});

describe("diagCapsuleLabels (#429)", () => {
	const t = (key: string, params?: Record<string, unknown>): string =>
		`${key}:${params?.count ?? ""}`;

	it("pulls every word from the vocabulary, count interpolated", () => {
		const labels = diagCapsuleLabels(t);
		expect(labels.error(2)).toBe("diag.capsule.error:2");
		expect(labels.warning(1)).toBe("diag.capsule.warning:1");
		expect(labels.diagnostic(3)).toBe("diag.capsule.diagnostic:3");
		expect(labels.unchanged(50)).toBe("diag.capsule.unchanged:50");
	});
});
