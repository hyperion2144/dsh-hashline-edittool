/**
 * PTC sub-call rendering (#353).
 *
 * In PTC mode the model sees only `run_code`; every hashline tool call is a
 * CHILD dispatch whose `parentCallId` points at the program. DSH copies each
 * child's presentationMeta onto the logged `tool/ptc-dispatch` result, so the
 * child is the same `ToolResultNode` shape a native call is — only the parent
 * edge differs.
 *
 * The card models used to refuse every `parentCallId`, which sent all six of
 * them to the generic input/output fallback in PTC sessions. These tests pin
 * the opposite: a child carrying valid meta draws its card, and the
 * soft-validation (not the parent edge) is what decides.
 *
 * @module dsh-hashline-edittool/client/test/ptc-subcall
 */
import { describe, expect, it } from "vitest";
import {
	deleteCardModel,
	diffCardModel,
	grepCardModel,
	errorCardModel,
	lspCardModel,
	lspStatusCardModel,
	readCardModel,
	writeCardModel,
} from "../src/client/models.js";
import type { ToolCallBlock } from "../src/client/types.js";

/** The `run_code` call the child belongs to; the bridge writes this id. */
const PTC_PARENT = "run-code-1";

/**
 * Build a settled PTC child: a tool-result block with `parentCallId` set and
 * the presentationMeta the dispatch bridge copied onto it.
 * @param name - wire tool name the child dispatched.
 * @param argsRaw - the child's argument payload.
 * @param meta - the presentationMeta the host persisted for the child.
 * @param overrides - fields a test needs to bend (error state, content…).
 * @returns the child block.
 */
function child(
	name: string,
	argsRaw: string,
	meta: unknown,
	overrides: Partial<Extract<ToolCallBlock, { kind: "tool-result" }>> = {},
): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 2,
		time: 0,
		callId: `${PTC_PARENT}:ptc:1`,
		parentCallId: PTC_PARENT,
		call: { name, argsRaw },
		callTime: 0,
		content: [],
		isError: false,
		meta,
		subCalls: [],
		...overrides,
	};
}

describe("PTC sub-call cards (#353)", () => {
	it("draws the read card for a dispatched read", () => {
		const model = readCardModel(
			child(
				"read",
				JSON.stringify({ file_path: "/w/src/a.ts" }),
				{
					path: "/w/src/a.ts",
					offset: 1,
					lines: [{ number: 1, text: "const a = 1;" }],
					totalLines: 1,
					hashlines: [{ number: 1, hash: "a1", text: "const a = 1;" }],
				},
			),
			"/w",
			undefined,
		);
		expect(model?.path).toBe("/w/src/a.ts");
		expect(model?.rows[0]?.gutter).toBe("1:a1");
	});

	it("draws the edit diff card for a dispatched edit", () => {
		const model = diffCardModel(
			child("edit", JSON.stringify({ path: "a.ts", edits: [] }), {
				path: "a.ts",
				diffs: [{ path: "a.ts", oldText: "old\n", newText: "new\n" }],
			}),
		);
		expect(model?.path).toBe("a.ts");
		expect(model?.diffs).toHaveLength(1);
	});

	it("draws the write card for a dispatched write", () => {
		const model = writeCardModel(
			child("write", JSON.stringify({ file_path: "/w/a.ts", content: "x\n" }), {
				path: "/w/a.ts",
				diffRows: [{ kind: "+", lineNumber: 1, hash: "h1", text: "x" }],
			}),
		);
		expect(model?.path).toBe("/w/a.ts");
		expect(model?.rows).toHaveLength(1);
	});

	it("draws the grep card for a dispatched grep", () => {
		const model = grepCardModel(
			child("grep", JSON.stringify({ path: "src", pattern: "alpha" }), {
				files: [
					{
						path: "src/a.ts",
						rows: [{ number: 12, hash: "a3f", text: "const alpha = 1;", match: true, spans: [[6, 11]] }],
					},
				],
				truncated: false,
				total: 1,
			}),
		);
		expect(model?.files[0]?.path).toBe("src/a.ts");
	});

	it("draws the lsp diagnostics card for a dispatched lsp", () => {
		const model = lspCardModel(
			child("lsp", JSON.stringify({ operation: "diagnostics", path: "/w/a.ts" }), {
				path: "/w/a.ts",
				hashlines: [{ number: 1, hash: "a1", text: "let a;", messages: ["error: implicit any"] }],
			}),
		);
		expect(model?.path).toBe("/w/a.ts");
		expect(model?.rows[0]?.messages).toEqual(["error: implicit any"]);
	});

	it("draws the lsp status card for a dispatched status", () => {
		const model = lspStatusCardModel(
			child("lsp", JSON.stringify({ operation: "status" }), {
				card: "lsp-status",
				slots: [{ languageId: "typescript", state: "ready" }],
			}),
		);
		expect(model?.slots).toEqual([{ languageId: "typescript", state: "ready" }]);
	});

	it("draws the delete card for a dispatched delete", () => {
		const model = deleteCardModel(
			child("delete", JSON.stringify({ paths: ["/w/a.ts"] }), {
				delete: {
					results: [{ path: "/w/a.ts", status: "deleted", detail: "1 file removed" }],
					failures: [],
				},
			}),
			"/w",
			undefined,
		);
		expect(model?.rows[0]?.path).toBe("a.ts");
	});

	it("still draws the structured error card for a dispatched failure", () => {
		const model = errorCardModel(
			child("edit", JSON.stringify({ path: "a.ts" }), undefined, {
				isError: true,
				content: [{ type: "text", text: "[E_STALE] anchor is stale" }],
			}),
		);
		expect(model?.code).toBe("E_STALE");
	});

	it("still refuses a child whose meta cannot be validated", () => {
		// The parent edge is no longer the gate; a torn payload still is.
		expect(grepCardModel(child("grep", "{}", { files: "nope", truncated: false, total: 0 }))).toBeNull();
		expect(lspCardModel(child("lsp", "{}", { path: "/w/a.ts" }))).toBeNull();
	});
});
