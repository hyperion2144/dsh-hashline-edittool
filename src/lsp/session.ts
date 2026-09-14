/**
 * One LSP session: the JSON-RPC conversation over a transport, from
 * `initialize` to `shutdown`.
 *
 * The protocol has a handful of traps that all present as "the server hangs",
 * so each is handled explicitly rather than left to the caller:
 *
 * 1. **`initialize` must come first, and `initialized` must follow it.** A
 *    request sent before the handshake is a protocol error, and a server that
 *    never receives `initialized` will sit waiting forever without saying so.
 * 2. **Server-to-client requests must be ANSWERED.** A server asking
 *    `workspace/configuration` and getting silence may block on it — from the
 *    outside that looks like our request timing out, and the real cause is a
 *    message we never replied to. Unanswered requests get a null result; the
 *    declared handler gets first refusal.
 * 3. **`didChange` on a document that was never opened is an error**, so the
 *    session tracks open state and versions itself. A server that receives a
 *    change for an unknown URI either ignores it or errors, and both lose the
 *    edit's effect on subsequent answers.
 * 4. **A timeout must remove its pending entry.** A late response arriving
 *    after we gave up would otherwise resolve a promise nobody is waiting for
 *    (or worse, be matched to a later request if ids ever wrapped).
 *
 * The transport is injected, so the whole conversation is testable against an
 * in-memory duplex pair — no language server, no process, no timing luck.
 *
 * @module dsh-hashline-edittool/lsp/session
 */
import { encodeMessage, MessageReader } from "./framing.js";

/** The byte-level channel to a server. */
export interface LspTransport {
	/** Write bytes to the server's stdin. */
	write(bytes: Buffer): void;
	/** Subscribe to the server's stdout. */
	onData(listener: (chunk: Buffer) => void): void;
	/** Subscribe to process exit. */
	onExit(listener: (code: number | null) => void): void;
	/** Terminate the server (tree-scoped, in the real implementation). */
	kill(): void | Promise<void>;
}

/** A pending outbound request. */
interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** An inbound notification or request from the server. */
export type ServerMessage =
	| { readonly kind: "notification"; readonly method: string; readonly params: unknown }
	| { readonly kind: "request"; readonly method: string; readonly params: unknown; readonly id: number | string };

/** A failure the caller turns into a `backendReason`. */
export class LspSessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LspSessionError";
	}
}

/** Error codes, bracketed as they appear in model-facing messages. */
export const E_LSP_TIMEOUT = "[E_LSP_TIMEOUT]";
export const E_LSP_NOT_READY = "[E_LSP_NOT_READY]";
export const E_LSP_CLOSED = "[E_LSP_CLOSED]";

/**
 * The canonical spelling of a `file://` URI, for keying and looking up state.
 *
 * A URI is not a string equality problem: the client builds one with
 * `pathToFileURL` (`file:///D:/vault/x.ts`) and the server echoes its OWN
 * normalization of the same document (`file:///d%3A/vault/x.ts`) — lower case
 * drive letter, percent-encoded colon. Both name one file, and a map keyed by
 * the raw string therefore MISSES: `publishDiagnostics` was stored under the
 * server's spelling and looked up under the client's, so every diagnostic
 * lookup answered "nothing has arrived yet" while the diagnostics were in the
 * map the whole time.
 *
 * This collapses the two spellings into one: lower-case scheme and host, an
 * optionally-ravelled drive letter in lower case, and that drive colon in its
 * literal form. The rest of the path is left byte-for-byte alone — on POSIX the
 * path IS case-sensitive, and re-encoding it here would be a different bug.
 *
 * @param uri - a URI as either side spelled it.
 * @returns the canonical form; a non-`file:` URI is returned unchanged.
 */
export function normalizeFileUri(uri: string): string {
	const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
	if (match === null) return uri;
	// `localhost` is the same host as no host at all; anything else is a real
	// (UNC) host and keeps its identity, lower-cased because hosts are.
	const host = (match[1] ?? "").toLowerCase();
	const path = match[2] ?? "";
	const canonicalHost = host === "localhost" ? "" : host;
	// A drive colon may arrive percent-encoded, so decode it FIRST; the case rule
	// below then sees the same shape whichever spelling it came from.
	//
	// Both rules are pattern-based because a URI carries no platform: on POSIX a
	// root entry literally named `D:` is legal, and this would fold it together
	// with `d:` — a vanishingly unlikely directory, against a definitely broken
	// lookup on Windows.
	const canonicalPath = path
		.replace(/^\/([a-z])%3a(?=\/|$)/i, (_, drive: string) => `/${drive}:`)
		.replace(/^\/([a-z]):(?=\/|$)/i, (_, drive: string) => `/${drive.toLowerCase()}:`);
	return `file://${canonicalHost}${canonicalPath}`;
}
/** What a session needs to start. */
export interface LspSessionOptions {
	/** Default per-request deadline in ms. */
	readonly requestTimeoutMs?: number;
	/** `clientInfo.name` reported in `initialize`. */
	readonly clientName?: string;
	/** Capabilities we advertise. Kept minimal on purpose. */
	readonly capabilities?: Record<string, unknown>;
}

/** An open document's tracked state. */
interface OpenDocument {
	version: number;
	languageId: string;
}

/** The result of a successful handshake. */
export interface InitializeOutcome {
	readonly capabilities: Record<string, unknown>;
	/** The server's own name/version, for diagnostics. */
	readonly serverInfo?: { name?: string; version?: string };
}

/** A live session. */
export class LspSession {
	#transport: LspTransport;
	#reader = new MessageReader();
	#pending = new Map<number | string, Pending>();
	#nextId = 1;
	#handlers = new Map<string, (params: unknown) => unknown>();
	#open = new Map<string, OpenDocument>();
	#state: "fresh" | "initializing" | "ready" | "closed" = "fresh";
	#serverCapabilities: Record<string, unknown> = {};
	#serverInfo: { name?: string; version?: string } | undefined;
	#timeoutMs: number;
	#options: LspSessionOptions;
	#exitCode: number | null | undefined;
	/** The last push per document URI; absent means none has arrived. */
	#diagnostics = new Map<string, readonly unknown[]>();
	/** Counts pushes, so a waiter can tell a new one from silence. */
	#diagnosticsRevision = 0;

	constructor(transport: LspTransport, options: LspSessionOptions = {}) {
		this.#transport = transport;
		this.#timeoutMs = options.requestTimeoutMs ?? 10_000;
		this.#options = options;
		transport.onData((chunk) => this.#onData(chunk));
		transport.onExit((code) => this.#onExit(code));
		// Diagnostics arrive UNPROMPTED: `textDocument/publishDiagnostics` is a
		// server-to-client notification, sent whether or not the client advertised
		// anything. Until this handler existed they were parsed and dropped, which
		// is why the capability comment above says nothing consumes them yet.
		this.on("textDocument/publishDiagnostics", (params) => {
			const payload = params as { uri?: unknown; diagnostics?: unknown } | null;
			if (typeof payload?.uri !== "string") return undefined;
			// Keyed by the CANONICAL form: the server echoes a URI it normalized its
			// own way (`file:///d%3A/…` for a path the client spelled `file:///D:/…`),
			// and a lookup by either spelling must land on the same entry.
			this.#diagnostics.set(normalizeFileUri(payload.uri), Array.isArray(payload.diagnostics) ? payload.diagnostics : []);
			// Bumped on every push, so a caller can tell "nothing arrived yet" from
			// "a server said there is nothing" — an empty list and silence are
			// different answers and a reader has to be able to tell them apart.
			this.#diagnosticsRevision += 1;
			return undefined;
		});
	}

	/**
	 * The last diagnostics a server PUSHED for one document.
	 *
	 * `undefined` means none has arrived yet, which is NOT the same as an empty
	 * array — a server that has looked and found nothing sends an empty array, and
	 * conflating the two would report "clean" for "unknown".
	 *
	 * @param uri - the document's `file://` URI.
	 * @returns the diagnostics, or undefined when none has been pushed.
	 */
	getDiagnostics(uri: string): readonly unknown[] | undefined {
		return this.#diagnostics.get(normalizeFileUri(uri));
	}

	/** How many pushes have arrived; waiters compare it against a snapshot. */
	get diagnosticsRevision(): number {
		return this.#diagnosticsRevision;
	}

	/** The server's advertised capabilities, after a successful handshake. */
	get serverCapabilities(): Record<string, unknown> {
		return this.#serverCapabilities;
	}

	/** The server's name/version, when it reported one. */
	get serverInfo(): { name?: string; version?: string } | undefined {
		return this.#serverInfo;
	}

	/** Whether the handshake completed and the session is still open. */
	get isReady(): boolean {
		return this.#state === "ready";
	}

	/** Register a handler for an inbound notification or request. */
	on(method: string, handler: (params: unknown) => unknown): void {
		this.#handlers.set(method, handler);
	}

	/** Feed bytes from the server. Exposed for transports that cannot push. */
	receive(chunk: Buffer): void {
		this.#onData(chunk);
	}

	#onData(chunk: Buffer): void {
		let messages: unknown[];
		try {
			messages = this.#reader.push(chunk);
		} catch (error) {
			// A framing failure is terminal for this session: the stream is
			// desynchronized and every subsequent message would be garbage.
			this.#failAll(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		for (const raw of messages) this.#dispatch(raw);
	}

	#dispatch(raw: unknown): void {
		if (typeof raw !== "object" || raw === null) return;
		const message = raw as Record<string, unknown>;
		const id = message.id;
		const method = message.method;

		// A response: `id` present, `method` absent.
		if (method === undefined && id !== undefined && (id as number | string) !== null) {
			const pending = this.#pending.get(id as number | string);
			if (pending === undefined) return;
			this.#pending.delete(id as number | string);
			clearTimeout(pending.timer);
			if (message.error !== undefined) {
				pending.reject(new LspSessionError("E_LSP_REQUEST_FAILED", JSON.stringify(message.error)));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (typeof method !== "string") return;
		const isRequest = id !== undefined && id !== null;

		if (!isRequest) {
			this.#handlers.get(method)?.(message.params);
			return;
		}

		// A server-to-client request. Silence can deadlock the server, so an
		// unhandled one is answered with `null` rather than dropped.
		let result: unknown = null;
		const handler = this.#handlers.get(method);
		if (handler !== undefined) {
			try {
				result = handler(message.params) ?? null;
			} catch {
				result = null;
			}
		}
		this.#transport.write(encodeMessage({ jsonrpc: "2.0", id, result }));
	}

	#onExit(code: number | null): void {
		this.#exitCode = code;
		this.#state = "closed";
		this.#failAll(new LspSessionError(E_LSP_CLOSED, `The language server exited (code ${code ?? "signal"}).`));
	}

	#failAll(error: Error): void {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	/**
	 * Perform the handshake.
	 *
	 * @param workspaceRoot - the root URI to advertise.
	 * @returns the server's capabilities.
	 * @throws {LspSessionError} on a timeout, an exit, or a bad state.
	 */
	async initialize(workspaceRoot: string): Promise<InitializeOutcome> {
		if (this.#state === "closed") throw new LspSessionError(E_LSP_CLOSED, "The session is closed.");
		if (this.#state !== "fresh") {
			throw new LspSessionError(E_LSP_NOT_READY, `initialize() was already called (state: ${this.#state}).`);
		}
		this.#state = "initializing";
		const rootUri = workspaceRoot.startsWith("file:") ? workspaceRoot : `file://${workspaceRoot}`;
		const result = (await this.#request("initialize", {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ uri: rootUri, name: "workspace" }],
			clientInfo: { name: this.#options.clientName ?? "dsh-hashline-edittool" },
			capabilities: this.#options.capabilities ?? {
				textDocument: {
					// PUSH diagnostics are advertised, PULL diagnostics are not — and the
					// two are different capabilities that share a word:
					//
					//   `textDocument/publishDiagnostics` is a NOTIFICATION the SERVER
					//   sends. Declaring `{}` is what ALLOWS it, and the `diagnostics`
					//   operation is built on exactly that push — without this line the
					//   server stayed silent and every call spent its whole budget to
					//   report "no answer yet" for a file full of errors.
					//
					//   `textDocument/diagnostic` is a REQUEST the CLIENT sends (pull),
					//   and THAT one stays unadvertised: nothing consumes it, and
					//   advertising a capability we ignore is how a server ends up
					//   waiting for a pull that never comes.
					publishDiagnostics: {},
					documentSymbol: { hierarchicalDocumentSymbolSupport: true },
					definition: {},
					references: {},
				},
				workspace: { workspaceFolders: true },
			},
		})) as { capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } } | null;

		// `initialized` is a NOTIFICATION and must follow the response, or the
		// server sits in its own initialization waiting for it.
		this.notify("initialized", {});
		this.#serverCapabilities = result?.capabilities ?? {};
		this.#serverInfo = result?.serverInfo;
		this.#state = "ready";
		return { capabilities: this.#serverCapabilities, ...(this.#serverInfo === undefined ? {} : { serverInfo: this.#serverInfo }) };
	}

	/** Send a request and await its result. */
	async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.#state === "closed") throw new LspSessionError(E_LSP_CLOSED, "The session is closed.");
		return this.#request(method, params, timeoutMs);
	}

	#request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		const id = this.#nextId++;
		const deadline = timeoutMs ?? this.#timeoutMs;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				// Remove the entry: a late response must not resolve a promise
				// nobody is waiting for any more.
				this.#pending.delete(id);
				reject(new LspSessionError(E_LSP_TIMEOUT, `${method} did not answer within ${deadline} ms.`));
			}, deadline);
			timer.unref?.();
			this.#pending.set(id, { resolve, reject, timer });
			this.#transport.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/** Send a notification. */
	notify(method: string, params: unknown): void {
		if (this.#state === "closed") return;
		this.#transport.write(encodeMessage({ jsonrpc: "2.0", method, params }));
	}

	/** Advertise a document the server has not seen. */
	didOpen(uri: string, languageId: string, text: string): void {
		if (this.#open.has(uri)) return; // already open; a change is the right call
		this.#open.set(uri, { version: 1, languageId });
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text },
		});
	}

	/**
	 * Tell the server a document's content changed.
	 *
	 * Full-text sync: the whole document is sent, so the server cannot end up
	 * with a different view of the file than we have. Returns false when the
	 * document is not open — the caller must `didOpen` first, and silently
	 * sending a change for an unknown URI loses the edit.
	 */
	didChange(uri: string, text: string): boolean {
		const doc = this.#open.get(uri);
		if (doc === undefined) return false;
		doc.version += 1;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: doc.version },
			contentChanges: [{ text }],
		});
		return true;
	}

	/** Tell the server a document is no longer of interest. */
	didClose(uri: string): boolean {
		if (!this.#open.delete(uri)) return false;
		this.notify("textDocument/didClose", { textDocument: { uri } });
		return true;
	}

	/** The URIs this session has open. */
	get openDocuments(): string[] {
		return [...this.#open.keys()];
	}

	/** The exit code, once the server has gone. */
	get exitCode(): number | null | undefined {
		return this.#exitCode;
	}

	/**
	 * Graceful shutdown: `shutdown` then `exit`.
	 *
	 * A server that does not answer `shutdown` is still killed — leaving it
	 * running because it ignored a polite request would leak a process per
	 * session.
	 */
	async shutdown(): Promise<void> {
		if (this.#state === "closed") return;
		try {
			if (this.#state === "ready") await this.#request("shutdown", null, 2_000);
		} catch {
			// A server that ignores `shutdown` is terminated below regardless.
		}
		try {
			this.notify("exit", null);
		} catch {
			// The pipe may already be gone.
		}
		this.#state = "closed";
		await this.#transport.kill();
	}
}
