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



	it("is deterministic for any given content (same content → same anchor set)", () => {
		const edited = "a\nB2\nc";
		expect(lineHashesPure(edited)).toEqual(lineHashesPure(edited));
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

	it("handles duplicate content lines (distinct anchors in v2.0)", () => {
		const content = "x\nx\nx";
		const hashes = lineHashesPure(content);
		expect(new Set(hashes).size).toBe(3);
	});

	it("handles blank lines (distinct anchors in v2.0)", () => {
		const content = "\n\n\n";
		const hashes = lineHashesPure(content);
		expect(new Set(hashes).size).toBe(3);
	});
});