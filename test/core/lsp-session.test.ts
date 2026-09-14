/**
 * The LSP conversation, driven against an in-memory duplex pair.
 *
 * No language server, no process and no timing luck: what is under test is
 * whether the session answers the messages that make servers hang, and whether
 * it keeps its own view of documents straight.
 */
import { describe, expect, it, vi } from "vitest";
import { LspSession, LspSessionError, normalizeFileUri, type LspTransport } from "../../src/lsp/session.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";

/** A transport whose two directions the test drives by hand. */
function harness() {
	const outbound = new MessageReader();
	const writes: Buffer[] = [];
	let onData: ((chunk: Buffer) => void) | undefined;
	let onExit: ((code: number | null) => void) | undefined;
	let killed = 0;

	const transport: LspTransport = {
		write(bytes) {
			writes.push(bytes);
			outbound.push(bytes);
		},
		onData(listener) {
			onData = listener;
		},
		onExit(listener) {
			onExit = listener;
		},
		kill() {
			killed += 1;
		},
	};

	const session = new LspSession(transport, { requestTimeoutMs: 50 });
	return {
		session,
		/** Everything the session has sent so far. */
		sent: () => writes.flatMap((buffer) => new MessageReader().push(buffer)),
		/** Deliver a message from the server. */
		deliver: (message: unknown, chunk?: Buffer) => onData?.(chunk ?? encodeMessage(message)),
		/** Deliver raw bytes (for split-chunk cases). */
		deliverRaw: (chunk: Buffer) => onData?.(chunk),
		exit: (code: number | null) => onExit?.(code),
		killed: () => killed,
	};
}

describe("the handshake", () => {
	it("sends initialize, then initialized, then reports readiness", async () => {
		const h = harness();
		const pending = h.session.initialize("/repo");
		// The session must not be usable before the response arrives.
		expect(h.session.isReady).toBe(false);
		const [initialize] = h.sent() as Array<{ id: number; method: string; params: { rootUri: string } }>;
		expect(initialize?.method).toBe("initialize");
		expect(initialize?.params.rootUri).toBe("file:///repo");
		h.deliver({ jsonrpc: "2.0", id: initialize!.id, result: { capabilities: { references: true }, serverInfo: { name: "fake" } } });
		await pending;
		expect(h.session.isReady).toBe(true);
		expect(h.session.serverCapabilities).toEqual({ references: true });
		expect(h.session.serverInfo).toEqual({ name: "fake" });
		// `initialized` is a notification and must FOLLOW the response.
		const methods = (h.sent() as Array<{ method?: string }>).map((m) => m.method);
		expect(methods).toEqual(["initialize", "initialized"]);
	});

	it("refuses a second initialize", async () => {
		const h = harness();
		const first = h.session.initialize("/repo");
		h.deliver({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
		await first;
		await expect(h.session.initialize("/repo")).rejects.toBeInstanceOf(LspSessionError);
	});

	it("advertises PUSH diagnostics and not PULL — two capabilities, one word", async () => {
		const h = harness();
		const pending = h.session.initialize("/repo");
		const [initialize] = h.sent() as Array<{ id: number; params: { capabilities: Record<string, unknown> } }>;
		const textDocument = initialize!.params.capabilities.textDocument as Record<string, unknown>;
		// `textDocument/publishDiagnostics` is the NOTIFICATION the server sends, and
		// declaring it is what allows the push: without it `typescript-language-server`
		// stayed silent and the `diagnostics` operation always answered "no answer yet"
		// for a file full of errors.
		expect(textDocument.publishDiagnostics).toEqual({});
		// `textDocument/diagnostic` is the REQUEST the client sends (pull). Advertising
		// a capability we ignore is how a server ends up waiting for a pull that never
		// comes, so this one stays undeclared.
		expect(textDocument.diagnostic).toBeUndefined();
		expect(textDocument.documentSymbol).toBeDefined();
		h.deliver({ jsonrpc: "2.0", id: initialize!.id, result: { capabilities: {} } });
		await pending;
	});
});

describe("server-to-client requests", () => {
	it("answers an unhandled request with null instead of going silent", () => {
		const h = harness();
		// A server asking for configuration and getting silence may block on it,
		// which from outside looks like OUR request timing out.
		h.deliver({ jsonrpc: "2.0", id: "srv-1", method: "workspace/configuration", params: { items: [] } });
		const replies = h.sent() as Array<{ id?: unknown; result?: unknown }>;
		expect(replies).toEqual([{ jsonrpc: "2.0", id: "srv-1", result: null }]);
	});

	it("uses a registered handler's answer when there is one", () => {
		const h = harness();
		h.session.on("workspace/configuration", () => [{ tabSize: 2 }]);
		h.deliver({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: {} });
		expect((h.sent() as Array<{ result?: unknown }>)[0]?.result).toEqual([{ tabSize: 2 }]);
	});

	it("answers with null when the handler throws, rather than hanging the server", () => {
		const h = harness();
		h.session.on("workspace/configuration", () => {
			throw new Error("boom");
		});
		h.deliver({ jsonrpc: "2.0", id: 8, method: "workspace/configuration", params: {} });
		expect((h.sent() as Array<{ result?: unknown }>)[0]?.result).toBeNull();
	});
});

describe("requests", () => {
	it("routes a response to its own request by id", async () => {
		const h = harness();
		const a = h.session.request("a", {});
		const b = h.session.request("b", {});
		const sent = h.sent() as Array<{ id: number; method: string }>;
		const idA = sent.find((m) => m.method === "a")!.id;
		const idB = sent.find((m) => m.method === "b")!.id;
		// Answer out of order: correlation is by id, not by arrival.
		h.deliver({ jsonrpc: "2.0", id: idB, result: "B" });
		h.deliver({ jsonrpc: "2.0", id: idA, result: "A" });
		expect(await a).toBe("A");
		expect(await b).toBe("B");
	});

	it("rejects a request the server answers with an error", async () => {
		const h = harness();
		const pending = h.session.request("x", {});
		const id = (h.sent() as Array<{ id: number }>)[0]!.id;
		h.deliver({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } });
		await expect(pending).rejects.toThrow(/no such method/);
	});

	it("times out with its own error code, and a late answer does not resolve it", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const pending = h.session.request("slow", {}, 20);
			const id = (h.sent() as Array<{ id: number }>)[0]!.id;
			vi.advanceTimersByTime(30);
			await expect(pending).rejects.toThrow(/did not answer within 20 ms/);
			// The pending entry must be gone: a late response would otherwise
			// resolve a promise nobody is waiting for any more.
			expect(() => h.deliver({ jsonrpc: "2.0", id, result: "late" })).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails in-flight requests when the server exits", async () => {
		const h = harness();
		const pending = h.session.request("x", {});
		h.exit(1);
		await expect(pending).rejects.toThrow(/exited/);
		expect(h.session.isReady).toBe(false);
		expect(h.session.exitCode).toBe(1);
	});

	it("refuses a request once the session is closed", async () => {
		const h = harness();
		h.exit(0);
		await expect(h.session.request("x", {})).rejects.toThrow(/closed/);
	});
});

describe("document sync", () => {
	it("opens with version 1 and increments on each change", () => {
		const h = harness();
		h.session.didOpen("file:///a.ts", "typescript", "const a = 1;");
		h.session.didChange("file:///a.ts", "const a = 2;");
		h.session.didChange("file:///a.ts", "const a = 3;");
		const sent = h.sent() as Array<{ method: string; params: { textDocument: { version: number } } }>;
		expect(sent.map((m) => m.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didChange",
		]);
		expect(sent.map((m) => m.params.textDocument.version)).toEqual([1, 2, 3]);
	});

	it("refuses a change for a document that was never opened", () => {
		const h = harness();
		// Silently sending this would lose the edit: the server either ignores
		// the unknown URI or errors, and neither updates its view.
		expect(h.session.didChange("file:///never.ts", "x")).toBe(false);
		expect(h.sent()).toEqual([]);
	});

	it("does not re-open an already open document", () => {
		const h = harness();
		h.session.didOpen("file:///a.ts", "typescript", "one");
		h.session.didOpen("file:///a.ts", "typescript", "two");
		expect((h.sent() as Array<{ method: string }>).filter((m) => m.method === "textDocument/didOpen")).toHaveLength(1);
	});

	it("tracks open documents and closes them once", () => {
		const h = harness();
		h.session.didOpen("file:///a.ts", "typescript", "one");
		expect(h.session.openDocuments).toEqual(["file:///a.ts"]);
		expect(h.session.didClose("file:///a.ts")).toBe(true);
		expect(h.session.didClose("file:///a.ts")).toBe(false);
		expect(h.session.openDocuments).toEqual([]);
	});
});

describe("shutdown", () => {
	it("sends shutdown then exit, and kills the server", async () => {
		const h = harness();
		const init = h.session.initialize("/repo");
		h.deliver({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
		await init;
		const closing = h.session.shutdown();
		const shutdownId = (h.sent() as Array<{ id?: number; method?: string }>).find((m) => m.method === "shutdown")!.id!;
		h.deliver({ jsonrpc: "2.0", id: shutdownId, result: null });
		await closing;
		const methods = (h.sent() as Array<{ method?: string }>).map((m) => m.method);
		expect(methods.slice(-2)).toEqual(["shutdown", "exit"]);
		expect(h.killed()).toBe(1);
	});

	it("kills a server that ignores shutdown", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const init = h.session.initialize("/repo");
			h.deliver({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
			await init;
			const closing = h.session.shutdown();
			vi.advanceTimersByTime(3_000);
			await closing;
			// Leaving it running because it ignored a polite request would leak
			// a process per session.
			expect(h.killed()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("is a no-op when already closed", async () => {
		const h = harness();
		h.exit(0);
		await expect(h.session.shutdown()).resolves.toBeUndefined();
		expect(h.killed()).toBe(0);
	});
});

describe("framing failures are terminal", () => {
	it("fails in-flight requests when the stream desynchronizes", async () => {
		const h = harness();
		const pending = h.session.request("x", {});
		// Garbage that never produces a header terminator.
		h.deliverRaw(Buffer.alloc(9 * 1024, 0x41));
		await expect(pending).rejects.toThrow(/not LSP|No header terminator/);
	});
});

describe("notifications from the server", () => {
	it("reaches a registered handler and does not reply", () => {
		const h = harness();
		const seen: unknown[] = [];
		h.session.on("textDocument/publishDiagnostics", (params) => {
			seen.push(params);
		});
		h.deliver({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///a.ts", diagnostics: [] } });
		expect(seen).toEqual([{ uri: "file:///a.ts", diagnostics: [] }]);
		// A notification has no id, so nothing may be written back.
		expect(h.sent()).toEqual([]);
	});

describe("diagnostics URI normalization", () => {
	it("finds a push stored under the server's spelling of the same file", async () => {
		// Measured on Windows: the client asks with `file:///D:/vault/x.ts`
		// (`pathToFileURL`) and the server pushes under `file:///d%3A/vault/x.ts`
		// (lower-case drive, percent-encoded colon). Keyed by the raw string, the
		// lookup missed and every diagnostic call answered "nothing has arrived".
		const h = harness();
		const pending = h.session.initialize("/repo");
		const [initialize] = h.sent() as Array<{ id: number }>;
		h.deliver({ jsonrpc: "2.0", id: initialize!.id, result: { capabilities: {} } });
		await pending;
		const serverUri = "file:///d%3A/vault/projects/x.ts";
		const clientUri = "file:///D:/vault/projects/x.ts";
		h.deliver({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri: serverUri, diagnostics: [{ message: "boom" }] },
		});
		expect(h.session.getDiagnostics(clientUri)).toEqual([{ message: "boom" }]);
		// And the other direction, so neither spelling is privileged.
		expect(h.session.getDiagnostics(serverUri)).toEqual([{ message: "boom" }]);
	});

	it("canonicalizes the spellings, and leaves the rest of the path alone", () => {
		// A drive letter is the only place a colon may appear in the first segment,
		// so that is the only decoding this rule does: on POSIX the path IS
		// case-sensitive and lower-casing it here would be a different bug.
		const same = "file:///d:/vault/x.ts";
		expect(normalizeFileUri("file:///D:/vault/x.ts")).toBe(same);
		expect(normalizeFileUri("file:///d%3A/vault/x.ts")).toBe(same);
		expect(normalizeFileUri("file:///D%3a/vault/x.ts")).toBe(same);
		expect(normalizeFileUri("file:///d%3A")).toBe("file:///d:");
		expect(normalizeFileUri("file://localhost/c:/x.ts")).toBe("file:///c:/x.ts");
		expect(normalizeFileUri("file:///Vault/Case/x.ts")).toBe("file:///Vault/Case/x.ts");
		expect(normalizeFileUri("file://Server/Share/x.ts")).toBe("file://server/Share/x.ts");
		expect(normalizeFileUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
	});
});
});
