/**
 * Tests for the line#hash anchor upgrade. Covers:
 *   - `read` rendering carries the `HASH IDENTIFIER │ FILE LINES` header
 *   - `parseRef` accepts both `line#hash` and bare-hash forms
 *   - `edit.remove_to` is optional (defaults to remove_from)
 *   - post-edit response carries the `Shift:` block
 *   - batch multi-hunk edits emit one Shift block per hunk
 *   - stale anchor echo uses read format (±3 context)
 *   - grep tool outputs read-format matches
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures.js";
import { initHasher, parseHashRef, grepFileContent, lineHashesPure } from "../../src/hashline/index.js";
import { genDiff } from "../../src/edit-diff.js";

beforeAll(async () => {
	await initHasher();
});

describe("parseRef — line#hash form", () => {
	it("parses line#hash", () => {
		expect(parseHashRef("12#aB3")).toEqual({ hash: "aB3" });
	});

	it("parses line#hash with multi-digit line", () => {
		expect(parseHashRef("123#xyz")).toEqual({ hash: "xyz" });
	});

	it("still parses bare hash for hash-only fallback", () => {
		expect(parseHashRef("aB3")).toEqual({ hash: "aB3" });
	});
});

describe("read — header line", () => {
	it("emits the HASH IDENTIFIER │ FILE LINES header on top", async () => {
		await withTempFile("h.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { ctx, readTool } = setupIntegrationTest(cwd);
			const res = await readTool.execute("r", { path: "h.txt" }, undefined, undefined, ctx);
			const text = getText(res);
			const lines = text.split("\n");
			expect(lines[0]).toBe("HASH IDENTIFIER │ FILE LINES");
			expect(lines[1]).toMatch(/^1#[A-Za-z0-9]{3}│alpha$/);
			expect(lines[2]).toMatch(/^2#[A-Za-z0-9]{3}│beta$/);
		});
	});
});

describe("edit — remove_to optional", () => {
	it("edits just the remove_from line when remove_to is omitted", async () => {
		await withTempFile("single.ts", "one\ntwo\nthree\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const read = await readTool.execute("r", { path: "single.ts" }, undefined, undefined, ctx);
			const lines = getText(read).split("\n").filter((l) => l.includes("│") && !l.startsWith("HASH IDENTIFIER"));
			// Extract line#hash of line 2 ("two")
			const lineMarker = lines[1]!.match(/^(\d+#[A-Za-z0-9]{3})/)![1]!;

			await editTool.execute(
				"e",
				{ path: "single.ts", remove_from: lineMarker, replacement_text: "TWO!" },
				undefined,
				undefined,
				ctx,
			);

			const read2 = await readTool.execute("r2", { path: "single.ts" }, undefined, undefined, ctx);
			const lines2 = getText(read2).split("\n").filter((l) => l.includes("│") && !l.startsWith("HASH IDENTIFIER"));
			expect(lines2[0]).toMatch(/one$/);
			expect(lines2[1]).toMatch(/TWO!$/);
			expect(lines2[2]).toMatch(/three$/);
		});
	});
});

describe("edit — Shift block", () => {
	it("emits a Shift: lines > N shift by +K block when the edit shifts lines below", async () => {
		await withTempFile("shift.ts", "a\nb\nc\nd\ne\n", async ({ cwd }) => {
			const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
			const read = await readTool.execute("r", { path: "shift.ts" }, undefined, undefined, ctx);
			const lines = getText(read).split("\n").filter((l) => l.includes("│") && !l.startsWith("HASH IDENTIFIER"));
			// Replace line 2 ("b") with two lines.
			const lineMarker = lines[1]!.match(/^(\d+#[A-Za-z0-9]{3})/)![1]!;
			const res = await editTool.execute(
				"e",
				{
					path: "shift.ts",
					remove_from: lineMarker,
					remove_to: lineMarker,
					replacement_text: "B\nB2",
				},
				undefined,
				undefined,
				ctx,
			);
			const out = getText(res);
			expect(out).toMatch(/Shift: lines > 3 shift by \+1/);
		});
	});

	it("emits cumulative Shift blocks per hunk in a batch", async () => {
		await withTempFile("two.ts", "a\nb\nc\nd\ne\nf\ng\nh\n", async ({ cwd }) => {
			const { ctx, readTool, batchEditTool } = setupIntegrationTest(cwd);
			const read = await readTool.execute("r", { path: "two.ts" }, undefined, undefined, ctx);
			const lines = getText(read).split("\n").filter((l) => l.includes("│") && !l.startsWith("HASH IDENTIFIER"));
			const line2 = lines[1]!.match(/^(\d+#[A-Za-z0-9]{3})/)![1]!;
			const line5 = lines[4]!.match(/^(\d+#[A-Za-z0-9]{3})/)![1]!;
			const res = await batchEditTool.execute(
				"be",
				{
					edits: [
						{ path: "two.ts", remove_from: line2, remove_to: line2, replacement_text: "B\nB2" },
						{ path: "two.ts", remove_from: line5, remove_to: line5, replacement_text: "E\nE2" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			const out = getText(res);
			// Two hunks, each +1 → first hunk emits +1, second hunk emits cumulative +2.
			expect(out).toMatch(/Shift: lines > 3 shift by \+1/);
			expect(out).toMatch(/Shift: lines > \d+ shift by \+2/);
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
				resEdit({ remove_from: hashes[2]!, remove_to: "ZZZ", replacement_text: "X" }),
			);
		} catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
		expect(caught!.message).toMatch(/Echo of the line you tried/);
		expect(caught!.message).toMatch(/HASH IDENTIFIER │ FILE LINES/);
	});
});

describe("grep — line#hash output", () => {
	it("renders matches as line#hash│content under the header", async () => {
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
			const text = String(await tool.execute({ path: "g.txt", pattern: "alpha" }, exec(ctx)));
			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^--- .*g\.txt ---$/);
			expect(lines[1]).toBe("HASH IDENTIFIER │ FILE LINES");
			expect(lines[2]).toMatch(/^1#\w{3}│alpha$/);
			expect(lines.some((l) => l.includes("alpha-again"))).toBe(true);
			expect(lines.some((l) => l.includes("gamma"))).toBe(false);
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
			const text = String(
				await tool.execute({ path: "ctx.txt", pattern: "c", context: 1 }, exec(ctx)),
			);
			// Should include c (line 3), b (line 2), d (line 4)
			expect(text).toMatch(/\d+#\w{3}│b/);
			expect(text).toMatch(/\d+#\w{3}│c/);
			expect(text).toMatch(/\d+#\w{3}│d/);
			// Should not include a (line 1) or e (line 5)
			expect(text).not.toMatch(/\d+#\w{3}│a/);
			expect(text).not.toMatch(/\d+#\w{3}│e/);
		});
	});

	it("grepFileContent returns no section when there is no match", async () => {
		const hashes = lineHashesPure("a\nb\nc\n");
		const section = await grepFileContent("/x", "a\nb\nc\n", hashes, "zzz");
		expect(section).toBeUndefined();
	});
});