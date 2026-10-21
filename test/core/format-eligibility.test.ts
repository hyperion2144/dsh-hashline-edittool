/**
 * Eligibility and the format section — decision B's gate and display.
 *
 * The gate: model-touched lines are ALWAYS eligible; formatter-touched lines
 * inherit eligibility from their pre-call sources' served anchors. The
 * The display: changed addressable rows only (ineligible rows are omitted
 * entirely — the #275 follow-up ruling), main-diff duplicates counted only
 * (`inMainDiffRows`, #312 — the main diff already carries them), and
 * `unservedRows` the honest "you cannot address this" count.
 */
import { describe, expect, it } from "vitest";
import { computeRowEligibility } from "../../src/domain/format/eligibility.js";
import {
	buildFormatSection,
	formatterChangedLines,
} from "../../src/domain/format/format-section.js";
import { lineMapFromTextEdits } from "../../src/domain/format/provenance.js";

describe("computeRowEligibility", () => {
	it("marks model-touched lines eligible regardless of served state", () => {
		const eligibility = computeRowEligibility({
			finalLineCount: 2,
			provenance: new Map(),
			modelTouched: new Set([2]),
			preCallHashes: [],
			served: new Set(),
		});
		expect(eligibility.get(2)).toBe(true);
	});

	it("inherits served-ness through the provenance map by content", () => {
		const eligibility = computeRowEligibility({
			finalLineCount: 2,
			provenance: new Map([
				[1, new Set([1])],
				[2, new Set([2])],
			]),
			modelTouched: new Set(),
			preCallHashes: ["AAA", "BBB"],
			served: new Set(["AAA"]), // pre-call line 1 was shown this session
		});
		expect(eligibility.get(1)).toBe(true);
		expect(eligibility.get(2)).toBe(false);
	});

	it("any served source in a merged set makes the line eligible", () => {
		const eligibility = computeRowEligibility({
			finalLineCount: 1,
			provenance: new Map([[1, new Set([1, 2])]]),
			modelTouched: new Set(),
			preCallHashes: ["AAA", "BBB"],
			served: new Set(["BBB"]),
		});
		expect(eligibility.get(1)).toBe(true);
	});

	it("formatter-invented lines (no provenance) are ineligible", () => {
		const eligibility = computeRowEligibility({
			finalLineCount: 1,
			provenance: new Map(),
			modelTouched: new Set(),
			preCallHashes: ["AAA"],
			served: new Set(["AAA"]),
		});
		expect(eligibility.get(1)).toBe(false);
	});
});

describe("formatterChangedLines", () => {
	it("flags re-indented, inserted, and merged lines", () => {
		const modelLines = ["one", "two", "three"];
		const finalLines = ["one", "  two", "extra", "three-or-so"];
		// Line 2 re-indented; line 3 inserted; line 4 merges old "three" with text.
		const map = new Map([
			[1, new Set([1])],
			[2, new Set([2])],
			[3, new Set([2])],
			[4, new Set([3])],
		]);
		expect(formatterChangedLines(modelLines, finalLines, map)).toEqual(new Set([2, 3, 4]));
	});

	it("leaves identical untouched lines alone", () => {
		const lines = ["a", "b"];
		const map = lineMapFromTextEdits(2, []);
		expect(formatterChangedLines(lines, lines, map)).toEqual(new Set());
	});
});

describe("buildFormatSection", () => {
	it("renders skipped as status + reason only", () => {
		const section = buildFormatSection({
			status: "skipped",
			server: "gopls",
			reason: "no formatting provider",
			finalLines: [],
			finalHashes: [],
			changed: new Set(),
			eligibility: new Map(),
			alsoInMain: new Set(),
		});
		expect(section).toEqual({
			status: "skipped",
			server: "gopls",
			reason: "no formatting provider",
		});
	});

	it("gives eligible rows the final anchor, omits ineligible rows", () => {
		const section = buildFormatSection({
			status: "formatted",
			server: "typescript-language-server",
			mode: "range",
			requested: 2,
			applied: 1,
			finalLines: ["a", "  b", "c!"],
			finalHashes: ["h1", "h2", "h3"],
			changed: new Set([2, 3]),
			eligibility: new Map([
				[2, true],
				[3, false],
			]),
			alsoInMain: new Set(),
		});
		expect(section.changedLines).toBe(2);
		expect(section.unservedRows).toBe(1);
		// The #275 follow-up ruling: an inline section never surfaces content the
		// model has no standing view of — line 3 returns nothing, only the count.
		expect(section.rows).toEqual([
			{ kind: "+", lineNumber: 2, hash: "h2", text: "  b" },
		]);
		expect(section.inMainDiffRows).toBe(0);
	});

	it("counts rows the main diff already shows and returns them in no form (#312)", () => {
		const section = buildFormatSection({
			status: "formatted",
			finalLines: ["x", "y!"],
			finalHashes: ["h1", ""],
			changed: new Set([1, 2]),
			eligibility: new Map([
				[1, false],
				[2, false],
			]),
			alsoInMain: new Set([1]),
		});
		expect(section.unservedRows).toBe(1); // only line 2 (line 1 is in the main diff)
		expect(section.inMainDiffRows).toBe(1);
		// #312: the main diff already shows line 1 — the section returns it in
		// NO form (no content, no anchor), only the count.
		expect(section.rows).toEqual([]);
	});

	it("counts a served in-main line without re-minting its anchor", () => {
		const section = buildFormatSection({
			status: "formatted",
			finalLines: ["x", "y"],
			finalHashes: ["h1", "h2"],
			changed: new Set([1, 2]),
			eligibility: new Map([
				[1, true],
				[2, true],
			]),
			alsoInMain: new Set([1]),
		});
		expect(section.inMainDiffRows).toBe(1);
		expect(section.unservedRows).toBe(0);
		expect(section.rows).toEqual([{ kind: "+", lineNumber: 2, hash: "h2", text: "y" }]);
	});

	it("renders noop with no rows", () => {
		const section = buildFormatSection({
			status: "noop",
			server: "gopls",
			finalLines: [],
			finalHashes: [],
			changed: new Set(),
			eligibility: new Map(),
			alsoInMain: new Set(),
		});
		expect(section.status).toBe("noop");
		expect(section.rows).toBeUndefined();
	});

	describe("restored runs (#315 PR review)", () => {
		it("collapses a pre-edit-identical line into restoredRows + a cluster, not a row", () => {
			const section = buildFormatSection({
				status: "formatted",
				finalLines: ["return 1;", "brandNew"],
				finalHashes: ["h1", "h2"],
				changed: new Set([1, 2]),
				eligibility: new Map([
					[1, true],
					[2, true],
				]),
				alsoInMain: new Set(),
				preEditLines: ["return 1;", "old"],
				finalText: "return 1;\nbrandNew",
				path: "a.ts",
			});
			// Line 1's final text exists in the pre-edit lines — old news, the
			// locator+summary carries it; line 2's text is genuinely new (k >
			// preCount) so it stays a drift row.
			expect(section.restoredRows).toBe(1);
			expect(section.rows).toEqual([{ kind: "+", lineNumber: 2, hash: "h2", text: "brandNew" }]);
			expect(section.clusters).toEqual([{ startLine: 1, lines: 2, restored: 1 }]);
		});

		it("keeps the second occurrence of duplicated text as a drift row", () => {
			const section = buildFormatSection({
				status: "formatted",
				finalLines: ["NEW", "NEW"],
				finalHashes: ["h1", "h2"],
				changed: new Set([1, 2]),
				eligibility: new Map([
					[1, true],
					[2, true],
				]),
				alsoInMain: new Set(),
				preEditLines: ["NEW"],
			});
			expect(section.restoredRows).toBe(1);
			expect(section.rows).toEqual([{ kind: "+", lineNumber: 2, hash: "h2", text: "NEW" }]);
			expect(section.clusters).toEqual([{ startLine: 1, lines: 2, restored: 1 }]);
		});

		it("emits nothing when there are no pre-edit lines to compare (manual)", () => {
			const section = buildFormatSection({
				status: "formatted",
				finalLines: ["x"],
				finalHashes: ["h1"],
				changed: new Set([1]),
				eligibility: new Map([[1, true]]),
				alsoInMain: new Set(),
			});
			expect(section.restoredRows).toBeUndefined();
			expect(section.clusters).toBeUndefined();
			expect(section.rows).toEqual([{ kind: "+", lineNumber: 1, hash: "h1", text: "x" }]);
		});
	});
});
