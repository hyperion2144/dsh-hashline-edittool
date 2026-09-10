/**
 * Tests for the grep card derivation (issue #92 / ADR-0005).
 *
 * The card's pure half lives in `models.ts` precisely because the client test
 * environment renders no React (no jsdom): everything that decides WHAT the
 * card shows — the meta soft-validation, the highlight segmentation, the gutter
 * text, the footer counts and the row chrome — is asserted here. Keyboard and
 * focus behaviour is covered by the real-machine smoke instead.
 */
import { describe, expect, it } from "vitest";
import {
	grepGutterLabel,
	grepCardModel,
	grepPresentationMeta,
	grepResultCounts,
	highlightSegments,
	toolRowModel,
	foldTabs,
} from "../src/client/models.js";
import type { GrepCardModel, ToolCallBlock } from "../src/client/types.js";

/** Build a settled result node fixture. */
function settled(overrides: Partial<Extract<ToolCallBlock, { kind: "tool-result" }>> = {}): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "grep", argsRaw: '{"path":"src","pattern":"alpha"}' },
		callTime: 0,
		content: [],
		isError: false,
		subCalls: [],
		...overrides,
	};
}

/** A valid one-file, two-row grep meta (one match + one context row). */
function meta(): Record<string, unknown> {
	return {
		files: [
			{
				path: "src/a.ts",
				rows: [
					{ number: 12, hash: "a3f", text: "const alpha = 1;", match: true, spans: [[6, 11]] },
					{ number: 13, hash: "b7c", text: "const beta = 2;" },
				],
			},
		],
		truncated: false,
		total: 1,
	};
}

describe("grepCardModel", () => {
	it("derives the card from a settled grep result", () => {
		const model = grepCardModel(settled({ meta: meta() }));
		expect(model?.files).toHaveLength(1);
		expect(model?.files[0]?.path).toBe("src/a.ts");
		expect(model?.files[0]?.rows).toHaveLength(2);
		expect(model?.total).toBe(1);
		expect(model?.truncated).toBe(false);
	});

	it("degrades to the generic body for a running call", () => {
		const running: ToolCallBlock = {
			callId: "c1",
			name: "grep",
			argsRaw: '{"pattern":"alpha"}',
			turn: 1,
			step: 1,
			time: 0,
			subCalls: [],
		};
		expect(grepCardModel(running)).toBeNull();
	});

	it("degrades for errors, sub-calls and other tools", () => {
		expect(grepCardModel(settled({ meta: meta(), isError: true }))).toBeNull();
		expect(grepCardModel(settled({ meta: meta(), parentCallId: "p" }))).toBeNull();
		expect(grepCardModel(settled({ meta: meta(), call: { name: "read", argsRaw: "{}" } }))).toBeNull();
	});

	it("degrades for the pre-0.4.4 meta shape (tier 1)", () => {
		const legacy = { files: [{ path: "a", matches: [{ lineNumber: 1, line: "1:a: x" }] }], truncated: false, total: 1 };
		expect(grepCardModel(settled({ meta: legacy }))).toBeNull();
		expect(grepCardModel(settled({ meta: undefined }))).toBeNull();
	});

	it("renders the card without highlights when rows carry no spans (tier 2)", () => {
		const noSpans = {
			files: [{ path: "a.ts", rows: [{ number: 1, hash: "h", text: "alpha" }] }],
			truncated: false,
			total: 1,
		};
		const model = grepCardModel(settled({ meta: noSpans }));
		expect(model?.files[0]?.rows[0]?.spans).toBeUndefined();
	});

	it("keeps a zero-match result as a valid empty card", () => {
		const model = grepCardModel(settled({ meta: { files: [], truncated: false, total: 0 } }));
		expect(model).not.toBeNull();
		expect(model?.files).toEqual([]);
	});

	it("rejects a malformed row rather than rendering a broken card", () => {
		const bad = meta();
		(bad.files as { rows: unknown[] }[])[0]!.rows = [{ number: 1, hash: "h", text: "x", match: false }];
		expect(grepPresentationMeta(bad)).toBeNull();
	});
});

describe("highlightSegments", () => {
	it("returns one plain segment when there is nothing to highlight", () => {
		expect(highlightSegments("plain text", undefined)).toEqual([{ text: "plain text", hit: false }]);
		expect(highlightSegments("plain text", [])).toEqual([{ text: "plain text", hit: false }]);
		// An empty line has nothing to render at all.
		expect(highlightSegments("", undefined)).toEqual([]);
	});

	it("splits at a single occurrence", () => {
		expect(highlightSegments("const alpha = 1;", [[6, 11]])).toEqual([
			{ text: "const ", hit: false },
			{ text: "alpha", hit: true },
			{ text: " = 1;", hit: false },
		]);
	});

	it("marks every occurrence, including one that starts the line", () => {
		expect(highlightSegments("alpha beta alpha", [[0, 5], [11, 16]])).toEqual([
			{ text: "alpha", hit: true },
			{ text: " beta ", hit: false },
			{ text: "alpha", hit: true },
		]);
	});

	it("handles an occurrence that ends the line", () => {
		expect(highlightSegments("x alpha", [[2, 7]])).toEqual([
			{ text: "x ", hit: false },
			{ text: "alpha", hit: true },
		]);
	});

	it("clamps out-of-range offsets instead of losing text", () => {
		expect(highlightSegments("abc", [[1, 99]])).toEqual([
			{ text: "a", hit: false },
			{ text: "bc", hit: true },
		]);
		expect(highlightSegments("abc", [[99, 120]])).toEqual([{ text: "abc", hit: false }]);
	});

	it("skips overlapping spans (a hand-edited payload cannot duplicate text)", () => {
		// The union of [0,3) and [1,5) is [0,5): one merged mark, then the tail.
		expect(highlightSegments("abcdef", [[0, 3], [1, 5]])).toEqual([
			{ text: "abcde", hit: true },
			{ text: "f", hit: false },
		]);
	});

	it("always reproduces the input text exactly, byte for byte", () => {
		const cases: [string, [number, number][] | undefined][] = [
			["const alpha = 1;", [[6, 11]]],
			["alpha beta alpha", [[0, 5], [11, 16]]],
			["π and π", [[0, 1], [6, 7]]],
			["", [[0, 4]]],
			["tail-only", [[5, 9]]],
			["overlap", [[0, 3], [1, 5]]],
			["clamped", [[2, 999]]],
		];
		for (const [text, spans] of cases) {
			expect(highlightSegments(text, spans).map((segment) => segment.text).join(""), text).toBe(text);
		}
	});
});

describe("grepGutterLabel", () => {
	it("draws `行号:锚点`", () => {
		expect(grepGutterLabel({ number: 12, hash: "a3f", text: "" })).toBe("12:a3f");
	});

	it("falls back to the bare line number when the anchor is unknown", () => {
		expect(grepGutterLabel({ number: 12, hash: "", text: "" })).toBe("12");
	});
});

describe("grepResultCounts", () => {
	it("counts match rows across the whole result, not just one tab", () => {
		const model: GrepCardModel = {
			files: [
				{
					path: "a.ts",
					rows: [
						{ number: 1, hash: "h1", text: "alpha", match: true },
						{ number: 2, hash: "h2", text: "alpha too" },
					],
				},
				{ path: "b.ts", rows: [{ number: 9, hash: "h9", text: "alpha", match: true }] },
			],
			truncated: false,
			total: 7,
		};
		expect(grepResultCounts(model)).toEqual({ shown: 2, total: 7, files: 2 });
	});
});

describe("grep row chrome", () => {
	it("mirrors the shipped search row: grep variant, Grep title, pattern summary", () => {
		const model = toolRowModel("grep", settled(), "/work", "/home/me");
		expect(model.variant).toBe("grep");
		expect(model.titleKey).toBe("tool.title.grep");
		expect(model.summary).toBe("alpha");
		// A search root is not an openable file: the row draws no file link.
		expect(model.filePath).toBeUndefined();
	});
});

describe("foldTabs", () => {
	/** `count` tabs of equal width. */
	const even = (count: number, width: number): number[] => Array.from({ length: count }, () => width);

	it("keeps every tab when the strip fits", () => {
		expect(foldTabs(even(3, 100), 300, 36, 0)).toEqual({ visible: [0, 1, 2], folded: [] });
	});

	it("folds trailing tabs once the strip overflows, reserving the trigger", () => {
		// 6 × 100 = 600 in a 320px strip that must leave 36px for the trigger:
		// two tabs fit (200 + 36 <= 320), the rest fold.
		const fold = foldTabs(even(6, 100), 320, 36, 0);
		expect(fold.visible).toEqual([0, 1]);
		expect(fold.folded).toEqual([2, 3, 4, 5]);
	});

	it("keeps the active tab visible when it would have been folded", () => {
		const fold = foldTabs(even(6, 100), 320, 36, 4);
		// Two tabs fit; the active one takes the last slot and the tab it
		// displaced moves into the menu instead.
		expect(fold.visible).toContain(4);
		expect(fold.visible).toEqual([0, 4]);
		expect(fold.folded).not.toContain(4);
	});

	it("drops prefix tabs when the pinned tab is wider than the one it displaced", () => {
		const widths = [100, 100, 100, 400];
		const fold = foldTabs(widths, 320, 36, 3);
		// 100 + 400 + 36 > 320, so the first tab goes too; the active one stays.
		expect(fold.visible).toEqual([3]);
		expect(fold.folded).toEqual([0, 1, 2]);
	});

	it("still shows the active tab when nothing fits beside the trigger", () => {
		const fold = foldTabs(even(4, 500), 200, 36, 2);
		expect(fold.visible).toEqual([2]);
		expect(fold.folded).toEqual([0, 1, 3]);
	});

	it("folds everything but the first tab when the active one is first", () => {
		const fold = foldTabs(even(5, 100), 250, 36, 0);
		expect(fold.visible).toEqual([0, 1]);
		expect(fold.folded).toEqual([2, 3, 4]);
	});

	it("never folds the only tab, even in a strip narrower than it", () => {
		// A single-match result keeps its tab: fitting is best-effort, the tab
		// is not.
		expect(foldTabs([300], 120, 36, 0)).toEqual({ visible: [0], folded: [] });
	});

	it("handles an empty strip and an out-of-range active index", () => {
		expect(foldTabs([], 300, 36, 0)).toEqual({ visible: [], folded: [] });
		const fold = foldTabs(even(3, 200), 100, 36, 99);
		expect(fold.visible).toEqual([2]);
	});

	it("treats a zero-width container as unmeasured input without crashing", () => {
		const fold = foldTabs(even(3, 100), 0, 36, 0);
		expect(fold.visible).toEqual([0]);
		expect(fold.folded).toEqual([1, 2]);
	});
});
