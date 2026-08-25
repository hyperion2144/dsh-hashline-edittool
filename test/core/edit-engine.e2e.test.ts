import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";

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

function undoTool(
	harness: ReturnType<typeof setupIntegrationTest>,
): Tool {
	return harness.getTool("undo_last_edit") as unknown as Tool;
}

const CONTENT = "line one\nline two\nline three\n";

/** Read through the hashline `read` tool so anchors are served, then parse rows. */
async function servedRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of getText(res).split("\n")) {
		const sep = line.indexOf("│");
		if (sep === -1) continue;
		rows.push({ hash: line.slice(0, sep), content: line.slice(sep + 1) });
	}
	return rows;
}

describe("edit-sequence engine — end-to-end through the tool builders", () => {
	it("edit applies multiple edits to one file in order", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const three = served.find((r) => r.content === "line three")!;

			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", from: one.hash, lines: ["ONE"] },
					{ op: "replace", from: three.hash, lines: ["THREE"] },
				],
			});

			const text = getText(res);
			expect(text).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nTHREE\n");
		});
	});

	it("edit with a failing edit aborts atomically — nothing written, earlier items unapplied", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;

			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", from: one.hash, lines: ["ONE"] },
						{ op: "replace", from: "zzz", lines: ["NOPE"] },
					],
				}),
			).rejects.toThrow(/E_BATCH_ABORT/);

			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("undo_last_edit reverts a single edit to the exact prior content", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;

			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [{ op: "replace", from: one.hash, lines: ["ONE"] }],
			});
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nline three\n");

			const res = await undoTool(harness).execute("undo_last_edit", { path: "t.txt" });
			expect(getText(res)).toContain("Undone last edit on t.txt.");
			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("undo_last_edit reverts a batch to the exact prior content", async () => {
		await withTempFile("t.txt", CONTENT, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const three = served.find((r) => r.content === "line three")!;

			await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", from: one.hash, lines: ["ONE"] },
					{ op: "replace", from: three.hash, lines: ["THREE"] },
				],
			});
			expect(await readFile(path, "utf-8")).toBe("ONE\nline two\nTHREE\n");

			const res = await undoTool(harness).execute("undo_last_edit", { path: "t.txt" });
			expect(getText(res)).toContain("Undone last edit on t.txt.");
			expect(await readFile(path, "utf-8")).toBe(CONTENT);
		});
	});

	it("edit rejects repeated noop edits at the loop threshold", async () => {
		await withTempFile("t.txt", "line one\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const one = served.find((r) => r.content === "line one")!;
			const edit = {
				path: "t.txt",
				edits: [{ op: "replace", from: one.hash, lines: ["line one"] }],
			};

			const first = await editTool(harness).execute("edit", edit);
			expect(getText(first)).toContain("Classification: noop");

			const second = await editTool(harness).execute("edit", edit);
			expect(getText(second)).toContain("no-op'd twice");

			await expect(
				editTool(harness).execute("edit", edit),
			).rejects.toThrow(/E_NOOP_LOOP/);

			expect(await readFile(path, "utf-8")).toBe("line one\n");
		});
	});

	describe("snapshot-concurrency semantics", () => {
		const MULTI = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]
			.map((l) => `${l}\n`)
			.join("");

		it("applies non-overlapping edits with original anchors in one batch", async () => {
			await withTempFile("t.txt", MULTI, async ({ cwd, path }) => {
				const harness = setupIntegrationTest(cwd);
				const served = await servedRows(harness, "t.txt");
				const by = (c: string) => served.find((r) => r.content === c)!;
				// replace 2-3, delete 5, insert after 7 in ONE batch — all with
				// ORIGINAL anchors (old semantics required shifted newLine#oldHash)
				const res = await editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", from: by("l2").hash, to: by("l3").hash, lines: ["R2", "R3"] },
						{ op: "del", from: by("l5").hash },
						{ op: "ins", from: by("l7").hash, lines: ["I7"] },
					],
				});
				const text = getText(res);
				expect(text).toContain("Successfully edited in t.txt");
				expect(await readFile(path, "utf-8")).toBe(
					"l1\nR2\nR3\nl4\nl6\nl7\nI7\nl8\n",
				);
			});
		});

		it("rejects overlapping ranges with E_BATCH_CONFLICT and writes nothing", async () => {
			await withTempFile("t.txt", MULTI, async ({ cwd, path }) => {
				const harness = setupIntegrationTest(cwd);
				const served = await servedRows(harness, "t.txt");
				const by = (c: string) => served.find((r) => r.content === c)!;
				await expect(
					editTool(harness).execute("edit", {
						path: "t.txt",
						edits: [
							{ op: "replace", from: by("l4").hash, to: by("l6").hash, lines: ["X"] },
							{ op: "del", from: by("l6").hash },
						],
					}),
				).rejects.toThrow(/E_BATCH_CONFLICT/);
				expect(await readFile(path, "utf-8")).toBe(MULTI);
			});
		});

		it("rejects two inserts at the same anchor line", async () => {
			await withTempFile("t.txt", MULTI, async ({ cwd, path }) => {
				const harness = setupIntegrationTest(cwd);
				const served = await servedRows(harness, "t.txt");
				const by = (c: string) => served.find((r) => r.content === c)!;
				await expect(
					editTool(harness).execute("edit", {
						path: "t.txt",
						edits: [
							{ op: "ins", from: by("l3").hash, lines: ["A"] },
							{ op: "ins", from: by("l3").hash, lines: ["B"] },
						],
					}),
				).rejects.toThrow(/E_BATCH_CONFLICT/);
				expect(await readFile(path, "utf-8")).toBe(MULTI);
			});
		});

		it("rejects ins whose anchor line is inside a replaced range", async () => {
			await withTempFile("t.txt", MULTI, async ({ cwd, path }) => {
				const harness = setupIntegrationTest(cwd);
				const served = await servedRows(harness, "t.txt");
				const by = (c: string) => served.find((r) => r.content === c)!;
				await expect(
					editTool(harness).execute("edit", {
						path: "t.txt",
						edits: [
							{ op: "replace", from: by("l4").hash, to: by("l6").hash, lines: ["X"] },
							{ op: "ins", from: by("l4").hash, lines: ["Y"] },
						],
					}),
				).rejects.toThrow(/E_BATCH_CONFLICT/);
				expect(await readFile(path, "utf-8")).toBe(MULTI);
			});
		});

		it("failure message echoes file rows exactly once", async () => {
			await withTempFile("t.txt", MULTI, async ({ cwd, path }) => {
				const harness = setupIntegrationTest(cwd);
				const served = await servedRows(harness, "t.txt");
				const by = (c: string) => served.find((r) => r.content === c)!;
				let message = "";
				try {
					await editTool(harness).execute("edit", {
						path: "t.txt",
						edits: [
							{ op: "replace", from: by("l1").hash, lines: ["A"] },
							{ op: "replace", from: "2#zzz", lines: ["B"] },
						],
					});
					expect.unreachable("edit should have rejected");
				} catch (e) {
					message = e instanceof Error ? e.message : String(e);
				}
				expect(message).toMatch(/E_BATCH_ABORT/);
				// stale-anchor echo must appear exactly once — no duplicated on-disk block
				expect(message.split("HASH IDENTIFIER │ FILE LINES").length - 1).toBe(1);
				expect(await readFile(path, "utf-8")).toBe(MULTI);
			});
		});
	});

});
