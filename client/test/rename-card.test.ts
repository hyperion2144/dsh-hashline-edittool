/**
 * The rename card's pure projection: `meta.rename` → title/summary/rows.
 * @module
 */
import { describe, expect, it } from "vitest";
import { renameCardModel } from "../src/client/models.js";
import { EN_CARD_DICTIONARY, ZH_CARD_DICTIONARY } from "../src/client/locale.js";

function block(meta: unknown) {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "rename", argsRaw: "{}" },
		callTime: 0,
		content: [],
		isError: false,
		meta,
		subCalls: [],
	} as never;
}

describe("renameCardModel", () => {
	it("projects pairs, failures, and the migrated family counts", () => {
		const model = renameCardModel(
			block({
				rename: {
					results: [
						{
							from: { path: "/a.ts" },
							to: { path: "/b.ts" },
							status: "renamed",
							migrated: {
								anchorLines: 2,
								undoLayers: 1,
								servedRows: 3,
								anchorMeta: 1,
								purged: { bytesFreed: 2048 },
							},
						},
					],
					failures: [
						{ path: "/c.ts", code: "E_NOT_FOUND", message: "File not found." },
					],
					totals: { renamed: 1, failed: 1 },
					migrated: { purgedBytes: 2048 },
					warnings: [],
				},
			}),
		);

		// issue 375: the summary and the migrated details are words + counts — the
		// model layer names the wording, the client renders it.
		expect(model?.summary).toEqual([
			{ kind: "word", key: "rename.count", params: { count: 2 } },
			{ kind: "word", key: "rename.stat.renamed", params: { count: 1 } },
			{ kind: "word", key: "rename.stat.failed", params: { count: 1 } },
			{ kind: "word", key: "rename.stat.reclaimed", params: { bytes: "2.0KiB" } },
		]);
		expect(model?.rows).toEqual([
			{
				from: "/a.ts",
				to: "/b.ts",
				status: "renamed",
				detail: [
					{ kind: "word", key: "rename.detail.anchors", params: { count: 2 } },
					{ kind: "word", key: "rename.detail.undo", params: { count: 1 } },
					{ kind: "word", key: "rename.detail.served", params: { count: 3 } },
					{ kind: "word", key: "rename.stat.reclaimed", params: { bytes: "2.0KiB" } },
				],
			},
			{
				from: "/c.ts",
				status: "failed",
				detail: [],
				// The model's own message, verbatim (the error channel is the model's).
				error: "[E_NOT_FOUND] File not found.",
			},
		]);
	});

	it("puts the single pair first in the collapsed summary (relativized + home)", () => {
		const model = renameCardModel(
			block({
				rename: {
					results: [
						{
							from: { path: "/home/me/.scratch/a.txt" },
							to: { path: "/home/me/.scratch/b.txt" },
							status: "renamed",
							migrated: {
								anchorLines: 0,
								undoLayers: 0,
								servedRows: 0,
								anchorMeta: 0,
								purged: { bytesFreed: 0 },
							},
						},
					],
					failures: [],
					totals: { renamed: 1, failed: 0 },
					warnings: [],
				},
			}),
			"/home/me",
			"/home/me",
		);
		expect(model?.summary).toEqual([
			{ kind: "literal", text: ".scratch/a.txt -> .scratch/b.txt" },
			{ kind: "word", key: "rename.stat.renamed", params: { count: 1 } },
			{ kind: "word", key: "rename.stat.failed", params: { count: 0 } },
		]);
		expect(model?.rows[0]?.from).toBe(".scratch/a.txt");
		expect(model?.rows[0]?.to).toBe(".scratch/b.txt");
	});

	it("returns null without a rename projection", () => {
		expect(renameCardModel(block(undefined))).toBeNull();
		expect(renameCardModel(block({ other: true }))).toBeNull();
	});

	it("renders its summary in the reader's language (issue 375)", () => {
		// The model layer owns the COUNTS and names the wording; the client
		// resolves the key. The rendered strings are the contract.
		const model = renameCardModel(
			block({
				rename: {
					results: [
						{
							from: { path: "/a.ts" },
							to: { path: "/b.ts" },
							status: "renamed",
							migrated: {
								anchorLines: 2,
								undoLayers: 1,
								servedRows: 3,
								anchorMeta: 1,
								purged: { bytesFreed: 2048 },
							},
						},
					],
					failures: [],
					totals: { renamed: 1, failed: 0 },
					migrated: { purgedBytes: 2048 },
					warnings: [],
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
		expect(render(EN_CARD_DICTIONARY)).toBe("/a.ts -> /b.ts · 1 renamed · 0 failed · 2.0KiB reclaimed");
		expect(render(ZH_CARD_DICTIONARY)).toBe("/a.ts -> /b.ts · 1 已重命名 · 0 失败 · 2.0KiB 已回收");
	});
});
