/**
 * The structural-summary layer: the gate, the renderer, the shrink rule and
 * the elision computation (the last through the real worker, so the node types
 * are the grammar's and not a guess).
 */
import { describe, expect, it } from "vitest";
import {
	ELISION_MARKER,
	containsElisionMarker,
	renderSummary,
	servedRowsFor,
	summaryFooter,
	summaryGate,
	summaryIsWorthIt,
} from "../../src/read-summary.js";
import {
	AST_SUMMARY_MAX_BYTES,
	AST_SUMMARY_MIN_TOTAL_LINES,
	AST_SUMMARY_MIN_BODY_LINES,
	AST_SUMMARY_MIN_COMMENT_LINES,
} from "../../src/constants.js";
import { handleRequest } from "../../src/ast/worker.js";
import type { ElisionSpan } from "../../src/ast/elide.js";

describe("summary gate", () => {
	it("refuses a file below the low gate, which is what keeps small files unchanged", () => {
		expect(summaryGate({ totalLines: AST_SUMMARY_MIN_TOTAL_LINES - 1, byteLength: 100 })).toBe("too-few-lines");
		expect(summaryGate({ totalLines: AST_SUMMARY_MIN_TOTAL_LINES, byteLength: 100 })).toBeUndefined();
	});

	it("refuses an over-large file", () => {
		// The line gate is checked first, so the sample must clear it for the
		// byte gate to be the one that answers.
		expect(summaryGate({ totalLines: AST_SUMMARY_MIN_TOTAL_LINES, byteLength: AST_SUMMARY_MAX_BYTES + 1 })).toBe("too-many-bytes");
	});
});

describe("summary rendering", () => {
	const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
	const hashes = lines.map((_, index) => `h${index + 1}`);
	// Fold lines 3..7 (opener 2, closer 8).
	const spans: ElisionSpan[] = [{ startLine: 3, endLine: 7, openerLine: 2, closerLine: 8, kind: "body" }];

	it("keeps every other line verbatim and merges only the folded pair", () => {
		const rendered = renderSummary({ lines, hashes, spans });
		const merged = rendered.rows.filter((row) => row.merged);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.number).toBe(2);
		expect(merged[0]!.endNumber).toBe(8);
		expect(merged[0]!.text).toBe(`b ${ELISION_MARKER} h`);
		// The anchor is the OPENER's: it is the line an edit names to replace
		// the whole construct.
		expect(merged[0]!.anchor).toBe("h2");
		expect(rendered.elidedLines).toBe(5);
	});

	it("keeps kept rows byte-identical", () => {
		const rendered = renderSummary({ lines, hashes, spans });
		const kept = rendered.rows.filter((row) => !row.merged);
		expect(kept.map((row) => row.text)).toEqual(["a", "i", "j"]);
	});

	it("serves both endpoints of a fold and nothing inside it", () => {
		const rendered = renderSummary({ lines, hashes, spans });
		expect(rendered.servedLines).toEqual([1, 2, 8, 9, 10]);
		// This is what makes "read the outline, then replace the block" work:
		// the edit contract requires the block's LAST line to be served.
		expect(rendered.servedLines).toContain(8);
		for (const interior of [3, 4, 5, 6, 7]) {
			expect(rendered.servedLines).not.toContain(interior);
		}
	});

	it("builds served rows in the store's own shape (drift key included)", () => {
		const rendered = renderSummary({ lines, hashes, spans });
		const rows = servedRowsFor(rendered, lines, hashes);
		expect(rows.map((row) => row.position)).toEqual([0, 1, 7, 8, 9]);
		expect(rows[0]!.anchor).toBe("h1");
		expect(rows.every((row) => typeof row.contentKey === "string" && row.contentKey.length > 0)).toBe(true);
	});
});

describe("shrink rule and footer", () => {
	it("refuses an outline that is not meaningfully shorter than the source", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		const hashes = lines.map(() => "a");
		// One tiny fold in a hundred lines: the outline is ~99% of the source,
		// which is worse than the source because it replaced the content.
		const rendered = renderSummary({
			lines,
			hashes,
			spans: [{ startLine: 2, endLine: 4, openerLine: 1, closerLine: 5, kind: "body" }],
		});
		expect(summaryIsWorthIt(rendered, lines.length)).toBe(false);
	});

	it("accepts an outline that folds most of the file", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		const hashes = lines.map(() => "a");
		const rendered = renderSummary({
			lines,
			hashes,
			spans: [{ startLine: 2, endLine: 99, openerLine: 1, closerLine: 100, kind: "body" }],
		});
		expect(summaryIsWorthIt(rendered, lines.length)).toBe(true);
	});

	it("names re-read ranges in the footer", () => {
		const lines = ["a", "b", "c", "d"];
		const rendered = renderSummary({
			lines,
			hashes: ["h1", "h2", "h3", "h4"],
			spans: [{ startLine: 1, endLine: 1, openerLine: 1, closerLine: 1, kind: "body" }],
		});
		expect(summaryFooter({ path: "a.ts", rendered })).toContain("a.ts:");
		expect(summaryFooter({ path: "a.ts", rendered })).toContain("ln elided");
	});
});

describe("elision marker", () => {
	it("uses U+2026, never three dots", () => {
		expect(ELISION_MARKER).toBe("\u2026");
		// `...` is a legal token in JavaScript and Python, so an edit payload
		// containing it could not be distinguished from real code.
		expect(containsElisionMarker("export function a() { ... }")).toBe(false);
		expect(containsElisionMarker(`export function a() { ${ELISION_MARKER} }`)).toBe(true);
	});
});

/**
 * A file shaped like the real thing: imports to fold, a documented class, a
 * function whose signature spans two lines, and a body long enough to clear
 * the floor. Deliberately not minimal — the elision rules all key off shape.
 */
function summaryFixture(): string {
	return [
		"import { a } from './a';",
		"import { b } from './b';",
		"import { c } from './c';",
		"import { d } from './d';",
		"",
		"/**",
		" * A documented class.",
		" *",
		" * With a body long enough to fold.",
		" */",
		"export class Box {",
		"\tvalue = 1;",
		"\tother = 2;",
		"\tthird = 3;",
		"\tmethod(): number {",
		"\t\treturn this.value;",
		"\t}",
		"}",
		"",
		"export function alpha(",
		"\tinput: number,",
		"): number {",
		"\tconst doubled = input * 2;",
		"\tconst tripled = input * 3;",
		"\tconst summed = doubled + tripled;",
		"\tconst squared = summed * summed;",
		"\treturn squared;",
		"}",
		"",
		"export const beta = 2;",
	].join("\n");
}

describe("elision computation (real grammar)", () => {

	it("folds a function body's interior and keeps the signature lines", async () => {
		const source = summaryFixture();
		const response = await handleRequest({
			id: 1,
			op: "summary",
			path: "a.ts",
			text: source,
			languageId: "typescript",
			minBodyLines: AST_SUMMARY_MIN_BODY_LINES,
			minCommentLines: AST_SUMMARY_MIN_COMMENT_LINES,
		});
		expect(response.ok).toBe(true);
		if (!response.ok || response.op !== "summary") return;
		expect(response.spans.length).toBeGreaterThan(0);
		// Every span leaves its delimiter lines in the output.
		for (const span of response.spans) {
			expect(span.startLine).toBe(span.openerLine + 1);
			expect(span.endLine).toBe(span.closerLine - 1);
		}
		const lines = source.split("\n");
		// Spans are ordered by start line, so the import run comes first; find
		// the function's fold by what its opener line actually says.
		// A body fold's opener is the line carrying `{`, NOT the declaration's
		// first line — which is exactly why a multi-line signature survives: its
		// earlier lines are ordinary kept rows.
		const braceLine = lines.findIndex((line) => line.trim() === "): number {") + 1;
		const fnSpan = response.spans.find((span) => span.openerLine === braceLine);
		expect(fnSpan).toBeDefined();
		expect(lines[fnSpan!.closerLine - 1]!.trim()).toBe("}");
		// Both signature lines stay outside the fold, so nothing is reconstructed.
		expect(fnSpan!.startLine).toBeGreaterThan(braceLine);
	});

	it("returns top-level, disjoint spans only", async () => {
		const response = await handleRequest({
			id: 2,
			op: "summary",
			path: "a.ts",
			text: summaryFixture(),
			languageId: "typescript",
			minBodyLines: AST_SUMMARY_MIN_BODY_LINES,
			minCommentLines: AST_SUMMARY_MIN_COMMENT_LINES,
		});
		if (!response.ok || response.op !== "summary") return;
		for (let i = 1; i < response.spans.length; i++) {
			expect(response.spans[i]!.startLine).toBeGreaterThan(response.spans[i - 1]!.endLine);
		}
	});
});
