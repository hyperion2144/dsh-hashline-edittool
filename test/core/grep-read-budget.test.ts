/**
 * Unit tests for the `grep` scan budget (issue #167).
 *
 * The policy is pure, so these exercise the arithmetic directly — the ceilings
 * are handed in rather than stubbed, which is why the module resolves its
 * defaults per call.
 */
import { describe, expect, it } from "vitest";
import { capModelText, makeReadBudget } from "../../src/infra/read-budget.js";

describe("makeReadBudget — per-file ceiling", () => {
	it("admits a file at exactly the per-file ceiling", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 1000 });
		expect(budget.admit(100)).toEqual({ ok: true, bytes: 100 });
		expect(budget.usage()).toMatchObject({ filesRead: 1, filesOmitted: 0 });
	});

	it("refuses a file one byte over the per-file ceiling and reserves nothing", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 1000 });
		expect(budget.admit(101)).toEqual({ ok: false, reason: "too-large", bytes: 101 });
		expect(budget.bytesRead).toBe(0);
		expect(budget.usage()).toMatchObject({ filesRead: 0, filesOmitted: 1, exhausted: false });
	});

	it("keeps scanning after a too-large file — that refusal is not exhaustion", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 1000 });
		budget.admit(5000);
		expect(budget.usage().exhausted).toBe(false);
		expect(budget.admit(50)).toEqual({ ok: true, bytes: 50 });
	});
});

describe("makeReadBudget — total ceiling", () => {
	it("admits while the running total fits, then reports exhaustion", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 100 });
		expect(budget.admit(60).ok).toBe(true);
		expect(budget.admit(40).ok).toBe(true);
		// The next file does not fit: the scan is over, not merely skipping.
		expect(budget.admit(1)).toEqual({ ok: false, reason: "budget", bytes: 1 });
		expect(budget.usage()).toMatchObject({ bytesRead: 100, filesRead: 2, exhausted: true });
	});

	it("reports remaining allowance and never goes negative", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 100 });
		budget.admit(70);
		expect(budget.remainingBytes).toBe(30);
		budget.release(200);
		expect(budget.bytesRead).toBe(0);
		expect(budget.remainingBytes).toBe(100);
	});

	it("releases an unused reservation so a failed read does not leak allowance", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 100 });
		budget.admit(40);
		budget.release(40);
		expect(budget.bytesRead).toBe(0);
		expect(budget.admit(100).ok).toBe(true);
	});

	it("ignores a non-positive release", () => {
		const budget = makeReadBudget({ maxFileBytes: 100, maxTotalBytes: 100 });
		budget.admit(40);
		budget.release(0);
		budget.release(-5);
		expect(budget.bytesRead).toBe(40);
	});
});

describe("makeReadBudget — unlimited dimensions", () => {
	it("treats a non-positive ceiling as unlimited", () => {
		const budget = makeReadBudget({ maxFileBytes: 0, maxTotalBytes: -1 });
		expect(budget.admit(10_000_000).ok).toBe(true);
		expect(budget.remainingBytes).toBe(Number.POSITIVE_INFINITY);
	});

	it("falls back to the shipped defaults when no ceilings are given", () => {
		const budget = makeReadBudget();
		// A byte, not a policy number: the defaults must be real ceilings, so a
		// file that could never be read is refused rather than admitted.
		expect(budget.admit(Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false });
		expect(budget.remainingBytes).toBeGreaterThan(0);
	});
});

describe("capModelText", () => {
	it("returns short text unchanged, byte for byte", () => {
		const text = "--- a.ts ---\nANCHOR:FILELINE\nab:1:needle\n";
		expect(capModelText(text, 1024)).toBe(text);
	});

	it("keeps the head and appends a truncation notice when over budget", () => {
		const text = "x".repeat(500);
		const capped = capModelText(text, 200);
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(200);
		expect(capped).toContain("grep output truncated");
		expect(capped.startsWith("x")).toBe(true);
	});

	it("never splits a surrogate pair at the cut", () => {
		// Each emoji is 4 UTF-8 bytes and 2 UTF-16 units: slicing by bytes alone
		// would leave a lone high surrogate at the boundary.
		const text = "😀".repeat(100);
		const capped = capModelText(text, 51);
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(51);
		expect(/[\uD800-\uDBFF]$/.test(capped)).toBe(false);
		expect(capped).not.toContain("\uFFFD");
	});

	it("passes text through when the ceiling is disabled", () => {
		const text = "y".repeat(500);
		expect(capModelText(text, 0)).toBe(text);
	});
});
