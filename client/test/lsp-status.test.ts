/**
 * The lsp status card's model layer under test (#320): `lspStatusCard` reads
 * the persisted `card: "lsp-status"` meta the host projects for `status` and
 * `warm` answers, soft-validated like every other meta reader — ANY deviation
 * yields `null`, which renders no card and falls through to the generic body.
 *
 * The JSX wiring (ToolRow priority, LspStatusBlock render) is a component
 * concern in a DOM-less environment — the same call ADR-0005 made: text-
 * deciding logic lives in these pure functions; visuals are real-machine smoke.
 *
 * @module dsh-hashline-edittool/client/test/lsp-status
 */
import { describe, expect, it } from "vitest";
import { lspStatusCardModel } from "../src/client/models.js";
import type { ToolCallBlock } from "../src/client/types.js";

/** Build a settled lsp result node carrying the given meta. */
function settled(meta: unknown): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "lsp", argsRaw: '{"operation":"status"}' },
		callTime: 0,
		content: [],
		isError: false,
		meta,
		subCalls: [],
	} as ToolCallBlock;
}

describe("lspStatusCardModel (#320)", () => {
	it("reads a structured status meta: every slot, verbatim", () => {
		const slots = [
			{ languageId: "typescript", state: "ready" },
			{ languageId: "python", state: "failed", reason: "lsp-timeout", message: "did not answer", attempts: 2 },
		];
		expect(lspStatusCardModel(settled({ card: "lsp-status", slots }))).toEqual({ slots });
	});

	it("rejects a meta with the wrong card name (a read meta is not a status)", () => {
		expect(lspStatusCardModel(settled({ path: "/a.ts", hashlines: [] }))).toBeNull();
	});

	it("rejects a status meta whose slots are not an array", () => {
		expect(lspStatusCardModel(settled({ card: "lsp-status", slots: "ready" }))).toBeNull();
	});

	it("rejects a slot that is not an object, and a slot without a language", () => {
		expect(lspStatusCardModel(settled({ card: "lsp-status", slots: ["ready"] }))).toBeNull();
		expect(
			lspStatusCardModel(settled({ card: "lsp-status", slots: [{ state: "ready" }] })),
		).toBeNull();
	});

	it("accepts a failed slot without optional fields, and rejects unknown fields", () => {
		expect(lspStatusCardModel(settled({ card: "lsp-status", slots: [{ languageId: "python", state: "failed" }] }))).toEqual({
			slots: [{ languageId: "python", state: "failed" }],
		});
		expect(
			lspStatusCardModel(settled({ card: "lsp-status", slots: [{ languageId: "python", state: "failed", nope: 1 }] })),
		).toBeNull();
	});

	it("yields null for running calls, errors, and non-object metas", () => {
		expect(lspStatusCardModel(settled(undefined))).toBeNull();
		expect(lspStatusCardModel(settled(null))).toBeNull();
		expect(lspStatusCardModel(settled("status"))).toBeNull();
	});
});
