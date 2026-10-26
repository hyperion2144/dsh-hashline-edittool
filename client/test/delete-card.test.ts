/**
 * The delete card's pure projection: `meta.delete` → title/summary/rows.
 * @module
 */
import { describe, expect, it } from "vitest";
import { deleteCardModel } from "../src/client/models.js";

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

		expect(model?.title).toBe("Delete");
		expect(model?.summary).toBe("3 paths · 1 deleted · 1 already absent · 1 failed · 2.0KiB freed");
		expect(model?.rows).toEqual([
			{ path: "/a.ts", status: "deleted", detail: "2 anchors · 1 undo · 3 served · 2.0KiB freed" },
			{ path: "/gone.ts", status: "already-absent", detail: "" },
			{ path: "/dir", status: "failed", detail: "[E_NOT_FILE] Path is not a regular file." },
		]);
		expect(model?.vacuum).toBe("pending");
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
		expect(model?.title).toBe("Delete");
		expect(model?.summary).toBe(".scratch/delete-test-file.txt · 1 deleted · 0 already absent · 0 failed");
		expect(model?.rows[0]?.path).toBe(".scratch/delete-test-file.txt");
	});

	it("returns null without a delete projection", () => {
		expect(deleteCardModel(block(undefined))).toBeNull();
		expect(deleteCardModel(block({ other: true }))).toBeNull();
	});
});
