import { describe, expect, it } from "vitest";
import { lineHashesPure, applyEdit } from "../../src/hashline/index.js";

// v2.0 duplicate-content semantics: identical lines get DISTINCT anchors
// (Q2-A). The allocator guarantees per-line uniqueness; content identity is
// NOT the anchor identity.

const SAMPLE =
	"function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";

describe("deterministic anchors with duplicate content lines", () => {
	it("gives identical lines DISTINCT anchors", () => {
		const hashes = lineHashesPure(SAMPLE);
		// the two closers `}` lines get different anchors
		expect(hashes[2]).not.toBe(hashes[6]);
		// every anchor is unique across the file
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	it("preserves an untouched duplicate's anchor after an edit", () => {
		const content = "a\nx\nb\nx\nc\n";
		const before = lineHashesPure(content);
		const edit = {
			hash_bounds: [
				{ anchor: before[0]! },
				{ anchor: before[0]! },
			],
			content_lines: ["A"],
		} as const;
		const result = applyEdit(content, edit as never);
		const after = lineHashesPure(result.content);
		// the untouched `x` lines keep their anchors (deterministic + session-stable)
		expect(after[1]).toBe(before[1]);
		expect(after[2]).toBe(before[2]);
	});

	it("keeps duplicate anchors distinct in the edited file", () => {
		const content = "x\ny\nx\n";
		const before = lineHashesPure(content);
		const edit = {
			hash_bounds: [
				{ anchor: before[1]! },
				{ anchor: before[1]! },
			],
			content_lines: ["Y2"],
		} as const;
		const result = applyEdit(content, edit as never);
		const after = lineHashesPure(result.content);
		// the two `x` lines keep their distinct anchors
		expect(after[0]).toBe(before[0]);
		expect(after[2]).toBe(before[2]);
		expect(after[0]).not.toBe(after[2]);
	});
});