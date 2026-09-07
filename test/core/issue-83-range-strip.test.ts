/**
 * Regression tests for issue #83: stripBarePrefixes must only strip
 * anchor prefixes when the anchor is within the edit range, not when
 * it collides with a short anchor elsewhere in the file.
 */
import { describe, expect, it } from "vitest";
import { applyEdit, resEdit } from "../../src/hashline/anchor-pipeline.js";
import { applyHashlineShape, hashSep } from "../../src/hashline/hash-assign.js";
import { anchorsPure } from "../../src/hashline/session-anchors.js";

const SEP = hashSep();

describe("#83 — range-restricted anchor-prefix stripping", () => {
	it("does NOT strip a short-anchor prefix that matches a distant file anchor", () => {
		const lines: string[] = [];
		for (let i = 0; i < 50; i++) lines.push(`line-${i}`);
		lines.push("distant-anchor-line");
		const content = lines.join("\n");
		const hashes = anchorsPure(content);

		const distantIdx = 50;
		const distantAnchor = hashes[distantIdx]!;
		if (distantAnchor.length > 3) return;

		const editLine = 0;
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[editLine]}`,
				remove_to: `${hashes[editLine]}`,
				replacement_text: `${distantAnchor}: success.length > 0,`,
			}),
		);

		expect(result.content).toBe(
			`${distantAnchor}: success.length > 0,\n` + lines.slice(1).join("\n"),
		);
	});

	it("DOES strip a prefix when the anchor is within the edit range", () => {
		const content = "alpha\nbeta\ngamma\ndelta";
		const hashes = anchorsPure(content);

		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[0]}`,
				remove_to: `${hashes[1]}`,
				replacement_text: `${hashes[0]}${SEP}REPLACED`,
			}),
		);

		expect(result.content).toBe("REPLACED\ngamma\ndelta");
	});

	it("falls back to full-file anchors when edit anchors are unresolvable", () => {
		const content = "alpha\nbeta\ngamma";

		expect(() => {
			applyEdit(
				content,
				resEdit({
					remove_from: "ZZZZZZZZ",
					remove_to: "ZZZZZZZZ",
					replacement_text: "test",
				}),
			);
		}).toThrow(/STALE|not_found|Invalid/i);
	});
});

describe("#83 — dynamic separator matching in rowRe", () => {
	it("only matches the configured separator, not hardcoded ':' when sep is '|'", () => {
		applyHashlineShape({ separator: "|", contextLines: 3 });
		try {
			const content = "alpha\nbeta\ngamma";
			const hashes = anchorsPure(content);

			const result = applyEdit(
				content,
				resEdit({
					remove_from: `${hashes[1]}`,
					remove_to: `${hashes[1]}`,
					replacement_text: `${hashes[1]}|BETA-NEW`,
				}),
			);
			expect(result.content).toBe("alpha\nBETA-NEW\ngamma");

			const result2 = applyEdit(
				content,
				resEdit({
					remove_from: `${hashes[1]}`,
					remove_to: `${hashes[1]}`,
					replacement_text: `${hashes[1]}:BETA-KEEP`,
				}),
			);
			expect(result2.content).toBe(`alpha\n${hashes[1]}:BETA-KEEP\ngamma`);
		} finally {
			applyHashlineShape({ separator: ":", contextLines: 3 });
		}
	});
});
