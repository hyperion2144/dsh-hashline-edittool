/**
 * One sentence for "there is more" (#246).
 *
 * Five channels used to spell the spill notice themselves: the shared
 * `spillModelTextOverflow` helper, grep's two spill branches, read's
 * continued-report footer, `write`'s auto-read preview, and a dead
 * `paginationHint` in `hashline/`. The wording drifted — read's own budget cut
 * speaks a window sentence (`[Lines X-Y of N. …]`) while everyone else said
 * `(Omitted …)`, and read's continued report said `more lines`.
 *
 * The ruling this file pins:
 *
 *  - `formatOmittedNotice` is the ONE spelling of the parenthesized notice, and
 *    the shared spill helper's output is byte-identical to what it emitted
 *    before the refactor;
 *  - read's window sentence stays read's spelling (`formatWindowSummary`), and
 *    `write`'s preview — which IS a file window — speaks it too, instead of a
 *    fourth spelling of the same idea;
 *  - `write`'s JSON mode stays parseable: the token and the window ride INSIDE
 *    the payload instead of being appended as prose (that append was the bug
 *    the diagnostics merge then re-parsed);
 *  - the guidance quotes the shapes that really exist.
 *
 * @module dsh-hashline-edittool/test/core/issue-246-tail-copy
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { applyEffective } from "../../src/config.js";
import { GREP_GUIDANCE, READ_GUIDANCE } from "../../src/domain/edit/prompts.js";
import {
	createResume,
	formatOmittedNotice,
	spillModelTextOverflow,
} from "../../src/infra/response-stream.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { getText, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

// #244: the line-number switch belongs to the user now and defaults OFF. Nothing
// here depends on numbering, so the default state is reset, not pinned.

/** The `write` tool bound to one temp workspace and session (see write-two-paths.test.ts). */
function writeHarness(cwd: string) {
	const tool = buildWriteShadowTool(
		localIO(),
		new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never),
	);
	const execFor = (args: unknown) =>
		({
			signal: new AbortController().signal,
			agent: { id: "test-session", session: { id: "test-session", header: { cwd } } },
			arguments: args,
		}) as unknown as ToolRunContext;
	return {
		write: (input: { file_path: string; content: string }) =>
			tool.execute(input, execFor(input)) as Promise<{ modelText: string; operation: string }>,
	};
}

/** Lines big enough that the 48 000-char response budget must cut the preview. */
function bigBody(n: number): string {
	return Array.from({ length: n }, (_, i) => `line-${i}-${"x".repeat(60)}`).join("\n");
}

afterEach(() => applyEffective(undefined));

describe("formatOmittedNotice — the one spelling of the spill notice", () => {
	it("adds the byte count only when the caller knows it", () => {
		expect(formatOmittedNotice({ omittedLines: 12, consumer: "grep", token: "tk-1" })).toBe(
			'(Omitted 12 lines. Use grep {resume: "tk-1"} to continue.)',
		);
		expect(
			formatOmittedNotice({ omittedLines: 12, omittedChars: 345, consumer: "read", token: "tk-1" }),
		).toBe('(Omitted 12 lines (~345 chars). Use read {resume: "tk-1"} to continue.)');
	});

	it("is exactly what the shared spill helper appends", async () => {
		const rows = ["a".repeat(10), "b".repeat(20), "c".repeat(30), "d".repeat(40)];
		const spilled = await spillModelTextOverflow({
			sessionKey: "test-session-246-spill",
			producer: "edit",
			consumer: "read",
			modelText: rows.join("\n"),
			budgetChars: rows[0]!.length + 1, // exactly the first row fits
		});
		const token = spilled.continuation!.resume;
		expect(spilled.continuation!.remaining).toBe(90); // 20 + 30 + 40
		expect(spilled.modelText).toBe(
			`${rows[0]}\n\n${formatOmittedNotice({ omittedLines: 3, omittedChars: 90, consumer: "read", token })}`,
		);
	});
});

describe("grep's spill notice", () => {
	it("ends with the shared notice and hands back a token that still resumes", async () => {
		await withTempDir("issue-246-grep-", async (dir) => {
			const rows = Array.from({ length: 900 }, (_, i) => `needle-${i}-${"z".repeat(90)}`);
			await writeFile(join(dir, "many.txt"), `${rows.join("\n")}\n`);
			const harness = setupIntegrationTest(dir);
			const text = getText(
				await harness
					.getTool("grep")
					.execute("grep-1", { path: ".", pattern: "needle", limit: rows.length }),
			);
			const notice = /\(Omitted (\d+) lines \(~(\d+) chars\)\. Use grep \{resume: "([^"]+)"\} to continue\.\)/.exec(
				text,
			);
			expect(notice).not.toBeNull();

			const resumed = getText(
				await harness.getTool("grep").execute("grep-2", {
					path: ".",
					pattern: "needle",
					limit: rows.length,
					resume: notice![3],
				}),
			);
			expect(resumed).not.toContain("[E_");
		});
	});
});

describe("read's continued report", () => {
	it("closes with the shared notice, without a byte count it cannot know", async () => {
		await withTempDir("issue-246-report-", async (dir) => {
			const harness = setupIntegrationTest(dir);
			// The report take is RESUME_WINDOW_LINES (4 000) ROWS, so more rows than
			// that is what makes the segment partial.
			const rows = Array.from({ length: 4100 }, (_, i) => `report line ${i}`);
			const { token } = await createResume({
				sessionKey: harness.sessionKey,
				producer: "edit",
				consumer: "read",
				kind: "report-segment",
				rows: rows.map((content) => ({ content })),
			});
			const text = getText(
				await harness.readTool.execute("read-1", { path: "report.txt", resume: token }),
			);
			expect(text.startsWith("[Continued report]")).toBe(true);
			expect(text).toMatch(/\(Omitted \d+ lines\. Use read \{resume: "[^"]+"\} to continue\.\)$/);
			expect(text).not.toContain("more lines");
		});
	});
});

describe("write's auto-read preview", () => {
	it("text mode closes the window with read's window sentence, not a fourth spelling", async () => {
		await withTempDir("issue-246-write-text-", async (dir) => {
			const created = await writeHarness(dir).write({ file_path: "big.ts", content: bigBody(1500) });
			expect(created.modelText).toMatch(
				/\[Lines 1-\d+ of 1500\. Omitted \d+ lines\. Use read \{resume: "[^"]+"\} to continue\.\]/,
			);
			expect(created.modelText).not.toContain("(Omitted");
		});
	});

	it("JSON mode stays parseable and carries the window and the token inside it", async () => {
		applyEffective({ output_format: "json" });
		await withTempDir("issue-246-write-json-", async (dir) => {
			const created = await writeHarness(dir).write({ file_path: "big.ts", content: bigBody(1500) });
			const payload = JSON.parse(created.modelText) as {
				window?: { start: number; end: number; totalLines: number };
				continuation?: { resume: string; remaining: number };
				lines?: unknown;
			};
			expect(payload.window).toEqual({ start: 1, end: expect.any(Number), totalLines: 1500 });
			expect(payload.window!.end).toBeLessThan(1500); // a real cut happened
			expect(typeof payload.continuation?.resume).toBe("string");
			expect(payload.lines).toBeDefined();
			expect(created.modelText).not.toContain("(Omitted");
		});
	});
});

describe("the guidance quotes the shapes that exist", () => {
	it("read's guidance describes the window sentence read really emits", () => {
		const text = READ_GUIDANCE.lines.join("\n");
		expect(text).toContain('[Lines X-Y of N. Omitted K lines. Use read {resume: "TOKEN"} to continue.]');
		expect(text).not.toContain("(Omitted N lines. Use read {resume:");
	});

	it("grep's guidance quotes the byte count grep's footer carries", () => {
		expect(GREP_GUIDANCE.lines.join("\n")).toContain(
			'(Omitted N lines (~C chars). Use grep {resume: "TOKEN"} to continue.)',
		);
	});
});
