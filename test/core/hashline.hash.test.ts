import { describe, expect, it } from "vitest";
import {
	applyEdit,
	lineHashes,
	lineHashesPure,
	parseText,
} from "../../src/hashline/index.js";
import { splitLines } from "../../src/infra/utils.js";
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

	it("refuses a bare-digit anchor and echoes the line the number names", () => {
		// A bare number is a LINE HINT, not an anchor. The refusal must not only
		// say so — the echo must CENTER on what the number names, so the caller
		// sees the line they meant instead of an anchor that never resolves.
		const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		const bare = {
			hash_bounds: [{ anchor: "7" }, { anchor: "7" }],
			content_lines: ["updated"],
		} as any;
		let message = "";
		try {
			applyEdit(content, bare);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/Bare-digit anchors are forbidden/);
		expect(message).toMatch(/LINE HINT, not an anchor/);
		// Echo centered on line 7: ±3 context covers lines 4..10, and every echo
		// row carries the `<anchor>:<line>` marker form.
		expect(message).toMatch(/^\s+[A-Za-z0-9]+:4:/m);
		expect(message).toMatch(/^\s+[A-Za-z0-9]+:7:/m);
		expect(message).toMatch(/^\s+[A-Za-z0-9]+:10:/m);
		expect(message).not.toMatch(/^\s+[A-Za-z0-9]+:11:/m);
	});
});

/**
 * A bare NUMBER is a line reference, and the served record is what makes that
 * claim checkable: an anchor is derived from its line's content, so
 * `served[n-1] === fileAnchors[n-1]` proves the line at n is unchanged since
 * it was served. With that proof the reference is repaired into the anchor;
 * without it the reference is refused with an echo on the line it named.
 */
describe("bare line numbers as references", () => {
	it("lifts a served line number to that line's anchor, with a notice", () => {
		const content = "alpha\nbeta\ngamma\n";
		const anchors = lineHashesPure(content);
		const result = applyEdit(
			content,
			{ content_lines: ["BETA"], hash_bounds: [{ anchor: "2" }, { anchor: "2" }] },
			undefined,
			anchors,
			"probe.txt",
			new Set(anchors),
		);
		expect(result.content).toBe("alpha\nBETA\ngamma\n");
		expect(result.warnings?.some((w) => w.includes("[E_LINE_REF]"))).toBe(true);
	});

	it("refuses a line number the session was NOT served", () => {
		const content = "alpha\nbeta\ngamma\n";
		const edit = { content_lines: ["X"], hash_bounds: [{ anchor: "3" }, { anchor: "3" }] } as never;
		expect(() =>
			applyEdit(content, edit, undefined, lineHashesPure(content), "probe.txt", new Set()),
		).toThrow(/Bare-digit anchors are forbidden/);
	});

	it("refuses a served line number whose content has since changed", () => {
		const served = lineHashesPure("alpha\nbeta\ngamma\n");
		// The REFERENCED line changed, so position 3 no longer holds the anchor
		// that was served there and the claim is stale.
		const drifted = "alpha\nbeta\nGAMMA-CHANGED\n";
		const edit = { content_lines: ["X"], hash_bounds: [{ anchor: "3" }, { anchor: "3" }] } as never;
		expect(() =>
			applyEdit(drifted, edit, undefined, lineHashesPure(drifted), "probe.txt", new Set(served)),
		).toThrow(/Bare-digit anchors are forbidden/);
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
						// `anchor`, not `hash`: `hash_bounds` is the parameter's name, but its
						// entries are Anchor-shaped and the field has been `anchor` since v2.
						//
						// The anchor is EMPTY on purpose. The previous `hash: realHashes[0]`
						// was an unknown field, so the anchor arrived as `undefined` and the
						// rejection this test asserts came from "no valid anchor" — NOT from
						// the out-of-range line the test is named for. With a resolving anchor
						// the edit is accepted (the line hint is only a hint), which is how the
						// mismatch surfaced. An empty anchor keeps the subject: a reference
						// that cannot be resolved is refused, hard.
						{ line: 5, anchor: "" },
						{ line: 5, anchor: "" },
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
