/**
 * `op: "sed"` — a range-scoped regular-expression substitution, aligned with
 * command-line sed.
 *
 * The contract worth pinning is the SEMANTIC alignment, not the existence of a
 * field: line by line (so a pattern never spans two lines), first match only
 * unless `g`, sed's own `\1` / `&` accepted alongside JavaScript's `$1` / `$&`,
 * an empty replacement deleting the match, and a refusal when the caller asks
 * for something sed does not do (a newline in the replacement, or `lines` next
 * to `pattern`).
 *
 * @module dsh-hashline-edittool/test/sed-op
 */
import { describe, expect, it } from "vitest";
import { applyEdit } from "../../src/hashline/anchor-pipeline.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { sedReplacement, sedTransform } from "../../src/domain/edit/edit-engine.js";
import { assertEditItem } from "../../src/contract/contract.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { join } from "node:path";

const SOURCE = [
	"const ALPHA_LIMIT = 10;",
	"const beta_limit = 20;",
	"const GammaLimit = 30;",
	"// a comment mentioning ALPHA_LIMIT and beta_limit",
].join("\n");

const anchors = lineHashesPure(SOURCE);

/** Apply a sed edit over lines [from, to] (1-based, inclusive). */
function sed(from: number, to: number, pattern: string, replacement: string, flags?: string): string {
	return applyEdit(
		SOURCE,
		{ content_lines: [""], hash_bounds: [{ anchor: anchors[from - 1]! }, { anchor: anchors[to - 1]! }] },
		undefined,
		anchors,
		"probe.ts",
		undefined,
		undefined,
		{ transform: sedTransform(pattern, replacement, flags) },
	).content;
}

const line = (text: string, n: number): string => text.split("\n")[n - 1]!;

describe("op:sed — a sed-aligned substitution", () => {
	it("rewrites only the anchor range, and only the FIRST match per line", () => {
		const out = sed(2, 2, "limit", "LIMIT");
		expect(line(out, 1)).toBe("const ALPHA_LIMIT = 10;");
		expect(line(out, 2)).toBe("const beta_LIMIT = 20;");
		expect(line(out, 3)).toBe("const GammaLimit = 30;");
		expect(line(out, 4)).toBe("// a comment mentioning ALPHA_LIMIT and beta_limit");
	});

	it("`g` replaces every match on every line, as sed's s///g does", () => {
		const out = sed(4, 4, "limit", "LIMIT", "gi");
		expect(line(out, 4)).toBe("// a comment mentioning ALPHA_LIMIT and beta_LIMIT");
	});

	it("`i` ignores case and `\\1` is a capture reference, sed's own syntax", () => {
		const out = sed(1, 1, "const (\\w+) =", "[\\1]", "i");
		expect(line(out, 1)).toBe("[ALPHA_LIMIT] 10;");
	});

	it("`$1` and `$&` work too — JavaScript's dialect is not a second-class citizen", () => {
		expect(sedReplacement("X$1")).toBe("X$1");
		expect(sedReplacement("X\\1")).toBe("X$1");
		expect(sedReplacement("<&>")).toBe("<$&>");
		expect(sedReplacement("\\&")).toBe("&");
		expect(sed(2, 2, "(beta)", "<$1>")).toContain("const <beta>_limit");
	});

	it("an empty replacement DELETES what the pattern matched", () => {
		const out = sed(4, 4, " ALPHA_LIMIT", "", "g");
		expect(line(out, 4)).toBe("// a comment mentioning and beta_limit");
	});

	it("a multi-line range rewrites each line independently — a pattern never spans lines", () => {
		const out = sed(1, 3, "^const (\\w+)", "let $1", "i");
		expect(line(out, 1)).toBe("let ALPHA_LIMIT = 10;");
		expect(line(out, 2)).toBe("let beta_limit = 20;");
		expect(line(out, 3)).toBe("let GammaLimit = 30;");
		expect(out.split("\n")).toHaveLength(SOURCE.split("\n").length);
	});
});

describe("op:sed — the contract refuses what sed cannot mean", () => {
	const item = (extra: Record<string, unknown>): Record<string, unknown> => ({
		op: "sed",
		anchor_start: "ab",
		pattern: "a",
		replacement: "b",
		...extra,
	});

	it("accepts a minimal sed item", () => {
		expect(() => assertEditItem(item({}), 0, true, false)).not.toThrow();
	});

	it("refuses `lines` next to `pattern` — the substitution is the replacement", () => {
		expect(() => assertEditItem(item({ lines: ["x"] }), 0, true, false)).toThrow(/not "lines"/);
	});

	it("refuses a newline in the replacement: sed never changes the line count", () => {
		expect(() => assertEditItem(item({ replacement: "a\nb" }), 0, true, false)).toThrow(
			/must not contain a newline/,
		);
	});

	it("refuses a missing pattern/replacement and a bad flags value", () => {
		expect(() => assertEditItem(item({ pattern: "" }), 0, true, false)).toThrow(/requires a non-empty "pattern"/);
		expect(() => assertEditItem({ op: "sed", anchor_start: "ab", pattern: "a" }, 0, true, false)).toThrow(
			/requires "replacement"/,
		);
		expect(() => assertEditItem(item({ flags: "x" }), 0, true, false)).toThrow(/subset of "gims"/);
		expect(() => assertEditItem(item({ flags: "gg" }), 0, true, false)).toThrow(/subset of "gims"/);
	});

	it("refuses an invalid regular expression at the shape gate, with the engine's words", () => {
		expect(() => assertEditItem(item({ pattern: "([" }), 0, true, false)).toThrow(
			/not a valid regular expression/,
		);
	});
});

describe("op:sed — through the real edit tool", () => {
	it("applies two sed hunks atomically, one per anchor range", async () => {
		await withTempFile(
			"sed-tool.txt",
			"const ALPHA_LIMIT = 10;\nconst beta_limit = 20;\n// note: ALPHA_LIMIT again\n",
			async ({ cwd }) => {
				const io = localIO();
				const sandbox = new FsSandboxController({
					fs: { sandboxMode: undefined },
					get: () => undefined,
				} as never);
				const read = (await buildReadTool(io).execute(
					{ path: "sed-tool.txt" },
					makeExec(cwd)({}),
				)) as { hashlines: { number: number; hash: string }[] };
				const tool = buildEditTool(io, sandbox);
				await tool.execute(
					{
						path: "sed-tool.txt",
						edits: [
							{
								op: "sed",
								anchor_start: read.hashlines[0]!.hash,
								anchor_end: read.hashlines[1]!.hash,
								pattern: "const (\\w+)",
								replacement: "let $1",
								flags: "i",
							},
							{
								op: "sed",
								anchor_start: read.hashlines[2]!.hash,
								pattern: "ALPHA_LIMIT",
								replacement: "ALPHA_MAX",
								flags: "g",
							},
						],
					},
					makeExec(cwd)({}),
				);
				const { readFile } = await import("node:fs/promises");
				const after = await readFile(join(cwd, "sed-tool.txt"), "utf-8");
				expect(after).toBe("let ALPHA_LIMIT = 10;\nlet beta_limit = 20;\n// note: ALPHA_MAX again\n");
			},
		);
	});
});
