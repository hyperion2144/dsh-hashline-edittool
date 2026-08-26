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

	it("rejects a replace whose lines count is too small (E_LINE_COUNT_MISMATCH)", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: served[0]!.hash,
							anchor_end: served[2]!.hash,
							lines: ["A"],
						},
					],
				}),
			).rejects.toThrow(/E_LINE_COUNT_MISMATCH/);
		});
	});

	it("rejects a replace whose lines count is too large, teaching the templates", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const err = await editTool(harness)
				.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: served[0]!.hash,
							anchor_end: served[1]!.hash,
							lines: ["A", "B", "C"],
						},
					],
				})
				.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
			expect(err).toMatch(/E_LINE_COUNT_MISMATCH/);
			expect(err).toContain("shrink N→M → replace the first M lines + del the rest");
			expect(err).toContain("expand M→N → replace the M-line range + ins at the range's last line");
		});
	});

	it("shrinks 10→2 as replace(first 2)+del(rest) in one call", async () => {
		await withTempFile("t.txt", BLOCK10, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("l1").hash, anchor_end: by("l2").hash, lines: ["N1", "N2"] },
					{ op: "del", anchor_start: by("l3").hash, anchor_end: by("l10").hash },
				],
			});
			expect(getText(res)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("N1\nN2");
		});
	});

	it("expands 2→10 as replace(2)+ins(last line) in one call, either hunk order", async () => {
		await withTempFile("t.txt", "a\nb\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const a = served.find((r) => r.content === "a")!;
			const b = served.find((r) => r.content === "b")!;
			for (const hunks of [
				[
					{ op: "replace", anchor_start: a.hash, anchor_end: b.hash, lines: ["A", "B"] },
					{ op: "ins", anchor_start: b.hash, lines: ["i1", "i2", "i3"] },
				],
				[
					{ op: "ins", anchor_start: b.hash, lines: ["i1", "i2", "i3"] },
					{ op: "replace", anchor_start: a.hash, anchor_end: b.hash, lines: ["A", "B"] },
				],
			] as const) {
				await writeFile(path, "a\nb\n");
				// Re-serve after restoring the file so the served mirror matches,
				// then re-resolve anchors (the first variant rewrote the file).
				await harness.readTool.execute("read", { path: "t.txt" });
				const served2 = await servedRows(harness, "t.txt");
				const a2 = served2.find((r) => r.content === "a")!;
				const b2 = served2.find((r) => r.content === "b")!;
				const use = (h: (typeof hunks)[number]) =>
					h.op === "ins" ? { ...h, anchor_start: b2.hash } : { ...h, anchor_start: a2.hash, anchor_end: b2.hash };
				const res = await editTool(harness).execute("edit", {
					path: "t.txt",
					edits: hunks.map(use),
				});
				expect(getText(res)).toContain("Successfully edited in t.txt");
				expect(await readFile(path, "utf-8")).toBe("A\nB\ni1\ni2\ni3\n");
			}
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

	it("json output surfaces the new errors in errors[]", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt"); // anchors from text mode
			applyEffective({ output_format: "json" });
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "replace",
						anchor_start: served[0]!.hash,
						anchor_end: served[1]!.hash,
						lines: ["A"],
					},
				],
			});
			const out = JSON.parse(getText(res)) as {
				ok: boolean;
				errors: Array<{ code: string; message: string }>;
			};
			expect(out.ok).toBe(false);
			expect(out.errors[0]!.code).toBe("E_LINE_COUNT_MISMATCH");
		});
	});
});