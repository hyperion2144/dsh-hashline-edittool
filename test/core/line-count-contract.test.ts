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
		if (line.startsWith("ANCHOR:")) continue; // skip the header row
		// Rows are `<anchor>:<line>: content` by default; the legacy order stays
		// tolerated, and a bare `<anchor>: content` row (line_numbers off) too.
		const current = /^(?:[+\- ])?([A-Za-z0-9]{2,8}):(\d+):\s?(.*)$/.exec(line);
		if (current) {
			rows.push({ hash: current[1]!, content: current[3]! });
			continue;
		}
		const legacy = /^(?:[+\- ])?(\d+):([A-Za-z0-9]{2,8}):\s?(.*)$/.exec(line);
		if (legacy) rows.push({ hash: legacy[2]!, content: legacy[3]! });
		else {
			const bare = /^([A-Za-z0-9]{2,8}):\s?(.*)$/.exec(line.replace(/^[+\- ]/, ""));
			if (bare) rows.push({ hash: bare[1]!, content: bare[2]! });
		}
	}
	return rows;
}

afterEach(() => {
	applyEffective({});
});

describe("exact line-count edit contract", () => {
	it("defaults a replace without anchor_end to a SINGLE-line replace", async () => {
		// v2.0.3: omitted anchor_end = range start..start. Forgetting to
		// duplicate the anchor was the highest-frequency model failure.
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [{ op: "replace", anchor_start: served[0]!.hash, lines: ["A"] }],
			});
			const after = await readFile(path, "utf-8");
			expect(after).toBe("A\nb\nc\n"); // only line 1 replaced
		});
	});

	it("defaults a MULTI-line replace without anchor_end to a SINGLE-line range", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: served[0]!.hash, lines: ["A", "B"] },
				],
			});
			const after = await readFile(path, "utf-8");
			expect(after).toBe("A\nB\nb\nc\n"); // only line 1 replaced with 2 lines
		});
	});

	it("defaults a del without anchor_end to a SINGLE-line delete", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [{ op: "del", anchor_start: served[1]!.hash }],
			});
			const after = await readFile(path, "utf-8");
			expect(after).toBe("a\nc\n"); // only line 2 removed
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

	it("accepts ins anchored on another range's END line, rejects start/interior — batch-ins vs replace coverage semantics changed in v2.0 (E_STALE under stricter content check); needs src decision", async () => {
		await withTempFile("t.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;

			// start line (a): rejected — ins anchored on a replace range's START
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
						{ op: "ins", anchor_after: by("a").hash, lines: ["X"] },
					],
				}),
			).rejects.toThrow(/E_BATCH_CONFLICT/);

			// interior (b): rejected
			await expect(
				editTool(harness).execute("edit", {
					path: "t.txt",
					edits: [
						{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
						{ op: "ins", anchor_after: by("b").hash, lines: ["X"] },
					],
				}),
			).rejects.toThrow(/E_BATCH_CONFLICT/);

			// end line (c, line 3): legal — gap insert after the replaced range
			const ok = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("a").hash, anchor_end: by("c").hash, lines: ["A", "B", "C"] },
					{ op: "ins", anchor_after: by("c").hash, lines: ["X"] },
				],
			});
			expect(getText(ok)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("A\nB\nC\nX\nd\n");
	});
	});

	it("ins leaves its anchor line untouched when another hunk replaces it — v2.0: ins anchored on a replaced line is E_STALE; needs src decision", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: by("b").hash, anchor_end: by("b").hash, lines: ["B"] },
					{ op: "ins", anchor_after: by("b").hash, lines: ["I"] },
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
			// Key order matches every other row: the ANCHOR first with its line
			// trailing — removed row `-<old anchor>:<old line>`, added row
			// `+<final anchor>:<final line>`, context row `<anchor>:<line>`.
			expect(out.diff[`-${by("b").hash}:2`]).toBe("b");
			const added = Object.keys(out.diff).find((k) => k.startsWith("+")) ?? "";
			expect(out.diff[`${by("a").hash}:1`]).toBe("a");
			expect(out.diff[`${by("c").hash}:3`]).toBe("c");
		});
	});

	it("ins resolves its anchor uniquely when content is duplicated — v2.0 SRC BUG: ins on a duplicate-content line inserts at the wrong position (line 3 dup disappears); needs src fix", async () => {
		// v2.0: identical content lines get DISTINCT anchors, so a bare anchor
		// uniquely identifies one row — there is no ambiguity to resolve.
		await withTempFile("t.txt", "dup\na\ndup\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			// line 3's anchor is distinct from line 1's; the ins must land after
			// the line whose anchor we actually pass.
			const line3Anchor = served[2]!.hash;
			const res = await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [{ op: "ins", anchor_after: line3Anchor, lines: ["IN"] }],
			});
			expect(getText(res)).toContain("Successfully edited in t.txt");
			expect(await readFile(path, "utf-8")).toBe("dup\na\ndup\nIN\n");
		});
	});

	it("grep json matches is one anchor-keyed dict — grep-json anchor keys vs read anchors mismatch; needs src check", async () => {
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
			// Match row and its context rows all live in the one dict, keyed
			// `<anchor>:<line>` like every other row.
			expect(matches[`${served[1]!.hash}:2`]).toBe("beta");
			expect(matches[`${served[0]!.hash}:1`]).toBe("alpha");
			expect(matches[`${served[2]!.hash}:3`]).toBe("gamma");
		});
	});

	it("multi-line replace without anchor_end works in json mode too", async () => {
		await withTempFile("t.txt", "a\nb\nc\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt"); // anchors from text mode
			applyEffective({ output_format: "json" });
			await editTool(harness).execute("edit", {
				path: "t.txt",
				edits: [
					{ op: "replace", anchor_start: served[0]!.hash, lines: ["A", "B"] },
				],
			});
			const after = await readFile(path, "utf-8");
			expect(after).toBe("A\nB\nb\nc\n"); // only line 1 replaced with 2 lines
		});
	});
});