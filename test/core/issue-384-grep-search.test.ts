/**
 * #384 — the search layer under `grep`: where a hit lands, and what happens
 * when the file changes after the search ran.
 *
 * Two things live here that the raw ripgrep hits do not carry:
 *
 * - the PLACEMENT of a hit in the read line space (ADR-0008): the read space
 *   folds a bare CR to LF, ripgrep counts LF only, and on a file that carries a
 *   bare CR the two count the file differently. The hit's offset inside its line
 *   says which line of the read space it is on;
 * - the DRIFT check: the search read the file, and the plugin reads it again. A
 *   file that changed in between has rows that are the search's SNAPSHOT, not the
 *   file's current text — and a row that claims to be a hit must really be one.
 *
 * @module dsh-hashline-edittool/issue-384-grep-search.test
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planGrepSearch } from "../../src/tools/grep-search.js";
import { withTempDir } from "../support/fixtures.js";

/** The lines of a text, in the read line space. */
function readLines(raw: string): string[] {
	const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	return raw.endsWith("\n") ? lines.slice(0, -1) : lines;
}

describe("#384 — the search layer places ripgrep's hits", () => {
	it("puts a bare-CR file's hit on the line the reader sees (#147)", async () => {
		await withTempDir("grep-384-search-barecr-", async (dir) => {
			const file = join(dir, "bare.txt");
			const raw = "alpha\rneedle in a file\rbeta\n";
			await writeFile(file, raw, "utf8");

			const plan = await planGrepSearch({
				pattern: "needle",
				regex: false,
				limit: 100,
				context: 0,
				files: [file],
			});

			const section = plan.sectionFor(file, { raw, lines: readLines(raw), lossy: false });

			// The read space counts three lines; ripgrep counts one. The hit is on the
			// SECOND — the line the reader sees.
			expect(section?.matches.map((row) => row.position)).toEqual([1]);
			expect(section?.matches[0]?.content).toBe("needle in a file");
			expect(section?.stale).toBe(false);
		});

	});

	it("places a hit that follows an astral character", async () => {
		await withTempDir("grep-384-search-emoji-", async (dir) => {
			const file = join(dir, "emoji.txt");
			// The emoji is FOUR bytes but TWO UTF-16 code units: a byte→character
			// conversion that walks code units overshoots the offset ripgrep
			// reported, and the hit's seat — and with it the hit — is lost.
			const raw = "alpha\r😀 needle here\rbeta\n";
			await writeFile(file, raw, "utf8");

			const plan = await planGrepSearch({
				pattern: "needle",
				regex: false,
				limit: 100,
				context: 0,
				files: [file],
			});

			const section = plan.sectionFor(file, { raw, lines: readLines(raw), lossy: false });

			expect(section?.matches.map((row) => row.position)).toEqual([1]);
			expect(section?.matches[0]?.content).toBe("😀 needle here");
		});
	});

	it("keeps a file that did not change live, with its context rows", async () => {
		await withTempDir("grep-384-search-live-", async (dir) => {
			const file = join(dir, "one.txt");
			const raw = "alpha\nneedle here\nomega\n";
			await writeFile(file, raw, "utf8");

			const plan = await planGrepSearch({
				pattern: "needle",
				regex: false,
				limit: 100,
				context: 1,
				files: [file],
			});

			const section = plan.sectionFor(file, { raw, lines: readLines(raw), lossy: false });

			expect(section?.stale).toBe(false);
			expect(section?.matches.map((row) => row.position)).toEqual([1]);
			// The context row above the hit is there — the file did not change.
			expect(section?.contextRows.map((row) => row.position)).toEqual([0, 1, 2]);
		});
	});

	it("serves a file that changed after the search as the snapshot it was", async () => {
		await withTempDir("grep-384-search-stale-", async (dir) => {
			const file = join(dir, "one.txt");
			await writeFile(file, "alpha\nneedle here\nomega\n", "utf8");

			const plan = await planGrepSearch({
				pattern: "needle",
				regex: false,
				limit: 100,
				context: 1,
				files: [file],
			});

			// The file changes between the search and the plugin's read: the line the
			// search found is no longer the line the file holds.
			const changed = "alpha\nsomething else\nomega\n";
			const section = plan.sectionFor(file, {
				raw: changed,
				lines: readLines(changed),
				lossy: false,
			});

			expect(section?.stale).toBe(true);
			// The rows are the search's snapshot — the text it found, not the file's
			// current text — and they carry no context rows (the search never
			// reported those).
			expect(section?.matches.map((row) => row.content)).toEqual(["needle here"]);
			expect(section?.contextRows).toHaveLength(1);
		});
	});
});
