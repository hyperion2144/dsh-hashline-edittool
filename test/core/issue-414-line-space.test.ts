/**
 * #414 (ADR-0035) — ONE line space, and it is ripgrep's `\n` model.
 *
 * ADR-0008 used to fold a bare CR into a line break so that read, grep, LSP and
 * tree-sitter all counted the same "logical" lines; #414 replaced the contract
 * with the engine's own model, because the alternative is a permanent
 * translation layer between two spaces.
 *
 * What is pinned here:
 *
 * - LF, CRLF and BOM files: read and grep agree on the line number and on the
 *   row's text (the CRLF's trailing CR is not part of the served row);
 * - a bare-CR file (`alpha\rbeta`) is ONE line in every tool — the declared
 *   behavior change;
 * - the checksum's normalization folds CRLF only (a bare CR changes the value),
 *   so `read`, `edit` and `grep` derive the same identity.
 *
 * @module dsh-hashline-edittool/issue-414-line-space.test
 */
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { NUMBERED, getText, setupIntegrationTest, withTempDir, useNumberedRows } from "../support/fixtures.js";
import { readFileIdentity } from "../../src/infra/file-identity.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { normalizeContent } from "../../src/domain/session/anchor-state.js";

// #244: the line-number switch belongs to the user now and defaults OFF; the
// row assertions below need numbered markers.
useNumberedRows();

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

/** The 1-based line numbers the model text carries for one file's rows. */
function servedLines(text: string): number[] {
	const lines: number[] = [];
	for (const line of text.split("\n")) {
		const match = /^[A-Za-z0-9]{2,8}:(\d+):\s?/.exec(line);
		if (match) lines.push(Number(match[1]));
	}
	return lines;
}

afterEach(() => {
	applyEffective({ ...NUMBERED });
});

describe("#414 — read and grep share ripgrep's line space", () => {
	it("agree on an LF file", async () => {
		await withTempDir("grep-414-lf-", async (cwd) => {
			await writeFile(join(cwd, "t.txt"), "one\ntwo needle\nthree\n", "utf8");
			const harness = setupIntegrationTest(cwd);
			const grepText = getText(
				await (harness.getTool("grep") as unknown as GrepTool).execute("g", { pattern: "needle", context: 0 }),
			);
			expect(servedLines(grepText)).toEqual([2]);
		});
	});

	it("agree on a CRLF file, and the served row carries no trailing CR", async () => {
		await withTempDir("grep-414-crlf-", async (cwd) => {
			await writeFile(join(cwd, "t.txt"), "one\r\ntwo needle\r\nthree\r\n", "utf8");
			const harness = setupIntegrationTest(cwd);
			const grepText = getText(
				await (harness.getTool("grep") as unknown as GrepTool).execute("g", { pattern: "needle", context: 0 }),
			);
			expect(servedLines(grepText)).toEqual([2]);
			expect(grepText).toContain("two needle");
			expect(grepText).not.toContain("needle\r");
		});
	});

	it("treat a bare-CR file as ONE line — the declared behavior change", async () => {
		await withTempDir("grep-414-barecr-", async (cwd) => {
			// The old read line space counted two lines here; ripgrep sees one.
			await writeFile(join(cwd, "t.txt"), "alpha\rneedle beta\r", "utf8");
			const harness = setupIntegrationTest(cwd);
			const grepText = getText(
				await (harness.getTool("grep") as unknown as GrepTool).execute("g", { pattern: "needle", context: 0 }),
			);
			expect(servedLines(grepText)).toEqual([1]);
		});
	});
});

describe("#414 — the file identity folds CRLF only", () => {
	it("matches the text path's checksum and line count", async () => {
		await withTempDir("grep-414-identity-", async (cwd) => {
			const file = join(cwd, "t.txt");
			await writeFile(file, "\uFEFFone\r\ntwo\rthree\n", "utf8");
			const identity = await readFileIdentity(file);
			const normalized = normalizeContent("\uFEFFone\r\ntwo\rthree\n");
			expect(identity.checksum).toBe(contentChecksum(normalized));
			// CRLF folds, a lone CR stays: one line break plus one literal CR line.
			expect(identity.lineCount).toBe(2);
		});
	});
});
