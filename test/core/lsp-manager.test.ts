/**
 * The manager's job is a decision, made synchronously and without blocking on
 * a server. What is under test is the decision table and the warming contract:
 * the FIRST call in a language must fall back while the server starts, and a
 * later call must switch over.
 */
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport, type SubprocessLike } from "../../src/lsp/transport.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";

/** A fake language server process the test drives by hand. */
function fakeServer(opts: { answerInitialize?: boolean } = {}) {
	let onStdout: ((chunk: Buffer) => void) | undefined;
	let onStderr: ((chunk: Buffer) => void) | undefined;
	let resolveDone: ((outcome: { exitCode: number | null; signal: string | null }) => void) | undefined;
	let killed = 0;
	const outbound = new MessageReader();
	const received: Array<{ id?: unknown; method?: string }> = [];

	const handle: SubprocessLike = {
		pid: 4242,
		stdin: {
			write(chunk: Buffer) {
				for (const message of outbound.push(chunk)) {
					received.push(message as { id?: unknown; method?: string });
					const m = message as { id?: number; method?: string };
					if (m.method === "initialize" && opts.answerInitialize !== false) {
						// Answer asynchronously, like a real server.
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
		stdout: { on(_event, listener) { onStdout = listener; return undefined; } },
		stderr: { on(_event, listener) { onStderr = listener; return undefined; } },
		done: new Promise((resolve) => {
			resolveDone = resolve;
		}),
		terminate() {
			killed += 1;
			resolveDone?.({ exitCode: null, signal: "SIGTERM" });
		},
		async waitForExit() {
			return true;
		},
	};

	return {
		handle,
		received: () => received,
		crash: (text: string) => {
			onStderr?.(Buffer.from(text, "utf8"));
			resolveDone?.({ exitCode: 1, signal: null });
		},
		killed: () => killed,
	};
}

function managerWith(present: string[], opts: { answerInitialize?: boolean; onSpawn?: () => void } = {}) {
	const servers = new Map<string, ReturnType<typeof fakeServer>>();
	const manager = new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async (p) => present.includes(p),
		initializeTimeoutMs: 200,
		maxDocumentBytes: 1_000,
		spawn: () => {
			opts.onSpawn?.();
			const server = fakeServer({ ...(opts.answerInitialize === undefined ? {} : { answerInitialize: opts.answerInitialize }) });
			servers.set(String(servers.size), server);
			return { transport: subprocessTransport(server.handle) };
		},
	});
	return { manager, servers };
}

// Drain the MICROTASK queue, and only that.
//
// The first version looped twenty times — a FIXED tick budget — and it broke
// the moment discovery grew one search location, because each extra
// `await isExecutable` costs a tick and the chain simply outnumbered it. A test
// synchronised by counting ticks fails when the code under it does more work,
// which is the one thing it is supposed to be indifferent to.
//
// It must stay microtasks: three tests here run under `vi.useFakeTimers()`,
// where a `setTimeout` never fires and awaiting one hangs for the full test
// timeout. That is a real constraint of this file, not a style choice.
//
// The budget is generous rather than exact, and that IS a heuristic — the
// honest fix is for each test to await the state it asserts. 1000 covers a
// discovery walk over every catalog entry and every search location with room
// to spare, which is the most a helper like this can promise without lying.
async function settle(): Promise<void> {
	for (let i = 0; i < 1000; i++) await Promise.resolve();
}

describe("the decision table", () => {
	it("falls back to the heuristic when no server was found", async () => {
		const { manager } = managerWith([]);
		const decision = manager.decide("python", "/repo", 100);
		expect(decision.backend).toBe("heuristic");
		await settle();
		// Once the search has run, the reason sharpens from "not started" to
		// "missing" — the remedies differ (wait vs install).
		expect(manager.decide("python", "/repo", 100).reason).toBe("server-missing");
	});

	it("falls back for an over-large file even with a server installed", () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver")]);
		expect(manager.decide("python", "/repo", 5_000)).toEqual({
			backend: "heuristic",
			reason: "file-too-large-for-lsp",
		});
	});

	it("serves the FIRST call heuristically while the server starts", () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver")]);
		// The whole point of warming: the first call must not block.
		expect(manager.decide("python", "/repo", 100).backend).toBe("heuristic");
	});

	it("switches to LSP once the warm-up completed", async () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver")]);
		manager.decide("python", "/repo", 100); // kicks off the warm
		await settle();
		await settle();
		const decision = manager.decide("python", "/repo", 100);
		expect(decision.backend).toBe("lsp");
		expect(decision.session).toBeDefined();
		expect(manager.readyLanguages).toEqual(["python"]);
	});
});

describe("warming", () => {
	it("starts each language at most once", async () => {
		let spawned = 0;
		const { manager } = managerWith([join("/bin", "typescript-language-server"), join("/bin", "pyright-langserver")], {
			onSpawn: () => {
				spawned += 1;
			},
		});
		manager.decide("python", "/repo", 10);
		manager.decide("python", "/repo", 10);
		manager.decide("python", "/repo", 10);
		await settle();
		expect(spawned).toBe(1);
	});

	it("does not start a server for a file it would refuse anyway", async () => {
		let spawned = 0;
		const { manager } = managerWith([join("/bin", "pyright-langserver")], { onSpawn: () => { spawned += 1; } });
		manager.decide("python", "/repo", 5_000);
		await settle();
		// The size check comes first: spinning up a server to then refuse the
		// document would waste the whole index for nothing.
		expect(spawned).toBe(0);
	});

	it("reports a startup timeout as its own reason", async () => {
		vi.useFakeTimers();
		try {
			const { manager } = managerWith([join("/bin", "pyright-langserver")], { answerInitialize: false });
			manager.decide("python", "/repo", 10);
			await settle();
			vi.advanceTimersByTime(400);
			await settle();
			const state = manager.unavailability("python");
			expect(state?.reason).toBe("lsp-timeout");
			expect(state?.message).toContain("did not answer");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry a language whose start already failed", async () => {
		let spawned = 0;
		const { manager } = managerWith([join("/bin", "pyright-langserver")], {
			answerInitialize: false,
			onSpawn: () => {
				spawned += 1;
			},
		});
		vi.useFakeTimers();
		try {
			manager.decide("python", "/repo", 10);
			await settle();
			vi.advanceTimersByTime(400);
			await settle();
			manager.decide("python", "/repo", 10);
			manager.decide("python", "/repo", 10);
			expect(spawned).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("disposal", () => {
	it("shuts down every server it launched", async () => {
		const { manager, servers } = managerWith([join("/bin", "pyright-langserver")]);
		manager.decide("python", "/repo", 10);
		await settle();
		await settle();
		await manager.dispose();
		expect(servers.get("0")!.received().map((m) => m.method)).toContain("shutdown");
	});

	it("refuses everything once disposed", async () => {
		const { manager } = managerWith([join("/bin", "pyright-langserver")]);
		await manager.dispose();
		expect(manager.decide("python", "/repo", 10)).toEqual({ backend: "heuristic", reason: "lsp-unavailable" });
	});
});
