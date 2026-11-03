/**
 * The `lsp` answers that carry no rows of their own (#397 review): a hover's
 * contents, an action list and a raw `request` JSON.
 *
 * The row used to fall back to a raw input/output dump for all three, because
 * the read projection carried zero rows and neither card model accepted the
 * meta. `lspAnswerModel` is the reader that turns the host's discriminator into
 * a card model — soft-validated like every other meta reader, so ANY deviation
 * yields `null` and the row stays on the generic body instead of drawing a
 * guess.
 *
 * The JSX wiring is a component concern in a DOM-less environment (the same
 * call ADR-0005 made): the decision is pure, the drawing is real-machine smoke.
 *
 * @module dsh-hashline-edittool/test/lsp-answer
 */
import { describe, expect, it } from "vitest";
import { lspAnswerModel } from "../src/client/lsp-answer.js";
import type { ToolCallBlock } from "../src/client/types.js";

/** Build a settled lsp result node carrying the given meta. */
function settled(meta: unknown): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "lsp", argsRaw: '{"operation":"hover"}' },
		callTime: 0,
		content: [],
		isError: false,
		meta,
		subCalls: [],
	} as ToolCallBlock;
}

describe("lspAnswerModel (#397 review)", () => {
	it("reads a hover answer as its own card", () => {
		const hover = "```typescript\nconst alpha: number\n```";
		expect(lspAnswerModel(settled({ operation: "hover", path: "a.ts", hover }))).toEqual({
			kind: "hover",
			path: "a.ts",
			text: hover,
		});
	});

	it("keeps the server's action list, kinds and all", () => {
		const actions = [
			{ title: "Add missing import", kind: "quickfix" },
			{ title: "Extract to constant" },
		];
		expect(lspAnswerModel(settled({ operation: "code_actions", path: "a.ts", actions }))).toEqual({
			kind: "actions",
			path: "a.ts",
			actions,
		});
	});

	it("carries the host's sentence for an EMPTY action list", () => {
		// A card with zero rows would draw an empty frame; the sentence is what
		// the body says instead.
		expect(
			lspAnswerModel(
				settled({ operation: "code_actions", path: "a.ts", actions: [], note: "No action is offered here." }),
			),
		).toEqual({
			kind: "actions",
			path: "a.ts",
			actions: [],
			note: "No action is offered here.",
		});
	});

	it("reads a raw request answer as the JSON card", () => {
		const json = '{\n  "ok": true\n}';
		expect(lspAnswerModel(settled({ operation: "request", path: "a.ts", json }))).toEqual({
			kind: "json",
			path: "a.ts",
			text: json,
		});
	});

	it("draws the SENTENCE when a hover is empty", () => {
		// `No hover information.` is the answer: the host projects it as `note`,
		// and the same frame renders it instead of an empty body.
		expect(
			lspAnswerModel(settled({ operation: "hover", path: "a.ts", hover: "", note: "No hover information." })),
		).toEqual({ kind: "note", path: "a.ts", text: "No hover information." });
		// Without the sentence there is nothing to draw.
		expect(lspAnswerModel(settled({ operation: "hover", path: "a.ts", hover: "" }))).toBeNull();
		expect(lspAnswerModel(settled({ operation: "request", path: "a.ts", json: "" }))).toBeNull();
	});

	it("draws an EMPTY navigation answer as its sentence, not a raw dump", () => {
		expect(lspAnswerModel(settled({ operation: "goToDefinition", path: "a.ts", note: "No results." }))).toEqual({
			kind: "note",
			path: "a.ts",
			text: "No results.",
		});
	});

	it("refuses a meta that is not one of the three answers", () => {
		expect(lspAnswerModel(settled({ operation: "symbols", path: "a.ts" }))).toBeNull();
		expect(lspAnswerModel(settled({ operation: "code_actions", path: "a.ts" }))).toBeNull();
		expect(lspAnswerModel(settled({ operation: "code_actions", path: "a.ts", actions: "nope" }))).toBeNull();
		expect(lspAnswerModel(settled("not an object"))).toBeNull();
	});

	it("refuses a malformed action — the card draws the list or nothing", () => {
		expect(lspAnswerModel(settled({ operation: "code_actions", actions: [{ title: 42 }] }))).toBeNull();
		expect(lspAnswerModel(settled({ operation: "code_actions", actions: [{ title: "x", kind: 7 }] }))).toBeNull();
	});
});
