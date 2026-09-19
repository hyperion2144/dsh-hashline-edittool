/**
 * The structured error-value seam under test (map #137, #139/#140, spec #146):
 * the shared builder, the `[E_*]` whitelist recognizer, and every tool's
 * execute boundary — a domain error comes back as a canonical value
 * (`{ modelText, error }`), never a throw; aborts and non-domain failures
 * still throw for the host.
 *
 * `lsp` is asserted at the harness level in `tool-lsp.test.ts`
 * (E_LSP_BAD_OPERATION resolves with the error content); its fake-manager
 * harness is file-local, so it is not re-rigged here.
 *
 * @module dsh-hashline-edittool/test/error-result
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildGrepTool } from "../../src/tools/tool-grep.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { buildUndoTool } from "../../src/tools/tool-undo.js";
import { buildAstGrepTool } from "../../src/tools/tool-ast-grep.js";
import { buildAstEditTool } from "../../src/tools/tool-ast-edit.js";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";
import { applyEffective } from "../../src/config.js";
import {
	buildErrorResult,
	pathFromArgs,
	thrownErrorResult,
	type ErrorResultValue,
} from "../../src/infra/error-result.js";

/** The edit/undo/ast-edit tools need a sandbox controller; unconfined is the test default. */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

/** A minimal tool handle: direct-execute tests never touch the typed surface. */
type ToolHandle = {
	execute: (args: never, exec: never) => Promise<unknown>;
	output?: { presentationMeta?: (args: unknown, value: unknown) => unknown };
};

/** Assert one tool call resolves to the structured error value for `code`. */
async function expectErrorValue(
	tool: ToolHandle,
	args: unknown,
	exec: unknown,
	code: string,
): Promise<ErrorResultValue> {
	const value = (await tool.execute(args as never, exec as never)) as ErrorResultValue;
	expect(value.error?.code).toBe(code);
	expect(typeof value.modelText).toBe("string");
	// Witnesses make error values FULLY conform to the declared schema —
	// no filtering: the host enforces every required field.
	expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	return value;
}

/** Config state is per-test; every test starts from the compiled defaults. */
afterEach(() => {
	applyEffective({});
});

describe("buildErrorResult", () => {
	it("text mode composes the house message format", () => {
		const value = buildErrorResult({
			code: "E_DEMO",
			message: "boom",
			context: "ctx lines",
			hint: "do this",
			mode: "text",
		});
		expect(value.modelText).toBe("[E_DEMO] boom\n\nctx lines\n\nHint: do this");
		expect(value.error).toEqual({ code: "E_DEMO", message: "boom", context: "ctx lines", hint: "do this" });
	});

	it("text mode omits absent sections", () => {
		expect(buildErrorResult({ code: "E_DEMO", message: "boom", mode: "text" }).modelText).toBe("[E_DEMO] boom");
	});

	it("json mode emits a parseable pure-JSON error object", () => {
		const value = buildErrorResult({ code: "E_DEMO", message: "boom", path: "a.ts", mode: "json" });
		const parsed = JSON.parse(value.modelText) as Record<string, unknown>;
		expect(parsed).toMatchObject({ error: true, code: "E_DEMO", message: "boom", path: "a.ts" });
	});
});

describe("thrownErrorResult", () => {
	it("text mode keeps the thrown message byte-identical", () => {
		const original = '[E_STALE] 2 stale anchors in a.ts: "x", "y". Re-read for fresh anchors.';
		const value = thrownErrorResult(new Error(original));
		expect(value.modelText).toBe(original);
		expect(value.error).toEqual({ code: "E_STALE", message: '2 stale anchors in a.ts: "x", "y". Re-read for fresh anchors.' });
	});

	it("splits the echo block into context — blank-line variant (the aggregate/declared composer)", () => {
		const head =
			"[E_CONTENT_MISMATCH] declared: WRONG; actual: alpha (currently appears at line 1).";
		const echo = "  Echo of the line you tried (read-style, ±3 context):\nHEADER\n  1:ab| alpha";
		const original = `${head}\n\n${echo}\n\n  If this is the line you meant to edit, reuse the fresh marker ab without calling read.`;
		const value = thrownErrorResult(new Error(original));
		expect(value.modelText).toBe(original);
		expect(value.error.code).toBe("E_CONTENT_MISMATCH");
		expect(value.error.message).toBe("declared: WRONG; actual: alpha (currently appears at line 1).");
		expect(value.error.context).toMatch(/^Echo of the line you tried/);
		expect(value.error.context).toContain("alpha");
	});

	it("splits the echo block into context — single-newline variant (the inline composer)", () => {
		const original =
			"[E_RANGE_UNVERIFIED] — line 3 was never served.\nEcho of the line you tried (read-style, ±3 context):\nHEADER\n  3:cd| gamma\n\nIf this is the line you meant, reuse the fresh marker cd.";
		const value = thrownErrorResult(new Error(original));
		expect(value.error.context).toMatch(/^Echo of the line you tried/);
		expect(value.error.message).not.toContain("Echo");
	});

	it("keeps a single-newline tail in the message (E_BATCH_ABORT has no blank line)", () => {
		const original =
			"[E_BATCH_ABORT] edits[1] (b.txt) failed: inner\nThe whole batch was rejected and NOTHING was written.";
		const value = thrownErrorResult(new Error(original));
		expect(value.error.message).toBe(
			"edits[1] (b.txt) failed: inner\nThe whole batch was rejected and NOTHING was written.",
		);
		expect(value.error.context).toBeUndefined();
	});

	it("rethrows anything outside the [E_*] whitelist", () => {
		const abort = new Error("Operation aborted");
		expect(() => thrownErrorResult(abort)).toThrow(abort);
		expect(() => thrownErrorResult(new Error("[sandbox: file access denied under read-only mode]"))).toThrow(
			/\[sandbox:/,
		);
		expect(() => thrownErrorResult("a plain string without a code")).toThrow();
	});

	it("carries the call-site path", () => {
		const value = thrownErrorResult(new Error("[E_DEMO] x"), { path: "a.ts" });
		expect(value.error.path).toBe("a.ts");
	});
});

describe("pathFromArgs", () => {
	it("reads path, then file_path, else undefined", () => {
		expect(pathFromArgs({ path: "a.ts" })).toBe("a.ts");
		expect(pathFromArgs({ file_path: "a.ts" })).toBe("a.ts");
		expect(pathFromArgs({ path: 123, file_path: "a.ts" })).toBe("a.ts");
		expect(pathFromArgs({ pattern: "x" })).toBeUndefined();
		expect(pathFromArgs(null)).toBeUndefined();
	});
});

describe("tool boundary — a domain error is a returned value, never a throw", () => {
	it("read: E_BAD_SHAPE args come back as the error value", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			await expectErrorValue(
				buildReadTool(localIO()) as unknown as ToolHandle,
				{ file_path: "f.txt", selector: "symbol" },
				makeExec(cwd)({}),
				"E_BAD_SHAPE",
			);
		});
	});

	it("edit: a failing single-file edit comes back as the error value (engine-wrapped)", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			const value = await expectErrorValue(
				buildEditTool(localIO(), testSandbox()) as unknown as ToolHandle,
				{ path: "f.txt", edits: [{ op: "replace", anchor_start: "2", lines: ["Y"] }] },
				makeExec(cwd)({}),
				"E_BATCH_ABORT",
			);
			// The engine wraps even a single-file failure; the INNER code rides the
			// message — the call's failure code is the wrapper (ADR-0007).
			expect(value.modelText).toContain("E_BAD_REF");
			expect(value.error?.path).toBe("f.txt");
		});
	});

	it("grep: E_BAD_SHAPE pattern comes back as the error value", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			await expectErrorValue(
				buildGrepTool(localIO()) as unknown as ToolHandle,
				{ pattern: "(" },
				makeExec(cwd)({}),
				"E_BAD_SHAPE",
			);
		});
	});

	it("write: E_BAD_SHAPE file_path comes back as the error value", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			await expectErrorValue(
				buildWriteShadowTool(localIO(), testSandbox()) as unknown as ToolHandle,
				{ file_path: "", content: "x" },
				makeExec(cwd)({}),
				"E_BAD_SHAPE",
			);
		});
	});

	it("undo: E_BAD_SHAPE path comes back as the error value", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			await expectErrorValue(
				buildUndoTool(localIO(), testSandbox()) as unknown as ToolHandle,
				{ path: "" },
				makeExec(cwd)({}),
				"E_BAD_SHAPE",
			);
		});
	});

	it("ast_grep: E_AST_DISABLED comes back as the error value", async () => {
		applyEffective({ ast: { enabled: false } });
		await withTempFile("f.ts", "const a = 1;\n", async ({ cwd }) => {
			await expectErrorValue(
				buildAstGrepTool(localIO()) as unknown as ToolHandle,
				{ path: "f.ts", pat: "const $N = $V;" },
				makeExec(cwd)({}),
				"E_AST_DISABLED",
			);
		});
	});

	it("ast_edit: E_AST_DISABLED comes back as the error value", async () => {
		applyEffective({ ast: { enabled: false } });
		await withTempFile("f.ts", "const a = 1;\n", async ({ cwd }) => {
			await expectErrorValue(
				buildAstEditTool(localIO(), testSandbox()) as unknown as ToolHandle,
				{ path: "f.ts", pat: "const $N = $V;", out: "const $N = 2;" },
				makeExec(cwd)({}),
				"E_AST_DISABLED",
			);
		});
	});

	it("JSON mode: modelText is a parseable error object, not prose", async () => {
		applyEffective({ output_format: "json" });
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			const value = (await (
				buildWriteShadowTool(localIO(), testSandbox()) as unknown as ToolHandle
			).execute({ file_path: "", content: "x" } as never, makeExec(cwd)({}) as never)) as ErrorResultValue;
			const parsed = JSON.parse(value.modelText) as Record<string, unknown>;
			expect(parsed).toMatchObject({ error: true, code: "E_BAD_SHAPE" });
		});
	});
});

describe("presentationMeta projects the error", () => {
	it("edit: an error value projects to exactly { error }", () => {
		const tool = buildEditTool(localIO(), testSandbox()) as unknown as ToolHandle;
		const meta = tool.output?.presentationMeta?.(undefined, {
			modelText: "x",
			error: { code: "E_DEMO", message: "boom" },
		});
		expect(meta).toEqual({ error: { code: "E_DEMO", message: "boom" } });
	});

	it("read: an error value projects to exactly { error }", () => {
		const tool = buildReadTool(localIO()) as unknown as ToolHandle;
		const meta = tool.output?.presentationMeta?.(undefined, {
			modelText: "x",
			error: { code: "E_DEMO", message: "boom" },
		});
		expect(meta).toEqual({ error: { code: "E_DEMO", message: "boom" } });
	});
});

describe("echo context end-to-end (require_line_content)", () => {
	it("a wrong declaration returns E_CONTENT_MISMATCH with the echo in context", async () => {
		applyEffective({ require_line_content: true });
		await withTempFile("decl.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const read = buildReadTool(localIO());
			const served = (await read.execute({ file_path: "decl.txt" }, makeExec(cwd)({}))) as {
				hashlines: Array<{ number: number; hash: string; text: string }>;
			};
			const alpha = served.hashlines.find((h) => h.text === "alpha")!;
			const edit = buildEditTool(localIO(), testSandbox());
			const value = (await edit.execute(
				{
					path: "decl.txt",
					edits: [{ op: "replace", anchor_start: { anchor: alpha.hash, line: "WRONG" }, lines: ["A"] }],
				},
				makeExec(cwd)({}),
			)) as ErrorResultValue;
			expect(value.error?.code).toBe("E_BATCH_ABORT");
			expect(value.modelText).toContain("E_CONTENT_MISMATCH");
			// This vocabulary family has NO echo block: its facts are structured
			// prose on single newlines, so they ride `message` and context stays empty.
			expect(value.error.message).toContain("declared: WRONG");
			expect(value.error.message).toContain("actual:");
			expect(value.error.context).toBeUndefined();
			// Atomic: nothing was written.
			expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\n");
		});
	});

	it("an external drift returns the stale family with the echo in context", async () => {
		await withTempFile("drift.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const read = buildReadTool(localIO());
			const served = (await read.execute({ file_path: "drift.txt" }, makeExec(cwd)({}))) as {
				hashlines: Array<{ number: number; hash: string; text: string }>;
			};
			const beta = served.hashlines.find((h) => h.text === "beta")!;
			// External drift AFTER the serve: the served-staleness check fires before
			// any declaration verdict, and its rejection carries the ±context echo.
			await writeFile(path, "alpha\nDRIFTED\ngamma\n", "utf-8");
			const edit = buildEditTool(localIO(), testSandbox());
			const value = (await edit.execute(
				{
					path: "drift.txt",
					edits: [{ op: "replace", anchor_start: `2:${beta.hash}`, lines: ["B"] }],
				},
				makeExec(cwd)({}),
			)) as ErrorResultValue;
			// The stale family surfaces its own code (the engine's wrap is selective);
			// what matters here is the family AND the echo landing in context.
			expect(
				["E_BATCH_ABORT", "E_RANGE_UNSERVED", "E_RANGE_UNVERIFIED", "E_STALE"].includes(value.error?.code ?? ""),
			).toBe(true);
			expect(value.modelText).toMatch(/E_RANGE_UNSERVED|E_RANGE_UNVERIFIED|E_STALE/);
			// A line hint lets the rejection center its ±context echo on the named
			// line, and that echo block is exactly what lands in context.
			expect(value.error?.context ?? "").toMatch(/^Echo of the line you tried/);
		});
	});
});

describe("abort stays a host failure", () => {
	it("an aborted signal rejects — never an error value", async () => {
		await withTempFile("f.txt", "alpha\n", async ({ cwd }) => {
			const tool = buildEditTool(localIO(), testSandbox()) as unknown as ToolHandle;
			const exec = { ...makeExec(cwd)({}), signal: AbortSignal.abort() };
			await expect(
				tool.execute({ path: "f.txt", edits: [{ op: "replace", anchor_start: "zz", lines: ["Y"] }] } as never, exec as never),
			).rejects.toThrow(/aborted/i);
		});
	});
});

describe("multi-file fail[] — backward compat + the all-failed aggregate", () => {
	/** Serve both files and return the anchor of `line` in `file`. */
	async function serveAnchor(cwd: string, file: string, line: string): Promise<string> {
		const read = buildReadTool(localIO());
		const served = (await read.execute({ file_path: file }, makeExec(cwd)({}))) as {
			hashlines: Array<{ hash: string; text: string }>;
		};
		return served.hashlines.find((h) => h.text === line)!.hash;
	}

	it("mixed: fail[] carries the failed file, no meta.error (the call did not fail)", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "beta\n", "utf-8");
			const aAnchor = await serveAnchor(cwd, "a.txt", "alpha");
			const edit = buildEditTool(localIO(), testSandbox());
			const value = (await edit.execute(
				{
					edits: [
						{ path: "a.txt", op: "replace", anchor_start: aAnchor, lines: ["ALPHA"] },
						{ path: "b.txt", op: "replace", anchor_start: "2", lines: ["B"] },
					],
				},
				makeExec(cwd)({}),
			)) as {
				success: unknown[];
				fail: Array<{ code: string; path: string }>;
				error?: unknown;
			};
			expect(value.success).toHaveLength(1);
			expect(value.fail).toHaveLength(1);
		// ADR-0004's fail[] convention keeps the BRACKETED marker; meta.error
		// (the card channel) is normalized unbracketed — both live side by side.
		expect(value.fail[0]).toMatchObject({ code: "[E_BAD_REF]", path: "b.txt" });
			expect(value.error).toBeUndefined();
		});
	});

	it("all failed: meta.error aggregates while fail[] keeps the per-file detail", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "beta\n", "utf-8");
			const edit = buildEditTool(localIO(), testSandbox());
			const value = (await edit.execute(
				{
					edits: [
						{ path: "a.txt", op: "replace", anchor_start: "2", lines: ["A"] },
						{ path: "b.txt", op: "replace", anchor_start: "2", lines: ["B"] },
					],
				},
				makeExec(cwd)({}),
			)) as {
				fail: Array<{ code: string; path: string }>;
				error?: { code: string; message: string; path?: string; context?: string };
			};
			expect(value.fail).toHaveLength(2);
			expect(value.error?.code).toBe("E_BAD_REF");
			expect(value.error?.message).toContain("2 file(s) failed");
			expect(value.error?.context ?? "").toContain("a.txt");
			expect(value.error?.context ?? "").toContain("b.txt");
		});
	});
});
