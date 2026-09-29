/**
 * `grep` builds its candidate list with ripgrep by default, so `.gitignore` decides
 * what is searchable at all — the fix for a repo whose build output filled the 64 MiB
 * read budget before the scan ever reached the source it was asked about.
 *
 * The switch (`grep_respect_gitignore`) turns that off, and rg being unavailable is
 * the documented fallback: the plugin's own walk, which skips hidden entries and
 * `node_modules` and consults no ignore file. Both ends are pinned here rather than
 * assumed, because "rg missing" is a real state on a user's machine.
 *
 * @module
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { rgFiles } from "../../src/tools/grep-rg.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

const grep = (harness: ReturnType<typeof setupIntegrationTest>): GrepTool =>
	harness.getTool("grep") as unknown as GrepTool;

/** One source file, one `.gitignore`d build tree, one nested `node_modules`. */
async function fixture(cwd: string): Promise<void> {
	await writeFile(join(cwd, ".gitignore"), "build/\n", "utf8");
	await writeFile(join(cwd, "keep.txt"), "needle in source\n", "utf8");
	await mkdir(join(cwd, "build"), { recursive: true });
	await writeFile(join(cwd, "build", "out.txt"), "needle in build\n", "utf8");
	await mkdir(join(cwd, "sub", "node_modules"), { recursive: true });
	await writeFile(join(cwd, "sub", "node_modules", "dep.txt"), "needle in dep\n", "utf8");
}

afterEach(() => {
	applyEffective({});
});

describe("grep — the candidate list respects .gitignore", () => {
	it("skips ignored trees by default, and searches them when the switch is off", async () => {
		await withTempDir("grep-ignore-", async (cwd) => {
			await fixture(cwd);
			const harness = setupIntegrationTest(cwd);

			// Whether rg can run HERE decides which contract is in force, so assert the
			// one that actually applies instead of pretending the other.
			const canUseRg = (await rgFiles(cwd)) !== undefined;

			const on = getText(await grep(harness).execute("g", { path: ".", pattern: "needle" }));
			expect(on).toContain("keep.txt");
			// node_modules is skipped on BOTH paths: the walk skips the name, rg gets the
			// matching `--glob` exclusion.
			expect(on).not.toContain(join("sub", "node_modules", "dep.txt"));
			if (canUseRg) {
				expect(on).not.toContain(join("build", "out.txt"));
			}

			applyEffective({ grep_respect_gitignore: false });
			const off = getText(await grep(harness).execute("g", { path: ".", pattern: "needle" }));
			expect(off).toContain("keep.txt");
			expect(off).not.toContain(join("sub", "node_modules", "dep.txt"));
			// The plugin's own walk consults no ignore file — the documented meaning of
			// switching this off.
			expect(off).toContain(join("build", "out.txt"));
		});
	});

	it("the listing itself is ignore-aware, and returns absolute paths", async () => {
		await withTempDir("grep-ignore-list-", async (cwd) => {
			await fixture(cwd);
			const listed = await rgFiles(cwd);
			if (listed === undefined) return; // no rg here — the tool falls back by contract
			expect(listed).toContain(join(cwd, "keep.txt"));
			expect(listed).not.toContain(join(cwd, "build", "out.txt"));
			expect(listed).not.toContain(join(cwd, "sub", "node_modules", "dep.txt"));
			expect(listed.every((p) => p.startsWith(cwd))).toBe(true);
		});
	});
});
