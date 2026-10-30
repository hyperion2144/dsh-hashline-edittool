/**
 * #386 — grep's truncation, and its hit counts, were SILENT.
 *
 * Two gaps, one ticket:
 *
 * - the DATA was half there. `totalMatches` and the truncated flag were
 *   accumulated per file and written into the canonical value, but the model
 *   text never mentioned them and the card's folded row carried no count — so a
 *   limit-truncated search read exactly like a complete one;
 * - the DATA itself was wrong. The engine stops at the per-file cap
 *   (`--max-count`), so the canonical `total` was the number of hits
 *   COLLECTED — equal to the cap — never the file's true count.
 *
 * The fix: a SECOND, uncapped counting pass (`rg --count`) for the files that
 * reached the cap; the counts in the model text (per file) and in the card's
 * title (per call); and a `truncatedBy` that says WHICH cut happened.
 *
 * @module dsh-hashline-edittool/issue-386-grep-hit-counts.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { buildGrepTool } from "../../src/tools/tool-grep.js";
import { buildRgCountArgv } from "../../src/tools/grep-rg.js";
import type { GrepFileRows } from "../../src/render/grep-card.js";
import { withTempDir } from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

afterEach(() => {
	// The budget and the output format are global state: restore the defaults so
	// this suite cannot leak them into any suite that runs after it.
	applyEffective(undefined);
});

/** The canonical value the tool returns — the shape the card and the model see. */
interface GrepValue {
	files: GrepFileRows[];
	truncated: boolean;
	total: number;
	truncatedBy?: "limit" | "budget" | "limit+budget";
	continuation?: { resume: string; remaining: number };
	modelText: string;
}

/** Drive the built grep tool over a temp cwd and return its CANONICAL value. */
async function runGrep(cwd: string, args: Record<string, unknown>): Promise<GrepValue> {
	const tool = buildGrepTool(localIO());
	const exec = (inner: unknown) =>
		({
			signal: new AbortController().signal,
			agent: { id: "s", session: { id: "s", header: { cwd } } },
			arguments: inner,
		}) as never;
	return (await tool.execute(args, exec({ cwd }))) as unknown as GrepValue;
}

/** A file whose every line carries `needle`. */
async function writeMatches(dir: string, name: string, count: number, pad = 0): Promise<void> {
	const rows = Array.from({ length: count }, (_, i) => `line ${i} needle${"x".repeat(pad)}`);
	await writeFile(join(dir, name), `${rows.join("\n")}\n`, "utf8");
}

/** The row texts the response served. */
function servedTexts(value: GrepValue): string[] {
	return value.files.flatMap((file) => file.rows.map((row) => row.text));
}

describe("#386 — grep says how many hits it found, and what it cut", () => {
	it("reports the TRUE hit count when the per-file cap cut the list (#386)", async () => {
		await withTempDir("grep-386-limit-", async (cwd) => {
			await writeMatches(cwd, "many.txt", 300);
			const value = await runGrep(cwd, { path: "many.txt", pattern: "needle", regex: false });
			// The cap is 100 by default: the engine collected 100 hits and the file
			// carries 300. The count is the TRUE one — the whole point of the
			// second, uncapped pass.
			expect(value.total).toBe(300);
			expect(value.truncatedBy).toBe("limit");
			// The model text says so too: the counts AND the reason.
			expect(value.modelText).toContain("300 total");
			expect(value.modelText).toContain("100 served");
			expect(value.modelText).toContain("Truncated by the per-file limit");
		});
	});

	it("reports the exact count when the cap cut nothing (#386)", async () => {
		await withTempDir("grep-386-exact-", async (cwd) => {
			await writeMatches(cwd, "few.txt", 3);
			const value = await runGrep(cwd, { path: "few.txt", pattern: "needle", regex: false });
			expect(value.total).toBe(3);
			expect(value.truncatedBy).toBeUndefined();
			expect(value.modelText).toContain("3 total");
			expect(value.modelText).toContain("3 served");
			expect(value.modelText).not.toContain("Truncated");
		});
	});

	it("counts with an UNCAPPED pass of its own (#386)", async () => {
		// The counting pass must not inherit the search's cap: a count that is
		// capped IS the cap, which is the bug (#386). The pattern rides as one
		// argv element and a literal as a flag — the #384 lesson.
		const argv = buildRgCountArgv({ pattern: "needle", literal: true, files: ["a.txt"] });
		expect(argv).toContain("--count");
		expect(argv).toContain("--fixed-strings");
		expect(argv).toContain("--regexp=needle");
		expect(argv.some((arg) => arg.startsWith("--max-count"))).toBe(false);
		expect(argv).not.toContain("-Fneedle");
	});

	it("says which cut happened when the budget cut the response (#386)", async () => {
		await withTempDir("grep-386-budget-", async (cwd) => {
			// The smallest budget the settings allow, and rows long enough to
			// overflow it. The hits (300) are BELOW the cap (1000), so the only
			// cut is the budget's.
			await writeMatches(cwd, "big.log", 300, 100);
			applyEffective({ max_response_chars: 8_000 });
			const value = await runGrep(cwd, { path: "big.log", pattern: "needle", limit: 1000 });
			expect(value.total).toBe(300);
			expect(value.truncatedBy).toBe("budget");
			expect(value.continuation?.resume).toMatch(/^rs-[0-9a-f]{32}$/);
			// The notice carries the true total: the model knows the scale of what
			// it did not get.
			expect(value.modelText).toContain("300 matches in total");
			expect(value.modelText).toContain("Truncated by the response budget");
		});
	});

	it("keeps the true total across the resume (#386)", async () => {
		await withTempDir("grep-386-resume-", async (cwd) => {
			await writeMatches(cwd, "big.log", 300, 100);
			applyEffective({ max_response_chars: 8_000 });
			const first = await runGrep(cwd, { path: "big.log", pattern: "needle", limit: 1000 });
			const token = first.continuation?.resume;
			expect(token).toBeDefined();
			const next = await runGrep(cwd, { resume: token! });
			// The continuation is part of the SAME search: the total does not
			// restart at the segment.
			expect(next.total).toBe(300);
			expect(servedTexts(next).length).toBeGreaterThan(0);
			// #386: the continuation ends EVERY one of its sections with the
			// same count line the first segment did — the file's true count,
			// what this segment served of it, and the cut.
			expect(next.modelText).toContain("[Matches: 300 total,");
			expect(next.modelText).toContain("Truncated by the response budget");
			// And the notice it carries says how big the search was.
			expect(next.modelText).toContain("300 matches in total");
		});
	});

	it("gives the card's folded row a title with the counts (#386)", async () => {
		await withTempDir("grep-386-title-", async (cwd) => {
			await writeMatches(cwd, "many.txt", 300);
			const tool = buildGrepTool(localIO());
			const exec = (inner: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: inner,
				}) as never;
			const value = (await tool.execute(
				{ path: "many.txt", pattern: "needle", regex: false },
				exec({ cwd }),
			)) as unknown as GrepValue;
			const meta = (tool.output as {
				presentationMeta: (args: unknown, value: unknown) => Record<string, unknown>;
			}).presentationMeta({ path: "many.txt", pattern: "needle" }, value) as {
				rowTitle?: { key: string; params?: Record<string, string | number> };
				total: number;
				truncated: boolean;
			};
			// The wire carries FACTS, never prose (ADR-0026): a stable key plus
			// the numbers that fill its template.
			expect(meta.rowTitle?.key).toBe("row.title.grep.stats.limit");
			expect(meta.rowTitle?.params).toEqual({ hits: 300, served: 100 });
			// The card's own numbers follow the true total.
			expect(meta.total).toBe(300);
			expect(meta.truncated).toBe(true);
		});
	});

	it("reports the true total on the JSON path too (#386)", async () => {
		await withTempDir("grep-386-json-", async (cwd) => {
			await writeMatches(cwd, "many.txt", 300);
			applyEffective({ output_format: "json" });
			const value = await runGrep(cwd, { path: "many.txt", pattern: "needle", regex: false });
			const json = JSON.parse(value.modelText) as { total: number; truncatedBy?: string };
			expect(json.total).toBe(300);
			expect(json.truncatedBy).toBe("limit");
			expect(json.truncatedBy).toBe("limit");
		});
	});

	it("keeps the canonical value inside the tool's own output schema (#386)", async () => {
		// The schema is checked by the HOST when it mounts the tool, so a value
		// that carries an undeclared field is refused THERE, not in a unit test
		// (#273). The new fields are declared, and this pins that.
		await withTempDir("grep-386-schema-", async (cwd) => {
			await writeMatches(cwd, "many.txt", 300);
			const tool = buildGrepTool(localIO());
			const exec = (inner: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: inner,
				}) as never;
			const value = await tool.execute(
				{ path: "many.txt", pattern: "needle", regex: false },
				exec({ cwd }),
			);
			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});
});
