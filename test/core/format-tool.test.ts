/**
 * The manual `format` tool through the real tool builder (map #275 / H3, G1
 * contract): whole-file and served-range formatting over a ready-only fake
 * language server, the refusal codes, the noop shape, the undo entry, and the
 * not-observed write path that pops the undo back.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { renderFormatSection } from "../../src/domain/edit/edit-response.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { applyEffective } from "../../src/config.js";
import { FormatUnsupportedError } from "../../src/lsp/format/index.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { getUndo } from "../../src/domain/edit/undo-edit.js";
import { withWorkspace } from "../../src/domain/session/session-view.js";
import {
	getText,
	setupIntegrationTest,
	useNumberedRows,
	withTempFile,
} from "../support/fixtures.js";

useNumberedRows();

interface FormatAnswers {
	/** `serverCapabilities` on the fake session (defaults to full+range). */
	caps?: Record<string, unknown>;
	/** Answers for `textDocument/rangeFormatting`. */
	range?: unknown[];
	/** Answers for `textDocument/formatting`. */
	full?: unknown[];
	/** Every request throws this (after the capability check). */
	requestFail?: Error;
	/** Thrown ONLY for the range request (the -32601 capability lie, #315). */
	rangeFail?: Error;
	/** `waitForSession` resolves to undefined (the server never came up). */
	noSession?: boolean;
	/** Recorded request method calls, for asserting the range path. */
	requests: Array<{ method: string; params: Record<string, unknown> }>;
	/** Recorded `syncDocumentContent` / post-write notify payloads. */
	syncs: string[];
}

/** A ready fake manager: formatting answers, no spawn, syncs recorded. */
function fakeFormatManager(answers: FormatAnswers): void {
	const session = {
		serverCapabilities:
			answers.caps ?? { documentFormattingProvider: true, documentRangeFormattingProvider: true },
		request: async (method: string, params: Record<string, unknown>) => {
			answers.requests.push({ method, params });
			if (answers.requestFail !== undefined) throw answers.requestFail;
			if (method === "textDocument/rangeFormatting") {
				if (answers.rangeFail !== undefined) throw answers.rangeFail;
				return answers.range ?? [];
			}
			if (method === "textDocument/formatting") return answers.full ?? [];
			return undefined;
		},
		notify: async () => { },
	};
	setLspManager({
		readyLanguages: ["typescript"],
		readySessionFor: () => session,
		status: async () => [{ language: "typescript", server: { displayName: "fake-ts" } }],
		openDocumentFor: () => (text: string) => {
			answers.syncs.push(text);
		},
		waitForSession: async () => (answers.noSession ? undefined : session),
		unavailability: () => undefined,
	} as never);
}

/** Re-indent one line — `character` past EOL means end-of-line (LSP clamp). */
function indentEdit(replacement: string) {
	return {
		range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1000 } },
		newText: replacement,
	};
}

const UNFORMATTED = "function a() {\nreturn 1;\n}\n";
const FORMATTED = "function a() {\n\treturn 1;\n}\n";

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

describe("the manual format tool (map #275 / G1)", () => {
	it("formats the whole file, lands one undo, and serves the changed rows", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;

			const res = await harness.formatTool.execute("format", { path });
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
			const text = getText(res);
			expect(text).toContain(`[format result] ${path}`);
			expect(text).toContain(
				"[format: fake-ts · full-file · requested 1 → applied 1 · 1 lines changed · 0 in main diff · 0 restored · 0 unserved]",
			);
			// The undo covers the whole call: content back to the pre-format text,
			// result checksum over the disk form.
			const undo = await withWorkspace(cwd, async () =>
				getUndo(await harness.io.resolve(path, cwd, undefined)),
			);
			expect(undo).toBeDefined();
			expect(undo!.content).toBe(UNFORMATTED);
			expect(undo!.resultChecksum).toBe(contentChecksum(FORMATTED));
			// The changed row was served pre-call → it earned an anchor (canon says a
			// pure re-indent keeps the anchor STEM, so freshness shows as an
			// anchored row, not a different string).
			const rowLine = text.split("\n").find((l) => l.startsWith("+") && l.includes("\treturn 1;"))!;
			expect(rowLine).toMatch(/^\+[A-Za-z0-9]/);
			// The server saw the model text (pre-write sync), then the final text
			// (post-write notify) — and nothing asked for diagnostics.
			expect(syncs).toEqual([UNFORMATTED, FORMATTED]);
		});
	});

	it("ignores format.auto mode entirely (Q4): a whole-file call works under range mode", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], requests: [], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain(
				"[format: fake-ts · full-file · requested 1 → applied 1 · 1 lines changed · 0 in main diff · 0 restored · 0 unserved]",
			);
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
		});
	});

	it("pins the matrix cell in RANGE mode too: explicit range + no range provider + fallback off refuses", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" } });
			const requests: FormatAnswers["requests"] = [];
			fakeFormatManager({
				caps: { documentFormattingProvider: true, documentRangeFormattingProvider: false },
				full: [indentEdit("\treturn 1;")],
				requests,
				syncs: [],
			});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			expect(getText(res)).toContain("[E_FORMAT_UNSUPPORTED]");
			expect(requests).toHaveLength(0);
		});
	});

	it("anchors every changed row even when nothing was served before (ruling ②)", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], requests: [], syncs: [] });
			// NO read first: the session has never served a line of this file.
			const harness = setupIntegrationTest(cwd);
			// The observed-file gate still applies — observe without serving the
			// changed line is not reachable through the tools, so observe normally.
			await harness.io.emitObserved(await harness.io.resolve(path, cwd, undefined));
			const res = await harness.formatTool.execute("format", { path });
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
			const text = getText(res);
			// A standalone format is the model's MAIN output: the changed row is
			// answered with an anchor — minted fresh, not gated on prior service.
			const rowLine = text.split("\n").find((l) => l.startsWith("+") && l.includes("\treturn 1;"))!;
			expect(rowLine).toMatch(/^\+[A-Za-z0-9]/);
			expect(text).toContain("0 unserved");
		});
	});

	it("formats a served range through the range request", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ range: [indentEdit("\treturn 1;")], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;

			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
			expect(getText(res)).toContain("[format: fake-ts · range · requested 1 → applied 1 ·");
			expect(requests).toHaveLength(1);
			expect(requests[0]!.method).toBe("textDocument/rangeFormatting");
			// 0-based lines: 2..3 in the file → { line: 1 } .. { line: 2 }.
			expect(requests[0]!.params.range).toEqual({
				start: { line: 1, character: 0 },
				end: { line: 2, character: 1 },
			});
		});
	});

	it("accepts the <line>:<anchor> composite a numbered row hands out (#316 review)", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			fakeFormatManager({ range: [indentEdit("\treturn 1;")], requests, syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			// Copied straight off a numbered read row: `2:<anchor>` — the line
			// half is a HINT; the anchor AFTER the colon is the key. (The bug:
			// the strip took the part BEFORE the colon, so the line number was
			// looked up as an anchor and every composite bound refused.)
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: `2:${two.hash}`, end: `3:${three.hash}` },
			});
			expect(getText(res)).toContain("[format: fake-ts · range · requested 1 → applied 1 ·");
			expect(requests[0]!.params.range).toEqual({
				start: { line: 1, character: 0 },
				end: { line: 2, character: 1 },
			});
		});
	});

	it("rejects an unserved range bound with the served echo", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ full: [], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			await servedRows(harness, path);
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: "zz", end: "zz" },
			});
			expect(getText(res)).toContain("[E_RANGE_UNVERIFIED]");
			// The refusal happened BEFORE any server wait and any write.
			expect(requests).toHaveLength(0);
			expect(syncs).toHaveLength(0);
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
	});

	it("noop: no write, no undo, zero requested and applied", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ full: [], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			await servedRows(harness, path);
			const res = await harness.formatTool.execute("format", { path });
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
			expect(getText(res)).toContain("[format: fake-ts · no changes]");
			expect(await withWorkspace(cwd, () => getUndo(path))).toBeUndefined();
			// The noop path still synced the server once (pre-request), but never
			// notified a write.
			expect(syncs).toEqual([UNFORMATTED]);
		});
	});

	it("refuses with [E_LSP_NO_SERVER] when no client or no server", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			setLspManager(undefined);
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_LSP_NO_SERVER]");
		});
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ noSession: true, requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_LSP_NO_SERVER] no server is usable");
		});
	});

	it("refuses with [E_FORMAT_UNSUPPORTED] when the server has no formatter", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ caps: {}, requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_FORMAT_UNSUPPORTED]");
			expect(requests).toHaveLength(0);
		});
	});

	it("surfaces request failures ([E_LSP_TIMEOUT] / [E_LSP_UNAVAILABLE])", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({
				requestFail: new Error("[E_LSP_TIMEOUT] The request took longer than 10000ms."),
				requests,
				syncs,
			});
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_LSP_TIMEOUT]");
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({
				requestFail: new Error(
					"[E_LSP_UNAVAILABLE] No language server is running for typescript.",
				),
				requests,
				syncs,
			});
			const harness = setupIntegrationTest(cwd);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_LSP_UNAVAILABLE]");
		});
	});

	it("a not-observed write pops the undo entry and propagates the refusal", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ full: [indentEdit("\treturn 1;")], requests, syncs });
			// The dsh read-before-write policy: this session never observed the
			// file, so the write is refused — and the undo entry must NOT stay.
			const refusing = {
				...localIO(),
				writeText: async () => {
					throw new Error(
						"[E_NOT_OBSERVED] The file has not been observed in this session (read-before-write policy). Call read() first, then retry the edit.",
					);
				},
			} as never;
			const harness = setupIntegrationTest(cwd, refusing);
			await servedRows(harness, path);
			const res = await harness.formatTool.execute("format", { path });
			expect(getText(res)).toContain("[E_NOT_OBSERVED]");
			expect(
				await withWorkspace(cwd, async () =>
					getUndo(await harness.io.resolve(path, cwd, undefined)),
				),
			).toBeUndefined();
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
	});

	it("renders the manual section with its own label", () => {
		const section = {
			status: "formatted" as const,
			server: "fake-ts",
			mode: "full-file" as const,
			requested: 1,
			applied: 2,
			changedLines: 2,
			unservedRows: 1,
			rows: [
				{ kind: "+" as const, lineNumber: 2, hash: "B1", text: "\treturn 1;" },
				{ kind: "+" as const, lineNumber: 3, hash: "", text: "\t// never served" },
			],
		};
		const text = renderFormatSection(section, false, "format");
		expect(text).toContain(
			"[format: fake-ts · full-file · requested 1 → applied 2 · 2 lines changed · 0 in main diff · 0 restored · 1 unserved]",
		);
		expect(text).toContain("+B1 \treturn 1;");
		// The unserved row renders with the four-space placeholder, not a lie.
		expect(text).toContain("+     \t// never served");
	});
});

describe("range availability vs format.fallback_full_file (#315)", () => {
	it("refuses a range request with [E_FORMAT_UNSUPPORTED] when the server lacks range and fallback is off (default)", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({
				caps: { documentFormattingProvider: true, documentRangeFormattingProvider: false },
				full: [indentEdit("\treturn 1;")],
				requests,
				syncs,
			});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			expect(getText(res)).toContain("[E_FORMAT_UNSUPPORTED]");
			expect(getText(res)).toContain("format.fallback_full_file");
			// The refusal happens BEFORE any request: never a silent whole-file.
			expect(requests).toHaveLength(0);
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
	});

	it("refuses when the server lies about range (-32601) and fallback is off", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ rangeFail: new FormatUnsupportedError("typescript"), full: [indentEdit("\treturn 1;")], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			expect(getText(res)).toContain("[E_FORMAT_UNSUPPORTED]");
			// Only the range attempt happened; no silent whole-file retry.
			expect(requests).toHaveLength(1);
			expect(requests[0]!.method).toBe("textDocument/rangeFormatting");
			expect(await readFile(path, "utf-8")).toBe(UNFORMATTED);
		});
	});

	it("falls back to the whole file only when format.fallback_full_file is on", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { fallback_full_file: true } });
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({
				caps: { documentFormattingProvider: true, documentRangeFormattingProvider: false },
				full: [indentEdit("\treturn 1;")],
				requests,
				syncs,
			});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			// The header names the ACTUAL mode: the fallback ran, and it says so.
			expect(getText(res)).toContain("[format: fake-ts · full-file · requested 1 → applied 1 ·");
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
		});
	});

	it("a -32601 lie also honors the fallback switch", async () => {
		await withTempFile("fmt.ts", UNFORMATTED, async ({ cwd, path }) => {
			applyEffective({ format: { fallback_full_file: true } });
			const requests: FormatAnswers["requests"] = [];
			const syncs: string[] = [];
			fakeFormatManager({ rangeFail: new FormatUnsupportedError("typescript"), full: [indentEdit("\treturn 1;")], requests, syncs });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, path);
			const two = served.find((r) => r.content === "return 1;")!;
			const three = served.find((r) => r.content === "}")!;
			const res = await harness.formatTool.execute("format", {
				path,
				range: { start: two.hash, end: three.hash },
			});
			expect(getText(res)).toContain("[format: fake-ts · full-file · requested 1 → applied 1 ·");
			expect(await readFile(path, "utf-8")).toBe(FORMATTED);
		});
	});
});
