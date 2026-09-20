/**
 * Issue #147: ONE line space for every line-number producer.
 *
 * `read` normalizes its text through `toLF` (CRLF, bare CR and LF all break a
 * line), so a progress-bar log whose `\r` overwrites count as lines exactly the
 * way pwsh counts them. grep / lsp / ast_grep / ast_edit used to split the RAW
 * `io.readText` text on `\n` only — on any file carrying bare CRs their line
 * numbers, row contents and anchor pairings drifted away from read's by the
 * cumulative number of CRs above each line.
 *
 * The fixture mirrors the field report in miniature: `alpha\rbeta\r\ngamma\rdelta\n`
 * is FOUR lines in read's space (alpha / beta / gamma / delta) and TWO in the
 * old LF-only space (alpha\rbeta / gamma\rdelta).
 *
 * The cross-CR behavior change the issue declares: a regex like `alpha.r` used
 * to match inside the old single line `alpha\rbeta`; after alignment the CR is
 * a line boundary and that pattern matches nothing.
 *
 * @module dsh-hashline-edittool/test-issue-147-line-space
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildLspTool } from "../../src/tools/tool-lsp.js";
import { setAstClient, type WorkerLike } from "../../src/ast/client.js";
import { handleRequest, type AstWorkerRequest, type AstWorkerResponse } from "../../src/ast/worker.js";
import { buildAstGrepTool } from "../../src/tools/tool-ast-grep.js";
import { buildAstEditTool } from "../../src/tools/tool-ast-edit.js";
import { localIO } from "../../src/infra/fs-bridge.js";

/** The field report's shape: bare CRs from progress-bar overwrites, plus one CRLF. */
type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

function grepTool(harness: ReturnType<typeof setupIntegrationTest>): GrepTool {
	return harness.getTool("grep") as unknown as GrepTool;
}

const BARE_CR_LOG = "alpha\rbeta\r\ngamma\rdelta\n";
/** An old-Mac-style source file: `\r` is THE line terminator, there is no `\n`. */
const CR_SOURCE = "const a = 1;\rconst b = 2;\rconst c = 3;\r";

interface Row {
	hash: string;
	line: number;
	content: string;
}

/** Parse `<anchor>:<line>: content` rows out of a read/grep model text. */
function parseRows(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("ANCHOR:")) continue;
		const m = /^([A-Za-z0-9]{2,8}):(\d+):\s?(.*)$/.exec(line);
		if (m) rows.push({ hash: m[1]!, line: Number(m[2]!), content: m[3]! });
	}
	return rows;
}

describe("#147 grep — line numbers in read's line space", () => {
	afterEach(() => {
		applyEffective({});
	});

	it("reports the line number and content read serves for the same match", async () => {
		await withTempFile("t.txt", BARE_CR_LOG, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const readRows = parseRows(getText(await harness.readTool.execute("read", { path })));
			expect(readRows.map((r) => r.content)).toEqual(["alpha", "beta", "gamma", "delta"]);

			const grepRows = parseRows(
				getText(await grepTool(harness).execute("g", { path, pattern: "beta", regex: false })),
			);
			const match = grepRows.find((r) => r.content === "beta");
			expect(match, "grep must find beta").toBeDefined();
			// read's line 2 is `beta`; the old LF-only split put `alpha\rbeta` on line 1.
			expect(match!.line).toBe(2);
			// The row grep serves must be a row read serves: same anchor AND same content.
			const readRow = readRows.find((r) => r.line === match!.line);
			expect(match!.hash).toBe(readRow!.hash);
			expect(match!.content).toBe(readRow!.content);
		});
	});

	it("json mode keys name the same anchor:line read does", async () => {
		await withTempFile("t.txt", BARE_CR_LOG, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const readRows = parseRows(getText(await harness.readTool.execute("read", { path })));
			const byContent = new Map(readRows.map((r) => [r.content, r]));
			applyEffective({ output_format: "json" });
			const res = await grepTool(harness).execute("g", { path, pattern: "gamma", regex: false, context: 1 });
			const out = JSON.parse(getText(res)) as {
				files: Array<{ path: string; matches: Record<string, string> }>;
			};
			const matches = out.files[0]!.matches;
			const gamma = byContent.get("gamma")!;
			const beta = byContent.get("beta")!;
			const delta = byContent.get("delta")!;
			// The match and its ±1 context rows, all in read's space (old space had
			// `gamma\rdelta` on ONE line 2 and nothing on lines 3-4).
			expect(matches[`${gamma.hash}:${gamma.line}`]).toBe("gamma");
			expect(matches[`${beta.hash}:${beta.line}`]).toBe("beta");
			expect(matches[`${delta.hash}:${delta.line}`]).toBe("delta");
		});
	});

	it("a regex crossing a bare-CR boundary no longer matches — the declared behavior change", async () => {
		await withTempFile("t.txt", BARE_CR_LOG, async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			// `.` matches `\r`, so the old single line `alpha\rbeta` matched. Aligned,
			// the CR is a line boundary and the pattern has nothing to match.
			const crossed = getText(await grepTool(harness).execute("g", { path, pattern: "alpha.r" }));
			expect(crossed).toContain("No matches");
			// Within-line regexes still work.
			const within = parseRows(
				getText(await grepTool(harness).execute("g", { path, pattern: "be.a" })),
			);
			expect(within.map((r) => r.content)).toContain("beta");
		});
	});

	it("CRLF files keep one line per CRLF and row content carries no trailing CR", async () => {
		await withTempFile("crlf.txt", "alpha\r\nbeta\r\n", async ({ cwd, path }) => {
			const harness = setupIntegrationTest(cwd);
			const readRows = parseRows(getText(await harness.readTool.execute("read", { path })));
			expect(readRows.map((r) => r.content)).toEqual(["alpha", "beta"]);
			const grepRows = parseRows(
				getText(await grepTool(harness).execute("g", { path, pattern: "beta", regex: false })),
			);
			const match = grepRows.find((r) => r.content === "beta");
			expect(match).toBeDefined();
			expect(match!.line).toBe(2);
			expect(match!.content).toBe("beta"); // not "beta\r"
			expect(match!.hash).toBe(readRows[1]!.hash);
		});
	});
});

const LSP_FILE = "/tmp/lsp-tool-probe/a.ts";

/** What the fake language server answers, per method; pushes on open like a real one. */
interface LspFake {
	readonly answers?: Record<string, unknown>;
	readonly pushOnOpen?: readonly unknown[];
}

describe("#147 lsp — server positions mapped onto read's line space", () => {
	/** The tool must sync the toLF text (no bare CR) and index rows in its space. */
	const syncedTexts: string[] = [];

	function install(fake: LspFake) {
		const pushed = new Map<string, readonly unknown[]>();
		let revision = 0;
		const uri = `file://${LSP_FILE}`;
		const session = {
			get diagnosticsRevision() {
				return revision;
			},
			getDiagnostics: (u: string) => pushed.get(u),
			request: async (method: string) => fake.answers?.[method],
		};
		setLspManager({
			waitForSession: async () => session as never,
			unavailability: () => ({ message: "no server is installed for typescript" }),
			openDocumentFor: () => (text: string) => {
				syncedTexts.push(text);
				const nonce = /dsh_probe_[a-z0-9]+_[a-z0-9]+/.exec(text)?.[0];
				if (nonce !== undefined) {
					pushed.set(uri, [{ message: `Cannot find name '${nonce}'.`, severity: 1, range: { start: { line: 0 } } }]);
					revision += 1;
					return;
				}
				if (fake.pushOnOpen !== undefined) {
					pushed.set(uri, fake.pushOnOpen);
					revision += 1;
				}
			},
		} as never);
	}

	afterEach(() => {
		setLspManager(undefined);
		syncedTexts.length = 0;
	});

	function makeExec() {
		return {
			signal: new AbortController().signal,
			agent: { session: { header: { cwd: "/tmp" } } },
		} as never;
	}

	function makeIo(text: string) {
		return {
			resolve: async (p: string) => p,
			readText: async () => text,
			emitObserved: async () => undefined,
		} as never;
	}

	const BARE_CR_TS = "export function alpha() {}\rconst b = 1;\r"; // read space: 2 lines

	it("symbols: a server line that only exists in the toLF space lands on the right row", async () => {
		install({
			answers: {
				// 0-based line 1 = the SECOND line of read's space (`const b = 1;`).
				"textDocument/documentSymbol": [{ name: "b", kind: 13, range: { start: { line: 1 } } }],
			},
		});
		const value = (await buildLspTool(makeIo(BARE_CR_TS)).execute(
			{ operation: "symbols", path: LSP_FILE },
			makeExec(),
		)) as { hashlines: Array<{ number: number; hash: string; text: string }> };
		expect(value.hashlines).toHaveLength(1);
		expect(value.hashlines[0]!.number).toBe(2);
		expect(value.hashlines[0]!.text).toBe("const b = 1;");
		expect(value.hashlines[0]!.hash).not.toBe("");
	});

	it("the document synced to the server is the toLF text, so server positions are read positions", async () => {
		install({
			answers: { "textDocument/documentSymbol": [{ name: "alpha", kind: 12, range: { start: { line: 0 } } }] },
		});
		await buildLspTool(makeIo(BARE_CR_TS)).execute({ operation: "symbols", path: LSP_FILE }, makeExec());
		expect(syncedTexts.length).toBeGreaterThan(0);
		for (const text of syncedTexts) expect(text).not.toContain("\r");
	});

	it("diagnostics: a pushed line number addresses the same row read serves", async () => {
		install({
			pushOnOpen: [{ message: "b is unused", severity: 2, range: { start: { line: 1 } } }],
		});
		const value = (await buildLspTool(makeIo(BARE_CR_TS)).execute(
			{ operation: "diagnostics", path: LSP_FILE },
			makeExec(),
		)) as { hashlines: Array<{ number: number; text: string; messages: string[] }> };
		expect(value.hashlines).toHaveLength(1);
		expect(value.hashlines[0]!.number).toBe(2);
		expect(value.hashlines[0]!.text).toBe("const b = 1;");
		expect(value.hashlines[0]!.messages.join(" ")).toContain("b is unused");
	});
});

describe("#147 ast_grep / ast_edit — tree-sitter rows in read's line space", () => {
	let dir: string;
	let file: string;

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

	function exec(cwd: string) {
		return (args: unknown) =>
			({
				signal: new AbortController().signal,
				agent: { id: "s", session: { id: "s", header: { cwd } } },
				arguments: args,
			}) as never;
	}

	beforeEach(async () => {
		applyEffective({ ast: { enabled: true } });
		dir = await mkdtemp(join(tmpdir(), "issue-147-ast-"));
		file = join(dir, "a.ts");
		await writeFile(file, CR_SOURCE, "utf-8");
		const { AstClient } = (await import("../../src/ast/client.js")) as unknown as {
			AstClient: new (opts: { spawn: () => WorkerLike; idleMs: number }) => Parameters<typeof setAstClient>[0];
		};
		setAstClient(new AstClient({ spawn: inProcessWorker, idleMs: 0 }));
	});

	afterEach(async () => {
		applyEffective(undefined);
		setAstClient(undefined);
		await rm(dir, { recursive: true, force: true });
	});

	it("ast_grep matches land on distinct read-space lines, not all on line 1", async () => {
		const value = (await buildAstGrepTool(localIO()).execute(
			{ path: file, pat: "const $N = $V;" },
			exec(dir)({}),
		)) as { matches: Array<{ startLine: number; captures: Record<string, string[]> }> };
		// tree-sitter counts rows by `\n` only; on the raw CR text every node sat
		// on row 0. In read's space the three statements are lines 1, 2, 3.
		expect(value.matches.map((m) => m.startLine)).toEqual([1, 2, 3]);
		// Document order: the second statement is `const b = 2;`, so line 2.
		expect(value.matches[1]!.startLine).toBe(2);
	});

	it("ast_edit replaces the line the pattern actually matched; CR endings survive the round trip", async () => {
		const { FsSandboxController } = await import("../../src/infra/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const value = (await buildAstEditTool(localIO(), sandbox).execute(
			{ path: file, pat: "const b = 2;", out: "const b = 42;" },
			exec(dir)({}),
		)) as { ok: boolean; count: number };
		expect(value.ok).toBe(true);
		expect(value.count).toBe(1);
		// The OLD space served line 1's anchor for every match, rewriting `const a = 1;`.
		expect(await readFile(file, "utf-8")).toBe("const a = 1;\rconst b = 42;\rconst c = 3;\r");
	});
});
