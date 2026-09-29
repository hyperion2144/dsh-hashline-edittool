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
import { GREP_MAX_TOTAL_BYTES } from "../../src/infra/constants.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";
import { rgFilesWithMatches } from "../../src/tools/grep-rg.js";

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
			// Past the per-file ceiling grep USED to have (#169 removed the skip). TEXT, not
			// a sparse hole: ripgrep classifies a NUL-filled file as binary and drops it from
			// the candidate list, which would skip the read this case is about.
			const huge = join(cwd, "huge.log");
			await writeFile(huge, `needle at the head\n${"filler line\n".repeat(400_000)}`);

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
			// Every file MATCHES, so the ripgrep pre-filter keeps them all and the READS
			// are what exceed the ceiling: the scan stops exhausted and says so. (Files
			// that do not match no longer reach the read stage at all — see the sibling
			// test below, which is the reported shape.)
			// Matching AND genuinely large, so the READS are what hits the ceiling. Text, not
			// sparse holes: ripgrep skips a NUL-filled file as binary, and the budget would
			// never be touched (that is the pre-filter working — just not this case).
			// One enormous LINE per file: it matches (so ripgrep keeps it) and the read still
			// costs the budget, while the rendered match stays a single "line exceeds …;
			// content not shown" row — so the honest notice is not pushed past the
			// model-text cap. Text, not a sparse hole: ripgrep skips a NUL-filled file as
			// binary and the budget would never be touched.
			for (let i = 0; i < 2; i++) {
				// 36 MB each: the ceiling is 64 MiB (67.1 MB), so the second read is what
				// overshoots it — two 33 MB files would have fit and proved nothing.
				await writeFile(join(cwd, `hit-${i}.log`), `needle ${"x".repeat(36_000_000)}`);
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

	it("huge files that do NOT match cost nothing — the pre-filter keeps them unread", async () => {
		// The reported shape: a tree full of build output the pattern cannot match. The
		// JS engine used to read all of it and stop at the budget; ripgrep answers first,
		// so the scan reads only the hits — here, none.
		await withTempDir("grep-prefilter-skip-", async (cwd) => {
			const harness = setupIntegrationTest(cwd);
			await writeFile(join(cwd, "a.txt"), "nothing to see\n");
			const aTxt = join(cwd, "a.txt");
			for (let i = 0; i < 3; i++) {
				const huge = join(cwd, `fill-${i}.log`);
				await writeFile(huge, "filler\n");
				await truncate(huge, Math.ceil(GREP_MAX_TOTAL_BYTES / 2));
			}

			// Without rg the JS engine reads everything by contract — and the budget
			// notice is then the CORRECT answer, so this case is only meaningful with rg.
			if ((await rgFilesWithMatches("needle-not-anywhere-198", [aTxt], 15_000)) === undefined) return;

			const res = await (harness.getTool("grep") as unknown as GrepTool).execute("g", {
				path: ".",
				pattern: "needle-not-anywhere-198",
			});
			const out = getText(res);

			expect(out).toContain("No matches");
			expect(out).not.toContain("[grep budget]");
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
