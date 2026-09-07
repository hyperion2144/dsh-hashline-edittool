/**
 * Regression tests for the genDiff structured rows + the presentationMeta
 * wiring (issue #71: the web diff card's `行号:锚点` gutter renders from
 * `presentationMeta.diffRows`, so both the row numbering and the meta
 * passthrough must be exact).
 * @module dsh-hashline-edittool/test/edit-diff-rows
 */
import { describe, expect, it } from "vitest";
import { genDiff } from "../../src/edit-diff.js";
import { lineHashesPure } from "../../src/hashline/index.js";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";

const BEFORE = [
	"# Hashline web card demo (round 2)",
	"",
	"This file exercises the #71 edit card gutter.",
	"",
	"## Section A",
	"",
	"- alpha line with code: `const x = 1`",
	"- beta line with 中文内容",
	"- gamma line unchanged",
	"- delta line unchanged",
	"",
	"## Section B",
	"",
	"First paragraph line one.",
	"First paragraph line two.",
	"First paragraph line three.",
	"",
	"## Section C",
	"",
	"tail line alpha",
	"tail line beta",
	"",
	"End of demo file.",
].join("\n");

const AFTER = BEFORE.replace(
	"const x = 1`",
	"const x = 42 // three-hunk gutter test`",
).replace(
	"First paragraph line two.",
	"Second paragraph line two (rewritten by the gutter test).",
).replace(
	"tail line beta",
	"tail line beta — beta prime",
);

describe("genDiff multi-hunk row numbering (issue #71 regression)", () => {
	it("numbers every row against its real file line — no drift after a mid-file hunk", () => {
		const { rows } = genDiff(BEFORE, AFTER, 3, lineHashesPure(AFTER), lineHashesPure(BEFORE), true);
		const adds = rows.filter((row) => row.kind === "+");
		const dels = rows.filter((row) => row.kind === "-");
		expect(adds).toHaveLength(3);
		expect(dels).toHaveLength(3);
		// The three replaced lines: old numbers 7 / 15 / 21, new numbers 7 / 15 / 21.
		expect(dels.map((row) => row.lineNumber)).toEqual([7, 15, 21]);
		expect(adds.map((row) => row.lineNumber)).toEqual([7, 15, 21]);
		// Content/anchor pairing stays exact: the del at 21 carries the pre-edit
		// anchor of "tail line beta" and the add its post-edit anchor.
		const delBeta = dels[2]!;
		expect(delBeta.content).toBe("tail line beta");
		const addBeta = adds[2]!;
		expect(addBeta.content).toBe("tail line beta — beta prime");
		expect(addBeta.hash).not.toBe("");
		// Context rows keep real file lines: line 20 is "tail line alpha" both sides.
		const ctx20 = rows.find((row) => row.kind === " " && row.lineNumber === 20);
		expect(ctx20?.content).toBe("tail line alpha");
	});

	it("the rendered diff text pairs every row with its own marker and content", () => {
		const { diff, rows } = genDiff(BEFORE, AFTER, 3, lineHashesPure(AFTER), lineHashesPure(BEFORE), true);
		// Every row's `line:hash` marker appears on the diff line that carries its
		// own content — the padStart alignment puts spaces after the prefix, so the
		// lookup is marker+content co-occurrence on one line, not exact prefix.
		for (const row of rows) {
			const marker = `${row.lineNumber}:${row.hash}`;
			const line = diff.split("\n").find((l) => l.includes(marker) && l.includes(row.content.slice(0, 20)));
			expect(line, `row ${row.kind} ${marker} ${row.content.slice(0, 30)}`).toBeDefined();
		}
		// The trailing End row pairs line 23's anchor with line 23's content.
		const endRow = rows.find((row) => row.content === "End of demo file.");
		expect(endRow).toBeDefined();
		const endLine = diff.split("\n").find((l) => l.includes("End of demo file."));
		expect(endLine).toContain(`${endRow!.lineNumber}:${endRow!.hash}`);
	});
});

describe("edit presentationMeta passes diffRows through (integration point)", () => {
	it("presentationMeta output carries the structured rows", async () => {
		await withTempFile("m.txt", "one\ntwo\nthree\n", async ({ cwd }) => {
			const { buildEditTool } = await import("../../src/tool-edit.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const { FsSandboxController } = await import("../../src/sandbox.js");
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const io = localIO();
			const read = buildReadTool(io);
			const edit = buildEditTool(io, sandbox);
			const exec = (args: unknown) =>
				({ signal: new AbortController().signal, agent: { id: "s", session: { id: "s", header: { cwd } } }, arguments: args }) as never;
			const readValue = (await read.execute({ path: "m.txt" }, exec({}))) as {
				hashlines: { number: number; hash: string }[];
			};
			const marker = `${readValue.hashlines[0]?.hash}`;
			const canonical = (await edit.execute(
				{ path: "m.txt", edits: [{ op: "replace", anchor_start: marker, anchor_end: marker, lines: ["ONE!"] }] },
				exec({}),
			)) as { diffRows?: unknown[] };
			expect(Array.isArray(canonical.diffRows)).toBe(true);
			// The exact integration point the host calls — diffRows must survive.
			const tool = edit as unknown as {
				output: { presentationMeta: (args: unknown, value: unknown) => Record<string, unknown> };
			};
			const meta = tool.output.presentationMeta({ path: "m.txt" }, canonical);
			expect(Array.isArray(meta.diffRows)).toBe(true);
			expect((meta.diffRows as unknown[]).length).toBeGreaterThan(0);
		});
	});
});

describe("edit presentationMeta multi-file diffs (issue #82)", () => {
	it("presentationMeta returns aggregated diffs + diffRows for multi-file edit", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { writeFile: wf } = await import("node:fs/promises");
			const { join } = await import("node:path");
			await wf(join(cwd, "b.txt"), "gamma\ndelta\n", "utf-8");

			const { buildEditTool } = await import("../../src/tool-edit.js");
			const { buildReadTool } = await import("../../src/tool-read.js");
			const { FsSandboxController } = await import("../../src/sandbox.js");
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const io = localIO();
			const read = buildReadTool(io);
			const edit = buildEditTool(io, sandbox);
			const exec = (args: unknown) =>
				({ signal: new AbortController().signal, agent: { id: "s", session: { id: "s", header: { cwd } } }, arguments: args }) as never;

			// Read both files to get anchors
			const ra = (await read.execute({ path: "a.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
			const rb = (await read.execute({ path: "b.txt" }, exec({}))) as { hashlines: { number: number; hash: string }[] };
			const aHash = ra.hashlines[0]!.hash;
			const bHash = rb.hashlines[0]!.hash;

			// Multi-file edit: edits to both a.txt and b.txt in one call
			const canonical = (await edit.execute(
				{
					edits: [
						{ path: "a.txt", op: "replace", anchor_start: aHash, anchor_end: aHash, lines: ["ALPHA!"] },
						{ path: "b.txt", op: "replace", anchor_start: bHash, anchor_end: bHash, lines: ["GAMMA!"] },
					],
				},
				exec({}),
			)) as { multiDiffs?: unknown[]; multiDiffRowGroups?: unknown[]; success?: unknown[] };

			// Multi-file form returns success array (not single-file canonical)
			expect(Array.isArray(canonical.success)).toBe(true);
			// issue #82: aggregated diffs + diffRowGroups are present
			expect(Array.isArray(canonical.multiDiffs)).toBe(true);
			expect((canonical.multiDiffs as unknown[]).length).toBeGreaterThan(0);
			expect(Array.isArray(canonical.multiDiffRowGroups)).toBe(true);
			expect((canonical.multiDiffRowGroups as unknown[]).length).toBeGreaterThan(0);
			// Each group has path + rows
			const groups = canonical.multiDiffRowGroups as Array<{ path: string; rows: unknown[] }>;
			expect(groups.every((g) => typeof g.path === "string" && Array.isArray(g.rows))).toBe(true);

			// presentationMeta passes them through (the integration point the host calls)
			const tool = edit as unknown as {
				output: { presentationMeta: (args: unknown, value: unknown) => Record<string, unknown> };
			};
			const meta = tool.output.presentationMeta({ edits: [] }, canonical);
			expect(Array.isArray(meta.diffs)).toBe(true);
			expect((meta.diffs as unknown[]).length).toBeGreaterThan(0);
			expect(Array.isArray(meta.diffRowGroups)).toBe(true);
			expect((meta.diffRowGroups as unknown[]).length).toBeGreaterThan(0);
		});
	});
});
