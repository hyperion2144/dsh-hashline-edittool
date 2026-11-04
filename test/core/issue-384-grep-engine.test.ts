/**
 * #384 / #414 — the engine seam: ONE ripgrep invocation over a path, with the
 * pipeline's bounds applied where the rows are produced.
 *
 * What the engine owns now: the argv (no file list, no chunking, no `--text`),
 * the raw-output ceiling, the per-row preview cap, and the rule that a failure
 * is a FAILURE — there is no second engine to fall back to (#414 Q2).
 *
 * @module dsh-hashline-edittool/issue-384-grep-engine.test
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildGrepArgv,
	runGrep,
	GREP_MAX_LINE_BYTES,
	RAW_OUTPUT_MAX_BYTES,
	type GrepSearchOptions,
} from "../../src/tools/grep-rg.js";
import { withTempDir } from "../support/fixtures.js";

/** The options a test's search starts from. */
function options(path: string, overrides: Partial<GrepSearchOptions> = {}): GrepSearchOptions {
	return { pattern: "needle", literal: true, path, context: 0, ...overrides };
}

describe("the engine's argv (#414)", () => {
	it("is ONE invocation: flags first, the path last", () => {
		const argv = buildGrepArgv(options("/some/dir"));
		expect(argv[0]).toBe("--no-config");
		expect(argv[1]).toBe("--json");
		expect(argv).toContain("--regexp=needle");
		expect(argv).toContain("--fixed-strings");
		expect(argv.at(-1)).toBe("/some/dir");
		// The removed pipeline: no file list behind the pattern beyond the path,
		// no per-file cap, and no binary-as-text.
		expect(argv).not.toContain("--text");
		expect(argv.some((arg) => arg.startsWith("--max-count"))).toBe(false);
	});

	it("carries the include glob and the context window", () => {
		const argv = buildGrepArgv(options("/dir", { include: "*.ts", context: 2 }));
		expect(argv).toContain("--glob=*.ts");
		expect(argv).toContain("--context=2");
	});

	it("only the fallback shape drops the ancestor-ignore rules", () => {
		expect(buildGrepArgv(options("/dir"))).not.toContain("--no-ignore-parent");
		const wide = buildGrepArgv(options("/dir", { ignoreAncestors: true }));
		expect(wide).toContain("--no-ignore-parent");
		expect(wide).toContain("--no-require-git");
	});
});

describe("the engine's rows (#414)", () => {
	it("reports a hit's line number and its text", async () => {
		await withTempDir("grep-414-engine-", async (dir) => {
			const file = join(dir, "a.txt");
			await writeFile(file, "one\ntwo needle\nthree\n", "utf8");
			const outcome = await runGrep(options(file));
			if (outcome.kind === "unavailable") return; // no ripgrep here
			expect(outcome.kind).toBe("ok");
			if (outcome.kind !== "ok") return;
			const hits = outcome.rows.filter((row) => row.match);
			expect(hits).toMatchObject([{ line: 2, text: "two needle", truncated: false }]);
		});
	});

	it("a miss is an ANSWER (exit 1), never a failure", async () => {
		await withTempDir("grep-414-miss-", async (dir) => {
			const file = join(dir, "a.txt");
			await writeFile(file, "one\ntwo\n", "utf8");
			const outcome = await runGrep(options(file));
			if (outcome.kind === "unavailable") return;
			expect(outcome.kind).toBe("ok");
			if (outcome.kind !== "ok") return;
			expect(outcome.rows.filter((row) => row.match)).toEqual([]);
		});
	});

	it("cuts a long line at the preview cap and says so", async () => {
		await withTempDir("grep-414-long-", async (dir) => {
			const file = join(dir, "a.txt");
			await writeFile(file, `${"a".repeat(GREP_MAX_LINE_BYTES * 2)}needle\n`, "utf8");
			const outcome = await runGrep(options(file));
			if (outcome.kind === "unavailable") return;
			expect(outcome.kind).toBe("ok");
			if (outcome.kind !== "ok") return;
			const [hit] = outcome.rows.filter((row) => row.match);
			expect(hit?.truncated).toBe(true);
			expect(hit?.text.endsWith("(line truncated)")).toBe(true);
		});
	});

	it("keeps the raw-output ceiling loud (#414 Q2)", async () => {
		// The cap is a constant the seam enforces; the value is the published
		// contract (the official tool's 20 MB).
		expect(RAW_OUTPUT_MAX_BYTES).toBe(20_000_000);
	});
});
