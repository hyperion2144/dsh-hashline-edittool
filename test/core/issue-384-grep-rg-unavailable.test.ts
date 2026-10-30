/**
 * #384 — the DEGRADED path: when ripgrep cannot answer, `grep` still answers.
 *
 * ripgrep is the engine (#384), but the plugin's own line matcher survives as the
 * fallback for the one case the engine cannot cover: ripgrep did not answer at
 * all — its binary is missing, or it rejected the pattern (a JS-only look-around
 * is not ripgrep syntax).
 *
 * The engine module is mocked here, so the seam is exercised without a missing
 * binary on the machine: `rgSearchMatches` is replaced, while `rgFiles` (the
 * candidate list) keeps its real implementation — the tool still needs a file
 * list to search.
 *
 * @module dsh-hashline-edittool/issue-384-grep-rg-unavailable.test
 */
import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RgSearchOutcome } from "../../src/tools/grep-rg.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

const engine = vi.hoisted(() => ({
	outcome: { kind: "unavailable" } as RgSearchOutcome,
}));

vi.mock("../../src/tools/grep-rg.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/tools/grep-rg.js")>();
	return {
		...actual,
		rgSearchMatches: vi.fn(async () => engine.outcome),
	};
});

type GrepTool = {
	execute: (
		_id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

async function runGrep(
	cwd: string,
	params: Record<string, unknown>,
): Promise<string> {
	const harness = setupIntegrationTest(cwd);
	const tool = harness.getTool("grep") as unknown as GrepTool;
	return getText(await tool.execute("g", params));
};

describe("#384 — the degraded path, when ripgrep cannot answer", () => {
	it("answers from the plugin's own matcher when ripgrep is unavailable", async () => {
		engine.outcome = { kind: "unavailable" };
		await withTempDir("grep-384-unavailable-", async (cwd) => {
			await writeFile(join(cwd, "hit.txt"), "alpha\nneedle in a file\n");
			await writeFile(join(cwd, "miss.txt"), "alpha\nbeta\n");

			const out = await runGrep(cwd, { path: ".", pattern: "needle", regex: false });

			expect(out).not.toContain("No matches");
			expect(out).toContain("hit.txt");
			expect(out).toContain("needle in a file");
			expect(out).not.toContain("miss.txt");
		});
	});

	it("reports a pattern ripgrep rejects as a bad pattern", async () => {
		engine.outcome = { kind: "invalid-pattern", message: "look-around is not supported" };
		await withTempDir("grep-384-invalid-", async (cwd) => {
			await writeFile(join(cwd, "hit.txt"), "alpha\nneedle in a file\n");

			// ripgrep's engine is the engine: a pattern it rejects is a bad
			// pattern, the way the official grep tool answers
			// SEARCH_INVALID_PATTERN. The plugin does NOT answer it with another
			// engine's idea of what the pattern means.
			const out = await runGrep(cwd, { path: ".", pattern: "(?=needle)" });

			expect(out).toContain("E_BAD_SHAPE");
			expect(out).toContain("rejected by ripgrep");
		});
	});
});
