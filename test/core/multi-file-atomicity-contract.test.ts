/**
 * Multi-file edit contract tests per ADR-0004 §A/§B/§C/§D + ADR-0003 §TD3.
 *
 * The LLM-visible contract is `content[0].text` (the `modelText` field of the
 * canonical value). text mode: aggregated prose. json mode: stringified JSON
 * envelope `{ok, success:[...], fail:[...]}`.
 */
import { describe, expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";
import { applyEffective } from "../../src/config.js";

type Tool = {
	execute: (_callId: string, params: unknown) => Promise<{
		content: Array<{ text?: string }>;
	}>;
};

async function readAnchors(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of (getText(res) as string).split("\n")) {
		const m = line.match(/(\d+#\w+):(.*)$/);
		if (m) rows.push({ hash: m[1]!, content: m[2]! });
	}
	return rows;
}

describe("multi-file edit — ADR-0004 response shape", () => {
	it("A. success text mode: aggregated prose with per-file blocks", async () => {
		await withTempFile("b1.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path: p1 }) => {
			await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
			const harness = setupIntegrationTest(cwd);
			const a1 = await readAnchors(harness, "b1.txt");
			const a2 = await readAnchors(harness, "b2.txt");

			const res = await harness.editTool.execute("edit", {
				path: "b1.txt",
				edits: [
					{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A1!"] },
					{ op: "replace", path: "b2.txt", anchor_start: a2[1]!.hash, anchor_end: a2[1]!.hash, lines: ["B2!"] },
				],
			});
			const text = getText(res);

			expect(text).toContain("Successfully edited 2 file(s) — 2 of 2 edit(s) applied.");
			expect(text).toContain("--- b1.txt ---");
			expect(text).toContain("Successfully edited in b1.txt. Added 1 line(s), removed 1 line(s).");
			expect(text).toContain("--- b2.txt ---");
			expect(text).toContain("Successfully edited in b2.txt. Added 1 line(s), removed 1 line(s).");
			// 两个文件都落盘
			expect(await readFile(p1, "utf-8")).toBe("A1!\nbeta\ngamma\n");
			expect(await readFile(join(cwd, "b2.txt"), "utf-8")).toBe("x\nB2!\nz\n");
		});
	});

	it("B. success json mode: stringified envelope with verbatim buildEditJson entries", async () => {
		applyEffective({ output_format: "json" });
		try {
			await withTempFile("b1.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path: p1 }) => {
				await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
				const harness = setupIntegrationTest(cwd);
				// anchors 用 text 模式读（read 也是 json/text 双模式的）
				applyEffective({});
				const a1 = await readAnchors(harness, "b1.txt");
				const a2 = await readAnchors(harness, "b2.txt");
				applyEffective({ output_format: "json" });

				const res = await harness.editTool.execute("edit", {
					path: "b1.txt",
					edits: [
						{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A1!"] },
						{ op: "replace", path: "b2.txt", anchor_start: a2[1]!.hash, anchor_end: a2[1]!.hash, lines: ["B2!"] },
					],
				});
				const text = getText(res);
				const parsed = JSON.parse(text) as {
					ok: boolean;
					success: Array<{ ok: boolean; path: string; diff: Record<string, string>; errors: unknown[] }>;
					fail: unknown[];
				};

				expect(parsed.ok).toBe(true);
				expect(parsed.fail).toEqual([]);
				expect(parsed.success).toHaveLength(2);
				expect(parsed.success[0]).toMatchObject({ ok: true, path: "b1.txt" });
				expect(parsed.success[1]).toMatchObject({ ok: true, path: "b2.txt" });
				// diff anchor-keyed: b2 line 2 被 replace
				expect(Object.keys(parsed.success[1]!.diff).some((k) => k.startsWith("+"))).toBe(true);
				expect(await readFile(p1, "utf-8")).toBe("A1!\nbeta\ngamma\n");
			});
		} finally {
			applyEffective({});
		}
	});

	it("C. partial-fail text mode: success block + Edit for failed line", async () => {
		await withTempFile("b1.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path: p1 }) => {
			await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
			const harness = setupIntegrationTest(cwd);
			const a1 = await readAnchors(harness, "b1.txt");

			// b2 用 stale anchor "zzz"
			const res = await harness.editTool.execute("edit", {
				path: "b1.txt",
				edits: [
					{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A1!"] },
					{ op: "replace", path: "b2.txt", anchor_start: "2#zzz", anchor_end: "2#zzz", lines: ["B2!"] },
				],
			});
			const text = getText(res);

			expect(text).toContain("Successfully edited 1 file(s) — 1 of 2 edit(s) applied.");
			expect(text).toContain("Successfully edited in b1.txt.");
			expect(text).toContain("Edit for b2.txt failed: [E_STALE_ANCHOR]");
			// b1 成功落盘, b2 未变
			expect(await readFile(p1, "utf-8")).toBe("A1!\nbeta\ngamma\n");
			expect(await readFile(join(cwd, "b2.txt"), "utf-8")).toBe("x\ny\nz\n");
		});
	});

	it("D. partial-fail json mode: fail entry is {path, code, message} without file content", async () => {
		applyEffective({ output_format: "json" });
		try {
			await withTempFile("b1.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path: p1 }) => {
				await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
				const harness = setupIntegrationTest(cwd);
				// anchors 用 text 模式读
				applyEffective({});
				const a1 = await readAnchors(harness, "b1.txt");
				applyEffective({ output_format: "json" });
				const res = await harness.editTool.execute("edit", {
					path: "b1.txt",
					edits: [
						{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A1!"] },
						{ op: "replace", path: "b2.txt", anchor_start: "2#zzz", anchor_end: "2#zzz", lines: ["B2!"] },
					],
				});
				const text = getText(res);
				const parsed = JSON.parse(text) as {
					ok: boolean;
					success: Array<{ path: string }>;
					fail: Array<{ path: string; code: string; message: string }>;
				};

				expect(parsed.ok).toBe(true); // 至少一个文件成功
				expect(parsed.success).toHaveLength(1);
				expect(parsed.success[0]!.path).toBe("b1.txt");
				expect(parsed.fail).toHaveLength(1);
				expect(parsed.fail[0]).toMatchObject({
					path: "b2.txt",
					code: "[E_STALE_ANCHOR]",
				});
				expect(parsed.fail[0]!.message).toContain("2 stale anchors");
				// fail entry 不带文件原文 — 只有 path/code/message
				expect(Object.keys(parsed.fail[0]!)).toEqual(["path", "code", "message"]);
				expect(await readFile(p1, "utf-8")).toBe("A1!\nbeta\ngamma\n");
			});
		} finally {
			applyEffective({});
		}
	});
});

describe("multi-file edit — ADR-0002 schema validation", () => {
	it("top-level absent + all items have per-item path → accepts", async () => {
		await withTempFile("b1.txt", "a\nb\nc\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b2.txt"), "x\ny\nz\n", "utf8");
			const harness = setupIntegrationTest(cwd);
			const a1 = await readAnchors(harness, "b1.txt");
			const a2 = await readAnchors(harness, "b2.txt");
			const res = await harness.editTool.execute("edit", {
				edits: [
					{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A1!"] },
					{ op: "replace", path: "b2.txt", anchor_start: a2[1]!.hash, anchor_end: a2[1]!.hash, lines: ["B2!"] },
				],
			});
			expect(getText(res)).toContain("Successfully edited 2 file(s)");
		});
	});

	it("top-level absent + some item missing per-item path → rejects [E_BAD_SHAPE]", async () => {
		await withTempFile("b1.txt", "a\nb\nc\n", async ({ cwd }) => {
			const harness = setupIntegrationTest(cwd);
			const a1 = await readAnchors(harness, "b1.txt");
			await expect(
				harness.editTool.execute("edit", {
					edits: [
						{ op: "replace", path: "b1.txt", anchor_start: a1[0]!.hash, anchor_end: a1[0]!.hash, lines: ["A"] },
						// 无 per-item path 且顶层 path 也缺 → 必须在 assertEditRequest 拒绝
						{ op: "replace", anchor_start: a1[1]!.hash, anchor_end: a1[1]!.hash, lines: ["B"] },
					],
				}),
			).rejects.toThrow(/E_BAD_SHAPE/);
		});
	});
});