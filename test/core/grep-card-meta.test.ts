/**
 * Tests for the grep card contract (issue #92 / ADR-0005).
 *
 * Three layers are covered:
 * - `matchSpans`: the pure highlight-span scan (all occurrences, regex whole
 *   match, zero-width skipped, literal mode, unicode).
 * - `capGrepMeta` / `grepPresentationFromMeta`: the byte budget and the soft
 *   validation that separates the card's three degradation tiers.
 * - the tool end-to-end: rows carry identity + `match` + `spans`, context rows
 *   are highlighted but not flagged, and `presentResult` lists only matches.
 */
import { describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest } from "../support/fixtures.js";
import {
	GREP_META_MAX_BYTES,
	capGrepMeta,
	grepPresentationFromMeta,
	matchSpans,
	type GrepPresentation,
} from "../../src/presentation-helpers.js";

/** Build a one-file meta with `count` rows of `text`, padded to reach a size. */
function metaWithRows(count: number, text: string): GrepPresentation {
	return {
		files: [
			{
				path: "big.txt",
				rows: Array.from({ length: count }, (_, i) => ({
					number: i + 1,
					hash: `h${i}`,
					text,
				})),
			},
		],
		truncated: false,
		total: count,
	};
}

describe("matchSpans", () => {
	it("marks every occurrence of a literal pattern", () => {
		expect(matchSpans("aXaXa", "a", false)).toEqual([
			[0, 1],
			[2, 3],
			[4, 5],
		]);
		expect(matchSpans("no hits here", "zzz", false)).toEqual([]);
	});

	it("marks every occurrence in regex mode too", () => {
		expect(matchSpans("alpha beta alpha", "alpha", true)).toEqual([
			[0, 5],
			[11, 16],
		]);
	});

	it("highlights the WHOLE match, never a capture group", () => {
		// The group `(b+)` matches "bb", but the whole match is "abba".
		expect(matchSpans("xabbay", "a(b+)a", true)).toEqual([[1, 5]]);
	});

	it("skips zero-width matches instead of looping forever", () => {
		expect(matchSpans("bbb", "^", true)).toEqual([]);
		expect(matchSpans("bbb", "b*", true)).toEqual([[0, 3]]);
		expect(matchSpans("abc", "", true)).toEqual([]);
		expect(matchSpans("abc", "", false)).toEqual([]);
	});

	it("scans non-overlapping left to right", () => {
		// "aa" in "aaaa" gives [0,2) and [2,4) — never the overlapping [1,3).
		expect(matchSpans("aaaa", "aa", true)).toEqual([
			[0, 2],
			[2, 4],
		]);
	});

	it("returns offsets usable by String#slice (UTF-16 units)", () => {
		const text = "π alπha π";
		const spans = matchSpans(text, "π", true);
		expect(spans.map(([start, end]) => text.slice(start, end))).toEqual(["π", "π", "π"]);
	});

	it("returns nothing for an invalid regex instead of throwing", () => {
		expect(matchSpans("abc", "([", true)).toEqual([]);
	});
});

describe("capGrepMeta", () => {
	it("returns the projection untouched when it fits the budget", () => {
		const meta = metaWithRows(3, "short");
		expect(capGrepMeta(meta)).toBe(meta);
	});

	it("drops TRAILING file groups until the payload fits, reporting the loss", () => {
		const row = { number: 1, hash: "h", text: "x".repeat(4096) };
		const meta: GrepPresentation = {
			files: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.txt`, rows: [row] })),
			truncated: false,
			total: 40,
		};
		const capped = capGrepMeta(meta);
		expect(capped.files.length).toBeGreaterThanOrEqual(1);
		expect(capped.files.length).toBeLessThan(40);
		expect(capped.truncated).toBe(true);
		// `total` counts what the search FOUND, not what the meta retained.
		expect(capped.total).toBe(40);
		expect(Buffer.byteLength(JSON.stringify(capped), "utf8")).toBeLessThanOrEqual(GREP_META_MAX_BYTES);
		// Dropping is from the tail: the head survives in order.
		expect(capped.files[0]?.path).toBe("f0.txt");
	});

	it("keeps a single oversized group rather than hiding a real result", () => {
		const meta = metaWithRows(4, "y".repeat(GREP_META_MAX_BYTES));
		const capped = capGrepMeta(meta);
		expect(capped.files).toHaveLength(1);
		expect(capped.truncated).toBe(true);
	});

	it("never mutates the input", () => {
		const meta: GrepPresentation = {
			files: Array.from({ length: 40 }, () => ({ path: "f.txt", rows: [{ number: 1, hash: "h", text: "z".repeat(4096) }] })),
			truncated: false,
			total: 40,
		};
		const before = meta.files.length;
		capGrepMeta(meta);
		expect(meta.files).toHaveLength(before);
		expect(meta.truncated).toBe(false);
	});
});

describe("grepPresentationFromMeta (three degradation tiers)", () => {
	const valid: GrepPresentation = {
		files: [{ path: "a.txt", rows: [{ number: 1, hash: "h1", text: "hi", match: true, spans: [[0, 2]] }] }],
		truncated: false,
		total: 1,
	};

	it("accepts a well-formed row projection (tier 3: highlighted)", () => {
		expect(grepPresentationFromMeta(valid)).toBe(valid);
	});

	it("accepts rows without spans (tier 2: card renders unhighlighted)", () => {
		const noSpans: GrepPresentation = {
			files: [{ path: "a.txt", rows: [{ number: 4, hash: "h4", text: "hi" }] }],
			truncated: false,
			total: 1,
		};
		expect(grepPresentationFromMeta(noSpans)).toBe(noSpans);
	});

	it("accepts a zero-match result as a valid EMPTY card", () => {
		const empty: GrepPresentation = { files: [], truncated: false, total: 0 };
		expect(grepPresentationFromMeta(empty)).toBe(empty);
	});

	it("rejects the pre-0.4.4 shape (tier 1: generic fallback)", () => {
		const legacy = {
			files: [{ path: "a.txt", matches: [{ lineNumber: 1, line: "1:h1: hi" }] }],
			truncated: false,
			total: 1,
		};
		expect(grepPresentationFromMeta(legacy)).toBeUndefined();
	});

	it("rejects malformed rows and metadata", () => {
		const cases: unknown[] = [
			undefined,
			null,
			[],
			{},
			{ files: "nope", truncated: false, total: 0 },
			{ files: [{ path: 1, rows: [] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: "nope" }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 0, hash: "h", text: "t" }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: 2, text: "t" }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: "h", text: 2 }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: "h", text: "t", match: false }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: "h", text: "t", spans: [[2, 2]] }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: "h", text: "t", spans: [[1]] }] }], truncated: false, total: 0 },
			{ files: [{ path: "a", rows: [{ number: 1, hash: "h", text: "t", spans: [[-1, 2]] }] }], truncated: false, total: 0 },
			{ files: [], truncated: "no", total: 0 },
			{ files: [], truncated: false, total: -1 },
		];
		for (const value of cases) {
			expect(grepPresentationFromMeta(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

describe("grep tool card projection (end to end)", () => {
	/** Drive the built grep tool against one temp file. */
	async function runGrep(
		fileName: string,
		content: string,
		args: Record<string, unknown>,
	): Promise<{
		value: {
			files: {
				path: string;
				rows: { number: number; hash: string; text: string; match?: true; spans?: [number, number][] }[];
			}[];
			truncated: boolean;
			total: number;
			modelText: string;
		};
		exec: unknown;
	}> {
		let captured: Awaited<ReturnType<typeof runGrep>> | undefined;
		await withTempFile(fileName, content, async ({ cwd }) => {
			const { ctx } = setupIntegrationTest(cwd);
			const { buildGrepTool } = await import("../../src/tool-grep.js");
			const { localIO } = await import("../../src/fs-bridge.js");
			const tool = buildGrepTool(localIO());
			const exec = (inner: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: inner,
				}) as never;
			const value = await tool.execute(args, exec(ctx));
			captured = { value: value as never, exec };
		});
		return captured!;
	}

	it("gives context rows highlight spans but no match flag", async () => {
		const { value } = await runGrep("ctx.txt", "one\nalpha here\ntwo\nthree\nfour\n", {
			path: "ctx.txt",
			pattern: "alpha",
			context: 1,
		});
		const rows = value.files[0]!.rows;
		expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
		expect(rows.map((row) => row.match === true)).toEqual([false, true, false]);
		// No context row contains the pattern here, so only the match is marked.
		expect(rows[1]?.spans).toEqual([[0, 5]]);
		expect(rows[0]?.spans).toBeUndefined();
	});

	it("highlights a context row that happens to contain the pattern", async () => {
		// Line 3 repeats the pattern but the per-file limit caps the match list at
		// line 1; line 3 still arrives as context and keeps its spans.
		const { value } = await runGrep("cap.txt", "alpha\nalpha again\nalpha\n", {
			path: "cap.txt",
			pattern: "alpha",
			limit: 1,
			context: 2,
		});
		const rows = value.files[0]!.rows;
		expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
		expect(rows.filter((row) => row.match === true).map((row) => row.number)).toEqual([1]);
		// Every row carries its own spans — the identity lives on the row, so a
		// context line is never muddled with the match line (the pre-0.4.4 bug).
		expect(rows[0]?.spans).toEqual([[0, 5]]);
		expect(rows[1]?.spans).toEqual([[0, 5]]);
		expect(rows[2]?.spans).toEqual([[0, 5]]);
		expect(value.truncated).toBe(true);
	});

	it("reports a zero-match search as an empty, valid card", async () => {
		const { value } = await runGrep("none.txt", "alpha\nbeta\n", { path: "none.txt", pattern: "zzz" });
		expect(value.files).toEqual([]);
		expect(value.total).toBe(0);
		expect(value.truncated).toBe(false);
		expect(grepPresentationFromMeta(value)).toBeDefined();
	});

	it("keeps the model text byte-identical while the card gains spans", async () => {
		const { value } = await runGrep("both.txt", "aa bb aa\n", { path: "both.txt", pattern: "aa" });
		expect(value.files[0]?.rows[0]?.spans).toEqual([
			[0, 2],
			[6, 8],
		]);
		// The row text is the line verbatim (no gutter, no rendering artifacts).
		expect(value.files[0]?.rows[0]?.text).toBe("aa bb aa");
		expect(value.modelText).toContain("aa bb aa");
		expect(value.modelText).toMatch(/^--- both\.txt ---$/m);
	});

	it("presentResult lists only the match rows in the built-in search view", async () => {
		const { buildGrepTool } = await import("../../src/tool-grep.js");
		const { localIO } = await import("../../src/fs-bridge.js");
		const tool = buildGrepTool(localIO());
		const meta = {
			files: [
				{
					path: "a.txt",
					rows: [
						{ number: 1, hash: "h1", text: "alpha", match: true, spans: [[0, 5]] },
						{ number: 2, hash: "h2", text: "alpha again", spans: [[0, 5]] },
					],
				},
			],
			truncated: false,
			total: 1,
		};
		const view = tool.presentResult!({ path: "a.txt", pattern: "alpha" }, { isError: false, meta } as never) as {
			card: string;
			shape: string;
			files: { path: string; matches: { lineNumber: number; line: string }[] }[];
			truncated: boolean;
			total: number;
		};
		expect(view.card).toBe("search");
		expect(view.shape).toBe("matches");
		// The context row (line 2) carries spans but is not a result.
		expect(view.files[0]?.matches).toEqual([{ lineNumber: 1, line: "alpha" }]);
		expect(view.truncated).toBe(false);
		expect(view.total).toBe(1);
	});

	it("presentResult declines errors and the pre-0.4.4 meta shape", async () => {
		const { buildGrepTool } = await import("../../src/tool-grep.js");
		const { localIO } = await import("../../src/fs-bridge.js");
		const tool = buildGrepTool(localIO());
		const args = { path: "a.txt", pattern: "alpha" };
		expect(tool.presentResult!(args, { isError: true } as never)).toBeUndefined();
		expect(
			tool.presentResult!(args, { isError: false, meta: { files: [{ path: "a", matches: [] }], truncated: false, total: 0 } } as never),
		).toBeUndefined();
	});
});
