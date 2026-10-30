/**
 * #384 — the literal-mode false negative, and the pipeline it belongs to.
 *
 * The bug: `grep` with `regex: false` (literal substring) over a DIRECTORY
 * answered "No matches" for every pattern, hit or not. The pre-filter handed
 * the literal pattern to ripgrep as `-F<pattern>`, while ripgrep's argv was
 * `["--no-config", "--files-with-matches", "-e", pattern]` — so ripgrep searched
 * for the TEXT "-F<pattern>", never found it, exited 1, and the caller read that
 * exit code as the final answer: an empty candidate list, and no search at all.
 *
 * The fix puts ripgrep back where the original requirement put it — the ENGINE.
 * The official DSH grep (packages/fs/tool-fs-search) runs `rg --json` and reads
 * the match records it produces; the pattern therefore reaches ripgrep as one
 * `--regexp=` argument, and a literal pattern as `--fixed-strings` — never glued
 * to the pattern text.
 *
 * This file pins the reproduction matrix the ticket asks for: literal mode over
 * several files (the false negative itself), literal mode over one file, regex
 * mode over several files, a literal that LOOKS like a regex, and a non-ASCII
 * literal.
 *
 * @module dsh-hashline-edittool/issue-384-grep-repro.test
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

type GrepTool = {
	execute: (
		_id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

/** Run the real `grep` tool over a temp workspace and return its model text. */
async function runGrep(
	cwd: string,
	params: Record<string, unknown>,
): Promise<string> {
	const harness = setupIntegrationTest(cwd);
	const tool = harness.getTool("grep") as unknown as GrepTool;
	return getText(await tool.execute("g", params));
}

describe("#384 — literal mode over a directory", () => {
	it("finds the hit instead of answering 'No matches' (#384)", async () => {
		await withTempDir("grep-384-literal-", async (cwd) => {
			// Two candidates, so the pre-filter actually ran: with ONE file the
			// pre-filter was skipped and the JS engine answered correctly — which is
			// exactly why the bug looked intermittent.
			await writeFile(join(cwd, "hit.txt"), "alpha\nneedle in a file\nomega\n");
			await writeFile(join(cwd, "miss.txt"), "alpha\nbeta\nomega\n");

			const out = await runGrep(cwd, { path: ".", pattern: "needle", regex: false });

			expect(out).not.toContain("No matches");
			expect(out).toContain("hit.txt");
			expect(out).toContain("needle in a file");
			// The file that does NOT carry the pattern stays out of the answer.
			expect(out).not.toContain("miss.txt");
		});
	});

	it("finds the hit for a single file too", async () => {
		await withTempDir("grep-384-single-", async (cwd) => {
			await writeFile(join(cwd, "only.txt"), "alpha\nneedle alone\n");

			const out = await runGrep(cwd, { path: "only.txt", pattern: "needle", regex: false });

			expect(out).not.toContain("No matches");
			expect(out).toContain("only.txt");
			expect(out).toContain("needle alone");
		});
	});

	it("keeps regex mode working over the same tree", async () => {
		await withTempDir("grep-384-regex-", async (cwd) => {
			await writeFile(join(cwd, "hit.txt"), "alpha\nneedle in a file\n");
			await writeFile(join(cwd, "miss.txt"), "alpha\nbeta\n");

			const out = await runGrep(cwd, { path: ".", pattern: "need[a-z]+" });

			expect(out).not.toContain("No matches");
			expect(out).toContain("hit.txt");
			expect(out).toContain("needle in a file");
		});
	});

	it("a literal pattern that looks like a regex matches LITERALLY (#384)", async () => {
		await withTempDir("grep-384-dots-", async (cwd) => {
			// The literal "a.b" must match the file that carries "a.b" — and NOT the
			// one carrying "axb", which is what a regex reading would have matched.
			await writeFile(join(cwd, "dot.txt"), "value a.b here\n");
			await writeFile(join(cwd, "wild.txt"), "value axb here\n");

			const out = await runGrep(cwd, { path: ".", pattern: "a.b", regex: false });

			expect(out).toContain("dot.txt");
			expect(out).not.toContain("wild.txt");
		});
	});

	it("a non-ASCII literal pattern matches (#384)", async () => {
		await withTempDir("grep-384-cjk-", async (cwd) => {
			await writeFile(join(cwd, "cjk.txt"), "前缀\n需要找到的一行\n后缀\n");
			await writeFile(join(cwd, "other.txt"), "无关\n");

			const out = await runGrep(cwd, { path: ".", pattern: "需要找到的一行", regex: false });

			expect(out).not.toContain("No matches");
			expect(out).toContain("cjk.txt");
			expect(out).toContain("需要找到的一行");
		});
	});

	it("places a bare-CR file's hits even for a pattern only ripgrep accepts", async () => {
		await withTempDir("grep-384-barecr-rg-only-", async (cwd) => {
			// `(?i)` is ripgrep syntax JavaScript has no matcher for, so the hit
			// comes from ripgrep alone — and its OFFSET inside the line says which
			// line of the read line space it is on (#147).
			await writeFile(join(cwd, "bare.txt"), "alpha\rNEEDLE here\rbeta\n");

			const out = await runGrep(cwd, { path: ".", pattern: "(?i)needle" });

			expect(out).not.toContain("No matches");
			expect(out).toContain("bare.txt");
			expect(out).toContain("NEEDLE here");
		});
	});

	it("a bare-CR file is matched in the READ line space, not ripgrep's (#147)", async () => {
		await withTempDir("grep-384-barecr-", async (cwd) => {
			// The read line space folds a bare CR to LF (ADR-0008); ripgrep counts
			// LF only, so its line numbers drift on this file. The hit's offset
			// inside the line says which line of the read space it is on.
			await writeFile(join(cwd, "bare.txt"), "alpha\rneedle in a file\rbeta\n");

			const out = await runGrep(cwd, { path: ".", pattern: "needle", regex: false });

			expect(out).not.toContain("No matches");
			expect(out).toContain("bare.txt");
			expect(out).toContain("needle in a file");
		});
	});
});
