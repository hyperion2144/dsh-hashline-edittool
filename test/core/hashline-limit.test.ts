import { describe, expect, it } from "vitest";
import {
	lineHashesPure,
	lineHashes,
	hashOf,
	canon,
	HASH_SPACE,
} from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("hashline size limits — removed", () => {
	it("derives the encoding space from the alphabet and hash length", () => {
		// HASH_SPACE remains the folding modulus; it is NOT a line-count limit.
		expect(HASH_SPACE).toBe(62 ** 3);
	});

	it("hashes far more lines than the old 62^3 ceiling without error", () => {
		// The old unique-allocation design capped files at HASH_SPACE lines;
		// deterministic content signatures have no ceiling.
		const line = "const x = 1; // padding padding padding padding";
		const content = Array.from({ length: HASH_SPACE + 5 }, () => line).join(
			"\n",
		);
		const hashes = lineHashesPure(content);
		expect(hashes).toHaveLength(HASH_SPACE + 5);
		// Identical lines share one deterministic hash — repetition is fine.
		expect(new Set(hashes).size).toBe(1);
	});

	it("does not throw E_FILE_TOO_LARGE through the persistence path", async () => {
		const line = "x";
		const content = Array.from({ length: 300_000 }, () => line).join("\n");
		const hashes = await lineHashes(content, home.testPath);
		expect(hashes).toHaveLength(300_000);
	});
});

describe("deterministic content hashing", () => {
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