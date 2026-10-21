/**
 * The automatic format pass, wired through the real tool builders (map #275,
 * H2): the section rides the model text, failures degrade to warnings, and
 * undo rolls the whole call back — edit AND format together (G3).
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderFormatSection } from "../../src/domain/edit/edit-response.js";
import { FormatUnsupportedError } from "../../src/lsp/format/index.js";
import { applyEffective } from "../../src/config.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import {
	getText,
	makeExec,
	setupIntegrationTest,
	useNumberedRows,
	withTempFile,
} from "../support/fixtures.js";

useNumberedRows();

/** Unconfined sandbox controller for direct-execute tools (test default). */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

interface FormatAnswers {
	range?: unknown[];
	full?: unknown[];
	fail?: Error;
	/** Thrown ONLY for the range request (the -32601 capability lie, #315). */
	rangeFail?: Error;
	/** Capability overrides — a range capability lie falls back to full-file. */
	caps?: { documentFormattingProvider?: boolean; documentRangeFormattingProvider?: boolean };
	/** Recorded `syncDocumentContent` payloads — the server's view trail. */
	syncs: string[];
}

/** A ready-only fake manager: formatting answers, no spawn, syncs recorded. */
function fakeFormatManager(answers: FormatAnswers): void {
	const session = {
		serverCapabilities: { documentFormattingProvider: true, documentRangeFormattingProvider: true, ...answers.caps },
		request: async (method: string) => {
			if (answers.fail !== undefined) throw answers.fail;
			if (method === "textDocument/rangeFormatting") {
				if (answers.rangeFail !== undefined) throw answers.rangeFail;
				return answers.range ?? [];
			}
			if (method === "textDocument/formatting") return answers.full ?? [];
			return undefined;
		},
		notify: async () => {},
	};
	setLspManager({
		readyLanguages: ["typescript"],
		readySessionFor: () => session,
		status: async () => [{ language: "typescript", server: { displayName: "fake-ts" } }],
		openDocumentFor: () => (text: string) => {
			answers.syncs.push(text);
		},
		waitForSession: async () => session,
	} as never);
}

/** Re-indent line 2 — `character` past EOL means end-of-line (LSP clamp). */
function indentEdit(replacement: string) {
	return {
		range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1000 } },
		newText: replacement,
	};
}

/** Rewrite any 1-based line — `character` past EOL clamps to it (LSP). */
function editAt(line: number, replacement: string) {
	return {
		range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1000 } },
		newText: replacement,
	};
}

const UNFORMATTED = "function a() {\nreturn 1;\n}\n";

/** 20 lines: the model touches 2, 10 and 19; the formatter reverts 10 exactly. */
const GAP_FILE = [
	"function a() {",
	"return 1;",
	"}",
	...Array.from({ length: 15 }, (_, k) => `// l${k + 4}`),
	"return 19;",
	"}",
].join("\n") + "\n";
/** Read through the hashline `read` tool; return served (hash, content) rows. */
async function servedRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of getText(res).split("\n")) {
		if (line.startsWith("ANCHOR:")) continue;
		const body = line.replace(/^[+\- ]+/, "");
		const sep = body.indexOf(":");
		if (sep === -1) continue;
		const first = body.slice(0, sep);
		const rest = body.slice(sep + 1);
		if (/^\d+$/.test(first)) {
			const h = rest.indexOf(":");
			if (h === -1) continue;
			rows.push({ hash: rest.slice(0, h), content: rest.slice(h + 1) });
		} else {
			const h = rest.indexOf(":");
			rows.push({ hash: first, content: h === -1 ? rest : rest.slice(h + 1) });
		}
	}
	return rows;
}

afterEach(() => {
	setLspManager(undefined);
	applyEffective({});
});

describe("auto-format through edit (map #275 / G3)", () => {
	it("formats after the model's change and renders a separate section", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const syncs: string[] = [];
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ range: [indentEdit("\treturn 1; // touched")], syncs });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 1; // touched"] }],
			});
			// The disk carries the FORMATTED text; the model row survives inside it.
			expect(await readFile(path, "utf-8")).toBe("function a() {\n\treturn 1; // touched\n}\n");
			const text = getText(res);
			expect(text).toContain(
				"[auto-format: fake-ts · range · requested 1 → applied 1 · 1 lines changed · 1 in main diff · 0 restored · 0 unserved]",
			);
			// #312: the formatter retouched the row the model just wrote — the main
			// diff already shows it, so the section counts it and does NOT repeat
			// the content (the old `(also in main diff)` rows are gone).
			expect(text).toContain("1 in main diff");
			expect(text).not.toContain("(also in main diff)");
			// The server saw the MODEL content before the request (pre-write sync).
			expect(syncs.some((t) => t.includes("// touched"))).toBe(true);
		});
	});

	// #312 spec review: a formatter-REVERTED model edit between two rendered
	// changes sits inside the served window but OUTSIDE the diff's blocks
	// (the >2×context gap splits them) — rule 3 says it returns as a section
	// row with its anchor, never as an "in main diff" count.
	it("returns a formatter-reverted row the main diff never rendered", async () => {
		await withTempFile("fmt.ts", GAP_FILE, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "full" } });
			const syncs: string[] = [];
			fakeFormatManager({
				caps: { documentRangeFormattingProvider: false },
				full: [editAt(2, "\treturn 1; // touched"), editAt(10, "// l10"), editAt(19, "\treturn 19; // end")],
				syncs,
			});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const ten = served.find((r) => r.content === "// l10")!;
			const nineteen = served.find((r) => r.content === "return 19;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [
					{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 1; // touched"] },
					{ op: "replace", anchor_start: ten.hash, anchor_end: ten.hash, lines: ["// l10 "] },
					{ op: "replace", anchor_start: nineteen.hash, anchor_end: nineteen.hash, lines: ["return 19; // end"] },
				],
			});
			const text = getText(res);

			expect(text).toContain(
				"[auto-format: fake-ts · full-file · requested 1 → applied 3 · 3 lines changed · 2 in main diff · 1 restored · 0 unserved]",
			);
			// Line 10's final text equals the original — the main diff cannot
			// show it, and (#315 PR review) the section no longer re-quotes old
			// news either: the run collapses into a locator + a restored summary.
			expect(text).toContain("@@ ~10,1 @@");
			expect(text).toContain("1 line(s) restored to their pre-edit content · anchors unchanged");
			expect(text).not.toContain("// l10");
		});
	});

	it("degrades a failing formatter to a warning and keeps the model content", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ fail: new Error("clangd exploded"), syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 2;"] }],
			});
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 2;\n}\n");
			const text = getText(res);
			expect(text).toContain("[auto-format: fake-ts · skipped · clangd exploded]");
			expect(text).toContain("Auto-format was skipped");
		});
	});

	it("stays silent with no running server, and when the switch is off", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			// Default OFF: even a ready formatter does nothing.
			applyEffective({});
			fakeFormatManager({ range: [indentEdit("\treturn 1;")], syncs: [] });
			let harness = setupIntegrationTest(cwd);
			let served = await servedRows(harness, path);
			let two = served.find((r) => r.content === "return 1;")!;
			let res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 9;"] }],
			});
			expect(getText(res)).not.toContain("[auto-format");
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 9;\n}\n");

			// Switch ON but no manager: silent skip (an edit must never spawn).
			applyEffective({ format: { auto: "range" } });
			setLspManager(undefined);
			harness = setupIntegrationTest(cwd);
			served = await servedRows(harness, path);
			two = served.find((r) => r.content === "return 9;")!;
			res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 8;"] }],
			});
			expect(getText(res)).not.toContain("[auto-format");
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 8;\n}\n");
		});
	});

	it("renders nothing when the formatter answers but nothing changes", async () => {
		await withTempFile("fmt.ts", "function a() {\n\treturn 1;\n}\n", async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ range: [], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "\treturn 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["\treturn 1; // x"] }],
			});
			expect(getText(res)).not.toContain("[auto-format");
		});
	});

	it("undo rolls back the whole call — the edit AND its format", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ range: [indentEdit("\treturn 1; // touched")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 1; // touched"] }],
			});
			expect(await readFile(path, "utf-8")).toBe("function a() {\n\treturn 1; // touched\n}\n");
			await harness.getTool("undo_last_edit").execute("undo", { path });
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
	});
});

describe("format.auto modes (#315)", () => {
	const RANGE_LIE = () => new FormatUnsupportedError("typescript");

	it("full mode ignores the hunks and asks for the whole file", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "full" } });
			fakeFormatManager({ range: [indentEdit("\treturn 1; // rangemode")], full: [editAt(2, "return 1; // fullmode")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 1; // touched"] }],
			});
			expect(getText(res)).toContain("[auto-format: fake-ts · full-file · requested 1 → applied 1 ·");
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 1; // fullmode\n}\n");
		});
	});

	it("range mode without range capability stays silent when fallback is off (default)", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ caps: { documentRangeFormattingProvider: false }, full: [indentEdit("\treturn 1; // fullfb")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 9;"] }],
			});
			expect(getText(res)).not.toContain("[auto-format");
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 9;\n}\n");
		});
	});

	it("range mode falls back to the whole file only when the fallback switch is on", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range", fallback_full_file: true } });
			fakeFormatManager({ caps: { documentRangeFormattingProvider: false }, full: [indentEdit("\treturn 1; // fullfb")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 9;"] }],
			});
			expect(getText(res)).toContain("[auto-format: fake-ts · full-file · requested 1 → applied 1 ·");
			expect(await readFile(path, "utf-8")).toBe("function a() {\n\treturn 1; // fullfb\n}\n");
		});
	});

	it("range mode treats a -32601 lie as no-capability: silent off, fallback on", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ rangeFail: RANGE_LIE(), full: [indentEdit("\treturn 1; // fullfb")], syncs: [] });
			let harness = setupIntegrationTest(cwd);
			let served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: two.hash, anchor_end: two.hash, lines: ["return 9;"] }],
			});
			expect(getText(res)).not.toContain("[auto-format");
			expect(await readFile(path, "utf-8")).toBe("function a() {\nreturn 9;\n}\n");

			// The same lie WITH the fallback switch → the whole file.
			applyEffective({ format: { auto: "range", fallback_full_file: true } });
			fakeFormatManager({ rangeFail: RANGE_LIE(), full: [indentEdit("\treturn 1; // fullfb")], syncs: [] });
			harness = setupIntegrationTest(cwd);
			served = await servedRows(harness, path);
			const nine = served.find((r) => r.content === "return 9;")!;
			const res2 = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: nine.hash, anchor_end: nine.hash, lines: ["return 8;"] }],
			});
			expect(getText(res2)).toContain("[auto-format: fake-ts · full-file ·");
			expect(await readFile(path, "utf-8")).toBe("function a() {\n\treturn 1; // fullfb\n}\n");
		});
	});

	it("a deletion-only edit collapses every hunk: silent unless the fallback switch is on", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			// The server HAS range capability — the collapse (no range left to
			// request) must NOT fall through to the whole file (#315 blocker).
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ full: [editAt(2, "// wholefile")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "del", anchor_start: two.hash }],
			});
			expect(getText(res)).not.toContain("[auto-format");
			expect(await readFile(path, "utf-8")).toBe("function a() {\n}\n");

			// The same collapse WITH the fallback switch → the whole file. A
			// SECOND deletion keeps the hunk collapsed (the point of the case)
			// while still changing content.
			applyEffective({ format: { auto: "range", fallback_full_file: true } });
			fakeFormatManager({ full: [editAt(1, "// wholefile")], syncs: [] });
			const harness2 = setupIntegrationTest(cwd);
			const served2 = await servedRows(harness2, path);
			const head = served2.find((r) => r.content === "function a() {")!;
			const res2 = await harness2.editTool.execute("edit", {
				path,
				edits: [{ op: "del", anchor_start: head.hash }],
			});
			expect(getText(res2)).toContain("[auto-format: fake-ts · full-file · requested 1 → applied 1 ·");
			expect(await readFile(path, "utf-8")).toBe("// wholefile\n");
		});
	});

	it("write has no hunks: range mode treats it as full (Q3)", async () => {
		const syncs: string[] = [];
		applyEffective({ format: { auto: "range" } });
		fakeFormatManager({ full: [indentEdit("\treturn 1;")], syncs });
		await withTempFile("holder.txt", "holder\n", async ({ cwd }) => {
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const value = (await tool.execute(
				{ file_path: "q3.ts", content: UNFORMATTED },
				makeExec(cwd)({ file_path: "q3.ts", content: UNFORMATTED }) as never,
			)) as { modelText: string };
			expect(value.modelText).toContain("[auto-format: fake-ts · full-file");
			expect(await readFile(join(cwd, "q3.ts"), "utf-8")).toBe("function a() {\n\treturn 1;\n}\n");
		});
	});
});

describe("auto-format through write (map #275 / G3)", () => {
	it("formats a created file; unseen rows are omitted and only counted", async () => {
		const syncs: string[] = [];
		applyEffective({ format: { auto: "full" } });
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], syncs });
		await withTempFile("holder.txt", "holder\n", async ({ cwd }) => {
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const value = (await tool.execute(
				{ file_path: "fresh.ts", content: UNFORMATTED },
				makeExec(cwd)({ file_path: "fresh.ts", content: UNFORMATTED }) as never,
			)) as {
				after: string;
				formats?: Array<{ status: string; mode?: string; inMainDiffRows?: number; rows?: Array<{ hash: string; text: string }> }>;
				modelText: string;
			};
			expect(value.after).toBe("function a() {\n\treturn 1;\n}\n");
			expect(await readFile(join(cwd, "fresh.ts"), "utf-8")).toBe("function a() {\n\treturn 1;\n}\n");
			expect(value.modelText).toContain("[auto-format: fake-ts · full-file");
			expect(value.formats?.[0]?.status).toBe("formatted");
			// Ruling on #275's follow-up: an inline section returns neither content
			// nor anchors for rows nothing served — a created file's rows are ALL
			// unseen, so the section counts them and returns none.
			expect(value.formats?.[0]?.rows).toEqual([]);
			expect((value.formats?.[0] as { inMainDiffRows?: number }).inMainDiffRows ?? 0).toBe(0);
			expect((value.formats?.[0] as { unservedRows?: number }).unservedRows ?? 0).toBeGreaterThan(0);
		});
	});

	// #312 spec review: an update withholds a changed row only when the
	// PREVIEW renders it — a line the model left alone (the formatter fixed
	// stale formatting away from the edit) is invisible in before→model, so
	// the section must return its row instead of counting it into "in main".
	it("update keeps a formatter-fixed row the preview never showed", async () => {
		const syncs: string[] = [];
		applyEffective({ format: { auto: "full" } });
		fakeFormatManager({ full: [editAt(2, "\treturn 2;"), editAt(4, "let x = 1;")], syncs });
		const BEFORE = "function a() {\nreturn 1;\n}\nlet x=1;\n";
		await withTempFile("upd.ts", BEFORE, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			await servedRows(harness, path); // serve every line — line 4's eligibility
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const model = "function a() {\nreturn 2;\n}\nlet x=1;\n";
			const value = (await tool.execute(
				{ file_path: path, content: model },
				makeExec(cwd)({ file_path: path, content: model }) as never,
			)) as {
				formats?: Array<{
					inMainDiffRows?: number;
					rows?: Array<{ lineNumber: number; hash: string; text: string }>;
				}>;
			};
			const section = value.formats?.[0];
			// Line 2: the model rewrote it → the preview renders it → counted.
			// Line 4: model==before there → the preview shows nothing → a row.
			expect(section?.inMainDiffRows).toBe(1);
			expect(section?.rows).toHaveLength(1);
			expect(section?.rows?.[0]).toMatchObject({ lineNumber: 4, text: "let x = 1;" });
			expect(section?.rows?.[0]?.hash).not.toBe("");
		});
	});
});

describe("renderFormatSection (map #275 / decision B)", () => {
	it("renders the skipped reason as the header", () => {
		expect(renderFormatSection({ status: "skipped", server: "gopls", reason: "no range here" })).toBe(
			"[auto-format: gopls · skipped · no range here]",
		);
	});

	it("anchors rows, withholds in-main rows behind the header count (#312)", () => {
		const text = renderFormatSection({
			status: "formatted",
			server: "fake-ts",
			mode: "range",
			requested: 2,
			applied: 3,
			changedLines: 2,
			inMainDiffRows: 1,
			unservedRows: 0,
			rows: [{ kind: "+", lineNumber: 9, hash: "", text: "\tnew line;" }],
		});
		expect(text).toContain(
			"[auto-format: fake-ts · range · requested 2 → applied 3 · 2 lines changed · 1 in main diff · 0 restored · 0 unserved]",
		);
		// #312: the in-main row is counted, never repeated — no content, no note.
		expect(text).not.toContain("(also in main diff)");
		expect(text).not.toContain("\tindented;");
		// The ineligible row renders the four-space placeholder where the
		// anchor would sit — absence, not a copyable marker.
		expect(text).toContain("+     \tnew line;");
	});

	it("renders the counts header when every changed row was withheld", () => {
		// A write-style update: the preview already shows all changed rows, so
		// the section collapses to its counts instead of "no changes".
		const text = renderFormatSection({
			status: "formatted",
			server: "fake-ts",
			changedLines: 3,
			inMainDiffRows: 3,
			unservedRows: 0,
			rows: [],
		});
		expect(text).toBe(
			"[auto-format: fake-ts · full-file · requested 1 → applied 0 · 3 lines changed · 3 in main diff · 0 restored · 0 unserved]",
		);
	});
});
