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
	// An explicit timeout, because the default is what this test actually fails
	// on: allocating anchors for 238,000+ identical lines is a real computation,
	// and under a full parallel run it has crossed the 5s default while passing
	// comfortably alone. That is the worst kind of test failure — it reports the
	// machine's load as a defect and teaches everyone to re-run until it is
	// green. The number here is a budget for work that is genuinely large, not a
	// way to hide a hang.
	it("hashes far more lines than the old 62^3 ceiling without error", { timeout: 30_000 }, () => {
		// v2.0 has no fixed line-count ceiling; layers auto-expand.
		const line = "const x = 1; // padding padding padding padding";
		const content = Array.from({ length: 62 ** 3 + 5 }, () => line).join("\n");
		const hashes = lineHashesPure(content);
		expect(hashes).toHaveLength(62 ** 3 + 5);
		// Identical lines get DISTINCT anchors (Q2-A) — uniqueness at scale.
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	// Same budget and the same reason as the test above: 300,000 lines through the
	// PERSISTENCE path is real work, and the 5s default is what it fails on under a
	// full parallel run while passing comfortably alone. Fixing only one of the two
	// in this file left the other one failing the suite at random — which is worse
	// than either, because a suite that is red one run in three teaches everyone to
	// re-run instead of to look.
	it("does not throw E_FILE_TOO_LARGE through the persistence path", { timeout: 30_000 }, async () => {
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