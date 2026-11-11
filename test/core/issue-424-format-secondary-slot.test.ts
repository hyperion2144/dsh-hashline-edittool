/**
 * #424 — the formatting secondary slot (ADR-0038 decision C, step ①):
 * `format.servers.<id>` names an opt-in second server per language; only
 * formatting resolves it, the primary slot stays untouched, and with no
 * setting the behavior is byte-for-byte yesterday's.
 *
 * @module dsh-hashline-edittool/test/issue-424-format-secondary-slot
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { formatConfiguredServers } from "../../src/infra/settings.js";
import { LspManager, setLspManager } from "../../src/lsp/manager.js";
import { subprocessTransport, type SubprocessLike } from "../../src/lsp/transport.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";
import { runAutoFormat } from "../../src/domain/format/auto-format.js";
import { getText, setupIntegrationTest, withTempFile } from "../support/fixtures.js";
import { localIO } from "../../src/infra/fs-bridge.js";

// ---- the manager harness, mirrored from lsp-manager.test.ts ----

/** A fake language server process the test drives by hand. */
function fakeServer(opts: { answerInitialize?: boolean } = {}) {
	let onStdout: ((chunk: Buffer) => void) | undefined;
	let onStderr: ((chunk: Buffer) => void) | undefined;
	let resolveDone: ((outcome: { exitCode: number | null; signal: string | null }) => void) | undefined;
	const outbound = new MessageReader();

	const handle: SubprocessLike = {
		pid: 4242,
		stdin: {
			write(chunk: Buffer) {
				for (const message of outbound.push(chunk)) {
					const m = message as { id?: number; method?: string };
					if (m.method === "initialize" && opts.answerInitialize !== false) {
						queueMicrotask(() => onStdout?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result: { capabilities: { references: true }, serverInfo: { name: "fake" } } })));
						continue;
					}
					if (m.method === "shutdown") {
						queueMicrotask(() => onStdout?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result: null })));
					}
				}
				return true;
			},
		},
		stdout: { on(_event: string, listener: (chunk: Buffer) => void) { onStdout = listener; return undefined; } },
		stderr: { on(_event: string, listener: (chunk: Buffer) => void) { onStderr = listener; return undefined; } },
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

function managerWith(
	present: string[],
	opts: {
		answerInitialize?: boolean;
		idleTimeoutMs?: () => number;
		retryBaseDelayMs?: number;
		formatConfigured?: () => Array<{ command: string; languages: string[] }>;
	} = {},
) {
	const manager = new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async (p) => present.includes(p),
		initializeTimeoutMs: 200,
		maxDocumentBytes: 1_000,
		...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
		...(opts.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: opts.retryBaseDelayMs }),
		...(opts.formatConfigured === undefined ? {} : { formatConfigured: opts.formatConfigured }),
		spawn: () => {
			const server = fakeServer({ ...(opts.answerInitialize === undefined ? {} : { answerInitialize: opts.answerInitialize }) });
			return { transport: subprocessTransport(server.handle) };
		},
	});
	return { manager };
}

// Drain the MICROTASK queue, and only that — same reasoning as
// lsp-manager.test.ts: a fixed tick budget breaks the moment the code under
// test does more async work than the budget guessed.
async function settle(): Promise<void> {
	for (let i = 0; i < 1000; i++) await Promise.resolve();
}

afterEach(() => {
	setLspManager(undefined);
	applyEffective(undefined);
});

describe("the format.servers.<id> setting (#424)", () => {
	it("reaches the effective snapshot, trimmed", () => {
		applyEffective({ format: { servers: { python: "  /usr/bin/ruff-lsp  " } } });
		expect(formatConfiguredServers().get("python")).toBe("/usr/bin/ruff-lsp");
	});

	it("drops empty entries and resets when the subtree is gone", () => {
		applyEffective({ format: { servers: { python: "   " } } });
		expect(formatConfiguredServers().has("python")).toBe(false);
		applyEffective({ format: { servers: { python: "/usr/bin/ruff-lsp" } } });
		expect(formatConfiguredServers().size).toBe(1);
		applyEffective(undefined);
		expect(formatConfiguredServers().size).toBe(0);
	});
});

describe("the manager's format slot (#424 / ADR-0038)", () => {
	it("a named secondary starts its own slot; the primary stays cold", async () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver"), join("/bin", "ruff-lsp")], {
			formatConfigured: () => [{ command: join("/bin", "ruff-lsp"), languages: ["python"] }],
		});
		const session = await manager.waitForSession("python", "/repo", 5_000, "format");
		expect(session).toBeDefined();
		// The primary slot never moved: no setting for it, no process, and the
		// card-facing surfaces report neither.
		expect(manager.readySessionFor("python")).toBeUndefined();
		expect(manager.readyLanguages).toEqual([]);
		expect(manager.snapshot()).toEqual([]);
		await manager.dispose();
	});

	it("the two slots warm independently and hand out different sessions", async () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver"), join("/bin", "ruff-lsp")], {
			formatConfigured: () => [{ command: join("/bin", "ruff-lsp"), languages: ["python"] }],
		});
		const primary = await manager.waitForSession("python", "/repo", 5_000);
		const secondary = await manager.waitForSession("python", "/repo", 5_000, "format");
		expect(primary).toBeDefined();
		expect(secondary).toBeDefined();
		expect(primary).not.toBe(secondary);
		expect(manager.readySessionFor("python")).toBe(primary);
		expect(manager.readySessionFor("python", "format")).toBe(secondary);
		await manager.dispose();
	});

	it("a missing secondary fails its OWN slot, with the format-slot remedy named", async () => {
		const { manager } = managerWith([], {
			retryBaseDelayMs: 1,
			formatConfigured: () => [{ command: join("/bin", "missing-ruff"), languages: ["python"] }],
		});
		expect(await manager.waitForSession("python", "/repo", 1_000, "format")).toBeUndefined();
		const why = manager.unavailability("python", "format");
		expect(why?.reason).toBe("server-missing");
		expect(String(why?.message)).toContain("hashline.format.servers");
		await manager.dispose();
	});

	it("rescan clears a failed format slot together with the primary ones", async () => {
		const { manager } = managerWith([], {
			retryBaseDelayMs: 60_000,
			formatConfigured: () => [{ command: join("/bin", "missing-ruff"), languages: ["python"] }],
		});
		await manager.waitForSession("python", "/repo", 200, "format");
		expect(manager.unavailability("python", "format")?.reason).toBe("server-missing");
		const cleared = manager.rescan();
		expect(cleared).toContain("python");
		expect(manager.unavailability("python", "format")).toEqual({ reason: "lsp-unavailable", message: expect.anything() });
		await manager.dispose();
	});

	it("the idle reaper reclaims the format slot like any other", async () => {
		vi.useFakeTimers();
		let manager: LspManager | undefined;
		try {
			const harness = managerWith([join("/bin", "pyright-langserver"), join("/bin", "ruff-lsp")], {
				idleTimeoutMs: () => 30,
				formatConfigured: () => [{ command: join("/bin", "ruff-lsp"), languages: ["python"] }],
			});
			manager = harness.manager;
			// The boot completes on MICROTASKS alone (settle): under fake timers a
			// waitForSession poll would hang, and it is not what this test needs.
			manager.warm("python", "/repo", "format");
			await settle();
			expect(manager.readySessionFor("python", "format")).toBeDefined();
			vi.advanceTimersByTime(1_000);
			await settle();
			expect(manager.readySessionFor("python", "format")).toBeUndefined();
			expect(manager.readyLanguages).toEqual([]);
		} finally {
			vi.useRealTimers();
			if (manager !== undefined) await manager.dispose();
		}
	});
});

describe("format routing through the secondary (#424)", () => {
	it("the manual tool resolves the FORMAT role when a secondary is named, the primary otherwise", async () => {
		await withTempFile("f.py", "x=1\n", async ({ cwd, path }) => {
			const roles: Array<string | undefined> = [];
			setLspManager({
				waitForSession: (_lang: unknown, _root: unknown, _timeout: unknown, role?: string) => {
					roles.push(role);
					return undefined;
				},
				unavailability: () => ({ reason: "lsp-unavailable", message: "did not start in time" }),
				disposed: false,
				dispose: async () => undefined,
			} as never);
			const harness = setupIntegrationTest(cwd);
			applyEffective({ format: { servers: { python: "/usr/bin/ruff-lsp" } } });
			const raw = getText(await harness.formatTool.execute("format", { path }));
			expect(raw).toContain("[E_LSP_NO_SERVER]");
			expect(raw).toContain("hashline.format.servers");
			expect(roles).toEqual(["format"]);
			// No secondary named: the primary path, word for word.
			applyEffective({});
			const raw2 = getText(await harness.formatTool.execute("format", { path }));
			expect(raw2).toContain("hashline.lsp.servers");
			expect(roles).toEqual(["format", "primary"]);
		});
	});

	it("the auto pass resolves the FORMAT role only for a ready secondary", async () => {
		const roles: Array<string | undefined> = [];
		setLspManager({
			readySessionFor: (_lang: unknown, role?: string) => {
				roles.push(role);
				return undefined;
			},
			disposed: false,
			dispose: async () => undefined,
		} as never);
		applyEffective({ format: { auto: "full", servers: { python: "/usr/bin/ruff-lsp" } } });
		await runAutoFormat({ io: localIO(), absolutePath: "/repo/a.py", modelContent: "x=1\n" });
		applyEffective({ format: { auto: "full" } });
		await runAutoFormat({ io: localIO(), absolutePath: "/repo/a.py", modelContent: "x=1\n" });
		// The ready-only rule is untouched; only the ROLE follows the setting.
		expect(roles).toEqual(["format", "primary"]);
		await settle();
	});
});
