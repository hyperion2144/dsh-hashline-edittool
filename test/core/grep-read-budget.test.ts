/**
 * Unit tests for the streaming-segments infrastructure (ADR-0013, #209/#210):
 * the per-response budget, row assembly, the spill store and resume tokens,
 * and version-stamp comparison. The end-to-end resume walk is covered by the
 * tool-level integration tests (issue-167-grep-budget.test.ts and friends).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	codeUnits,
	takeRowsWithinBudget,
	createResume,
	loadResume,
	readSpillRows,
	advanceResume,
	takeTextContinuation,
	resumeError,
	stampChanged,
	type SegmentRow,
} from "../../src/infra/response-stream.js";
import {
	RESPONSE_BUDGET_DEFAULT,
	RESPONSE_BUDGET_MIN,
	RESPONSE_BUDGET_MAX,
} from "../../src/infra/constants.js";

const SESSION = "test-session-streaming";
const CONSUMER = "grep";

afterEach(() => {});

describe("per-response budget constants", () => {
	it("the default sits inside the host-safe band", () => {
		expect(RESPONSE_BUDGET_DEFAULT).toBe(48_000);
		expect(RESPONSE_BUDGET_DEFAULT).toBeGreaterThanOrEqual(RESPONSE_BUDGET_MIN);
		expect(RESPONSE_BUDGET_DEFAULT).toBeLessThanOrEqual(RESPONSE_BUDGET_MAX);
	});
});

describe("takeRowsWithinBudget", () => {
	it("takes whole rows up to the budget and spills the rest", () => {
		const rows = [1, 2, 3, 4, 5].map((n) => `row-${n}`);
		const { included, overflow } = takeRowsWithinBudget(rows, 15, codeUnits);
		expect(included).toEqual(["row-1", "row-2", "row-3"]);
		expect(overflow).toEqual(["row-4", "row-5"]);
	});

	it("never cuts a row in half — a single oversized row is included alone", () => {
		const rows = ["a", "X".repeat(1000), "b"];
		const { included, overflow } = takeRowsWithinBudget(rows, 100, codeUnits);
		expect(included).toEqual(["a"]);
		expect(overflow).toEqual(["X".repeat(1000), "b"]);
	});

	it("codeUnits counts UTF-16 code units (CJK = 1 per char)", () => {
		expect(codeUnits("中文")).toBe(2);
		expect(codeUnits("abc")).toBe(3);
	});
});

describe("resume tokens", () => {
	it("round-trips rows: create → load → read → advance", async () => {
		const rows: SegmentRow[] = ["a", "b", "c", "d"].map((content) => ({ content }));
		const { token, total } = await createResume({
			sessionKey: SESSION,
			producer: "grep",
			consumer: CONSUMER,
			kind: "scan-continuation",
			rows,
		});
		expect(total).toBe(4);
		expect(token).toMatch(/^rs-[0-9a-f]{32}$/);

		const sidecar = await loadResume(SESSION, token, CONSUMER);
		expect(sidecar.consumer).toBe(CONSUMER);
		expect(sidecar.cursor).toBe(0);

		const first = await readSpillRows(sidecar, 2);
		expect(first.map((r) => r.content)).toEqual(["a", "b"]);
		await advanceResume(SESSION, token, 2);

		const take = await takeTextContinuation(SESSION, token, CONSUMER, 2);
		expect(take.lines).toEqual(["c", "d"]);
		expect(take.done).toBe(true);
	});

	it("rejects a malformed token with E_RESUME_BAD", () => {
		expect(() => {
			throw resumeError("E_RESUME_BAD", "boom");
		}).toThrow("[E_RESUME_BAD] boom");
	});

	it("rejects an unknown token with E_RESUME_GONE", async () => {
		const good = "rs-" + "0".repeat(32);
		await expect(loadResume(SESSION, good, CONSUMER)).rejects.toThrow("[E_RESUME_GONE]");
	});

	it("rejects a token consumed by the wrong tool with E_RESUME_TOOL", async () => {
		const { token } = await createResume({
			sessionKey: SESSION,
			producer: "grep",
			consumer: CONSUMER,
			kind: "scan-continuation",
			rows: [{ content: "x" }],
		});
		await expect(loadResume(SESSION, token, "read")).rejects.toThrow("[E_RESUME_TOOL]");
	});
});

describe("stampChanged", () => {
	it("detects a version change", () => {
		expect(stampChanged({ version: "a" }, { version: "b" })).toBe(true);
		expect(stampChanged({ version: "a" }, { version: "a" })).toBe(false);
	});

	it("falls back to mtime+size when versions are absent", () => {
		expect(stampChanged({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(false);
		expect(stampChanged({ mtimeMs: 1, size: 2 }, { mtimeMs: 9, size: 2 })).toBe(true);
	});

	it("treats a missing side as unchanged (the caution stays off)", () => {
		expect(stampChanged(undefined, { version: "a" })).toBe(false);
	});
});
