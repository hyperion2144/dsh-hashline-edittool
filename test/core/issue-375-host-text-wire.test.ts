/**
 * The host's texts on the wire (issue 375): FACTS, not prose.
 *
 * The host cannot read the reader's language — `locale` is a CLIENT service
 * (#369) — so a host that assembled a sentence for a card had already picked a
 * language the reader did not ask for. The wire therefore carries a stable key
 * plus the params that fill it, and the client resolves both.
 *
 * Two things are pinned here, because they are the contract the client half
 * depends on:
 *
 *  1. the SHAPE of a row title (one function, every tool) — the key names the
 *     wording, the params carry the facts;
 *  2. the lossy note's shape — a key + params, and the schema that says so;
 *  3. the LANGUAGE-SERVER routes' texts (#377) — the same shape, so an English
 *     session does not read the host's Chinese.
 *
 * @module dsh-hashline-edittool/test/issue-375-host-text-wire
 */
import { describe, expect, it } from "vitest";
import { LOSSY_NOTE_TEXT, rowTitle } from "../../src/render/wire-text.js";
import { buildReadTool, readPresentationMeta } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";
import type { ReadPresentation } from "../../src/render/read-card.js";
import { handleLspInstall, handleLspStatus } from "../../src/lsp/status-route.js";
import { LspManager, setLspManager } from "../../src/lsp/manager.js";
import { installLspServer, type SpawnLike } from "../../src/lsp/install-server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("the row title on the wire (issue 375)", () => {
	it("is ONE shape for every tool: a key plus the params that fill it", () => {
		expect(rowTitle("edit", { path: "src/a.ts" })).toEqual({
			key: "row.title.edit",
			params: { path: "src/a.ts" },
		});
		expect(rowTitle("write", { path: "src/a.ts" })).toEqual({
			key: "row.title.write",
			params: { path: "src/a.ts" },
		});
		expect(rowTitle("grep", {})).toEqual({ key: "row.title.grep", params: {} });
	});

	it("names the read's window in the KEY — three wordings, three keys", () => {
		// A template that could swallow every case would need a conditional; a
		// template with an empty hole renders a stray space in the one case that has
		// none. So the window is a different key — and so is a CUT window (issue 374).
		expect(rowTitle("read", { path: "a.ts", start: 12, end: 61, total: 240 })).toEqual({
			key: "row.title.read.window",
			params: { path: "a.ts", start: 12, end: 61, total: 240 },
		});
		// The response budget cut it: the resume hint rides with the range.
		expect(
			rowTitle("read", { path: "a.ts", start: 12, end: 61, total: 240, truncated: true }),
		).toEqual({
			key: "row.title.read.window.truncated",
			params: { path: "a.ts", start: 12, end: 61, total: 240 },
		});
		// The whole file is not a window: only its length is worth saying.
		expect(rowTitle("read", { path: "a.ts", start: 1, end: 240, total: 240 })).toEqual({
			key: "row.title.read.total",
			params: { path: "a.ts", total: 240 },
		});
		// A call that named no window at all read the whole file.
		expect(rowTitle("read", { path: "a.ts", total: 240 })).toEqual({
			key: "row.title.read.total",
			params: { path: "a.ts", total: 240 },
		});
		expect(rowTitle("read", { path: "a.ts" })).toEqual({
			key: "row.title.read",
			params: { path: "a.ts" },
		});
	});

	it("never invents a window out of half a range", () => {
		expect(rowTitle("read", { path: "a.ts", start: 12 }).key).toBe("row.title.read");
		expect(rowTitle("read", { path: "a.ts", end: 61 }).key).toBe("row.title.read");
	});

	it("carries no path when the call named no file", () => {
		expect(rowTitle("edit", {})).toEqual({ key: "row.title.edit", params: {} });
	});

	it("the read card's meta carries the title — the window's own wording", () => {
		const windowed = readPresentationMeta({
			path: "a.ts",
			offset: 12,
			totalLines: 240,
			lines: [],
			hashlines: [],
			window: { start: 12, end: 61, totalLines: 240 },
		}) as ReadPresentation;
		expect(windowed.rowTitle).toEqual({
			key: "row.title.read.window",
			params: { path: "a.ts", start: 12, end: 61, total: 240 },
		});

		// A window the response budget CUT (issue 374) says so: the resume hint is
		// its own key, because a template cannot say "and resume" conditionally.
		const cut = readPresentationMeta({
			path: "a.ts",
			offset: 12,
			totalLines: 240,
			lines: [],
			hashlines: [],
			window: { start: 12, end: 61, totalLines: 240, truncated: true },
		}) as ReadPresentation;
		expect(cut.rowTitle).toEqual({
			key: "row.title.read.window.truncated",
			params: { path: "a.ts", start: 12, end: 61, total: 240 },
		});

		// A whole-file read is not a window: it says the file's length.
		const whole = readPresentationMeta({
			path: "a.ts",
			offset: 1,
			totalLines: 240,
			lines: [],
			hashlines: [],
			window: { start: 1, end: 240, totalLines: 240 },
		}) as ReadPresentation;
		expect(whole.rowTitle).toEqual({ key: "row.title.read.total", params: { path: "a.ts", total: 240 } });
	});
});

describe("the lossy note on the wire (issue 375)", () => {
	it("is a key + params, never prose", () => {
		expect(LOSSY_NOTE_TEXT).toEqual({ key: "read.lossy" });
	});

	it("the read tool's declared schema accepts the shape and refuses a sentence", () => {
		const tool = buildReadTool(localIO());
		const schema = outputSchemaOf(tool);
		const base = {
			path: "a.ts",
			offset: 1,
			totalLines: 1,
			lines: [],
			hashlines: [],
			modelText: "m",
		};
		expect(
			schemaViolations(schema, { ...base, lossy: true, lossyNote: { key: "read.lossy" } }),
		).toEqual([]);
		// The OLD shape — the English sentence the host used to compose — no
		// longer fits the declaration: a string is not an object.
		expect(
			schemaViolations(schema, { ...base, lossy: true, lossyNote: "[Undecodable bytes…]" }),
		).not.toEqual([]);
	});
});

/**
 * A response the routes can write to, and the JSON they wrote.
 *
 * @returns the fake response and a reader for the payload it carries.
 */
function fakeRes(): { res: ServerResponse; body: () => unknown } {
	let payload: unknown;
	const res = {
		writeHead: () => res,
		end: (chunk: string) => {
			payload = JSON.parse(chunk);
		},
	} as unknown as ServerResponse;
	return { res, body: () => payload };
}

/**
 * A spawn that answers with a fixed exit code and a fixed tail of output.
 *
 * @param exitCode - the code the command "exited" with.
 * @param output - what the command said on stdout/stderr.
 * @returns a spawn seam that runs nothing and answers with those facts.
 */
function fakeSpawn(exitCode: number | null, output = ""): SpawnLike {
	return () => ({
		pid: 4242,
		stdin: undefined,
		stdout: {
			on: (_event: "data", listener: (chunk: Buffer) => void) => {
				return undefined;
			},
		},
		stderr: {
			on: (_event: "data", listener: (chunk: Buffer) => void) => {
				if (output !== "") listener(Buffer.from(output, "utf8"));
				return undefined;
			},
		},
		done: Promise.resolve({ exitCode, signal: null }),
		terminate: () => {},
		waitForExit: async () => true,
	});
}

/** A manager that finds NO server on this machine, whatever the machine has. */
function emptyManager(): LspManager {
	return new LspManager({
		isExecutable: async () => false,
		pathDirs: [],
		spawn: () => {
			throw new Error("this manager never starts a server");
		},
	});
}

describe("the language-server routes' texts on the wire (issue 377)", () => {
	it("the status route's own refusals are KEYS, never Chinese sentences", async () => {
		// No client installed: the route says so in the reader's language, and the
		// sentence it used to send in Chinese is now a key + no params.
		setLspManager(undefined);
		const status = fakeRes();
		await handleLspStatus({} as IncomingMessage, status.res);
		expect(status.body()).toEqual({
			available: false,
			message: { key: "lsp.status.noClient" },
			languages: [],
		});

		// The install route's refusal when the deployment has no subprocess seam.
		const install = fakeRes();
		await handleLspInstall({} as IncomingMessage, install.res, undefined);
		expect(install.body()).toEqual({ ok: false, message: { key: "lsp.status.noSubprocessSeam" } });
	});

	it("the row's own hint is one of THREE keys, and each names its situation", async () => {
		// A row is read at a glance, and the three situations have three different
		// next moves: we install it, you name it, or you install it yourself.
		const manager = emptyManager();
		const rows = await manager.status(["typescript", "c", "julia"]);
		const byLanguage = new Map(rows.map((row) => [row.languageId, row]));

		// npm can install it: one click.
		expect(byLanguage.get("typescript")?.message).toEqual({ key: "lsp.row.canInstall" });
		// The catalog knows the command but has no installer for it: your move.
		expect(byLanguage.get("c")?.message).toEqual({
			key: "lsp.row.selfInstall",
			params: { command: "clangd" },
		});
		// No catalog entry at all: name the command yourself.
		expect(byLanguage.get("julia")?.message).toEqual({ key: "lsp.row.noBuiltinCommand" });
	});

	it("the install outcome's refusals are keys, with the FACTS as params", async () => {
		// No installer at all for this server: the refusal names it.
		const noCommand = await installLspServer("c", fakeSpawn(0));
		expect(noCommand.message).toEqual({
			key: "lsp.install.noCommand",
			params: { displayName: "clangd" },
		});

		// The command failed: the exit code and the tail ride as FACTS, verbatim.
		const failed = await installLspServer("typescript", fakeSpawn(1, "npm ERR! boom"));
		expect(failed.message).toEqual({
			key: "lsp.install.exitCode",
			params: { code: 1, tail: "npm ERR! boom" },
		});

		// npm reported success but the launcher is not where npm puts it.
		const missing = await installLspServer("typescript", fakeSpawn(0));
		expect(missing.message).toEqual({
			key: "lsp.install.npmOkButMissing",
			params: { command: "typescript-language-server" },
		});

		// A toolchain install lands in its OWN directory, and says so.
		const toolchain = await installLspServer("go", fakeSpawn(0));
		expect(toolchain.message).toEqual({
			key: "lsp.install.doneOwnToolchain",
			params: { displayName: "gopls" },
		});
	});

	it("an install that landed in the plugin's own directory says THAT", async () => {
		// The npm path's own check: the launcher has to be where npm puts it, or
		// the install is reported as a failure. Make it so.
		// The premise is POSIX: a shebang launcher + chmod IS "executable". Windows
		// grants executability by extension, not by mode, so the fake launcher
		// cannot pass the install's own check there — what this pins is the
		// WORDING (doneBuiltinDir), not the platform's install mechanics.
		if (process.platform === "win32") return;
		const { mkdir, writeFile, chmod } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { lspServersDir } = await import("../../src/infra/paths.js");
		const binDir = join(lspServersDir(), "node_modules", ".bin");
		await mkdir(binDir, { recursive: true });
		const launcher = join(binDir, "typescript-language-server");
		await writeFile(launcher, "#!/bin/sh\n");
		await chmod(launcher, 0o755);
		const done = await installLspServer("typescript", fakeSpawn(0));
		expect(done.ok).toBe(true);
		expect(done.message).toEqual({
			key: "lsp.install.doneBuiltinDir",
			params: { displayName: "TypeScript Language Server" },
		});
	});

	it("a platform that cannot install it says WHICH platform, as a fact", async () => {
		// `jdtls` is offered through Homebrew, so it is macOS-only. On the other
		// platforms the row must say so — and the platform is a FACT, not a word.
		if (process.platform === "darwin") return;
		const outcome = await installLspServer("java", fakeSpawn(0));
		expect(outcome.message).toEqual({
			key: "lsp.install.noCommandForPlatform",
			params: { displayName: "Eclipse JDT Language Server", platform: process.platform },
		});
	});
});
