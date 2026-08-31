import { describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { getText, withTempFile, setupIntegrationTest } from "../support/fixtures.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type GrepTool = {
	execute: (
		_id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

function grepTool(h: ReturnType<typeof setupIntegrationTest>): GrepTool {
	return h.getTool("grep") as unknown as GrepTool;
}

describe("grep recursion + include + default path (host-aligned)", () => {
	it("recurses the whole tree and matches in subdirectories", async () => {
		await withTempFile("t.txt", "root line\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			await mkdir(join(cwd, "src"));
			await writeFile(join(cwd, "src", "deep.txt"), "needle in a stack\n");
			await writeFile(join(cwd, "src", "deep2.ts"), "no hit here\n");
			const res = await grepTool(harness).execute("g", { path: ".", pattern: "needle" });
			const out = getText(res);
			expect(out).toContain("src/deep.txt");
			expect(out).not.toContain("deep2.ts");
			expect(out).toContain("needle");
		});
	});

	it("skips hidden entries and node_modules while recursing", async () => {
		await withTempFile("t.txt", "x\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			await mkdir(join(cwd, "node_modules"));
			await writeFile(join(cwd, "node_modules", "hit.js"), "needle\n");
			await mkdir(join(cwd, ".hidden"));
			await writeFile(join(cwd, ".hidden", "hit.txt"), "needle again\n");
			await writeFile(join(cwd, "visible.txt"), "needle visible\n");
			const res = await grepTool(harness).execute("g", { path: ".", pattern: "needle" });
			const out = getText(res);
			expect(out).not.toContain("node_modules");
			expect(out).not.toContain(".hidden");
			expect(out).toContain("visible.txt");
		});
	});

	it("include filters files by basename glob at any depth", async () => {
		await withTempFile("t.txt", "x\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			await mkdir(join(cwd, "a"));
			await writeFile(join(cwd, "a", "one.ts"), "needle\n");
			await writeFile(join(cwd, "a", "two.js"), "needle\n");
			const res = await grepTool(harness).execute("g", {
				path: ".",
				pattern: "needle",
				include: "*.ts",
			});
			const out = getText(res);
			expect(out).toContain("one.ts");
			expect(out).not.toContain("two.js");
		});
	});

	it("rejects negated include patterns", async () => {
		await withTempFile("t.txt", "x\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			await expect(
				grepTool(harness).execute("g", {
					path: ".",
					pattern: "needle",
					include: "!*.ts",
				}),
			).rejects.toThrow(/positive glob/);
		});
	});

	it("defaults path to the session workspace", async () => {
		await withTempFile("t.txt", "workspace needle\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const res = await grepTool(harness).execute("g", { pattern: "workspace needle" });
			expect(getText(res)).toContain("t.txt");
		});
	});

	it("json mode reports recursive matches per file — SRC BUG: grep-json matches dict values come back undefined (same root as line-count-contract grep-json); needs src check", async () => {
		await withTempFile("t.txt", "x\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			await mkdir(join(cwd, "sub"));
			await writeFile(join(cwd, "sub", "hit.txt"), "json needle\n");
			applyEffective({ output_format: "json" });
			const res = await grepTool(harness).execute("g", { path: ".", pattern: "json needle" });
			const out = JSON.parse(getText(res)) as {
				files: Array<{ path: string; matches: Record<string, string> }>;
			};
			expect(out.files[0]!.path).toContain("sub/hit.txt");
			expect(Object.values(out.files[0]!.matches)[0]).toBe("json needle");
			applyEffective({});
		});
	});
});