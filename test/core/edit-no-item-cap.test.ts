/**
 * The per-call cap on the `edits` array is gone (#380).
 *
 * The pre-0.4 `batch_edit` capped a batch at 32 because a batch rewrote the
 * file wholesale. An `edit` addresses each line on its own, so the count
 * carries no resource or consistency risk — only the cost of splitting one
 * change across several calls, each of which has to re-read the file first.
 *
 * These tests pin that shape: a batch longer than the old cap is accepted,
 * and every edit in it is applied.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { assertEditRequest } from "../../src/contract/contract.js";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";

/** The cap that used to exist — the number this test deliberately exceeds. */
const OLD_CAP = 32;

describe("the edit batch has no length cap (#380)", () => {
	it("accepts a request with more edits than the old cap", () => {
		const edits = Array.from({ length: OLD_CAP + 1 }, (_, index) => ({
			op: "replace" as const,
			anchor_start: "aB",
			anchor_end: "aB",
			lines: [`line ${index}`],
		}));
		expect(() => assertEditRequest({ path: "big.txt", edits }, false)).not.toThrow();
	});

	it("applies every edit of a batch longer than the old cap", async () => {
		const lines = Array.from({ length: OLD_CAP + 8 }, (_, index) => `line ${index}`);
		await withTempFile("big.txt", `${lines.join("\n")}\n`, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const read = await harness.readTool.execute("read", { path: "big.txt" });
			const anchors = (getText(read) as string)
				.split("\n")
				.filter((line) => /^[A-Za-z0-9]{2,8}:/.test(line) && !line.startsWith("ANCHOR:"))
				.map((line) => line.slice(0, line.indexOf(":")));
			expect(anchors.length).toBe(lines.length);

			const edits = anchors.map((anchor, index) => ({
				op: "replace" as const,
				anchor_start: anchor,
				anchor_end: anchor,
				lines: [`edited ${index}`],
			}));
			expect(edits.length).toBeGreaterThan(OLD_CAP);

			const res = await harness.editTool.execute("edit", { path: "big.txt", edits });
			expect(getText(res)).toContain("Successfully edited in big.txt.");
			const written = await readFile(path, "utf-8");
			expect(written).toBe(`${lines.map((_, index) => `edited ${index}`).join("\n")}\n`);
		});
	});
});
