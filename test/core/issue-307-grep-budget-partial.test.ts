/**
 * Issue #307: a `grep` section larger than the per-response budget answered
 * with an EMPTY shell — the continuation notice and nothing else.
 *
 * The admission was per-SECTION (all or nothing): a file whose section
 * exceeded `max_response_chars` was poured into the spill wholesale, so the
 * response carried no row at all and the model was told only "go resume".
 *
 * ADR-0013 segments a response to the budget and ADR-0009 allocates anchors
 * ONLY for the rows the response actually returns — so a section that does not
 * fit is split per ROW: the prefix that fits is served (anchored, editable),
 * the tail spills to the resume token. No row is ever cut.
 *
 * @module dsh-hashline-edittool/issue-307-grep-budget-partial.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { buildGrepTool } from "../../src/tools/tool-grep.js";
import type { GrepFileRows } from "../../src/render/grep-card.js";
import { withTempDir } from "../support/fixtures.js";

afterEach(() => {
	// The per-response budget is global state: restore the compiled defaults so
	// this suite cannot leak a small budget into any suite that runs after it.
	applyEffective(undefined);
});

/** The canonical value the tool returns — the shape the card and the model see. */
interface GrepValue {
	files: GrepFileRows[];
	truncated: boolean;
	total: number;
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

/** `count` matching rows, each ~113 chars — a section that overflows 8,000. */
function matchingRows(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `needle row ${i} ${"x".repeat(100)}`);
}

/** The smallest budget the settings allow, so a modest file spills. */
const BUDGET = 8_000;

/** A corpus that overflows the budget: 100 matching rows of ~113 chars each. */
const BIG_LOG = `${matchingRows(100).join("\n")}\n`;

/** Every row text the response served, across all its files. */
function servedTexts(value: GrepValue): string[] {
	return value.files.flatMap((file) => file.rows.map((row) => row.text));
}

/** The served row texts that CONTAIN `needle` — a row text is the whole line. */
function servedTextsMatching(value: GrepValue, needle: string): string[] {
	return servedTexts(value).filter((text) => text.includes(needle));
}

/**
 * Walk the continuation chain and collect every row the scan can deliver —
 * the first segment plus every resumed one.
 */
async function collectAll(cwd: string, first: GrepValue): Promise<Set<string>> {
	const seen = new Set<string>(servedTexts(first));
	let token = first.continuation?.resume;
	let guard = 0;
	while (token !== undefined && guard++ < 20) {
		const next = await runGrep(cwd, { resume: token });
		for (const text of servedTexts(next)) seen.add(text);
		token = next.continuation?.resume;
	}
	return seen;
}

describe("grep over a section larger than the per-response budget (#307)", () => {
	it("serves the rows that fit instead of an empty shell", async () => {
		await withTempDir("grep-307-", async (cwd) => {
			await writeFile(join(cwd, "big.log"), BIG_LOG);
			// The smallest budget the settings allow, so a modest file spills.
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "big.log", pattern: "needle" });

			// The reported bug: the response carried NO row, only a notice.
			expect(value.modelText).not.toContain("Matches exist but exceed the per-response budget");
			expect(servedTexts(value).length).toBeGreaterThan(0);
			expect(value.modelText).toContain("needle row 0");
			expect(value.files[0]?.path).toBe("big.log");
			// The rest is not lost — it is reachable through the resume token.
			expect(value.continuation?.resume).toMatch(/^rs-[0-9a-f]{32}$/);
			expect(value.truncated).toBe(true);
		});
	});

	it("anchors the rows it serves — they are editable, not bare line numbers", async () => {
		await withTempDir("grep-307-anchor-", async (cwd) => {
			await writeFile(join(cwd, "big.log"), BIG_LOG);
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "big.log", pattern: "needle" });
			const first = value.files[0]?.rows[0];
			expect(first?.hash ?? "").not.toBe("");
			expect(first?.match).toBe(true);
			// The rendered row carries the anchor, never the `[line N]` fallback.
			expect(value.modelText).not.toContain("[line 1]");
		});
	});

	it("serves no more than the budget allows, and keeps the rest for the resume", async () => {
		await withTempDir("grep-307-budget-", async (cwd) => {
			await writeFile(join(cwd, "big.log"), BIG_LOG);
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "big.log", pattern: "needle" });
			const rows = value.files[0]?.rows ?? [];
			// The accounting the scan itself keeps: content + the per-row marker
			// allowance. It must fit the budget…
			const cost = rows.reduce((sum, row) => sum + row.text.length, 0) + 24 * rows.length;
			expect(cost).toBeLessThanOrEqual(BUDGET);
			// …and the rendered text stays inside it too.
			const sections = value.modelText.split("\n(Omitted ")[0] ?? "";
			expect(sections.length).toBeLessThanOrEqual(BUDGET);
			// Not everything fit — that is what the continuation is for.
			expect(rows.length).toBeLessThan(100);
		});
	});

	it("serves the spilled tail through the resume token", async () => {
		await withTempDir("grep-307-resume-", async (cwd) => {
			await writeFile(join(cwd, "big.log"), BIG_LOG);
			applyEffective({ max_response_chars: BUDGET });

			const first = await runGrep(cwd, { path: "big.log", pattern: "needle" });
			const token = first.continuation?.resume;
			expect(token).toBeDefined();

			const next = await runGrep(cwd, { resume: token! });
			// The LAST match is in the spill — it comes back on resume.
			expect(servedTextsMatching(next, "needle row 99")).toHaveLength(1);
		});
	});

	it("keeps every match reachable across the response and its continuations", async () => {
		await withTempDir("grep-307-two-", async (cwd) => {
			await writeFile(join(cwd, "a-small.log"), "needle small one\nneedle small two\n");
			await writeFile(join(cwd, "b-big.log"), BIG_LOG);
			applyEffective({ max_response_chars: BUDGET });

			// A directory search — the file ORDER is ripgrep's and is not stable,
			// so this case asserts what holds either way: nothing is lost.
			const first = await runGrep(cwd, { path: ".", pattern: "needle" });
			expect(first.files.length).toBeGreaterThan(0);

			const all = await collectAll(cwd, first);
			for (const row of matchingRows(100)) expect(all.has(row)).toBe(true);
			expect(all.has("needle small one")).toBe(true);
			expect(all.has("needle small two")).toBe(true);
		});
	});

	it("leaves a file that fits untouched", async () => {
		await withTempDir("grep-307-small-", async (cwd) => {
			await writeFile(join(cwd, "small.log"), `${matchingRows(3).join("\n")}\n`);
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "small.log", pattern: "needle" });
			expect(value.files[0]?.rows).toHaveLength(3);
			expect(value.continuation).toBeUndefined();
			expect(value.truncated).toBe(false);
			expect(value.modelText).not.toContain("Omitted");
		});
	});

	it("projects the partially served rows into the JSON output too", async () => {
		await withTempDir("grep-307-json-", async (cwd) => {
			await writeFile(join(cwd, "big.log"), BIG_LOG);
			applyEffective({ max_response_chars: BUDGET, output_format: "json" });

			const value = await runGrep(cwd, { path: "big.log", pattern: "needle" });
			const parsed = JSON.parse(value.modelText.split("\n")[0] ?? "{}") as {
				files: { path: string; matches: Record<string, string> }[];
				truncated: boolean;
			};
			// The JSON projection is the model's other view of the same result —
			// it must not claim the file had no matches.
			expect(parsed.files).toHaveLength(1);
			expect(Object.keys(parsed.files[0]?.matches ?? {}).length).toBeGreaterThan(0);
			expect(parsed.truncated).toBe(true);
		});
	});

	it("never answers with an empty shell when the first row nearly fills the budget", async () => {
		await withTempDir("grep-307-nofit-", async (cwd) => {
			// A first line that almost fills the budget: its own cost (content + the
			// per-row allowance) is INSIDE the budget, so it is served — while the
			// section as a whole does not fit. This is exactly the case that used to
			// fall through to the notice-only response.
			const first = `needle ${"x".repeat(7954)}`;
			const second = `needle ${"y".repeat(500)}`;
			await writeFile(join(cwd, "huge.log"), `${first}\n${second}\n`);
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "huge.log", pattern: "needle" });
			// Not the notice-only answer — a row the model can read.
			expect(value.modelText).not.toContain("Matches exist but exceed the per-response budget");
			expect(servedTexts(value)).toHaveLength(1);
			expect(servedTexts(value)[0]).toBe(first);
			// And the row that did not fit is still reachable.
			expect(value.continuation?.resume).toMatch(/^rs-[0-9a-f]{32}$/);
			const next = await runGrep(cwd, { resume: value.continuation!.resume });
			expect(servedTextsMatching(next, "needle ")).toHaveLength(1);
		});
	});

	it("serves a hit, not only the context that filled the window", async () => {
		await withTempDir("grep-307-context-", async (cwd) => {
			// Three huge context rows sit BEFORE the hit, so a cut that simply takes
			// the file's first rows would show context and no match — and the JSON
			// projection would read as "this file has no matches".
			const contextRows = ["x".repeat(4_000), "y".repeat(4_000), "z".repeat(4_000)];
			const hit = "needle in the middle";
			await writeFile(join(cwd, "wide.log"), `${[...contextRows, hit].join("\n")}\n`);
			applyEffective({ max_response_chars: BUDGET });

			const value = await runGrep(cwd, { path: "wide.log", pattern: "needle", context: 3 });
			// The hit is served…
			expect(servedTextsMatching(value, hit)).toHaveLength(1);
			// …and the skipped context rows are not lost: they lead the spill.
			expect(value.continuation?.resume).toMatch(/^rs-[0-9a-f]{32}$/);
			const next = await runGrep(cwd, { resume: value.continuation!.resume });
			expect(servedTexts(next).length).toBeGreaterThan(0);

			// The JSON projection must show the hit too — never an empty match map.
			applyEffective({ max_response_chars: BUDGET, output_format: "json" });
			const json = await runGrep(cwd, { path: "wide.log", pattern: "needle", context: 3 });
			const parsed = JSON.parse(json.modelText.split("\n")[0] ?? "{}") as {
				files: { path: string; matches: Record<string, string> }[];
			};
			expect(Object.keys(parsed.files[0]?.matches ?? {}).length).toBeGreaterThan(0);
		});
	});
});
