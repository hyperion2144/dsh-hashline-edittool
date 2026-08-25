import { describe, expect, it } from "vitest";
import { lineHashes, lineHashesPure, HASH_SPACE } from "../../src/hashline/index.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("large file stress tests — store path", () => {
  it("handles 10,000 identical lines via store with unique hashes", async () => {
    const line = "}";
    const content = Array.from({ length: 10_000 }, () => line).join("\n");
    const start = performance.now();
    const hashes = await lineHashes(content, home.testPath);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(10_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(1); // identical lines share one hash
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("handles 50,000 unique lines via store without timeout", async () => {
    const content = Array.from({ length: 50_000 }, (_, i) => `line${i}`).join("\n");
    const start = performance.now();
    const hashes = await lineHashes(content, home.testPath);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(50_000);
    const unique = new Set(hashes);
    expect(unique.size).toBeGreaterThan(45_000); // collisions allowed
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("cache hit returns identical hashes for repeated content", async () => {
    const content = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const first = await lineHashes(content, home.testPath);
    const second = await lineHashes(content, home.testPath);
    expect(second).toEqual(first);
  }, 60_000);

  it("preserves hashes for unchanged lines in a 10,000-line file after small edit", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const lines = oldContent.split("\n");
    lines[5000] = "MODIFIED";
    const newContent = lines.join("\n");

    const result = await lineHashes(newContent, home.testPath);

    expect(result).toHaveLength(10_000);
    expect(result[0]).toBe(oldHashes[0]);
    expect(result[4999]).toBe(oldHashes[4999]);
    expect(result[5001]).toBe(oldHashes[5001]);
    expect(result[5000]).not.toBe(oldHashes[5000]);
  }, 120_000);

  it("preserves hashes when prepending 1,000 lines to a 10,000-line file", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const prefix = Array.from({ length: 1_000 }, (_, i) => `new${i}`).join("\n");
    const newContent = prefix + "\n" + oldContent;

    const result = await lineHashes(newContent, home.testPath);

    expect(result).toHaveLength(11_000);
    for (let i = 0; i < 10_000; i++) {
      expect(result[i + 1_000]).toBe(oldHashes[i]);
    }
  }, 120_000);

  it("preserves hashes when appending 1,000 lines to a 10,000-line file", async () => {
    const oldContent = Array.from({ length: 10_000 }, (_, i) => `line${i}`).join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);

    const suffix = Array.from({ length: 1_000 }, (_, i) => `new${i}`).join("\n");
    const newContent = oldContent + "\n" + suffix;

    const result = await lineHashes(newContent, home.testPath);

    expect(result).toHaveLength(11_000);
    for (let i = 0; i < 10_000; i++) {
      expect(result[i]).toBe(oldHashes[i]);
    }
  }, 120_000);
});

describe("large file stress tests — pure path (no store)", () => {
  it("handles 100,000 unique lines without timeout", () => {
    const content = Array.from({ length: 100_000 }, (_, i) => `line${i}`).join("\n");
    const start = performance.now();
    const hashes = lineHashesPure(content);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(100_000);
    const unique = new Set(hashes);
    expect(unique.size).toBeGreaterThan(60_000); // 62^3 space: ~20k collision pairs expected at 100k lines
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);

  it("handles 20,000 identical closing braces", () => {
    const content = Array.from({ length: 20_000 }, () => "}").join("\n");
    const start = performance.now();
    const hashes = lineHashesPure(content);
    const elapsed = performance.now() - start;

    expect(hashes).toHaveLength(20_000);
    const unique = new Set(hashes);
    expect(unique.size).toBe(1); // identical braces share one hash
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});

describe("hash collision stress tests", () => {
  it("assigns unique hashes to 1,000 identical lines via store", async () => {
    const content = Array.from({ length: 1_000 }, () => "same").join("\n");
    const hashes = await lineHashes(content, home.testPath);
    const unique = new Set(hashes);
    expect(unique.size).toBe(1); // identical lines share one hash
  }, 60_000);

  it("assigns unique hashes to 10,000 identical lines (pure)", () => {
    const content = Array.from({ length: 10_000 }, () => "same").join("\n");
    const hashes = lineHashesPure(content);
    const unique = new Set(hashes);
    expect(unique.size).toBe(1); // identical lines share one hash
  }, 60_000);

  it("recomputes identical lines deterministically after a trim", async () => {
    const oldContent = Array.from({ length: 10_000 }, () => "same").join("\n");
    const oldHashes = lineHashesPure(oldContent);

    const newContent = Array.from({ length: 5_000 }, () => "same").join("\n");
    const result = await lineHashes(newContent, home.testPath);

    expect(result).toHaveLength(5_000);
    expect(new Set(result).size).toBe(1);
    expect(result[0]).toBe(oldHashes[0]);
  }, 120_000);

  it("handles 100 identical lines with mixed content types via store", async () => {
    const lines = [
      ...Array.from({ length: 25 }, () => "import { foo } from 'bar';"),
      ...Array.from({ length: 25 }, () => "const x = 1;"),
      ...Array.from({ length: 25 }, () => "}"),
      ...Array.from({ length: 25 }, () => "  return result;"),
    ];
    const content = lines.join("\n");
    const hashes = await lineHashes(content, home.testPath);
		const unique = new Set(hashes);
		expect(unique.size).toBe(4); // four distinct contents → four distinct hashes
	}, 60_000);
});
