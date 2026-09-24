/**
 * Integration tests for the `grep` memory budget (issue #167).
 *
 * The unit tests in `grep-read-budget.test.ts` pin the arithmetic; these pin
 * the behaviour that matters to a caller — a tree containing a file far larger
 * than the per-file ceiling must still produce a usable, HONEST result instead
 * of reading the file and taking the host heap with it.
 *
 * A sparse file makes this cheap: `truncate` gives it a real multi-megabyte
 * size while occupying no blocks, so the ceiling is exercised without writing
 * megabytes in the test.
 */
import { describe, expect, it } from "vitest";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GREP_MAX_FILE_BYTES, GREP_MAX_TOTAL_BYTES } from "../../src/infra/constants.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

describe("grep memory budget — oversized files (issue #167)", () => {
	it("SEARCHES a file past the old per-file ceiling — sparse lazy anchors (#169)", async () => {
		await withTempDir("grep-budget-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			await writeFile(join(cwd, "normal.txt"), "needle in a normal file\n");
			// Past the OLD per-file ceiling: with lazy anchors a big file costs only
			// its RETURNED rows, so the hard skip is gone and the file IS searched.
			const huge = join(cwd, "huge.log");
			await writeFile(huge, "needle at the head\n");
			await truncate(huge, GREP_MAX_FILE_BYTES + 1);

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle",
			});
			const out = getText(res);

			// Both files are searched: the big one is no longer skipped.
			expect(out).toContain("normal.txt");
			expect(out).toContain("needle in a normal file");
			expect(out).toContain("huge.log");
			expect(out).toContain("needle at the head");
			// No skip notice: nothing was refused.
			expect(out).not.toContain("[grep budget]");
		});
	});

	it("stops at the TOTAL budget with an honest notice, not a lying empty", async () => {
		await withTempDir("grep-budget-only-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			// The TOTAL budget is the remaining ceiling: a tree whose sum exceeds
			// it stops exhausted, and the notice says so.
			await writeFile(join(cwd, "a.log"), "needle one\n");
			for (let i = 0; i < 3; i++) {
				const huge = join(cwd, `fill-${i}.log`);
				await writeFile(huge, "filler\n");
				await truncate(huge, Math.ceil(GREP_MAX_TOTAL_BYTES / 2));
			}

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle",
			});
			const out = getText(res);

			expect(out).toContain("[grep budget]");
			expect(out).toContain("total read budget");
		});
	});

	it("leaves an ordinary tree untouched — no notice when nothing is refused", async () => {
		await withTempDir("grep-budget-clean-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			await writeFile(join(cwd, "a.txt"), "needle here\n");
			await writeFile(join(cwd, "b.txt"), "nothing\n");

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle",
			});
			const out = getText(res);

			expect(out).toContain("a.txt");
			expect(out).not.toContain("[grep budget]");
		});
	});
});
