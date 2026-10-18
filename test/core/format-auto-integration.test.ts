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
	/** Recorded `syncDocumentContent` payloads — the server's view trail. */
	syncs: string[];
}

/** A ready-only fake manager: formatting answers, no spawn, syncs recorded. */
function fakeFormatManager(answers: FormatAnswers): void {
	const session = {
		serverCapabilities: { documentFormattingProvider: true, documentRangeFormattingProvider: true },
		request: async (method: string) => {
			if (answers.fail !== undefined) throw answers.fail;
			if (method === "textDocument/rangeFormatting") return answers.range ?? [];
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

const UNFORMATTED = "function a() {\nreturn 1;\n}\n";

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
			applyEffective({ format: { auto: true } });
			const syncs: string[] = [];
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
			expect(text).toContain("[auto-format: fake-ts · range · requested 1 → applied 1 · 1 lines changed · 0 unserved]");
			// The row the formatter retouched is the one the model just wrote.
			expect(text).toContain("(also in main diff)");
			// The server saw the MODEL content before the request (pre-write sync).
			expect(syncs.some((t) => t.includes("// touched"))).toBe(true);
		});
	});

	it("degrades a failing formatter to a warning and keeps the model content", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: true } });
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
			applyEffective({ format: { auto: true } });
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
			applyEffective({ format: { auto: true } });
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
			applyEffective({ format: { auto: true } });
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

describe("auto-format through write (map #275 / G3)", () => {
	it("formats a created file; unseen rows are omitted and only counted", async () => {
		const syncs: string[] = [];
		applyEffective({ format: { auto: true } });
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], syncs });
		await withTempFile("holder.txt", "holder\n", async ({ cwd }) => {
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const value = (await tool.execute(
				{ file_path: "fresh.ts", content: UNFORMATTED },
				makeExec(cwd)({ file_path: "fresh.ts", content: UNFORMATTED }) as never,
			)) as {
				after: string;
				formats?: Array<{ status: string; mode?: string; rows?: Array<{ hash: string; text: string; alsoInMainDiff: boolean }> }>;
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
			expect((value.formats?.[0] as { unservedRows?: number }).unservedRows ?? 0).toBeGreaterThan(0);
		});
	});
});

describe("renderFormatSection (map #275 / decision B)", () => {
	it("renders the skipped reason as the header", () => {
		expect(renderFormatSection({ status: "skipped", server: "gopls", reason: "no range here" })).toBe(
			"[auto-format: gopls · skipped · no range here]",
		);
	});

	it("anchors eligible rows, marks also-in-main rows, leaves ineligible rows bare", () => {
		const text = renderFormatSection({
			status: "formatted",
			server: "fake-ts",
			mode: "range",
			requested: 2,
			applied: 3,
			changedLines: 2,
			unservedRows: 0,
			rows: [
				{ kind: "+", lineNumber: 4, hash: "a1b2c", text: "\tindented;", alsoInMainDiff: true },
				{ kind: "+", lineNumber: 9, hash: "", text: "\tnew line;", alsoInMainDiff: false },
			],
		});
		expect(text).toContain("[auto-format: fake-ts · range · requested 2 → applied 3 · 2 lines changed · 0 unserved]");
		expect(text).toContain("(also in main diff)");
		// The ineligible row renders the four-space placeholder where the
		// anchor would sit — absence, not a copyable marker.
		expect(text).toContain("+     \tnew line;");
	});
});
