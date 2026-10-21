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

function managerWith(
	present: string[],
	opts: { answerInitialize?: boolean; onSpawn?: () => void; idleTimeoutMs?: () => number; retryBaseDelayMs?: number } = {},
) {
	const servers = new Map<string, ReturnType<typeof fakeServer>>();
	const manager = new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async (p) => present.includes(p),
		initializeTimeoutMs: 200,
		maxDocumentBytes: 1_000,
		...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
		...(opts.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: opts.retryBaseDelayMs }),
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

	it("does not retry inside the backoff window", async () => {
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

/**
 * Issue #306: a language server nobody is using must not stay resident for the
 * rest of the session. A TypeScript server holding a large repository's index
 * can cost gigabytes, and the old contract was "warm once, keep it until the
 * plugin unloads".
 *
 * The window is READ AT USE TIME — the value is a setting, and a setting can
 * change while the plugin is loaded — so these tests change it mid-flight.
 */
describe("idle reclamation (#306)", () => {
	it("reclaims a session nobody is using", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(1);
			// The SLOT is gone too: the language is cold again, not stuck on a
			// session that is about to die.
			expect(manager.readyLanguages).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a session that is still in use", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			// Half the window passes, the session is used, then the other half
			// passes: the clock RESTARTS on use, so it is not idle.
			vi.advanceTimersByTime(30_000);
			manager.decide("python", "/repo", 10);
			vi.advanceTimersByTime(30_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(0);
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("warms a fresh server after a reclaim", async () => {
		vi.useFakeTimers();
		try {
			let spawned = 0;
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
				onSpawn: () => {
					spawned += 1;
				},
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(spawned).toBe(1);
			// The next ask is COLD: a new server is warmed, and it is usable.
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			expect(spawned).toBe(2);
			expect(manager.readyLanguages).toEqual(["python"]);
			expect(servers.get("1")).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("never reclaims when the window is 0", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 0,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			vi.advanceTimersByTime(600_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(0);
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reclaim a session that is mid-answer", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			const session = manager.readySessionFor("python")!;
			// A request the fake server never answers: the session is WORKING, not
			// idle, and killing it now would break a request already in flight.
			void session.request("textDocument/definition", {}, 600_000).catch(() => undefined);
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(0);
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads the window at use time, so a longer window delays the reclaim", async () => {
		vi.useFakeTimers();
		try {
			let window = 60_000;
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => window,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			// The user raises the window while the timer is already running.
			window = 120_000;
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(0);
			// …and the session is reclaimed only once the NEW window has passed.
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shuts the process down when the handshake failed", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				answerInitialize: false,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			vi.advanceTimersByTime(400);
			await settle();
			// The slot is failed and the process is GONE: a server nobody will talk
			// to again must not hold its index until the plugin unloads.
			expect(servers.get("0")!.killed()).toBe(1);
			expect(manager.unavailability("python")?.reason).toBe("lsp-timeout");
		} finally {
			vi.useRealTimers();
		}
	});
	it("does not write to a session that was reclaimed", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			const open = manager.openDocumentFor("python", "file:///repo/a.py")!;
			open("print(1)");
			vi.advanceTimersByTime(60_000);
			await settle();
			expect(servers.get("0")!.killed()).toBe(1);
			// The closure outlived its session. Writing to a DEAD server would
			// push a change into a pipe nobody reads — and, worse, throw on a
			// closed pipe. The reclaimed session must be left alone.
			expect(() => open("print(2)")).not.toThrow();
			expect(servers.get("0")!.received().map((m) => m.method)).not.toContain("textDocument/didChange");
		} finally {
			vi.useRealTimers();
		}
	});
	it("hands a stale closure to the re-warmed server", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => 60_000,
			});
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			const open = manager.openDocumentFor("python", "file:///repo/a.py")!;
			vi.advanceTimersByTime(60_000);
			await settle();
			// The language goes cold and is warmed again.
			manager.decide("python", "/repo", 10);
			await settle();
			await settle();
			open("print(3)");
			// The CURRENT server is the one that must learn about the document —
			// the new one has never seen it, so this is a didOpen.
			expect(servers.get("1")!.received().map((m) => m.method)).toContain("textDocument/didOpen");
		} finally {
			vi.useRealTimers();
		}
	});
	it("survives a settings surface that throws", async () => {
		vi.useFakeTimers();
		try {
			const { manager } = managerWith([join("/bin", "pyright-langserver")], {
				idleTimeoutMs: () => {
					throw new Error("the settings surface is broken");
				},
			});
			// Reading the window must never be the thing that breaks a tool call.
			expect(manager.decide("python", "/repo", 10).backend).toBe("heuristic");
			await settle();
			await settle();
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("retry after a failed start (#318)", () => {
	/** A manager whose spawn #n fails for each n in `failRounds`, and answers otherwise. */
	function flakyManager(
		present: string[],
		failRounds: number[],
		opts: { retryBaseDelayMs?: number; idleTimeoutMs?: () => number; failMessage?: string } = {},
	) {
		const servers: ReturnType<typeof fakeServer>[] = [];
		const manager = new LspManager({
			pathDirs: ["/bin"],
			isExecutable: async (p) => present.includes(p),
			initializeTimeoutMs: 200,
			...(opts.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: opts.retryBaseDelayMs }),
			...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
			spawn: () => {
				const index = servers.length;
				const answers = !failRounds.includes(index);
				const server = fakeServer({ answerInitialize: answers });
				if (!answers) queueMicrotask(() => server.crash(opts.failMessage ?? `spawn round ${index} blew up: missing lib`));
				servers.push(server);
				return { transport: subprocessTransport(server.handle) };
			},
		});
		return { manager, servers };
	}

	it("retries a failed start once the backoff window has passed", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = flakyManager([join("/bin", "pyright-langserver")], [0], { retryBaseDelayMs: 100 });
			manager.warm("python", "/repo");
			await settle();
			expect(manager.unavailability("python")?.reason).toBe("lsp-unavailable");
			expect(servers.length).toBe(1);
			vi.advanceTimersByTime(100);
			manager.warm("python", "/repo"); // the window has passed: the failed slot gives way
			await settle();
			expect(servers.length).toBe(2);
			expect(manager.unavailability("python")).toBeUndefined();
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("backs off further on each repeated failure", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = flakyManager([join("/bin", "pyright-langserver")], [0, 1], { retryBaseDelayMs: 100 });
			manager.warm("python", "/repo");
			await settle();
			expect(servers.length).toBe(1);
			vi.advanceTimersByTime(100); // one base window: due again
			manager.warm("python", "/repo");
			await settle();
			expect(servers.length).toBe(2);
			vi.advanceTimersByTime(100); // the second window needs 200 — not due yet
			manager.warm("python", "/repo");
			await settle();
			expect(servers.length).toBe(2);
			vi.advanceTimersByTime(100); // 200 past the second failure: due now
			manager.warm("python", "/repo");
			await settle();
			expect(servers.length).toBe(3);
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forceWarm restarts a failed server immediately, inside the window", async () => {
		const { manager, servers } = flakyManager([join("/bin", "pyright-langserver")], [0]);
		manager.warm("python", "/repo");
		await settle();
		expect(manager.unavailability("python")).toBeDefined();
		const session = await manager.forceWarm("python", "/repo", 5_000);
		expect(session).toBeDefined();
		expect(servers.length).toBe(2);
		expect(manager.readyLanguages).toEqual(["python"]);
	});

	it("forceWarm reports why a permanently broken server failed", async () => {
		const { manager } = flakyManager([join("/bin", "pyright-langserver")], [0, 1]);
		manager.warm("python", "/repo");
		await settle();
		const session = await manager.forceWarm("python", "/repo", 1_000);
		expect(session).toBeUndefined();
		expect(manager.unavailability("python")?.reason).toBe("lsp-unavailable");
		// The refusal carries the server's own stderr, not just the exit code.
		expect(manager.unavailability("python")?.message).toContain("missing lib");
	});

	it("the stderr tail is capped so a chatty server cannot flood the card", async () => {
		const { manager } = flakyManager([join("/bin", "pyright-langserver")], [0], {
			failMessage: `${"x".repeat(1500)} THE END`,
		});
		manager.warm("python", "/repo");
		await settle();
		const message = manager.unavailability("python")?.message ?? "";
		expect(message).toContain("--- server stderr (tail) ---");
		// The LAST content survives the cap: the tail is why the server died.
		expect(message).toContain("THE END");
		expect(message).not.toContain("x".repeat(1300));
	});


	it("a successful start resets the attempt count", async () => {
		vi.useFakeTimers();
		try {
			const { manager, servers } = flakyManager([join("/bin", "pyright-langserver")], [0, 2], {
				retryBaseDelayMs: 100,
				idleTimeoutMs: () => 1_000,
			});
			manager.warm("python", "/repo");
			await settle(); // attempt 1 fails
			vi.advanceTimersByTime(100);
			manager.warm("python", "/repo"); // attempt 2 answers
			await settle();
			expect(manager.readyLanguages).toEqual(["python"]);
			vi.advanceTimersByTime(1_000); // the idle window reclaims the slot
			await settle();
			manager.warm("python", "/repo"); // a fresh start — spawn index 2 fails
			await settle();
			expect(manager.snapshot().find((row) => row.languageId === "python")?.attempts).toBe(1);
			vi.advanceTimersByTime(100); // the BASE delay only — the counter restarted
			manager.warm("python", "/repo"); // spawn index 3 answers
			await settle();
			expect(servers.length).toBe(4);
			expect(manager.readyLanguages).toEqual(["python"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rescan clears failed slots and the retry counters", async () => {
		vi.useFakeTimers();
		try {
			const { manager } = flakyManager([join("/bin", "pyright-langserver")], [0, 1, 2], { retryBaseDelayMs: 100 });
			manager.warm("python", "/repo");
			await settle();
			vi.advanceTimersByTime(100);
			manager.warm("python", "/repo");
			await settle();
			expect(manager.snapshot().find((row) => row.languageId === "python")?.attempts).toBe(2);
			manager.rescan();
			expect(manager.snapshot()).toEqual([]); // the failed slot is gone
			manager.warm("python", "/repo"); // a fresh start — spawn index 2 fails again
			await settle();
			expect(manager.snapshot().find((row) => row.languageId === "python")?.attempts).toBe(1); // counted from one, not three
		} finally {
			vi.useRealTimers();
		}
	});

	it("a missing server stays a cheap refusal across repeated decisions", async () => {
		let lookups = 0;
		const manager = new LspManager({
			pathDirs: ["/bin"],
			isExecutable: async () => {
				lookups += 1;
				return false;
			},
			initializeTimeoutMs: 200,
			spawn: () => {
				throw new Error("no server was found — spawn must never run");
			},
		});
		manager.warm("python", "/repo");
		await settle();
		expect(manager.unavailability("python")?.reason).toBe("server-missing");
		const afterFirstWarm = lookups; // one discovery walk checks many candidates — that is fine
		for (let i = 0; i < 5; i += 1) {
			manager.decide("python", "/repo", 10);
			await settle();
		}
		expect(lookups).toBe(afterFirstWarm); // but it never re-runs: refusals never re-scan
	});
});
