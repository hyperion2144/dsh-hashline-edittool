/**
 * #425 — the formatter-only catalog entry (ADR-0038, step ②): `ruff-lsp`
 * drives python's FORMAT slot only. Primary discovery never sees it, the
 * format slot's discovery opts in, it is installable via pipx, and status
 * rows carry it for the settings card.
 *
 * @module dsh-hashline-edittool/test/issue-425-formatter-catalog
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	canInstallFormatServer,
	canInstallServer,
	formatInstallCommand,
	formatServerEntryFor,
	installCommandFor,
	serverEntryFor,
} from "../../src/lsp/install-server.js";
import { applyEffective } from "../../src/config.js";
import { discoverServers } from "../../src/lsp/discovery.js";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport, type SubprocessLike } from "../../src/lsp/transport.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";

/** A fake language server process; the boot completes on microtasks. */
function fakeServer() {
	let onStdout: ((chunk: Buffer) => void) | undefined;
	let resolveDone: ((outcome: { exitCode: number | null; signal: string | null }) => void) | undefined;
	const outbound = new MessageReader();

	const handle: SubprocessLike = {
		pid: 4242,
		stdin: {
			write(chunk: Buffer) {
				for (const message of outbound.push(chunk)) {
					const m = message as { id?: number; method?: string };
					if (m.method === "initialize") {
						queueMicrotask(() => onStdout?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result: { capabilities: {}, serverInfo: { name: "fake" } } })));
					}
					if (m.method === "shutdown") {
						queueMicrotask(() => onStdout?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result: null })));
					}
				}
				return true;
			},
		},
		stdout: { on(_event: string, listener: (chunk: Buffer) => void) { onStdout = listener; return undefined; } },
		stderr: { on(_event: string, listener: (chunk: Buffer) => void) { return undefined; } },
		done: new Promise((resolve) => {
			resolveDone = resolve;
		}),
		terminate() {
			resolveDone?.({ exitCode: null, signal: "SIGTERM" });
		},
		async waitForExit() {
			return true;
		},
	};

	return { handle };
}

function managerWith(present: string[]) {
	const manager = new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async (p) => present.includes(p),
		initializeTimeoutMs: 200,
		maxDocumentBytes: 1_000,
		spawn: () => {
			const server = fakeServer();
			return { transport: subprocessTransport(server.handle) };
		},
	});
	return { manager };
}

afterEach(async () => {
	applyEffective(undefined);
});

describe("the formatter-only catalog entry (#425)", () => {
	it("serves the FORMAT slot for python and never the primary", () => {
		// The primary entry is untouched: pyright is still python's server.
		expect(serverEntryFor("python")?.command).toBe("pyright-langserver");
		expect(canInstallServer("python")).toBe(true);
		expect(installCommandFor("python")).toEqual(["npm"]);
		// The format entry exists for python and nowhere else.
		expect(formatServerEntryFor("python")?.command).toBe("ruff-lsp");
		expect(formatServerEntryFor("typescript")).toBeUndefined();
		expect(canInstallFormatServer("python")).toBe(true);
		expect(canInstallFormatServer("typescript")).toBe(false);
		expect(formatInstallCommand("python")).toEqual(["pipx", "install", "ruff-lsp", "--pip-args", "-r {requirements}"]);
	});

	it("is invisible to primary discovery; the format scan opts in", async () => {
		const isRuff = async (p: string) => p === join("/bin", "ruff-lsp");
		const primary = await discoverServers({ pathDirs: ["/bin"], isExecutable: isRuff });
		expect(primary.find((server) => server.command === "ruff-lsp")).toBeUndefined();
		const format = await discoverServers({ pathDirs: ["/bin"], isExecutable: isRuff, includeFormatterOnly: true });
		const found = format.find((server) => server.command === "ruff-lsp");
		expect(found?.languages).toEqual(["python"]);
		expect(found?.origin).toBe("path");
	});
});

describe("status rows surface the format server (#425)", () => {
	it("carries the format server and its install offer for python", async () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver"), join("/bin", "ruff-lsp")]);
		const rows = await manager.status(["python"]);
		expect(rows[0]?.server?.command).toBe("pyright-langserver");
		expect(rows[0]?.formatServer?.command).toBe("ruff-lsp");
		expect(rows[0]?.formatCanInstall).toBe(true);
		// A language with no formatter entry carries neither field.
		const ts = await manager.status(["typescript"]);
		expect(ts[0]?.formatServer).toBeUndefined();
		expect(ts[0]?.formatCanInstall).toBeUndefined();
		await manager.dispose();
	});
});
