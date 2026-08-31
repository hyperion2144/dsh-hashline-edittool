import { beforeAll, describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff.js";

beforeAll(async () => {
});
describe("genDiff", () => {
	it("adds hash hints for context and addition lines and pads deletion lines", () => {
		const result = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		expect(diff).toMatch(/^ \s*[A-Za-z0-9]{2,8}:alpha$/m);
		expect(diff).toMatch(/^\+\s*[A-Za-z0-9]{2,8}:BETA$/m);
		expect(diff).toMatch(/^-\s*[ ]{4}:beta$/m);
		expect(diff).toMatch(/^ \s*[A-Za-z0-9]{2,8}:gamma$/m);
	});

	it("carries the old hashes on deletion rows when oldContentHashes are provided", () => {
		const { diff } = genDiff(
			"alpha\nbeta\ngamma",
			"alpha\nBETA\ngamma",
			1,
			undefined,
			["AAA", "BBB", "CCC"],
		);
		expect(diff).toMatch(/^-\s*BBB:beta$/m);
		expect(diff).toMatch(/^\+\s*[A-Za-z0-9]{2,8}:BETA$/m);
	});

	it("tracks old line numbers across skipped context and multi-line deletions", () => {
		const { diff } = genDiff(
			"a\nb\nc\nd",
			"a\nd",
			0,
			undefined,
			["H1", "H2", "H3", "H4"],
		);
		expect(diff).toMatch(/-H2:b/);
		expect(diff).toMatch(/-H3:c/);
	});

	it("marks every diff row with the line#hash marker prefix", () => {

		const before = [
			"function greet(name) {",
			"  console.log('old')",
			"  return 'hi'",
			"}",
		].join("\n");
		const after = [
			"function greet(name) {",
			"  return `Hello, ${name}`",
			"}",
		].join("\n");

		const { diff } = genDiff(before, after);

		const lines = diff.split("\n");
		for (const line of lines) {
			if (!line.includes(":")) continue;
			// diff prefix + anchor + : — the marker structure is invariant.
			expect(line).toMatch(/^[ +-]\s*[A-Za-z0-9 ]{2,8}\s*:/);
		}

		expect(lines).toContainEqual(expect.stringMatching(/^ \s*[A-Za-z0-9]{2,8}:function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^-\s*[ ]{4}: {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+\s*[A-Za-z0-9]{2,8}: {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ \s*[A-Za-z0-9]{2,8}:\}$/));
	});
	it("truncates context between two distant changes", () => {
		const lines = [];
		for (let i = 1; i <= 1000; i++) lines.push("line " + i);
		const before = "BEFORE\n" + lines.join("\n") + "\nAFTER";
		const after = "BEFORE_CHANGED\n" + lines.join("\n") + "\nAFTER_CHANGED";

		const { diff } = genDiff(before, after, 4);
		const diffLines = diff.split("\n");

		expect(diffLines.length).toBeLessThan(50);

		const ellipsisCount = diffLines.filter((l: string) => l.trim() === "...").length;
		expect(ellipsisCount).toBe(1);

		const ellipsisIdx = diffLines.findIndex((l: string) => l.trim() === "...");
		expect(ellipsisIdx).toBeGreaterThan(0);
		expect(ellipsisIdx).toBeLessThan(diffLines.length - 1);

		expect(diffLines[ellipsisIdx - 1]).toContain("line 4");
		expect(diffLines[ellipsisIdx + 1]).toContain("line 997");

		expect(diff).toContain("BEFORE_CHANGED");
		expect(diff).toContain("AFTER_CHANGED");
	});
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

describe("genDiff — property: column alignment", () => {
  const vocab = [
    "",
    "}",
    "  foo",
    "import x",
    "a = 1;",
    "// c",
    "a:b",
    "line with : inside",
    "  const y = 2;",
  ];

  it("keeps every diff row carrying the line#hash marker prefix across random content", () => {
    for (let iter = 0; iter < 200; iter++) {
      const rnd = mulberry32(iter * 2654435761 + 17);
      const oldContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");
      const newContent = Array.from(
        { length: randInt(rnd, 0, 30) },
        () => vocab[randInt(rnd, 0, vocab.length - 1)]!,
      ).join("\n");

      const { diff } = genDiff(oldContent, newContent, randInt(rnd, 0, 4));
      for (const line of diff.split("\n")) {
        if (line.includes(":")) {
			expect(
				line,
				`unmarked diff row for iter ${iter}: ${JSON.stringify(line)}`,
			).toMatch(/^[ +-]\s*[A-Za-z0-9 ]{2,8}\s*:/);
        }
      }
    }
  });

  it("keeps the marker structure correct for single-line diffs too", () => {
    const { diff } = genDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
    for (const line of diff.split("\n")) {
			if (line.includes(":")) expect(line).toMatch(/^[ +-]\s*[A-Za-z0-9 ]{2,8}\s*:/);
    }
  });
});
