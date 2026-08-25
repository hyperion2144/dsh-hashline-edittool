import { describe, expect, it } from "vitest";
import { lineHashesPure, applyEdit } from "../../src/hashline/index.js";

// Duplicate-content semantics under deterministic content signatures:
// identical lines SHARE one hash. The line number inside `line#hash` is the
// locator, so sharing a hash is safe — the hash only verifies content.

const SAMPLE =
	"function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";

describe("deterministic hashing with duplicate content lines", () => {
	it("gives identical lines the same hash", () => {
		const hashes = lineHashesPure(SAMPLE);
		// the two closers `}` lines share one hash
		expect(hashes[2]).toBe(hashes[6]);
		// the two openers differ (function a vs function b) and thus hash differently
		expect(hashes[0]).not.toBe(hashes[4]);
	});

	it("preserves the shared hash for an untouched duplicate after an edit", () => {
		const content = "a\nx\nb\nx\nc\n";
		const before = lineHashesPure(content);
		const edit = {
			hash_bounds: [
				{ line: 1, hash: before[0]! },
				{ line: 1, hash: before[0]! },
			],
			content_lines: ["A"],
		} as const;
		const result = applyEdit(content, edit as never);
		const after = lineHashesPure(result.content);
		// the untouched `x` line keeps its hash
		expect(after[1]).toBe(before[1]);
	});

	it("keeps duplicate hashes identical in the edited file", () => {
		const content = "x\ny\nx\n";
		const before = lineHashesPure(content);
		const edit = {
			hash_bounds: [
				{ line: 2, hash: before[1]! },
				{ line: 2, hash: before[1]! },
			],
			content_lines: ["Y2"],
		} as const;
		const result = applyEdit(content, edit as never);
		const after = lineHashesPure(result.content);
		expect(after[0]).toBe(after[2]); // both `x` lines still share a hash
		expect(after[0]).not.toBe(after[1]);
	});
});