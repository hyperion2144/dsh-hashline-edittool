import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	lineHashesPure,
	parseText,
} from "../../src/hashline/index.js";
import { splitLines } from "../../src/utils.js";
import { useTestHome } from "../support/fixtures.js";
const home = useTestHome();

describe("strict hashline contract", () => {
	it("strips internal ASCII whitespace when hashing (ADR-0005)", async () => {
		const hashes = await lineHashes("a b", home.testPath);
		const hashes2 = await lineHashes("ab", home.testPath);
		expect(hashes[0]).toBe(hashes2[0]);
	});

	it("trims trailing spaces when hashing", async () => {
		const hashes = await lineHashes("value  ", home.testPath);
		const hashes2 = await lineHashes("value", home.testPath);
		expect(hashes[0]).toBe(hashes2[0]);
	});

	it("preserves explicit blank trailing line in string input", () => {
		expect(parseText("alpha\n")).toEqual(["alpha", ""]);
		expect(parseText("alpha\n\n")).toEqual(["alpha", "", ""]);
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
		const stale = {
      hash_bounds: [{ line: 1, hash: "ZZZZ" }, { line: 1, hash: "ZZZZ" }], content_lines: ["updated"],
    } as any;
		expect(() => applyEdit(content, stale)).toThrow(/stale anchor/);
	});
});

describe("perfect hashing", () => {
	it("returns one hash per line, indexed 0-based by line number", async () => {
		const hashes = await lineHashes("alpha\nbeta\ngamma", home.testPath);
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hashes[2]).toMatch(/^[A-Za-z0-9]{2,8}$/);
	});

	

	

	it("lets the edit tool target a specific occurrence when content is duplicated", async () => {
		const file = [
			"const x = 1;",
			"const y = 2;",
			"const x = 1;",
		].join("\n");
		const hashes = await lineHashes(file, home.testPath);
		const result = applyEdit(file, { hash_bounds: [{ anchor: hashes[2]! }, { anchor: hashes[2]! }], content_lines: ["const x = 999;"] });
		expect(result.content).toBe("const x = 1;\nconst y = 2;\nconst x = 999;");
	});
	it("stale-anchor error shows the file's current state for context", () => {
		const file = ["const x = 1;", "const y = 2;", "const x = 1;"].join("\n");
		const staleAnchor = "ZZZZ";
		let caught: Error | undefined;
		try {
			applyEdit(file, { hash_bounds: [{ anchor: staleAnchor }, { anchor: staleAnchor }], content_lines: ["X"] });
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE|E_RANGE_UNVERIFIED/);
		expect(caught!.message).toMatch(/fresh anchors/);
	});

	it("rejects out-of-range line anchors with hard read-required message", async () => {
		// line#hash disambiguates positions with identical content. With
		// line=5 against a 4-line file, validation must reject — the agent
		// must call read() to learn the current line count.
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = await lineHashes(file, home.testPath);

		let caught: Error | undefined;
		try {
			applyEdit(
				file,
				{
					hash_bounds: [
						{ line: 5, hash: realHashes[0]! },
						{ line: 5, hash: realHashes[0]! },
					],
					content_lines: ["X"],
				},
				undefined,
				realHashes,
			);
		} catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_RANGE_UNVERIFIED/);
		expect(caught!.message).toMatch(/out of range/);
		expect(caught!.message).toMatch(/Call read/);
	});



	it("hash array length matches line count for edge cases", async () => {
		const cases = ["", "\n", "a", "a\n", "a\nb\nc\n"];
		for (const file of cases) {
			const hashes = await lineHashes(file, home.testPath);
			expect(hashes).toHaveLength(splitLines(file).length);
		}
	});
});

describe("pure hasher", () => {
	it("lineHashesPure agrees with the pathless wrapper and needs no store", async () => {
		const content = "alpha\nbeta\ngamma";
		const pure = lineHashesPure(content);
		// The wrapper without a path never touches the hash store — it is
		// exactly the pure path.
		const wrapper = await lineHashes(content);
		expect(pure).toEqual(wrapper);
		expect(new Set(pure).size).toBe(pure.length);
	});

	it("lineHashesPure is deterministic", () => {
		const content = "a\nb\nc\nd\ne\n";
		expect(lineHashesPure(content)).toEqual(lineHashesPure(content));
	});
});
