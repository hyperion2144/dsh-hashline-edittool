/**
 * `grep` lets ripgrep walk the path, so the tree's ignore rules decide what is
 * searchable at all (#414). Three ends are pinned here:
 *
 * - a `.gitignore`d build tree is not searched by default (the OOM's own case);
 * - the setting `grep_respect_gitignore: false` widens the search on purpose;
 * - a path named UNDER an ancestor's ignored directory still finds its hits —
 *   the first search honours the ancestor's rule, the 0-hit retry does not.
 *
 * @module dsh-hashline-edittool/test-grep-gitignore
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

const grep = (harness: ReturnType<typeof setupIntegrationTest>): GrepTool =>
	harness.getTool("grep") as unknown as GrepTool;

/** One source file, one `.gitignore`d build tree, in a CHECKOUT (rg needs the `.git`). */
async function fixture(cwd: string): Promise<void> {
	await mkdir(join(cwd, ".git"), { recursive: true });
	await writeFile(join(cwd, ".gitignore"), "build/\n", "utf8");
	await writeFile(join(cwd, "keep.txt"), "needle in source\n", "utf8");
	await mkdir(join(cwd, "build"), { recursive: true });
	await writeFile(join(cwd, "build", "out.txt"), "needle in build\n", "utf8");
}

afterEach(() => {
	applyEffective({});
});

describe("grep — the ignore rules decide what is searched (#414)", () => {
	it("does not search a .gitignore'd build tree by default", async () => {
		await withTempDir("grep-ignored-", async (cwd) => {
			await fixture(cwd);
			const harness = setupIntegrationTest(cwd);
			const text = getText(await grep(harness).execute("1", { pattern: "needle" }));
			expect(text).toContain("keep.txt");
			// Path separators differ on Windows; assert on the file name only.
			expect(text).not.toContain("out.txt");
		});
	});

	it("searches it when the setting turns the rules off", async () => {
		applyEffective({ grep_respect_gitignore: false });
		await withTempDir("grep-ignored-off-", async (cwd) => {
			await fixture(cwd);
			const harness = setupIntegrationTest(cwd);
			const text = getText(await grep(harness).execute("1", { pattern: "needle" }));
			expect(text).toContain("out.txt");
		});
	});

	it("does not walk a named path's ignored ancestor by default (#414)", async () => {
		await withTempDir("grep-parent-ignore-", async (cwd) => {
			// The tree that OOM'd: the rule lives in the PARENT repo root, the named
			// path has no ignore file of its own.
			await mkdir(join(cwd, ".git"), { recursive: true });
			await writeFile(join(cwd, ".gitignore"), "src-tauri/target/\n", "utf8");
			await mkdir(join(cwd, "src-tauri", "target"), { recursive: true });
			await writeFile(join(cwd, "src-tauri", "main.rs"), "needle in source\n", "utf8");
			await writeFile(join(cwd, "src-tauri", "target", "out.txt"), "needle in target\n", "utf8");

			const harness = setupIntegrationTest(cwd);
			const text = getText(await grep(harness).execute("1", { pattern: "needle", path: "src-tauri" }));
			expect(text).toContain("main.rs");
			expect(text).not.toContain("out.txt");
		});
	});

	it("retries wide when the named path is entirely ignored (#414 Q3)", async () => {
		await withTempDir("grep-parent-ignore-only-", async (cwd) => {
			await mkdir(join(cwd, ".git"), { recursive: true });
			await writeFile(join(cwd, ".gitignore"), "target/\n", "utf8");
			await mkdir(join(cwd, "target"), { recursive: true });
			await writeFile(join(cwd, "target", "out.txt"), "needle in target\n", "utf8");

			const harness = setupIntegrationTest(cwd);
			const text = getText(await grep(harness).execute("1", { pattern: "needle", path: "target" }));
			expect(text).toContain("out.txt");
		});
	});
});
