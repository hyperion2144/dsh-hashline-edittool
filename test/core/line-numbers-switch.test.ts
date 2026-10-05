/**
 * #244 (A1) — line numbers are the USER's switch, not a tool parameter.
 *
 * The `line_numbers` argument is gone from every tool. The plugin setting
 * ("显示行号 / Show line numbers", OFF by default) decides whether a model-side
 * row is `<anchor>:<line>` or the bare anchor. The other suites pin the legacy
 * ON state so their old assertions still mean something; THIS file pins what
 * only it can:
 *
 *   1. both states, in one place, on the real tools;
 *   2. the retirement is EXPLICIT — a whitelist that silently ignored the old
 *      parameter would look like success to the model, so every tool refuses it
 *      with the settings pointer instead;
 *   3. structured presentation metadata is NOT governed by the switch. The web
 *      cards read `presentationMeta`, so "hide the row numbers" must not take
 *      the gutter away from them.
 *
 * Row assertions go through `markerFor` rather than a hand-written regex: the
 * marker column is padded and the content seam carries a space
 * (`fmtHashlineRow` → `${marker.padStart(width)}${separator} ${content}`), so a
 * regex on the rendered line would pin formatting the test does not care about.
 *
 * @module test/core/line-numbers-switch.test.ts
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { applyEffective } from "../../src/config.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { fmtMarker } from "../../src/hashline/hash-assign.js";
import { loadHashStore } from "../../src/domain/session/hash-store.js";
import { buildAstGrepTool } from "../../src/tools/tool-ast-grep.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { setAstClient, type WorkerLike } from "../../src/ast/client.js";
import { handleRequest, type AstWorkerRequest, type AstWorkerResponse } from "../../src/ast/worker.js";
import { getText, getWritableTempRoot, makeExec, setupIntegrationTest } from "../support/fixtures.js";

const BODY = ["line-01 content", "line-02 content", "line-03 content"].join("\n") + "\n";
/** A dot-free TypeScript line the AST pattern below matches exactly once. */
const TS_BODY = "const a = f(1, 2);\n";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "line-numbers-switch-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

// Every test states the mode it needs; nothing may leak into the next one.
afterEach(() => {
	applyEffective(undefined);
	setAstClient(undefined);
});

function testSandbox(): FsSandboxController {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** The IN-PROCESS worker `tool-ast.test.ts` drives — the grammar really parses
 *  and no thread is spawned (the built `worker.js` does not exist in a source
 *  checkout, which is what makes the spawn path fail under vitest). */
function inProcessWorker(): WorkerLike {
	let respond: ((response: AstWorkerResponse) => void) | undefined;
	return {
		postMessage(message: AstWorkerRequest) {
			void handleRequest(message).then((response) => respond?.(response));
		},
		onMessage(listener) {
			respond = listener;
		},
		onExit() {},
		terminate() {},
	};
}

/** A temp cwd holding `f.txt` (BODY) — and optionally a TypeScript sibling. */
async function makeCase(name: string, extra?: { file: string; body: string }): Promise<string> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "f.txt"), BODY, "utf-8");
	if (extra) await writeFile(join(cwd, extra.file), extra.body, "utf-8");
	return cwd;
}

/**
 * The marker rendered in front of `content`, exactly as the model reads it:
 * everything left of the content seam, padding trimmed. Both dialects come
 * through here — the anchor alone, or `<anchor>:<line>` — so a test says which
 * it expects instead of re-describing the format.
 */
/** Every rendered row as `[marker, content]`: read rows seam tight
 *  (`<marker>:content`), `fmtHashlineRow` seams with a space (`<marker>: content`),
 *  and diff rows carry a `+`/`-`/` ` prefix before the (possibly padded) marker —
 *  all three meet here. */
function renderRows(text: string): Array<[string, string]> {
	const found: Array<[string, string]> = [];
	for (const raw of text.split("\n")) {
		const match = /^[+\- ]*([A-Za-z0-9]{1,8}(?::\d+)?):\s?(.*)$/.exec(raw);
		if (match !== null) found.push([match[1]!, match[2] ?? ""]);
	}
	return found;
}

/**
 * The marker rendered in front of `content`, exactly as the model reads it —
 * the anchor alone, or `<anchor>:<line>`. Row assertions say which they expect
 * instead of re-describing the format.
 */
function markerFor(text: string, content: string): string {
	const row = renderRows(text).find(([, body]) => body === content);
	if (row === undefined) throw new Error(`no row for ${JSON.stringify(content)} in:\n${text}`);
	return row[0];
}

/** `true` when any row carries a `:line` hint between its anchor and its text. */
function hasNumberedRows(text: string): boolean {
	return /^\s*[+\- ]*[A-Za-z0-9]{1,8}:\d+:/.test(text.split("\n").join("\n")) || /\n\s*[+\- ]*[A-Za-z0-9]{1,8}:\d+:/.test(text);
}

/**
 * The refusal text of a tool call. A rejected hashline request comes back as
 * `[E_…]` TEXT on the tool's single channel (that is the contract `edit`'s echo
 * tests rely on too), so "refused" is not the same thing as "threw" — both are
 * accepted here, and a success is reported as a failure with the tool's name.
 */
async function refusal(tool: string, run: Promise<unknown>): Promise<string> {
	let text: string;
	try {
		const result = (await run) as { content?: Array<{ text?: string }> };
		text = typeof result === "string" ? result : getText(result as { content: Array<{ text?: string }> });
	} catch (err) {
		text = err instanceof Error ? err.message : String(err);
	}
	if (!/\[E_[A-Z_]+\]/.test(text)) {
		throw new Error(`${tool} accepted the retired \`line_numbers\` parameter: ${text.slice(0, 200)}`);
	}
	return text;
}

describe("#244 the line-number switch", () => {
	it("is OFF by default: read rows carry the anchor alone", async () => {
		applyEffective(undefined);
		const h = setupIntegrationTest(await makeCase("read-off"));
		const text = getText(await h.readTool.execute("read", { path: "f.txt" }));

		expect(text).toContain("the marker is the anchor alone");
		expect(markerFor(text, "line-01 content")).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hasNumberedRows(text)).toBe(false);
	});

	it("is ON on request: the same rows carry <anchor>:<line>", async () => {
		applyEffective({ line_numbers: true });
		const h = setupIntegrationTest(await makeCase("read-on"));
		const text = getText(await h.readTool.execute("read", { path: "f.txt" }));

		expect(text).toContain("the line number is a positional hint only");
		expect(markerFor(text, "line-01 content")).toMatch(/^[A-Za-z0-9]{2,8}:1$/);
		expect(hasNumberedRows(text)).toBe(true);
	});

	it("refuses the retired parameter on every tool — never a silent ignore", async () => {
		applyEffective(undefined);
		const h = setupIntegrationTest(await makeCase("retired"));

		// Thunks, not promises: a call that fails ARG VALIDATION rejects before the
		// loop reaches it, and an unawaited rejection is reported as an unhandled
		// error rather than the refusal this test is looking for.
		const cases: Array<[string, () => Promise<unknown>]> = [
			["read", () => h.readTool.execute("read", { path: "f.txt", line_numbers: false })],
			[
				"edit",
				() =>
					h.editTool.execute("edit", {
						path: "f.txt",
						line_numbers: true,
						edits: [{ op: "replace", anchor_start: "zz", anchor_end: "zz", lines: ["x"] }],
					}),
			],
			["grep", () => h.getTool("grep").execute("grep", { path: ".", pattern: "line", line_numbers: true })],
			["undo_last_edit", () => h.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.txt", line_numbers: true })],
		];

		for (const [tool, run] of cases) {
			const message = await refusal(tool, run());
			expect(`${tool}: ${message}`).toContain("[E_BAD_SHAPE]");
			expect(`${tool}: ${message}`).toContain("line_numbers");
			expect(`${tool}: ${message}`).toContain("`line_numbers` is not a tool parameter anymore");
			// The pointer is the whole point: the model must learn WHERE the
			// switch lives instead of retrying the parameter.
			expect(`${tool}: ${message}`).toContain("显示行号");
		}
	});

	it("edit rows — text and JSON keys — follow the switch, and the CARD keeps its numbers", async () => {
		const cwd = await makeCase("edit-switch");
		const io = localIO();
		const read = buildReadTool(io);
		const edit = buildEditTool(io, testSandbox());
		const execFor = makeExec(cwd, "test-session");
		const params = (anchor: string, content = "line-02 changed") => ({
			path: "f.txt",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: [content] }],
		});

		/**
		 * The anchor of line 2, from whichever view the current output mode
		 * serves: the JSON `lines` map or the text rows — both run in file order.
		 * The served set is single-use, so every call below re-reads: the previous
		 * call consumed its anchor, and what it left behind is just the file's
		 * next state.
		 */
		const freshAnchor = async (): Promise<string> => {
			const served = (await read.execute({ path: "f.txt" }, execFor({}))) as unknown as {
				modelText?: string;
			};
			const text = served.modelText ?? "";
			// A JSON view IS the model text in JSON mode: its keys run in file order.
			const json = text.startsWith("{") ? (JSON.parse(text) as { lines?: Record<string, string> }).lines : undefined;
			const markers = json !== undefined ? Object.keys(json) : renderRows(text).map(([marker]) => marker);
			const marker = markers[1];
			if (marker === undefined) throw new Error(`no line 2 in:\n${text}`);
			// The line number is a positional hint, never part of the anchor.
			return marker.replace(/:\d+$/, "");
		};

		// Text mode, OFF: the diff row names the anchor alone.
		applyEffective(undefined);
		const anchor = await freshAnchor();
		const off = (await edit.execute(params(anchor, "line-02 changed"), execFor({}))) as {
			modelText: string;
		};
		expect(markerFor(off.modelText, "line-02 changed")).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hasNumberedRows(off.modelText)).toBe(false);

		// The gutter the web card draws is structured metadata, so it is out of
		// the switch's reach: glue that hid it would blank the card's rows.
		// The single-file form projects `diffs` + `diffRows` (the multi-file form
		// uses `diffRowGroups`); both carry the card's gutter, so both are read here.
		const { presentationMeta } = edit.output as unknown as {
			presentationMeta?: (args: unknown, value: unknown) => {
				diffRows?: Array<{ lineNumber?: number }>;
				diffRowGroups?: Array<{ rows: Array<{ lineNumber?: number }> }>;
			};
		};
		const meta = presentationMeta?.(params(anchor), off) ?? {};
		const rows = [...(meta.diffRows ?? []), ...(meta.diffRowGroups ?? []).flatMap((group) => group.rows)];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(Number.isInteger(row.lineNumber)).toBe(true);

		// JSON mode: the keys are the model-side names for the same rows, so they
		// must follow the switch in both states. In this mode the envelope IS the
		// model text (the same dict `getText` hands a caller), so it is parsed from
		// there rather than off the value's own fields.
		const jsonDiffOf = async (content: string, state: Parameters<typeof applyEffective>[0]): Promise<Record<string, string>> => {
			applyEffective(state);
			const value = (await edit.execute(params(await freshAnchor(), content), execFor({}))) as {
				modelText: string;
			};
			const parsed = JSON.parse(value.modelText) as { ok?: boolean; diff?: Record<string, string> };
			expect(parsed.ok).toBe(true);
			return parsed.diff ?? {};
		};

		const offKeys = Object.keys(await jsonDiffOf("line-02 changed again", { output_format: "json" })).map((key) =>
			key.replace(/^[+-]/, ""),
		);
		expect(offKeys.length).toBeGreaterThan(0);
		for (const key of offKeys) expect(key).toMatch(/^[A-Za-z0-9]{2,8}$/);

		const onKeys = Object.keys(
			await jsonDiffOf("line-02 changed a third time", { output_format: "json", line_numbers: true }),
		).map((key) => key.replace(/^[+-]/, ""));
		expect(onKeys.length).toBeGreaterThan(0);
		for (const key of onKeys) expect(key).toMatch(/^[A-Za-z0-9]{2,8}:\d+$/);
	});

	it("grep and undo_last_edit rows follow the same switch", async () => {
		applyEffective(undefined);
		const h = setupIntegrationTest(await makeCase("grep-undo"));

		const grepOff = getText(await h.getTool("grep").execute("grep", { path: ".", pattern: "line-02" }));
		expect(markerFor(grepOff, "line-02 content")).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hasNumberedRows(grepOff)).toBe(false);

		const read = getText(await h.readTool.execute("read", { path: "f.txt" }));
		const anchor = markerFor(read, "line-02 content");
		await h.editTool.execute("edit", {
			path: "f.txt",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["line-02 changed"] }],
		});
		const undone = getText(await h.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.txt" }));
		expect(undone).toContain("line-02 content");
		expect(hasNumberedRows(undone)).toBe(false);

		applyEffective({ line_numbers: true });
		const grepOn = getText(await h.getTool("grep").execute("grep", { path: ".", pattern: "line-02" }));
		expect(markerFor(grepOn, "line-02 content")).toMatch(/^[A-Za-z0-9]{2,8}:2$/);
	});

	it("write's auto-read preview follows the switch", async () => {
		const cwd = await makeCase("write-preview");
		const tool = buildWriteShadowTool(localIO(), testSandbox());
		const execFor = makeExec(cwd, "test-session");

		applyEffective(undefined);
		const off = (await tool.execute({ file_path: "w.txt", content: "alpha\nbeta\n" }, execFor({}))) as {
			modelText: string;
		};
		expect(off.modelText).toContain("Auto-read");
		expect(markerFor(off.modelText, "alpha")).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hasNumberedRows(off.modelText)).toBe(false);

		applyEffective({ line_numbers: true });
		const on = (await tool.execute({ file_path: "w2.txt", content: "alpha\nbeta\n" }, execFor({}))) as {
			modelText: string;
		};
		expect(markerFor(on.modelText, "alpha")).toMatch(/^[A-Za-z0-9]{2,8}:1$/);
	});

	it("ast_grep rows follow the switch", async () => {
		const cwd = await makeCase("ast-rows", { file: "t.ts", body: TS_BODY });
		await loadHashStore(cwd);
		const { AstClient } = (await import("../../src/ast/client.js")) as unknown as {
			AstClient: new (opts: { spawn: () => WorkerLike; idleMs: number }) => Parameters<typeof setAstClient>[0];
		};
		setAstClient(new AstClient({ spawn: inProcessWorker, idleMs: 0 }));
		const tool = buildAstGrepTool(localIO());
		const execFor = makeExec(cwd, "test-session");
		const params = { path: "t.ts", pat: "const $NAME = f($$$ARGS);" };

		applyEffective({ ast: { enabled: true } });
		const off = (await tool.execute(params, execFor({}))) as { modelText?: string };
		expect(markerFor(off.modelText ?? "", "const a = f(1, 2);")).toMatch(/^[A-Za-z0-9]{2,8}$/);
		expect(hasNumberedRows(off.modelText ?? "")).toBe(false);

		applyEffective({ ast: { enabled: true }, line_numbers: true });
		const on = (await tool.execute(params, execFor({}))) as { modelText?: string };
		expect(markerFor(on.modelText ?? "", "const a = f(1, 2);")).toMatch(/^[A-Za-z0-9]{2,8}:1$/);
	});

	it("one marker helper serves every row site, lsp included", () => {
		// `lsp` renders its rows through `fmtMarker` (src/tools/tool-lsp.ts), so
		// this helper IS the lsp side of the switch — a second "does lsp follow?"
		// integration test would exercise this same call and nothing more.
		applyEffective(undefined);
		expect(fmtMarker("ab", 3)).toBe("ab");
		applyEffective({ line_numbers: true });
		expect(fmtMarker("ab", 3)).toBe("ab:3");
	});
});
