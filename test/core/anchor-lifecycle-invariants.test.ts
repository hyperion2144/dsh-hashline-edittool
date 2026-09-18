/**
 * Anchor lifecycle invariants (post-incident hardening).
 *
 * The three rules the maintainer set after the `2t` double-booking incident:
 *   1. Allocation happens ONLY on first serve or actual content change.
 *   2. Already-allocated anchors never change: rewrites/external changes
 *      INHERIT by line alignment — unchanged lines keep their anchors.
 *   3. Exclusivity: one live anchor names at most one line, in the allocator
 *      AND in the served mirror; ambiguous resolution is a hard error.
 *
 * @module dsh-hashline-edittool/anchor-lifecycle-invariants
 */
import { describe, expect, it } from "vitest";
import { anchorsFor } from "../../src/hashline/session-anchors.js";
import { applyEdit, type HEdit } from "../../src/hashline/anchor-pipeline.js";
import {
} from "../../src/domain/session/session-view.js";

let unique = 0;
const freshPath = (): string => `/tmp/invariants-${++unique}.ts`;

describe("invariant 2 — rewrite inherits, unchanged lines keep anchors", () => {
	it("a rewrite that changes one line preserves every other line's anchor", () => {
		const path = freshPath();
		const before = ["alpha", "beta", "gamma", "delta"].join("\n");
		const after = ["alpha", "BETA", "gamma", "delta"].join("\n");

		const a1 = anchorsFor(path, before);
		const a2 = anchorsFor(path, after);

		expect(a2[0]).toBe(a1[0]); // alpha unchanged → anchor kept
		expect(a2[2]).toBe(a1[2]); // gamma unchanged → anchor kept
		expect(a2[3]).toBe(a1[3]); // delta unchanged → anchor kept
		expect(a2[1]).not.toBe(a1[1]); // beta CHANGED → new anchor
	});

	it("a rewrite above identical blank lines does NOT reshuffle them", () => {
		const path = freshPath();
		const before = ["def a():", "    pass", "", "", "def b():"].join("\n");
		const after = ["def a():", "    return 1", "", "", "def b():"].join("\n");

		const a1 = anchorsFor(path, before);
		const a2 = anchorsFor(path, after);

		expect(a2[2]).toBe(a1[2]); // blank line 3 — same content, same anchor
		expect(a2[3]).toBe(a1[3]); // blank line 4 — same content, same anchor
		expect(a2[4]).toBe(a1[4]); // def b(): — same content, same anchor
	});

	it("normalization: BOM/CRLF raw text and clean text allocate IDENTICALLY", () => {
		const path = freshPath();
		const clean = "export const a = 1;\nexport const b = 2;\n";
		const raw = `\uFEFFexport const a = 1;\r\nexport const b = 2;\r\n`;
		expect(anchorsFor(path, raw)).toEqual(anchorsFor(path, clean));
	});
});

describe("invariant 3 — exclusivity", () => {
	it("anchorsFor output never contains duplicate anchors", () => {
		const path = freshPath();
		const lines = ["x", "", "", "y", "", "z", ""].join("\n");
		const anchors = anchorsFor(path, lines);
		expect(new Set(anchors).size).toBe(anchors.length);
	});

	it("pinBound through applyEdit refuses a duplicate anchor with [E_ANCHOR_AMBIGUOUS]", () => {
		const content = "one\ntwo\nthree\n";
		const dup = ["AA", "BB", "AA"];
		const edit: HEdit = {
			hash_bounds: [{ anchor: "AA" }, { anchor: "AA" }],
			content_lines: ["gone"],
		};
		expect(() => applyEdit(content, edit, undefined, dup)).toThrow(
			/\[E_ANCHOR_AMBIGUOUS\].*lines 1 and 3/,
		);
	});

});
