/**
 * The ripgrep pre-filter's contract.
 *
 * `rg --files-with-matches` answers "nothing matched" with exit code 1. Treating that
 * as a failure made the caller keep its whole candidate list, so a zero-hit grep — the
 * very case this pre-filter exists to make cheap — re-read the tree with the JS engine
 * and burned the scan's read budget instead. Exit 1 is an ANSWER now: the narrowed
 * list is empty, and nothing is read.
 *
 * The integration half runs the REAL rg (the plugin declares `@vscode/ripgrep`, the
 * same binary DSH's own search ships). When rg cannot be resolved in this environment
 * the function returns undefined by contract, and the test says so rather than
 * pretending: the fallback is the caller's business, not this seam's.
 *
 * @module
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { classifyRgExit, rgFilesWithMatches } from "../../src/tools/grep-rg.js";

describe("classifyRgExit", () => {
	it("reads exit 1 as 'nothing matched' — an answer, not a failure", () => {
		expect(classifyRgExit(null)).toBe("matched");
		expect(classifyRgExit(undefined)).toBe("matched");
		expect(classifyRgExit({ code: 1 })).toBe("no-match");
	});

	it("keeps every real failure a failure", () => {
		// 2 = rg's own error (a rejected pattern, an unreadable path).
		expect(classifyRgExit({ code: 2 })).toBe("failed");
		// A spawn error carries an errno string, never a number.
		expect(classifyRgExit({ code: "ENOENT" })).toBe("failed");
		expect(classifyRgExit({ code: null })).toBe("failed");
		expect(classifyRgExit({})).toBe("failed");
	});
});

describe("the pre-filter's own wiring", () => {
	it("ships ripgrep as a direct dependency, and the binary it resolves to is real", async () => {
		// The whole pre-filter hangs on this: `@vscode/ripgrep` is a DIRECT dependency
		// (so an install brings the platform binary), and resolution must land on a file
		// that exists. A silent miss here is what degraded every grep back to the JS
		// engine — it should fail loudly instead.
		const pkg = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(pkg.dependencies?.["@vscode/ripgrep"]).toBeTruthy();

		const dir = await mkdtemp(join(tmpdir(), "rg-dependency-"));
		try {
			const file = join(dir, "one.txt");
			await writeFile(file, "needle\n", "utf8");
			expect(await rgFilesWithMatches("needle", [file], 15_000)).toEqual([file]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("rgFilesWithMatches", () => {
	it("narrows to the matching files, and answers [] when nothing matches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rg-prefilter-"));
		try {
			const hit = join(dir, "hit.txt");
			const miss = join(dir, "miss.txt");
			await writeFile(hit, "alpha\nneedle\nomega\n", "utf8");
			await writeFile(miss, "alpha\nbeta\nomega\n", "utf8");

			const matched = await rgFilesWithMatches("needle", [hit, miss], 15_000);
			if (matched === undefined) {
				// No rg in this environment: the contract is "undefined, caller keeps its
				// list". Nothing to assert about narrowing — say so instead of passing
				// vacuously.
				expect(matched).toBeUndefined();
				return;
			}
			expect(matched).toEqual([hit]);

			// THE regression: a miss is an EMPTY narrowing, never undefined. Returning
			// undefined here is what made a zero-hit grep read the whole tree.
			expect(await rgFilesWithMatches("no-such-string-anywhere-198", [hit, miss], 15_000)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("sizes each invocation by command-line length, never by file count (#260)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rg-argv-"));
		try {
			const hit = join(dir, "hit.txt");
			await writeFile(hit, "needle\n", "utf8");
			if ((await rgFilesWithMatches("needle", [hit], 15_000)) === undefined) {
				// No rg here: this seam's contract is "undefined, caller keeps its list",
				// which is the same answer this test expects for its own reason. The
				// positive half lives in grep-rg-argv-limit.test.ts.
				return;
			}

			// 400 paths of ~6.3K chars ≈ 2.5 MB of argv — past macOS' 1 MiB `ARG_MAX`,
			// Linux' 2 MiB, and Windows' 32,767-char command line alike. The count-based
			// chunker put all 400 on ONE command line and `execFile` threw `spawn E2BIG`
			// synchronously, so the rejection surfaced to the model as a tool error.
			// Length-based chunking keeps every invocation inside the budget: rg runs,
			// and paths that do not exist are a FAILURE (exit 2) — undefined, and the
			// caller keeps its full list.
			const huge = Array.from(
				{ length: 400 },
				(_unused, index) => `${dir}/${"d".repeat(6_200)}-miss-${index}.ts`,
			);
			await expect(rgFilesWithMatches("needle", huge, 15_000)).resolves.toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
