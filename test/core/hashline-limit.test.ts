import { describe, expect, it } from "vitest";
import {
	lineHashesPure,
	lineHashes,
	hashOf,
	canon,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("hashline size limits — removed in v2.0", () => {
	it("hashes far more lines than the old 62^3 ceiling without error", () => {
		// v2.0 has no fixed line-count ceiling; layers auto-expand.
		const line = "const x = 1; // padding padding padding padding";
		const content = Array.from({ length: 62 ** 3 + 5 }, () => line).join("\n");
		const hashes = lineHashesPure(content);
		expect(hashes).toHaveLength(62 ** 3 + 5);
		// Identical lines get DISTINCT anchors (Q2-A) — uniqueness at scale.
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	it("does not throw E_FILE_TOO_LARGE through the persistence path", async () => {
		const line = "x";
		const content = Array.from({ length: 300_000 }, () => line).join("\n");
		const hashes = await lineHashes(content, home.testPath);
		expect(hashes).toHaveLength(300_000);
		expect(new Set(hashes).size).toBe(300_000);
	});
});

describe("legacy content hashing (hashOf — retained for compat)", () => {
	it("maps identical content to the identical hash", () => {
		const a = hashOf(canon("function foo() {"));
		const b = hashOf(canon("function foo() {"));
		expect(a).toBe(b);
	});

	it("is a pure function of the canonicalized line", () => {
		// whitespace differences canonicalize away
		expect(hashOf(canon("a = b"))).toBe(hashOf(canon("a=b")));
		expect(hashOf(canon("let x;"))).toBe(hashOf(canon("let\tx;")));
	});

	it("produces distinct hashes for distinct content in practice", () => {
		const lines = Array.from(
			{ length: 1000 },
			(_, i) => `line number ${i} unique`,
		);
		const hashes = lines.map((l) => hashOf(canon(l)));
		// 62^3 space: a few collisions are possible, but 1000 distinct lines
		// must not collapse into a single bucket.
		expect(new Set(hashes).size).toBeGreaterThan(900);
	});
});