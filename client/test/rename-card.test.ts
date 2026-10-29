/**
 * The rename card's pure projection: `meta.rename` → title/summary/rows.
 * @module
 */
import { describe, expect, it } from "vitest";
import { renameCardModel } from "../src/client/models.js";

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
					warnings: [],
				},
			}),
		);

		expect(model?.title).toBe("Rename");
		expect(model?.summary).toBe("/a.ts -> /b.ts, /c.ts · 1 renamed · 1 failed");
		expect(model?.rows).toEqual([
			{
				from: "/a.ts",
				to: "/b.ts",
				status: "renamed",
				detail: "2 anchors · 1 undo · 3 served · 2.0KiB reclaimed",
			},
			{ from: "/c.ts", status: "failed", detail: "[E_NOT_FOUND] File not found." },
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
		expect(model?.summary).toBe(".scratch/a.txt -> .scratch/b.txt · 1 renamed · 0 failed");
		expect(model?.rows[0]?.from).toBe(".scratch/a.txt");
		expect(model?.rows[0]?.to).toBe(".scratch/b.txt");
	});

	it("returns null without a rename projection", () => {
		expect(renameCardModel(block(undefined))).toBeNull();
		expect(renameCardModel(block({ other: true }))).toBeNull();
	});
});
