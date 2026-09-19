/**
 * The error card's model layer under test (map #137, #140, spec #146):
 * `errorCardModel`'s degradation matrix (structured `meta.error` → legacy
 * `isError` synthesis → nothing), `hasMetaError`, and the row state
 * derivation that lights the red dot for `isError: false` error values.
 *
 * The JSX wiring (ToolRow priority, ErrorCard render, StateDot) is a
 * component concern in a DOM-less environment — the same call ADR-0005 made:
 * text-deciding logic lives in these pure functions; visuals are real-machine
 * smoke.
 *
 * @module dsh-hashline-edittool/client/test/error-card
 */
import { describe, expect, it } from "vitest";
import { errorCardModel, hasMetaError, toolRowModel } from "../src/client/models.js";
import type { ToolCallBlock } from "../src/client/types.js";

/** Build a settled result node fixture. */
function settled(overrides: Partial<Extract<ToolCallBlock, { kind: "tool-result" }>> = {}): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "read", argsRaw: "{}" },
		callTime: 0,
		content: [],
		isError: false,
		subCalls: [],
		...overrides,
	};
}

/** Build a running call fixture. */
function running(): ToolCallBlock {
	return {
		callId: "c1",
		name: "read",
		argsRaw: "{}",
		turn: 1,
		step: 1,
		time: 0,
		subCalls: [],
	};
}

describe("errorCardModel — structured path (meta.error)", () => {
	it("extracts the five-field failure from persisted meta", () => {
		const block = settled({
			meta: {
				error: {
					code: "E_STALE",
					message: "2 stale anchors",
					path: "a.ts",
					context: "Echo of the line you tried:\nrows",
					hint: "Re-read for fresh anchors.",
				},
			},
		});
		expect(errorCardModel(block)).toEqual({
			code: "E_STALE",
			message: "2 stale anchors",
			path: "a.ts",
			context: "Echo of the line you tried:\nrows",
			hint: "Re-read for fresh anchors.",
		});
	});

	it("drops empty optional fields", () => {
		const block = settled({ meta: { error: { code: "E_DEMO", message: "x", path: "", context: "" } } });
		expect(errorCardModel(block)).toEqual({ code: "E_DEMO", message: "x" });
	});

	it("rejects malformed payloads — no half-facts, ever", () => {
		expect(errorCardModel(settled({ meta: { error: { message: "no code" } } }))).toBeNull();
		expect(errorCardModel(settled({ meta: { error: "not an object" } }))).toBeNull();
		expect(errorCardModel(settled({ meta: { error: { code: "", message: "x" } } }))).toBeNull();
		expect(errorCardModel(settled({ meta: "not an object" }))).toBeNull();
	});

	it("a running call draws nothing", () => {
		expect(errorCardModel(running())).toBeNull();
	});
});

describe("errorCardModel — legacy synthesis (isError, no meta.error)", () => {
	it("parses the [E_*] marker off the head of the result text", () => {
		const block = settled({
			isError: true,
			content: [{ type: "text", text: "[E_STALE] boom\nre-read" }],
		});
		expect(errorCardModel(block)).toEqual({ code: "E_STALE", message: "boom\nre-read" });
	});

	it("falls back to code ERROR for host-level failures without a marker", () => {
		const text = "[sandbox: file access denied under read-only mode]";
		const block = settled({ isError: true, content: [{ type: "text", text }] });
		expect(errorCardModel(block)).toEqual({ code: "ERROR", message: text });
	});

	it("an interrupted call is a stop, not a failure", () => {
		const block = settled({
			isError: true,
			error: { name: "AbortError", code: "interrupted" },
			content: [{ type: "text", text: "stopped" }],
		});
		expect(errorCardModel(block)).toBeNull();
	});

	it("a clean success draws nothing", () => {
		expect(errorCardModel(settled())).toBeNull();
	});

	it("an error with no text draws nothing", () => {
		expect(errorCardModel(settled({ isError: true, content: [] }))).toBeNull();
	});
});

describe("hasMetaError", () => {
	it("is true exactly when the meta carries a structured error", () => {
		expect(hasMetaError({ error: { code: "E_DEMO", message: "x" } })).toBe(true);
		expect(hasMetaError({})).toBe(false);
		expect(hasMetaError({ error: null })).toBe(false);
		expect(hasMetaError(undefined)).toBe(false);
	});
});

describe("toolRowModel state derivation", () => {
	it("meta.error lights the error state even when isError is false (#139 values)", () => {
		const model = toolRowModel(
			"read",
			settled({ meta: { error: { code: "E_STALE", message: "x" } } }),
			undefined,
			undefined,
		);
		expect(model.state).toBe("error");
	});

	it("legacy isError still errors (old logs)", () => {
		const model = toolRowModel(
			"read",
			settled({ isError: true, content: [{ type: "text", text: "[E_STALE] x" }] }),
			undefined,
			undefined,
		);
		expect(model.state).toBe("error");
	});

	it("interrupted stays stopped — the state the row already speaks", () => {
		const model = toolRowModel(
			"read",
			settled({
				isError: true,
				error: { name: "AbortError", code: "interrupted" },
				content: [{ type: "text", text: "x" }],
			}),
			undefined,
			undefined,
		);
		expect(model.state).toBe("stopped");
	});

	it("a clean success stays ok", () => {
		expect(toolRowModel("read", settled(), undefined, undefined).state).toBe("ok");
	});
});
