/**
 * #440 — the whole-content sha256 is computed once per content: a
 * single-entry memo in `contentChecksum` (keyed by content equality) collapses
 * the 2–3 independent hashes one read used to pay for the same text.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { setupIntegrationTest, getText, withTempFile } from "../support/fixtures.js";

vi.mock("node:crypto", async (importOriginal) => {
	const real = (await importOriginal()) as typeof import("node:crypto");
	return { ...real, createHash: vi.fn(real.createHash) };
});

const digests = () => vi.mocked(createHash).mock.calls.length;

afterEach(() => {
	vi.clearAllMocks();
});

describe("#440 contentChecksum memo (P5)", () => {
	const text = `unique-${Date.now()}-${Math.random()}\n` + Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");

	it("hashes the same string once — the second ask is a memo hit", () => {
		const before = digests();
		const a = contentChecksum(text);
		expect(digests()).toBe(before + 1);
		const b = contentChecksum(text);
		expect(b).toBe(a);
		expect(digests()).toBe(before + 1);
	});

	it("hits for an equal-content copy (different string reference)", () => {
		contentChecksum(text);
		const before = digests();
		const copy = `${text}`;
		expect(contentChecksum(copy)).toBe(contentChecksum(text));
		expect(digests()).toBe(before);
	});

	it("recomputes when the content differs — invalidation is inherent", () => {
		const original = contentChecksum(text);
		const before = digests();
		const changed = contentChecksum(`${text}\n// externally changed`);
		expect(changed).not.toBe(original);
		// Asking for the original again is a DIFFERENT string than the memo's
		// current entry — one recompute, then stable.
		expect(contentChecksum(text)).toBe(original);
		expect(digests()).toBe(before + 2);
	});

	it("per-line fingerprints do not evict a whole-file memo hit (#440 review)", () => {
		const big = `${text}\n` + Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n");
		expect(big.length).toBeGreaterThanOrEqual(4096);
		const digest = contentChecksum(big);
		const before = digests();
		// The served-row churn: many SMALL checksums in between.
		for (let i = 0; i < 50; i++) contentChecksum(`row ${i}`);
		expect(contentChecksum(big)).toBe(digest);
		expect(digests()).toBe(before + 50);
	});

	it("an externally changed file reads fresh — the dedup never false-fires", async () => {
		await withTempFile("drift.txt", text, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const first = getText(await harness.readTool.execute("read", { path }));
			expect(first).toContain("line 7");

			// External change (not through the tools).
			await writeFile(path, `${text}\n// externally changed\n`, "utf-8");

			const second = getText(await harness.readTool.execute("read", { path }));
			expect(second).toContain("externally changed");
			// And the file on disk is exactly what we wrote.
			expect(await readFile(path, "utf-8")).toBe(`${text}\n// externally changed\n`);
		});
	});
});
