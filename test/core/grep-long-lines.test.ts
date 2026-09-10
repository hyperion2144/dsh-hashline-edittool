/**
 * grep long-line contract tests (fix alongside #53).
 *
 * Regression: grep used to clip every row to 200 chars + "..." (silent), which
 * broke the advertised "grep hit → edit directly, no extra read" flow — and in
 * `require_line_content` mode the clipped line could never match the declared
 * full line, forcing `[E_CONTENT_MISMATCH]`.
 *
 * Contract now: rows carry the FULL line; only a row exceeding the read tool's
 * per-line byte budget (200KB) is hidden, with the same `sed` pointer read
 * emits; no silent ellipsis anywhere.
 *
 * @module test/core/grep-long-lines.test
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { MAX_READ_LINE_BYTES } from "../../src/constants.js";
import { setupIntegrationTest, getText } from "../support/fixtures.js";
import { applyHashlineShape } from "../../src/hashline/hash-assign.js";

applyHashlineShape({ separator: ":", contextLines: 3 });

type Tool = {
	execute: (
		_callId: string,
		params: unknown,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

afterEach(() => {
	applyEffective({});
});

describe("grep long lines", () => {
	it("returns the FULL line content — no 200-char clip, no ellipsis", async () => {
		const dir = await mkdtemp(join(tmpdir(), "grep-long-"));
		try {
			const long = "MARK " + "x".repeat(300) + " TAIL";
			await writeFile(join(dir, "long.txt"), long + "\nshort\n", "utf-8");
			const h = setupIntegrationTest(dir);
			const res = await (h.getTool("grep") as Tool).execute("grep", {
				pattern: "MARK",
				path: "long.txt",
			});
			const text = getText(res);
			const row = text.split("\n").find((l) => l.includes("MARK"));
			expect(row).toBeDefined();
			expect(row).toContain("TAIL");
			expect(row).not.toContain("...");
			// The row's content equals the file's line verbatim.
			const content = row!.replace(/^\s*(?:\d+:)?[A-Za-z0-9]{2,8}:\s?/, "");
			expect(content).toBe(long);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the anchor editable: a grep hit can be edited with a declared full line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "grep-long-edit-"));
		try {
			const long = "PREFIX " + "y".repeat(260) + " SUFFIX";
			const path = join(dir, "long.txt");
			await writeFile(path, long + "\nkeep\n", "utf-8");
			applyEffective({ require_line_content: true });
			const h = setupIntegrationTest(dir);
			const res = await (h.getTool("grep") as Tool).execute("grep", {
				pattern: "PREFIX",
				path: "long.txt",
			});
			const row = getText(res).split("\n").find((l) => l.includes("PREFIX"));
			expect(row).toBeDefined();
			const m = /^\s*(?:(\d+):)?([A-Za-z0-9]{2,8}):\s?(.*)$/.exec(row!);
			expect(m).not.toBeNull();
			const lineNo = m![1]!;
			const anchor = m![2]!;
			const fullLine = m![3]!;
			expect(fullLine).toBe(long); // exactly what grep showed

			// Edit directly from the grep row: declared line = the shown full text.
			const editRes = await (h.getTool("edit") as Tool).execute("edit", {
				path: "long.txt",
				edits: [
					{
						op: "replace",
						anchor_start: { anchor: `${lineNo}:${anchor}`, line: fullLine },
						lines: ["REPLACED"],
					},
				],
			});
			const text = getText(editRes);
			expect(text).not.toContain("E_CONTENT_MISMATCH");
			expect(await readFile(path, "utf-8")).toBe("REPLACED\nkeep\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("hides only rows above the 200KB per-line budget, with a sed pointer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "grep-huge-"));
		try {
			const huge = "HUGE " + "z".repeat(MAX_READ_LINE_BYTES + 1024);
			await writeFile(join(dir, "huge.txt"), huge + "\n", "utf-8");
			const h = setupIntegrationTest(dir);
			const res = await (h.getTool("grep") as Tool).execute("grep", {
				pattern: "HUGE",
				path: "huge.txt",
			});
			const text = getText(res);
			expect(text).toContain("content not shown");
			expect(text).toContain("sed -n '1p'");
			expect(text).toContain(`head -c ${MAX_READ_LINE_BYTES}`);
			// The giant content itself is not shipped.
			expect(text.length).toBeLessThan(MAX_READ_LINE_BYTES);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
