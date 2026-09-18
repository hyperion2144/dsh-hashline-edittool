import { describe, expect, it } from "vitest";
import { computeDrift } from "../../src/domain/session/session-view.js";

describe("computeDrift", () => {
	it("never anchors drift echoes to an ambiguous (duplicated) hash", () => {
		// hA appears at result rows 1 and 3: not a unique position anchor —
		// the drifted row (hB, gone from the result) must fall back to a
		// numeric estimate, never NaN.
		const result = computeDrift({
			served: new Set(["hA", "hB", "hA"]),
			originalHashes: ["hA", "hC", "hA"],
			resultHashes: ["hA", "hC", "hA"],
			resultLines: ["a", "c", "a"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "hA",
				endHash: "hA",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.text).not.toContain("NaN");
		expect(result!.rows.every((r) => typeof r.anchor === "string")).toBe(true);
	});
	it("returns undefined when nothing drifted outside the range", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02"]),
			originalHashes: ["h00", "h01", "h02"],
			resultHashes: ["h00", "h01", "h02"],
			resultLines: ["a", "b", "c"],
			range: {
				startLine: 2,
				endLine: 2,
				startHash: "h01",
				endHash: "h01",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeUndefined();
	});

	it("reports an in-place drift below the range with its post-edit content", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["h00", "h01", "h02", "X03"],
			resultHashes: ["h00", "h01", "h02", "X03"],
			resultLines: ["a", "b", "c", "changed"],
			range: {
				startLine: 2,
				endLine: 2,
				startHash: "h01",
				endHash: "h01",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(false);
		expect(result!.rows).toEqual([
			{ anchor: "h03", drifted: true },
		]);
		expect(result!.text).toContain("Drift notice:");
		expect(result!.text).toContain("1 anchor(s)");
	});

	it("excludes the resolved range even when a boundary line was deleted", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03", "h04"]),
			originalHashes: ["h00", "h01", "X03", "h04"],
			resultHashes: ["h00", "h01", "X03", "h04"],
			resultLines: ["a", "b", "x", "d"],
			range: {
				startLine: 3,
				endLine: 4,
				startHash: "h02",
				endHash: "h03",
				delta: -1,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(2);
		expect(result!.rows).toEqual([
			{ anchor: "h02", drifted: true },
			{ anchor: "h03", drifted: true },
		]);

	});
	it("applies the edit's positional shift to served entries below the range", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03", "h04"]),
			originalHashes: ["h00", "h01", "h03", "X04"],
			resultHashes: ["h00", "h01", "h03", "X04"],
			resultLines: ["a", "b", "d", "shifted"],
			range: {
				startLine: 3,
				endLine: 3,
				startHash: "h02",
				endHash: "h02",
				delta: -1,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.rows).toEqual([
			{ anchor: "h02", drifted: true },
			{ anchor: "h04", drifted: true },
		]);

	});
	it("keeps positions of served entries above the range regardless of delta", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02"]),
			originalHashes: ["h00", "X01", "h02"],
			resultHashes: ["h00", "X01", "h02"],
			resultLines: ["a", "changed", "c"],
			range: {
				startLine: 3,
				endLine: 3,
				startHash: "h02",
				endHash: "h02",
				delta: -5,
			},
			reported: new Set(),
		});
		expect(result!.rows).toEqual([
			{ anchor: "h01", drifted: true },
		]);
	});

	it("counts served entries shifted out of the file as drifted without rows", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02"]),
			originalHashes: ["X02"],
			resultHashes: ["X02"],
			resultLines: ["c"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h00",
				endHash: "h00",
				delta: -2,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(3);
		expect(result!.rows).toEqual([
			{ anchor: "h00", drifted: true },
			{ anchor: "h01", drifted: true },
			{ anchor: "h02", drifted: true },
		]);
	});

	it("emits a one-line pointer when every drifted line is already reported", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["h00", "h01", "h02", "X03"],
			resultHashes: ["h00", "h01", "h02", "X03"],
			resultLines: ["a", "b", "c", "changed"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h00",
				endHash: "h00",
				delta: 0,
			},
			reported: new Set(["h03"]),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(true);
		expect(result!.rows).toEqual([]);
		expect(result!.text).toContain("already reported");
		expect(result!.text).not.toMatch(/\d+#[A-Za-z0-9]{3}/);
	});

	it("shows a full notice with rows for all drifted lines when any is not yet reported", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["X00", "h01", "h02", "X03"],
			resultHashes: ["X00", "h01", "h02", "X03"],
			resultLines: ["changedA", "b", "c", "changedD"],
			range: {
				startLine: 2,
				endLine: 2,
				startHash: "h01",
				endHash: "h01",
				delta: 0,
			},
			reported: new Set(["h03"]),
		});
		expect(result).toBeDefined();
		expect(result!.allAlreadyReported).toBe(false);
		expect(result!.rows).toEqual([
			{ anchor: "h00", drifted: true },
			{ anchor: "h03", drifted: true },
		]);
	});

	it("caps the total shown rows (drifted + context) and appends a hint for the remainder", () => {
		const served = new Set<string>();
		const resultHashes: string[] = [];
		const resultLines: string[] = [];
		for (let i = 0; i < 200; i++) {
			served.add(`h${i}`);
			resultHashes.push(i % 2 === 0 ? `h${i}` : `R${i}`);
			resultLines.push(`line ${i}`);
		}
		const result = computeDrift({
			served,
			originalHashes: resultHashes,
			resultHashes,
			resultLines,
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h0",
				endHash: "h0",
				delta: 0,
			},
			reported: new Set(),
			cap: 150,
		});
		expect(result).toBeDefined();
		expect(result!.rows).toHaveLength(100);
		expect(result!.total).toBe(100);
		expect(result!.text).toContain("100 anchor(s)");
	});

	it("ignores never-served markers", () => {
		const result = computeDrift({
			served: new Set(["h00", "h02"]),
			originalHashes: ["h00", "X01", "h02"],
			resultHashes: ["h00", "X01", "h02"],
			resultLines: ["a", "changed", "c"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h00",
				endHash: "h00",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeUndefined();
	});

	it("tolerates an external positional shift above the range — only genuinely removed lines drift", () => {
		const served = new Set([
			"h00",
			"h01",
			"h02",
			"h03",
			"h04",
			"h05",
			"h06",
			"h07",
			"h08",
			"h09",
		]);
		const resultHashes = [
			"h00",
			"h01",
			"X04",
			"h05",
			"h06",
			"h07",
			"h08",
			"h09",
		];
		const resultLines = ["a", "b", "R", "e", "f", "g", "h", "i"];
		const result = computeDrift({
			served,
			originalHashes: resultHashes,
			resultHashes,
			resultLines,
			range: {
				startLine: 3,
				endLine: 3,
				startHash: "h04",
				endHash: "h04",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(3);
		expect(result!.rows).toEqual([
			{ anchor: "h02", drifted: true },
			{ anchor: "h03", drifted: true },
			{ anchor: "h04", drifted: true },
		]);
	});

	it("shows a before/drift/after window for a single drifted line", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["h00", "h01", "X02", "h03"],
			resultHashes: ["h00", "h01", "X02", "h03"],
			resultLines: ["a", "b", "changed", "d"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h00",
				endHash: "h00",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(1);
		expect(result!.rows).toEqual([
			{ anchor: "h02", drifted: true },
		]);
	});

	it("merges adjacent drifted lines into a single window with shared context boundaries", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["X00", "X01", "X02", "X03"],
			resultHashes: ["X00", "X01", "X02", "X03"],
			resultLines: ["a", "b", "C", "D"],
			range: {
				startLine: 1,
				endLine: 2,
				startHash: "h00",
				endHash: "h01",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(4);
		expect(result!.rows).toEqual([
			{ anchor: "h00", drifted: true },
			{ anchor: "h01", drifted: true },
			{ anchor: "h02", drifted: true },
			{ anchor: "h03", drifted: true },
		]);
	});

	it("bounds the window at the file start — only in-bounds context rows, no fabricated before-row", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02"]),
			originalHashes: ["X00", "h01", "h02"],
			resultHashes: ["X00", "h01", "h02"],
			resultLines: ["changed", "b", "c"],
			range: {
				startLine: 3,
				endLine: 3,
				startHash: "h02",
				endHash: "h02",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(1);
		expect(result!.rows).toEqual([
			{ anchor: "h00", drifted: true },
		]);
	});

	it("bounds the window at the file end — only in-bounds context rows, no fabricated after-row", () => {
		const result = computeDrift({
			served: new Set(["h00", "h01", "h02", "h03"]),
			originalHashes: ["h00", "h01", "h02", "X03"],
			resultHashes: ["h00", "h01", "h02", "X03"],
			resultLines: ["a", "b", "c", "changed"],
			range: {
				startLine: 1,
				endLine: 1,
				startHash: "h00",
				endHash: "h00",
				delta: 0,
			},
			reported: new Set(),
		});
		expect(result).toBeDefined();
		expect(result!.total).toBe(1);
		expect(result!.rows).toEqual([
			{ anchor: "h03", drifted: true },
		]);
	});
});
