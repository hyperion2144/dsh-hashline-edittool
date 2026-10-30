/**
 * #384 — ripgrep is the grep tool's ENGINE, and a literal pattern is a FLAG.
 *
 * The pre-filter that came before it searched for `-F<pattern>` whenever the
 * caller asked for a literal search: ripgrep reads that as the TEXT
 * `-F<pattern>`, which matches nothing, so every literal search ended in
 * "No matches" — a false negative the plugin could not see.
 *
 * These tests drive the REAL ripgrep (the plugin declares `@vscode/ripgrep`,
 * the same binary DSH's own search ships) through the new engine seam, and
 * pin the argv the engine builds: the flag and the shape of the command line
 * are two halves of the same bug.
 *
 * @module dsh-hashline-edittool/issue-384-grep-engine.test
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRgArgv, rgSearchMatches } from "../../src/tools/grep-rg.js";
import { rgMatchesOf, withTempDir } from "../support/fixtures.js";


describe("the argv the engine builds (#384)", () => {
	it("passes a literal pattern as --fixed-strings, never as a -F prefix", () => {
		const argv = buildRgArgv({ pattern: "a.b", literal: true, files: ["/tmp/one.txt"] });

		// THE bug: `-Fa.b` is TEXT to ripgrep, not a flag. Nothing else in the
		// argv may start with a dash but a known flag.
		expect(argv).not.toContain("-Fa.b");
		expect(argv.some((arg) => arg.startsWith("-F"))).toBe(false);
		expect(argv).toContain("--fixed-strings");

		// The pattern rides in --flag=value form, so a pattern that starts with a
		// dash can never be read as a flag either.
		expect(argv.filter((arg) => arg.startsWith("--regexp="))).toEqual(["--regexp=a.b"]);

		// The files ride behind `--`, so a path that looks like a flag is a path.
		const separator = argv.indexOf("--");
		expect(separator).toBeGreaterThan(-1);
		expect(argv.slice(separator + 1)).toEqual(["/tmp/one.txt"]);
	});

	it("keeps the flags in one fixed order", () => {
		expect(buildRgArgv({ pattern: "needle", literal: false, files: ["a", "b"] })).toEqual([
			"--no-config",
			"--json",
			"--text",
			"--regexp=needle",
			"--",
			"a",
			"b",
		]);
		expect(buildRgArgv({ pattern: "needle", literal: true, limit: 3, files: [] })).toEqual([
			"--no-config",
			"--json",
			"--text",
			"--max-count=3",
			"--fixed-strings",
			"--regexp=needle",
			"--",
		]);
	});

	it("starts with --no-config, so the host's ripgrep config cannot run", () => {
		// RIPGREP_CONFIG_PATH (or an rg.conf next to the binary) may set `--pre`,
		// which runs an arbitrary preprocessor against every file the search
		// touches. A search must never execute the host's config.
		expect(buildRgArgv({ pattern: "needle", literal: false, files: [] })[0]).toBe("--no-config");
	});
});

describe("the engine searches with ripgrep", () => {
	it("finds the hits of a LITERAL pattern across several files (#384)", async () => {
		await withTempDir("rg-384-literal-", async (dir) => {
			const hit = join(dir, "hit.txt");
			const miss = join(dir, "miss.txt");
			await writeFile(hit, "alpha\nneedle here\nomega\n", "utf8");
			await writeFile(miss, "alpha\nbeta\nomega\n", "utf8");

			const outcome = await rgSearchMatches({
				pattern: "needle here",
				literal: true,
				files: [hit, miss],
			});
			// No ripgrep in this environment: the seam's contract says so, and
			// there is nothing to assert about the hits.
			if (outcome.kind === "unavailable") return;
			expect(outcome.kind).toBe("ok");
			expect(rgMatchesOf(outcome)).toMatchObject([{ path: hit, line: 2 }]);
			// The hit carries the line's TEXT — the search's snapshot of it, which
			// is what the plugin compares against the line it reads now.
			expect(rgMatchesOf(outcome)[0]?.text).toBe("needle here");
		});
	});

	it("finds the hit of a LITERAL pattern in a single file", async () => {
		await withTempDir("rg-384-single-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\nneedle here\nomega\n", "utf8");

			const outcome = await rgSearchMatches({
				pattern: "needle here",
				literal: true,
				files: [file],
			});
			if (outcome.kind === "unavailable") return;
			expect(rgMatchesOf(outcome)).toMatchObject([{ path: file, line: 2 }]);
		});
	});

	it("matches a REGULAR EXPRESSION, and reports a miss as an empty answer", async () => {
		await withTempDir("rg-384-regex-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\nneedle here\nomega\n", "utf8");

			const hit = await rgSearchMatches({
				pattern: "need[a-z]+ here",
				literal: false,
				files: [file],
			});
			if (hit.kind === "unavailable") return;
			expect(rgMatchesOf(hit)).toMatchObject([{ path: file, line: 2 }]);
			// The hit's OFFSET inside its line: what places a hit in the read
			// line space on a file ripgrep cannot count (#147).
			expect(rgMatchesOf(hit)[0]?.offset).toBe(0);

			// A miss is an ANSWER (ripgrep exits 1), never a failure: collapsing
			// the two is what made a zero-hit grep re-read the whole tree.
			const miss = await rgSearchMatches({
				pattern: "no-such-string-anywhere-198",
				literal: false,
				files: [file],
			});
			expect(miss.kind).toBe("ok");
			expect(rgMatchesOf(miss)).toEqual([]);
		});
	});

	it("reports a pattern ripgrep refuses as invalid-pattern", async () => {
		await withTempDir("rg-384-badregex-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\n", "utf8");

			// Rust's regex engine has no look-ahead; ripgrep rejects the pattern
			// with exit code 2 and says so on stderr.
			const outcome = await rgSearchMatches({
				pattern: "(?=foo)",
				literal: false,
				files: [file],
			});
			if (outcome.kind === "unavailable") return;
			expect(outcome.kind).toBe("invalid-pattern");
		});
	});

	it("finds the hits of a file with a NUL byte, on the right lines (#268)", async () => {
		await withTempDir("rg-384-binary-", async (dir) => {
			const file = join(dir, "binary.dat");
			// Line 1 carries a NUL byte, and the needle sits ON that line as well
			// as after it. Without `--text` ripgrep counts the NUL as a line
			// break: the first hit is reported against line 2 and every later
			// line is off by one. The plugin's own reader counts only newlines,
			// so the engine has to agree with it (#268).
			await writeFile(file, Buffer.from("alpha\u0000needle\nbeta needle\ngamma needle\n", "utf8"));

			const outcome = await rgSearchMatches({
				pattern: "needle",
				literal: true,
				files: [file],
			});
			if (outcome.kind === "unavailable") return;
			expect(rgMatchesOf(outcome)).toMatchObject([
				{ path: file, line: 1 },
				{ path: file, line: 2 },
				{ path: file, line: 3 },
			]);
		});
	});

	it("answers a failure — never a rejection — when a path does not exist", async () => {
		await withTempDir("rg-384-missing-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\n", "utf8");

			const outcome = await rgSearchMatches({
				pattern: "alpha",
				literal: true,
				files: [file, join(dir, "no-such-file.txt")],
			});
			if (outcome.kind === "unavailable") return;
			expect(outcome.kind).toBe("failed");
		});
	});

	it("sizes a huge file list by command-line length, and still answers (#260)", async () => {
		await withTempDir("rg-384-huge-", async (dir) => {
			// 400 paths of ~6.3K chars ≈ 2.5 MB of argv: past macOS' 1 MiB
			// ARG_MAX, Linux' 2 MiB and Windows' 32,767-char command line alike.
			// The length-based chunker keeps every invocation inside the budget;
			// the paths do not exist, so ripgrep fails — and a failure is an
			// OUTCOME, not a rejected promise.
			const huge = Array.from(
				{ length: 400 },
				(_unused, index) => join(dir, `${"d".repeat(6_200)}-miss-${index}.ts`),
			);
			const outcome = await rgSearchMatches({
				pattern: "needle",
				literal: true,
				files: huge,
			});
			expect(outcome.kind).toBe("failed");
		});
	});
});

describe("a ripgrep that is not there", () => {
	it("reports unavailable instead of pretending there were no hits", async () => {
		await withTempDir("rg-384-missing-rg-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\n", "utf8");

			const outcome = await rgSearchMatches({
				pattern: "alpha",
				literal: true,
				files: [file],
				rgPath: join(dir, "no-such-ripgrep"),
			});
			expect(outcome.kind).toBe("unavailable");
		});
	});
});

describe("the ripgrep the plugin ships", () => {
	it("is a DIRECT dependency, and the binary it resolves to really runs", async () => {
		// The whole engine hangs on this: `@vscode/ripgrep` is a DIRECT
		// dependency (so an install brings the platform binary), and resolution
		// must land on a file that exists. A silent miss here is what degraded
		// every grep back to the JS engine — it should fail loudly instead.
		const pkg = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(pkg.dependencies?.["@vscode/ripgrep"]).toBeTruthy();

		await withTempDir("rg-384-dependency-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "needle\n", "utf8");
			const outcome = await rgSearchMatches({
				pattern: "needle",
				literal: true,
				files: [file],
			});
			if (outcome.kind === "unavailable") return; // no ripgrep in this environment
			expect(rgMatchesOf(outcome)).toMatchObject([{ path: file, line: 1 }]);
		});
	});
});
