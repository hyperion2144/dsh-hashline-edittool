import { describe, expect, it } from "vitest";
import { lineHashesPure, lineHashes } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

// Deterministic content signatures: the SAME content always hashes to the
// SAME value (in any snapshot), so "stability across edits" is a property of
// the hash function itself — no mapping pass is needed or tested anymore.

describe("deterministic hashing — stability as a function property", () => {
	it("preserves every hash when content is unchanged", () => {
		const content = "a\nb\nc";
		const hashes = lineHashesPure(content);
		expect(lineHashesPure(content)).toEqual(hashes);
	});

	it("keeps untouched lines' hashes after appending lines at the end", () => {
		const oldContent = "a\nb\nc";
		const newContent = "a\nb\nc\nd\ne";
		const oldHashes = lineHashesPure(oldContent);
		const newHashes = lineHashesPure(newContent);
		expect(newHashes.slice(0, 3)).toEqual(oldHashes);
	});

	it("keeps untouched lines' hashes after prepending lines", () => {
		const oldContent = "a\nb\nc";
		const newContent = "z\ny\na\nb\nc";
		const oldHashes = lineHashesPure(oldContent);
		const newHashes = lineHashesPure(newContent);
		expect(newHashes.slice(2)).toEqual(oldHashes);
	});

	it("recomputes hashes for replaced lines deterministically", () => {
		const edited = "a\nB2\nc";
		const hashes = lineHashesPure(edited);
		expect(hashes[0]).toBe(lineHashesPure("a\n")[0]);
		expect(hashes[1]).toBe(lineHashesPure("B2\n")[0]);
		expect(hashes[2]).toBe(lineHashesPure("a\nb\nc")[2]);
	});

	it("produces the identical hash set through the persistence path", async () => {
		const content = "a\nb\nc";
		const pure = lineHashesPure(content);
		const throughStore = await lineHashes(content, home.testPath);
		expect(throughStore).toEqual(pure);
	});

	it("is stable across store reloads (cache and recompute agree)", async () => {
		const content = "first\nsecond\nthird";
		const first = await lineHashes(content, home.testPath);
		const second = await lineHashes(content, home.testPath);
		expect(second).toEqual(first);
	});

	it("handles duplicate content lines (same content, same hash)", () => {
		const content = "x\nx\nx";
		const hashes = lineHashesPure(content);
		expect(new Set(hashes).size).toBe(1);
	});

	it("handles blank lines (all share one deterministic hash)", () => {
		const content = "\n\n\n";
		const hashes = lineHashesPure(content);
		expect(new Set(hashes).size).toBe(1);
	});
});