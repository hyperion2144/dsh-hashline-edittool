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
import { GREP_MAX_FILE_BYTES } from "../../src/infra/constants.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

describe("grep memory budget — oversized files (issue #167)", () => {
	it("skips a file past the per-file ceiling and still answers for the rest", async () => {
		await withTempDir("grep-budget-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			await writeFile(join(cwd, "normal.txt"), "needle in a normal file\n");
			// One byte past the ceiling: the file must never be read.
			const huge = join(cwd, "huge.log");
			await writeFile(huge, "needle\n");
			await truncate(huge, GREP_MAX_FILE_BYTES + 1);

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle",
			});
			const out = getText(res);

			// The readable file is still searched and served.
			expect(out).toContain("normal.txt");
			expect(out).toContain("needle in a normal file");
			// The oversized one is not read, and the caller is told why.
			expect(out).not.toContain("huge.log" + ":");
			expect(out).toContain("huge.log");
			expect(out).toContain("[grep budget]");
		});
	});

	it("reports a search with NO readable hits as budget-limited, not as empty", async () => {
		await withTempDir("grep-budget-only-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			const huge = join(cwd, "only.log");
			await writeFile(huge, "needle\n");
			await truncate(huge, GREP_MAX_FILE_BYTES + 1);

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle",
			});
			const out = getText(res);

			// "No matches" would be a lie: the only candidate was never searched.
			expect(out).toContain("[grep budget]");
			expect(out).toContain("only.log");
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
