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
import { diagnosticsJson, type FileDiagnostics } from "../../src/lsp/auto-diag.js";
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
		// The number part may be a RANGE: a merged outline row's marker is
		// `<anchor>:<start>-<end>` (#259), and a pattern that rejected it would
		// make that row invisible to every assertion below — which is how the
		// outline leak stayed hidden.
		const match = /^[+\- ]*([A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?):\s?(.*)$/.exec(raw);
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

/**
 * `true` when any RENDERED ROW's marker carries a line number — `:N`, or the
 * `:START-END` range a merged outline row shows.
 *
 * Row-shaped ONLY. Prose that happens to name a line (a cursor's `offset=41`,
 * a rejection's `file:12` location, grep's `[line 7]` fallback for a row with
 * no anchor at all) is not a row and is deliberately NOT governed by the
 * switch — the caller cannot act without it in either state.
 */
function hasNumberedRows(text: string): boolean {
	return renderRows(text).some(([marker]) => /:\d/.test(marker));
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
		// `lsp` renders its ROWS through `fmtMarker` (src/tools/tool-lsp.ts), so for
		// those this helper IS the lsp side of the switch. Its diagnostics JSON
		// projection is a separate builder with its own key spelling — that one is
		// pinned in the #259 block below, not here.
		applyEffective(undefined);
		expect(fmtMarker("ab", 3)).toBe("ab");
		applyEffective({ line_numbers: true });
		expect(fmtMarker("ab", 3)).toBe("ab:3");
	});
});

/**
 * #259 — the switch is TOTAL. #248 wired the four tools and `ast_grep`'s match
 * rows; auditing every marker and legend construction against
 * `lineNumbersEnabled()`'s consumers turned up the sites it left behind. One
 * test per site, each stating the ticket's contract: with the switch OFF,
 * nothing a tool returns carries a line number — not a text row, not a merged
 * row's range, not a JSON key, not a header legend.
 *
 * The boundary is ROWS AND LEGENDS, not prose. A cursor (`offset=41`), a
 * rejection's `file:12` location and grep's `[line N]` fallback for a row with
 * no anchor at all stay in BOTH states: the caller cannot act without them, and
 * each is a statement about the file rather than a marker pretending to be one.
 * `hasNumberedRows` is written to that line.
 */
describe("#259 no row site escapes the switch", () => {
	/** A TypeScript file the outline GATE accepts: past the 20-line floor, with
	 *  bodies of ≥4 lines to fold and folds that clear the 0.6 shrink ratio. */
	const FOLDABLE = [
		'import { a } from "./m";',
		"",
		...[0, 1].flatMap((i) => [
			`export function fn${i}() {`,
			...Array.from({ length: 8 }, (_, j) => `  const v${i}_${j} = ${j};`),
			"}",
			"",
		]),
	].join("\n");

	/** `ast_grep` over FOLDABLE — the same in-process worker the pattern test
	 *  above builds, because the outline needs a REAL parse. */
	async function astGrepOverFoldable(name: string) {
		const cwd = await makeCase(name, { file: "t.ts", body: FOLDABLE });
		await loadHashStore(cwd);
		const { AstClient } = (await import("../../src/ast/client.js")) as unknown as {
			AstClient: new (opts: { spawn: () => WorkerLike; idleMs: number }) => Parameters<typeof setAstClient>[0];
		};
		setAstClient(new AstClient({ spawn: inProcessWorker, idleMs: 0 }));
		return { tool: buildAstGrepTool(localIO()), execFor: makeExec(cwd, "test-session") };
	}

	it("ast_grep's OUTLINE rows — a merged row's range included — follow the switch", async () => {
		const { tool, execFor } = await astGrepOverFoldable("outline-rows");

		applyEffective({ ast: { enabled: true } });
		const off = (await tool.execute({ path: "t.ts" }, execFor({}))) as { modelText?: string };
		const offText = off.modelText ?? "";
		expect(offText).toContain("fn0"); // the outline itself, not a refusal
		expect(renderRows(offText).length).toBeGreaterThan(0);
		expect(hasNumberedRows(offText)).toBe(false);
		// A fold reports itself as a RANGE in the number slot; anchors are Base62,
		// so a `-` inside a marker can only ever be that range.
		expect(renderRows(offText).some(([marker]) => marker.includes("-"))).toBe(false);

		applyEffective({ ast: { enabled: true }, line_numbers: true });
		const on = (await tool.execute({ path: "t.ts" }, execFor({}))) as { modelText?: string };
		expect(hasNumberedRows(on.modelText ?? "")).toBe(true);
	});

	it("ast_grep's outline JSON keys are bare anchors when OFF", async () => {
		const { tool, execFor } = await astGrepOverFoldable("outline-json");
		const keysOf = async (): Promise<string[]> => {
			const value = (await tool.execute({ path: "t.ts" }, execFor({}))) as { modelText?: string };
			return Object.keys(
				(JSON.parse(value.modelText ?? "{}") as { lines?: Record<string, string> }).lines ?? {},
			);
		};

		applyEffective({ ast: { enabled: true }, output_format: "json" });
		const off = await keysOf();
		expect(off.length).toBeGreaterThan(0);
		for (const key of off) expect(key).toMatch(/^[A-Za-z0-9]{2,8}$/);

		applyEffective({ ast: { enabled: true }, output_format: "json", line_numbers: true });
		const on = await keysOf();
		expect(on.length).toBe(off.length);
		for (const key of on) expect(key).toMatch(/^[A-Za-z0-9]{2,8}:\d+(-\d+)?$/);
	});

	it("grep's JSON match AND context keys are bare anchors when OFF", async () => {
		const h = setupIntegrationTest(await makeCase("grep-json-rows"));
		const keysOf = async (): Promise<string[]> => {
			const text = getText(await h.getTool("grep").execute("grep", { path: ".", pattern: "line-02" }));
			const parsed = JSON.parse(text) as { files?: Array<{ matches: Record<string, string> }> };
			return (parsed.files ?? []).flatMap((file) => Object.keys(file.matches));
		};

		applyEffective({ output_format: "json" });
		const off = await keysOf();
		// The hit AND its context rows: one hand-built key per row, so a fix that
		// only reaches the match row still fails here.
		expect(off).toHaveLength(3);
		for (const key of off) expect(key).toMatch(/^[A-Za-z0-9]{2,8}$/);

		applyEffective({ output_format: "json", line_numbers: true });
		const on = await keysOf();
		expect(on).toHaveLength(3);
		for (const key of on) expect(key).toMatch(/^[A-Za-z0-9]{2,8}:\d+$/);
	});

	it("grep's RESUMED (spilled) rows follow the switch", async () => {
		const cwd = await makeCase("grep-resume-rows");
		// Past the response budget, so the tail spills into a resume token and
		// comes back through the continuation renderer.
		await writeFile(
			join(cwd, "many.txt"),
			`${Array.from({ length: 900 }, (_, i) => `needle-${i}-${"z".repeat(90)}`).join("\n")}\n`,
			"utf-8",
		);
		applyEffective(undefined);
		const h = setupIntegrationTest(cwd);
		const first = getText(
			await h.getTool("grep").execute("grep", { path: ".", pattern: "needle", limit: 900 }),
		);
		const token = /Use grep \{resume: "([^"]+)"\}/.exec(first)?.[1];
		expect(token).toBeDefined();

		const resumed = getText(await h.getTool("grep").execute("grep", { resume: token }));
		expect(resumed).toContain("needle-");
		expect(hasNumberedRows(resumed)).toBe(false);
	});

	it("the diagnostics JSON projection keys rows by the bare anchor when OFF", () => {
		const report = {
			path: "a.ts",
			absolutePath: "/repo/a.ts",
			toolName: "edit",
			totalSeen: 2,
			truncated: false,
			rows: [
				{ number: 1, hash: "ab", text: "const a = 1;", messages: ["error: boom"], severities: [1] },
				{ number: 2, hash: "cd", text: "const b = 2;", messages: [], severities: [] },
			],
		} as FileDiagnostics;

		applyEffective(undefined);
		expect(Object.keys(diagnosticsJson([report])[0]!.rows)).toEqual(["ab", "cd"]);

		applyEffective({ line_numbers: true });
		expect(Object.keys(diagnosticsJson([report])[0]!.rows)).toEqual(["ab:1", "cd:2"]);

		// A row with no anchor at all has no marker to bare: its line number is the
		// only handle there is, in EITHER state (the deliberate exception).
		const orphan = {
			...report,
			rows: [{ number: 7, hash: "", text: "x", messages: [], severities: [] }],
		} as FileDiagnostics;
		applyEffective(undefined);
		expect(Object.keys(diagnosticsJson([orphan])[0]!.rows)).toEqual(["7"]);
		applyEffective({ line_numbers: true });
		expect(Object.keys(diagnosticsJson([orphan])[0]!.rows)).toEqual(["7"]);
	});

	it("the drift rejection's ±context echo legend follows the switch", async () => {
		/** Serve `f.txt`, drift it EXTERNALLY, then resubmit the served anchor: the
		 *  served verdict answers with a ±context echo, and that echo carries a
		 *  legend. A fresh case per state — the first rejection re-materialises the
		 *  window, so a second attempt on the same anchor has no line hint left to
		 *  centre an echo on. */
		const rejected = async (name: string): Promise<string> => {
			const cwd = await makeCase(name);
			const h = setupIntegrationTest(cwd);
			const anchor = markerFor(
				getText(await h.readTool.execute("read", { path: "f.txt" })),
				"line-02 content",
			);
			await writeFile(join(cwd, "f.txt"), BODY.replace("line-02 content", "DRIFTED"), "utf-8");
			return getText(
				await h.editTool.execute("edit", {
					path: "f.txt",
					edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["B"] }],
				}),
			);
		};

		applyEffective(undefined);
		const off = await rejected("echo-legend-off");
		expect(off).toMatch(/E_RANGE_UNSERVED|E_RANGE_UNVERIFIED|E_STALE/);
		expect(off).toMatch(/Echo of the (line you tried|first unserved line)/);
		// The legend must not teach `<anchor>:<line>` above bare-anchor rows.
		expect(off).toContain("the marker is the anchor alone");
		expect(off).not.toContain("the marker is <anchor>:<line>");

		applyEffective({ line_numbers: true });
		const on = await rejected("echo-legend-on");
		expect(on).toMatch(/Echo of the (line you tried|first unserved line)/);
		expect(on).toContain("the marker is <anchor>:<line>");
		expect(on).not.toContain("the marker is the anchor alone");
	});
});
