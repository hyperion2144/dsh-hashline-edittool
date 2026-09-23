import { describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { getText, withTempFile, setupIntegrationTest } from "../support/fixtures.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { matchInclude } from "../../src/infra/file-scan.js";

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
			// The product derives this path with the platform's relative-path
			// function, so the expectation has to be derived the same way — a
			// hardcoded "src/deep.txt" only ever matched where the separator is `/`.
			expect(out).toContain(join("src", "deep.txt"));
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
			).resolves.toMatchObject({ content: [{ type: "text", text: expect.stringMatching(/positive glob/) }] });
		});
	});

	it("defaults path to the session workspace", async () => {
		await withTempFile("t.txt", "workspace needle\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const res = await grepTool(harness).execute("g", { pattern: "workspace needle" });
			expect(getText(res)).toContain("t.txt");
		});
	});

	it("json mode reports recursive matches per file, keyed by anchor", async () => {
		await withTempFile("t.txt", "x\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			await mkdir(join(cwd, "sub"));
			await writeFile(join(cwd, "sub", "hit.txt"), "json needle\n");
			applyEffective({ output_format: "json" });
			const res = await grepTool(harness).execute("g", { path: ".", pattern: "json needle" });
			const out = JSON.parse(getText(res)) as {
				files: Array<{ path: string; matches: Record<string, string> }>;
			};
			// Same rule as the text case above: derive the path the way the product
			// does. The old name on this test blamed a `grep` JSON source bug
			// ("matches dict values come back undefined") — that assertion passes,
			// while THIS line only ever held where the separator is `/`.
			expect(out.files[0]!.path).toContain(join("sub", "hit.txt"));
			expect(Object.values(out.files[0]!.matches)[0]).toBe("json needle");
			applyEffective({});
		});
	});
});

describe("matchInclude — one separator space", () => {
	it("matches a Windows-shaped relative path", () => {
		// `relative()` yields backslashes on Windows. The basename split needs a
		// separator to find, and minimatch is a POSIX-glob matcher — without
		// normalising first, `*.ts` matched NOTHING below the root on Windows,
		// silently (the E2E case above only caught it on a Windows runner).
		expect(matchInclude("*.ts", "a\\one.ts")).toBe(true);
		expect(matchInclude("*.ts", "a\\b\\deep.ts")).toBe(true);
		expect(matchInclude("*.js", "a\\one.ts")).toBe(false);
		// A pattern WITH a slash compares the root-relative path — same space.
		expect(matchInclude("a/*.ts", "a\\one.ts")).toBe(true);
		expect(matchInclude("b/*.ts", "a\\one.ts")).toBe(false);
		// POSIX paths keep behaving exactly as before.
		expect(matchInclude("*.ts", "a/one.ts")).toBe(true);
		expect(matchInclude("*.ts", "a/b/deep.ts")).toBe(true);
		expect(matchInclude("a/*.ts", "a/one.ts")).toBe(true);
	});
});