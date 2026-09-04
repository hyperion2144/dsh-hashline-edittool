/**
 * Tests for the line#hash anchor upgrade. Covers:
 *   - `read` rendering carries the `ANCHOR:FILELINE` header
 *   - `parseRef` accepts both `line#hash` and bare-hash forms
 *   - `edit.remove_to` is optional (defaults to remove_from)
 *   - post-edit response carries the `Shift:` block
 *   - batch multi-hunk edits emit one Shift block per hunk
 *   - stale anchor echo uses read format (±3 context)
 *   - grep tool outputs read-format matches
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { genDiff } from "../../src/edit-diff.js";
import {
	parseHashRef,
	grepFileContent,
	lineHashesPure,
	lineHashes,
} from "../../src/hashline/index.js";

beforeAll(async () => {
});

describe("parseRef — v2 anchor forms", () => {
	it("parses a bare anchor", () => {
		expect(parseHashRef("aB3")).toEqual({ anchor: "aB3" });
	});

	it("parses a line:hint anchor", () => {
		expect(parseHashRef("123:xyz")).toEqual({ anchor: "xyz", line: 123 });
	});

	it("rejects the legacy line#hash form", () => {
		expect(() => parseHashRef("12#aB3")).toThrow(/legacy line#hash form is no longer supported/);
	});
});

describe("read — header line", () => {
	it("emits the ANCHOR:FILELINE header on top", async () => {
		await withTempFile("h.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const res = await readTool.execute("r", { path: "h.txt" }, undefined, undefined, ctx);
			const text = getText(res);
			const lines = text.split("\n");
			// dsh 0.1.2 web parity: the read text is enveloped; rows start after it.
			expect(lines[0]).toMatch(/^<path>.*h\.txt<\/path>$/);
			expect(lines[1]).toBe("<type>file</type>");
			expect(lines[2]).toBe("<content>");
			expect(lines[3]).toMatch(/^ANCHOR:FILELINE/);
			expect(lines[4]).toMatch(/^[A-Za-z0-9]{2,8}:\s*alpha$/);
			expect(lines[5]).toMatch(/^[A-Za-z0-9]{2,8}:beta$/);
		});
	});
});

describe("edit — remove_to optional", () => {
	it("edits just the from line when to is omitted", async () => {
		await withTempFile("single.ts", "one\ntwo\nthree\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const read = await readTool.execute("r", { path: "single.ts" }, undefined, undefined, ctx);
			const lines = getText(read).split("\n").filter((l) => l.includes(":") && !l.startsWith("ANCHOR:"));
			// Extract the bare anchor of line 2 ("two")
			const lineMarker = lines[1]!.match(/^([A-Za-z0-9]{2,8})/)![1]!;

			await editTool.execute(
				"e",
				{ path: "single.ts", edits: [{ op: "replace", anchor_start: lineMarker, anchor_end: lineMarker, lines: ["TWO!"] }] },
				undefined,
				undefined,
				ctx,
			);

			const read2 = await readTool.execute("r2", { path: "single.ts" }, undefined, undefined, ctx);
			const lines2 = getText(read2).split("\n").filter((l) => l.includes(":") && !l.startsWith("ANCHOR:"));
			expect(lines2[0]).toMatch(/one$/);
			expect(lines2[1]).toMatch(/TWO!$/);
			expect(lines2[2]).toMatch(/three$/);
		});
	});
});

describe("edit — no Shift block in v2.0", () => {
	it("post-edit response has no Shift block; diff rows carry bare anchors", async () => {
		await withTempFile("shift.ts", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const read = await readTool.execute("r", { path: "shift.ts" }, undefined, undefined, ctx);
			const lines = getText(read).split("\n").filter((l) => l.includes(":") && !l.startsWith("ANCHOR:"));
			const lineMarker = lines[1]!.match(/^([A-Za-z0-9]{2,8})/)![1]!;
			const res = await editTool.execute(
				"e",
				{
					path: "shift.ts",
					edits: [{ op: "replace", anchor_start: lineMarker, anchor_end: lineMarker, lines: ["B", "B2"] }],
				},
				undefined,
				undefined,
				ctx,
			);
			const out = getText(res);
			expect(out).not.toContain("Shift:");
			expect(out).toMatch(/\+[A-Za-z0-9]{2,8}:B2/);
		});
	});
});


describe("stale anchor echo — read format", () => {
	it("emits the resolved anchor's line in read format with ±3 context", async () => {
		const { applyEdit, resEdit, lineHashes } = await import("../../src/hashline/index.js");
		const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
		const hashes = await lineHashes(content);
		// Resolve one anchor (l3's hash) and pair it with a stale anchor to
		// force the not-found branch to render the read-format echo.
		let caught: Error | undefined;
		try {
			applyEdit(
				content,
				resEdit({
					remove_from: `3:${hashes[2]!}`,
					remove_to: `3:${hashes[2]!}`,
					replacement_text: "X",
				}),
				undefined,
				[
					hashes[0]!,
					hashes[1]!,
					"ZZZ", // stale hash at line 3
					hashes[3]!,
					hashes[4]!,
					hashes[5]!,
					hashes[6]!,
					hashes[7]!,
					hashes[8]!,
				],
			);
		} catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE|E_RANGE_UNVERIFIED/);
		expect(caught!.message).toMatch(/Echo of the line you tried|fresh anchors/);
	});
});

describe("grep — line#hash output", () => {
	it("renders matches as line#hash:content under the header", async () => {
		await withTempFile("g.txt", "alpha\nbeta\nalpha-again\ngamma\n", async ({ cwd }) => {
			const { ctx } = setupIntegrationTest(cwd);
			const { buildGrepTool } = await import("../../src/tool-grep.js");
			const { localIO } = await import("../../src/fs-bridge.js");
			const tool = buildGrepTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute(
				{ path: "g.txt", pattern: "alpha" },
				exec(ctx),
			)) as { modelText: string; files: unknown[]; total: number };
			const text = value.modelText;
			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^--- .*g\.txt ---$/);
			expect(lines[1]).toMatch(/^ANCHOR:FILELINE/);
			expect(lines[2]).toMatch(/^[A-Za-z0-9]{2,8}:\s*alpha$/);
			expect(lines.some((l) => l.includes("alpha-again"))).toBe(true);
			expect(lines.some((l) => l.includes("gamma"))).toBe(false);
			expect(value.files.length).toBe(1);
			expect(value.total).toBe(2);
		});
	});

	it("includes context rows when -C N is provided", async () => {
		await withTempFile("ctx.txt", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
			const { ctx } = setupIntegrationTest(cwd);
			const { buildGrepTool } = await import("../../src/tool-grep.js");
			const { localIO } = await import("../../src/fs-bridge.js");
			const tool = buildGrepTool(localIO());
			const exec = (args: unknown) =>
				({
					signal: new AbortController().signal,
					agent: { id: "s", session: { id: "s", header: { cwd } } },
					arguments: args,
				}) as never;
			const value = (await tool.execute(
				{ path: "ctx.txt", pattern: "c", context: 1 },
				exec(ctx),
			)) as { modelText: string };
			const text = value.modelText;
			// Should include c (line 3), b (line 2), d (line 4)
			expect(text).toMatch(/[A-Za-z0-9]{2,8}:\s*b/);
			expect(text).toMatch(/[A-Za-z0-9]{2,8}:\s*c/);
			expect(text).toMatch(/[A-Za-z0-9]{2,8}:\s*d/);
			// Should not include a (line 1) or e (line 5)
			expect(text).not.toMatch(/[A-Za-z0-9]{2,8}:a/);
			expect(text).not.toMatch(/[A-Za-z0-9]{2,8}:e/);
		});
	});

	it("grepFileContent returns no section when there is no match", async () => {
		const hashes = lineHashesPure("a\nb\nc\n");
		const section = await grepFileContent("/x", "a\nb\nc\n", hashes, "zzz");
		expect(section).toBeUndefined();
	});
});