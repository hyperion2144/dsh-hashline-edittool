import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { applyEffective } from "../../src/config.js";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";

const BLOCK10 = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");

type Tool = {
	execute: (
		_callId: string,
		params: unknown,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

function editTool(
	harness: ReturnType<typeof setupIntegrationTest>,
): Tool {
	return harness.editTool;
}

/** Read through the hashline `read` tool so anchors are served, then parse rows. */
async function servedRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of getText(res).split("\n")) {
		const m = /^(\d+#[A-Za-z0-9]+):\s?(.*)$/.exec(line);
		if (m) rows.push({ hash: m[1]!, content: m[2]! });
	}
	return rows;
}

afterEach(() => {
	applyEffective({});
});

describe("exact line-count edit contract", () => {
	it("rejects a replace without anchor_end (E_MISSING_ANCHOR_END)", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [{ op: "replace", anchor_start: served[0]!.hash, lines: ["A"] }],
				}),
			).rejects.toThrow(/E_MISSING_ANCHOR_END/);
		});
	});

	it("replaces a 10-line range with 2 lines in one call (free line count)", async () => {
		await withTempFile("t.txt", BLOCK10, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("l1").hash, anchor_end: by("l10").hash, lines: ["N1", "N2"] },
				],
			});
			expect(getText(res)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("N1\nN2");
		});
	});

	it("replaces a 2-line range with 10 lines in one call (free line count)", async () => {
		await withTempFile("t.txt", "a\nb\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const a = served.find((r) => r.content === "a")!;
			const b = served.find((r) => r.content === "b")!;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: a.hash, anchor_end: b.hash, lines: ["A", "B", "i1", "i2", "i3"] },
				],
			});
			expect(getText(res)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("A\nB\ni1\ni2\ni3\n");
		});
	});

	it("accepts ins anchored on another range's END line, rejects start/interior", async () => {
		await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;

			// end line (c, line 3): legal — gap insert after the replaced range
			const ok = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
					{ op: "ins", anchor_start: by("c").hash, lines: ["X"] },
				],
			});
			expect(getText(ok)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("A\nB\nC\nX\nd\n");

			// start line (a): rejected
			await writeFile(path, "a\nb\nc\nd\n");
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
						{ op: "ins", anchor_start: by("a").hash, lines: ["X"] },
					],
				}),
			).rejects.toThrow(/E_BATCH_CONFLICT/);

			// interior (b): rejected
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
						{ op: "ins", anchor_start: by("b").hash, lines: ["X"] },
					],
				}),
			).rejects.toThrow(/E_BATCH_CONFLICT/);
		});
	});

	it("ins leaves its anchor line untouched when another hunk replaces it", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("b").hash, anchor_end: by("b").hash, lines: ["B"] },
					{ op: "ins", anchor_start: by("b").hash, lines: ["I"] },
				],
			});
			expect(getText(res)).toContain("Successfully edited in t.txt");
			// anchor line rewritten to "B", inserted row after it — not duplicated
			expect(await readFile(path, "utf-8")).toBe("a\nB\nI\nc\n");
		});
	});

	it("json success diff is an anchor-keyed dict (+/- prefixed changes, bare context)", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			applyEffective({ output_format: "json" });
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("b").hash, anchor_end: by("b").hash, lines: ["B"] },
				],
			});
			const out = JSON.parse(getText(res)) as { ok: boolean; diff: Record<string, string> };
			expect(out.ok).toBe(true);
			// removed row: "-" + old anchor; added row: "+" + final anchor
			expect(out.diff[`-${by("b").hash}`]).toBe("b");
			const added = Object.keys(out.diff).find((k) => k.startsWith("+2#")) ?? "";
			expect(out.diff[added]).toBe("B");
			// context rows use BARE anchors, aligned with read's lines
			expect(out.diff[by("a").hash]).toBe("a");
			expect(out.diff[by("c").hash]).toBe("c");
		});
	});

	it("ins resolves its anchor by line#hash, never by bare hash (collision-safe)", async () => {
		// Lines 1 and 3 share identical content -> identical hash. A bare-hash
		// lookup would pick line 1 and paste the insert after IT; anchor
		// resolution must act on the claimed line (3).
		await withTempFile("t.txt", "dup\na\ndup\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			// line 3 shares its content (and hash) with line 1; anchor must act
			// on the CLAIMED line 3, not the first bare-hash hit (line 1).
			const line3Anchor = `3${served[0]!.hash.slice(served[0]!.hash.indexOf("#"))}`;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [{ op: "ins", anchor_start: line3Anchor, lines: ["IN"] }],
			});
			expect(getText(res)).toContain("after line 3");
			expect(await readFile(path, "utf-8")).toBe("dup\na\ndup\nIN\n");
		});
	});

	it("grep json matches is one anchor-keyed dict (match + context rows together)", async () => {
		await withTempFile("t.txt", "alpha\nbeta\ngamma\ndelta\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			applyEffective({ output_format: "json" });
			const res = await (harness.getTool("grep") as unknown as {
				execute: (id: string, p: unknown) => Promise<{ content: Array<{ text?: string }> }>;
			}).execute("g", { path: "t.txt", pattern: "beta" });
			const out = JSON.parse(getText(res)) as {
				files: Array<{ path: string; matches: Record<string, string> }>;
			};
			const matches = out.files[0]!.matches;
			// match row and its context rows all live in the one dict (key = line#hash)
			expect(matches[served[1]!.hash]).toBe("beta");
			expect(matches[served[0]!.hash]).toBe("alpha");
			expect(matches[served[2]!.hash]).toBe("gamma");
		});
	});

	it("rejected edits fail loudly in json mode too (throw, isError)", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt"); // anchors from text mode
			applyEffective({ output_format: "json" });
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [{ op: "replace", anchor_start: served[0]!.hash, lines: ["A"] }],
				}),
			).rejects.toThrow(/E_MISSING_ANCHOR_END/);
		});
	});
});