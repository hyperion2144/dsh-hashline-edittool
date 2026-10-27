import { describe, expect, it } from "vitest";

import { buildDisplayRows, copyText, foldWindow, gutterLabel, isContentRow } from "../src/client/diff-rows.js";
import type { DiffContentRowMeta, DiffRowMeta } from "../src/client/types.js";

/** One CONTENT row — a line of the file. */
function content(kind: DiffContentRowMeta["kind"], lineNumber: number, hash: string, text: string): DiffContentRowMeta {
	return { kind, lineNumber, hash, text };
}

/** One SEGMENT HEADER — the `@@ -a,b +c,d @@ scope()` line (#295). */
function hunk(text: string): DiffRowMeta {
	return { kind: "hunk", text };
}

describe("buildDisplayRows (the drawn rows, #295)", () => {
	it("draws a segment header as its own row: no gutter, the header text", () => {
		const display = buildDisplayRows([hunk("@@ -194,7 +194,7 @@ myersRange()"), content(" ", 194, "C7", "const x = 1;")]);
		expect(display.map((row) => row.kind)).toEqual(["hunk", "ctx"]);
		expect(display[0]!.gutter).toBe("");
		expect(display[0]!.text).toBe("@@ -194,7 +194,7 @@ myersRange()");
	});

	it("keeps the gutter label of every content row", () => {
		expect(gutterLabel(content("-", 21, "C7", "old"))).toBe("-21:C7");
		expect(gutterLabel(content("+", 21, "h2", "new"))).toBe("+21:h2");
		expect(gutterLabel(content(" ", 20, "Cg", "keep"))).toBe("20:Cg");
		const display = buildDisplayRows([content("-", 21, "C7", "old"), content("+", 21, "h2", "new"), content(" ", 20, "Cg", "keep")]);
		expect(display.map((row) => row.gutter)).toEqual(["-21:C7", "+21:h2", "20:Cg"]);
	});

	it("renders a blank hash as a bare line number — the confirmation gutter (#354)", () => {
		expect(gutterLabel(content("+", 21, "", "new"))).toBe("+21");
		expect(gutterLabel(content("-", 21, "", "old"))).toBe("-21");
		expect(gutterLabel(content(" ", 20, "", "keep"))).toBe("20");
		const display = buildDisplayRows([content("+", 21, "", "new")]);
		expect(display[0]!.gutter).toBe("+21");
	});

	it("suppresses the line-number gap at a segment boundary — the header IS the boundary", () => {
		const display = buildDisplayRows([content(" ", 10, "a1", "first"), hunk("@@ -10,1 +10,1 @@ scope()"), content(" ", 20, "a2", "second")]);
		expect(display.map((row) => row.kind)).toEqual(["ctx", "hunk", "ctx"]);
	});

	it("still shows the line-number gap for a jump INSIDE one segment", () => {
		const display = buildDisplayRows([content(" ", 10, "a1", "first"), content(" ", 20, "a2", "second")]);
		expect(display.map((row) => row.kind)).toEqual(["ctx", "gap", "ctx"]);
		expect(display[1]!.text).toBe("⋯");
	});
});

describe("copyText (what the copy button yields, #295)", () => {
	it("drops the segment headers — structure is not content", () => {
		const display = buildDisplayRows([
			hunk("@@ -1,2 +1,2 @@ scope()"),
			content("-", 1, "a1", "old"),
			content("+", 1, "n1", "new"),
			content(" ", 2, "a2", "keep"),
		]);
		expect(copyText(display)).toBe("- old\n+ new\nkeep");
	});

	it("keeps the `⋯` gap marker (pre-existing behaviour, unchanged by #295)", () => {
		const display = buildDisplayRows([content(" ", 1, "a1", "a"), content(" ", 9, "a9", "b")]);
		expect(copyText(display)).toBe("a\n⋯\nb");
	});
});

describe("foldWindow (the fold counts CODE rows, #295)", () => {
	/** Three segments, six code rows: the middle segment is fully collapsible. */
	function threeSegments(): ReturnType<typeof buildDisplayRows> {
		return buildDisplayRows([
			hunk("@@ -1,3 +1,3 @@ one()"),
			content(" ", 1, "a1", "a"),
			content(" ", 2, "a2", "b"),
			content(" ", 3, "a3", "c"),
			hunk("@@ -9,2 +9,2 @@ two()"),
			content(" ", 9, "a9", "d"),
			content(" ", 10, "aa", "e"),
			hunk("@@ -20,1 +20,1 @@ three()"),
			content(" ", 20, "ab", "f"),
		]);
	}

	it("counts the CODE rows only — a header is a title, not a line of the file", () => {
		const display = threeSegments();
		const fold = foldWindow(display, 2, false);
		// SIX code rows, two fit — the three headers are not counted.
		expect(fold.hidden).toBe(4);
		expect(fold.head.concat(fold.tail).filter(isContentRow)).toHaveLength(2);
	});

	it("draws a header WITH its section: it rides the window of its first visible code row", () => {
		const display = threeSegments();
		const fold = foldWindow(display, 2, false);
		expect(fold.head.map((row) => row.kind)).toEqual(["hunk", "ctx"]);
		expect(fold.head[0]!.text).toBe("@@ -1,3 +1,3 @@ one()");
		expect(fold.tail.map((row) => row.kind)).toEqual(["hunk", "ctx"]);
		expect(fold.tail[0]!.text).toBe("@@ -20,1 +20,1 @@ three()");
	});

	it("drops a header whose whole section is collapsed — a title over nothing reads as a fault", () => {
		const fold = foldWindow(threeSegments(), 2, false);
		expect(fold.head.concat(fold.tail).map((row) => row.text)).not.toContain("@@ -9,2 +9,2 @@ two()");
	});

	it("draws everything when expanded, and still reports the hidden count", () => {
		const display = threeSegments();
		const fold = foldWindow(display, 2, true);
		expect(fold.head).toHaveLength(display.length);
		expect(fold.tail).toHaveLength(0);
		expect(fold.hidden).toBe(4);
	});

	it("never lets a header push a code row out of the window", () => {
		const display = buildDisplayRows([
			hunk("@@ -1,2 +1,2 @@ one()"),
			content(" ", 1, "a1", "a"),
			content(" ", 2, "a2", "b"),
			hunk("@@ -9,2 +9,2 @@ two()"),
			content(" ", 9, "a9", "c"),
			content(" ", 10, "aa", "d"),
		]);
		const fold = foldWindow(display, 2, false);
		expect(fold.hidden).toBe(2);
		expect(fold.head.concat(fold.tail).filter(isContentRow)).toHaveLength(2);
	});
});
