/**
 * The delete card's pure projection: `meta.delete` → title/summary/rows.
 * @module
 */
import { describe, expect, it } from "vitest";
import { deleteCardModel } from "../src/client/models.js";
import { EN_CARD_DICTIONARY, ZH_CARD_DICTIONARY } from "../src/client/locale.js";

function block(meta: unknown) {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "delete", argsRaw: "{}" },
		callTime: 0,
		content: [],
		isError: false,
		meta,
		subCalls: [],
	} as never;
}

describe("deleteCardModel", () => {
	it("projects results, failures, and the logical reclaim summary", () => {
		const model = deleteCardModel(
			block({
				delete: {
					results: [
						{
							path: "/a.ts",
							status: "deleted",
							reclaimed: {
								anchorLines: 2,
								undoLayers: 1,
								servedRows: 3,
								anchorMeta: 1,
								bytesFreed: 2048,
							},
						},
						{ path: "/gone.ts", status: "already-absent" },
					],
					failures: [
						{ path: "/dir", code: "E_NOT_FILE", message: "Path is not a regular file." },
					],
					totals: { deleted: 1, alreadyAbsent: 1, failed: 1 },
					reclaimed: { bytesFreed: 2048 },
					vacuum: "pending",
				},
			}),
		);

		// #375: the summary and the reclaim details are words + counts — the
		// model layer names the wording, the client renders it.
		expect(model?.summary).toEqual([
			{ kind: "word", key: "delete.count", params: { count: 3 } },
			{ kind: "word", key: "delete.stat.deleted", params: { count: 1 } },
			{ kind: "word", key: "delete.stat.absent", params: { count: 1 } },
			{ kind: "word", key: "delete.stat.failed", params: { count: 1 } },
			{ kind: "word", key: "delete.stat.freed", params: { bytes: "2.0KiB" } },
		]);
		expect(model?.rows).toEqual([
			{
				path: "/a.ts",
				status: "deleted",
				detail: [
					{ kind: "word", key: "delete.detail.anchors", params: { count: 2 } },
					{ kind: "word", key: "delete.detail.undo", params: { count: 1 } },
					{ kind: "word", key: "delete.detail.served", params: { count: 3 } },
					{ kind: "word", key: "delete.stat.freed", params: { bytes: "2.0KiB" } },
				],
			},
			{ path: "/gone.ts", status: "already-absent", detail: [] },
			{
				path: "/dir",
				status: "failed",
				detail: [],
				// The model's own message, verbatim (the error channel is the model's).
				error: "[E_NOT_FILE] Path is not a regular file.",
			},
		]);
	});

	it("puts the single path first in the collapsed summary (relativized + home)", () => {
		const model = deleteCardModel(
			block({
				delete: {
					results: [{ path: "/home/me/.scratch/delete-test-file.txt", status: "deleted" }],
					failures: [],
					totals: { deleted: 1, alreadyAbsent: 0, failed: 0 },
					reclaimed: { bytesFreed: 0 },
					vacuum: "none",
				},
			}),
			"/home/me",
			"/home/me",
		);
		expect(model?.summary).toEqual([
			{ kind: "literal", text: ".scratch/delete-test-file.txt" },
			{ kind: "word", key: "delete.stat.deleted", params: { count: 1 } },
			{ kind: "word", key: "delete.stat.absent", params: { count: 0 } },
			{ kind: "word", key: "delete.stat.failed", params: { count: 0 } },
		]);
		expect(model?.rows[0]?.path).toBe(".scratch/delete-test-file.txt");
	});

	it("returns null without a delete projection", () => {
		expect(deleteCardModel(block(undefined))).toBeNull();
		expect(deleteCardModel(block({ other: true }))).toBeNull();
	});

	it("renders its summary in the reader's language (#375)", () => {
		// The model layer owns the COUNTS and names the wording; the client
		// resolves the key. The rendered strings are the contract.
		const model = deleteCardModel(
			block({
				delete: {
					results: [{ path: "/a.ts", status: "deleted" }],
					failures: [],
					totals: { deleted: 1, alreadyAbsent: 1, failed: 1 },
					reclaimed: { bytesFreed: 2048 },
					vacuum: "none",
				},
			}),
		);
		const render = (dictionary: Record<string, string>): string =>
			(model?.summary ?? [])
				.map((part) =>
					part.kind === "literal"
						? part.text
						: (dictionary[part.key] ?? part.key).replace(
								/\{(\w+)\}/g,
								(_match, name: string) => String(part.params?.[name] ?? ""),
							),
				)
				.join(" · ");
		expect(render(EN_CARD_DICTIONARY)).toBe("/a.ts · 1 deleted · 1 already absent · 1 failed · 2.0KiB freed");
		expect(render(ZH_CARD_DICTIONARY)).toBe("/a.ts · 1 已删除 · 1 已不存在 · 1 失败 · 2.0KiB 已释放");
	});
});
