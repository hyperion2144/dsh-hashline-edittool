/**
 * Owns one language server per language, and answers the question the read
 * path actually asks: *should this call use LSP, or the parser?*
 *
 * The answer is deliberately **synchronous and independent of whether a server
 * is up**, because the read path must not block on one. Warming is what makes
 * that work: the first call for a language starts the server **in the
 * background** and is served by tree-sitter; by the second call the server is
 * usually ready and answers instead. Starting every configured server at
 * session start would spin up servers in sessions that never use AST (a
 * TypeScript server indexing a large repo can consume gigabytes); never warming
 * would make the first call permanently bad.
 *
 * Every refusal names its reason, because the reasons have different remedies:
 * a missing server means install one, a timeout means retry, and a too-large
 * file means the heuristic is genuinely the only option.
 *
 * @module dsh-hashline-edittool/lsp/manager
 */
import { LspSession, type LspTransport } from "./session.js";
import { canInstallServer, serverEntryFor } from "./install-server.js";
import {
	discoverServers,
	serverArgv,
	serverForLanguage,
	type DiscoveredServer,
	type DiscoveryOptions,
	type ServerOrigin,
} from "./discovery.js";

/** Why the heuristic backend answered instead of LSP. */
export type BackendReason =
	| "lsp-unavailable"
	| "lsp-timeout"
	| "file-too-large-for-lsp"
	| "server-missing";

/** What the caller should use for one operation. */
export interface BackendDecision {
	readonly backend: "lsp" | "heuristic";
	/** Present only when `backend` is `heuristic`. */
	readonly reason?: BackendReason;
	/** The live session, when there is one. */
	readonly session?: LspSession;
}

/**
 * One language's language-server state, as a card would show it.
 *
 * `ready` and `reason` are deliberately independent of `server`: a server can
 * be discovered but not started yet, started but still handshaking, or failed
 * after starting. Collapsing those into one field would force the reader to
 * guess which of them "not ready" meant.
 */
export interface LspLanguageStatus {
	readonly languageId: string;
	/** What discovery found, when it found something. */
	readonly server?: {
		readonly displayName: string;
		readonly command: string;
		readonly executable: string;
		/** `project` / `path` / `configured` — where it came from. */
		readonly origin: ServerOrigin;
	};
	/** Whether a session is live and usable right now. */
	readonly ready: boolean;
	/** Why not, when it is not ready. */
	readonly reason?: BackendReason;
	readonly message?: string;
	/**
	 * Whether the plugin can install this one itself.
	 *
	 * Present so the card can offer the action EXACTLY where it will work. A
	 * server that comes from `go install` or rustup is still found and still
	 * reported, and the card names the toolchain that owns it rather than showing
	 * a button that fails.
	 */
	readonly canInstall?: boolean;
}

/** How the manager talks to the outside world; all injected for tests. */
export interface LspManagerOptions extends DiscoveryOptions {
	/** Spawn a discovered server into a transport. */
	readonly spawn: (server: DiscoveredServer, cwd: string) => { readonly transport: ServerTransportLike };
	/** Deadline for the handshake alone. */
	readonly initializeTimeoutMs?: number;
	/** A file above this uses the heuristic backend (the server's own limit). */
	readonly maxDocumentBytes?: number;
	/** Called when a server fails to start, for logs. */
	readonly onFailure?: (languageId: string, message: string) => void;
}

/** The transport shape the manager needs (the session's, plus diagnostics). */
export interface ServerTransportLike extends LspTransport {
	readonly pid?: number;
	stderrTail?(): string;
}

/** One language's slot. */
type Slot =
	| { readonly state: "starting" }
	| { readonly state: "ready"; readonly session: LspSession; readonly transport: ServerTransportLike }
	| { readonly state: "failed"; readonly reason: BackendReason; readonly message: string };

/** A server this manager launched, for teardown. */
interface Launched {
	readonly transport: ServerTransportLike;
	readonly session: LspSession;
}

/** Default document ceiling, matching the platform LSP provider's. */
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** Owns the sessions. */
export class LspManager {
	#options: LspManagerOptions;
	#slots = new Map<string, Slot>();
	#launched: Launched[] = [];
	#disposed = false;
	#discovered: DiscoveredServer[] | undefined;
	#discovering: Promise<DiscoveredServer[]> | undefined;

	constructor(options: LspManagerOptions) {
		this.#options = options;
	}

	/** The per-call deadline for requests. */
	get maxDocumentBytes(): number {
		return this.#options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
	}

	/** Discover servers once per manager; concurrent callers share the search. */
	#servers(): Promise<DiscoveredServer[]> {
		if (this.#discovered !== undefined) return Promise.resolve(this.#discovered);
		this.#discovering ??= discoverServers({
			...(this.#options.projectRoot === undefined ? {} : { projectRoot: this.#options.projectRoot }),
			...(this.#options.pathDirs === undefined ? {} : { pathDirs: this.#options.pathDirs }),
			...(this.#options.configured === undefined ? {} : { configured: this.#options.configured }),
			...(this.#options.isExecutable === undefined ? {} : { isExecutable: this.#options.isExecutable }),
			...(this.#options.executableSuffixes === undefined ? {} : { executableSuffixes: this.#options.executableSuffixes }),
		}).then((servers) => {
			this.#discovered = servers;
			this.#discovering = undefined;
			return servers;
		});
		return this.#discovering;
	}

	/**
	 * Start warming a language's server, if it is not already starting or up.
	 *
	 * @param languageId - registry id.
	 * @param workspaceRoot - the root to advertise.
	 */
	warm(languageId: string, workspaceRoot: string): void {
		if (this.#disposed) return;
		if (this.#slots.has(languageId)) return;
		this.#slots.set(languageId, { state: "starting" });
		void this.#start(languageId, workspaceRoot);
	}

	async #start(languageId: string, workspaceRoot: string): Promise<void> {
		try {
			const servers = await this.#servers();
			const server = serverForLanguage(servers, languageId);
			if (server === undefined) {
				this.#slots.set(languageId, {
					state: "failed",
					reason: "server-missing",
					message: `No language server for ${languageId} was found on PATH or in the project's bin directory.`,
				});
				return;
			}
			const { transport } = this.#options.spawn(server, workspaceRoot);
			const session = new LspSession(transport, {
				requestTimeoutMs: this.#options.initializeTimeoutMs ?? 10_000,
			});
			this.#launched.push({ transport, session });
			await session.initialize(workspaceRoot);
			if (this.#disposed) {
				// Raced with disposal: do not leave an orphan behind.
				await session.shutdown();
				return;
			}
			this.#slots.set(languageId, { state: "ready", session, transport });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#slots.set(languageId, { state: "failed", reason: reasonFor(error), message });
			this.#options.onFailure?.(languageId, message);
		}
	}

	/**
	 * Decide the backend for one operation.
	 *
	 * Never starts a server itself beyond kicking off a warm — the caller gets
	 * an answer now, and the answer improves on the next call.
	 *
	 * @param languageId - registry id.
	 * @param workspaceRoot - the root to advertise when warming.
	 * @param byteLength - the document's size, for the per-backend limit.
	 */
	decide(languageId: string, workspaceRoot: string, byteLength: number): BackendDecision {
		if (this.#disposed) return { backend: "heuristic", reason: "lsp-unavailable" };
		if (byteLength > this.maxDocumentBytes) {
			// The server's own limit, not ours: sending it anyway would have the
			// server refuse or truncate, and both are worse than saying so.
			return { backend: "heuristic", reason: "file-too-large-for-lsp" };
		}
		const slot = this.#slots.get(languageId);
		if (slot === undefined || slot.state === "failed") {
			this.warm(languageId, workspaceRoot);
			return {
				backend: "heuristic",
				reason: slot?.state === "failed" ? slot.reason : "lsp-unavailable",
			};
		}
		if (slot.state === "starting") {
			return { backend: "heuristic", reason: "lsp-unavailable" };
		}
		return { backend: "lsp", session: slot.session };
	}

	/**
	 * A callback that syncs one document on a READY session, or `undefined`
	 * when there is nothing to sync.
	 *
	 * Returned as a closure rather than exposing the session so the caller
	 * cannot accidentally warm one: the readiness check has already happened by
	 * the time this exists, and a write must never start a server.
	 *
	 * @param languageId - registry id.
	 * @param uri - the document's `file://` URI.
	 */
	openDocumentFor(languageId: string, uri: string): ((text: string) => void) | undefined {
		const slot = this.#slots.get(languageId);
		if (slot?.state !== "ready") return undefined;
		const session = slot.session;
		return (text: string) => {
			// Open-or-change: a document the server has never seen must be opened
			// before it can be changed.
			if (!session.openDocuments.includes(uri)) {
				session.didOpen(uri, languageId, text);
				return;
			}
			session.didChange(uri, text);
		};
	}

	/**
	 * The ready session for a language, or `undefined` — WITHOUT warming.
	 *
	 * Synchronous on purpose: the status/card paths ask "is it up right now" and
	 * must not start a server by asking. Use `waitForSession` when the caller's
	 * job is the protocol itself.
	 */
	readySessionFor(languageId: string): LspSession | undefined {
		const slot = this.#slots.get(languageId);
		return slot?.state === "ready" ? slot.session : undefined;
	}
	/** How long `waitForSession` holds a caller while the server boots. */
	static readonly START_TIMEOUT_MS = 15_000;

	/**
	 * The live session, WAITING for a cold server to finish booting.
	 *
	 * `sessionFor` is fire-and-forget by design — `edit` and `read` must fall back
	 * to the heuristic the instant a server is not up. But the `lsp` TOOL is the
	 * protocol-first path, and answering it with "still starting" forced the caller
	 * to retry blind until luck landed. Waiting is what the caller meant.
	 *
	 * @param languageId - the registry id to warm and wait on.
	 * @param workspaceRoot - passed to the warm-up.
	 * @param timeoutMs - how long to hold before giving up (default 15s).
	 * @returns the session, or `undefined` when it failed or timed out.
	 */
	async waitForSession(
		languageId: string,
		workspaceRoot: string,
		timeoutMs: number = LspManager.START_TIMEOUT_MS,
	): Promise<LspSession | undefined> {
		const slot = this.#slots.get(languageId);
		if (slot?.state === "ready") return slot.session;
		if (this.#disposed) return undefined;
		this.warm(languageId, workspaceRoot);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const current = this.#slots.get(languageId);
			if (current?.state === "ready") return current.session;
			if (current?.state === "failed") return undefined;
		}
		return undefined;
	}

	/** The live session for a language, warming it if this is the first ask. */
	async sessionFor(languageId: string, workspaceRoot: string): Promise<LspSession | undefined> {
		const slot = this.#slots.get(languageId);
		if (slot?.state === "ready") return slot.session;
		this.warm(languageId, workspaceRoot);
		return undefined;
	}


	/** Why a language has no session, for diagnostics and the settings card. */
	unavailability(languageId: string): { reason: BackendReason; message: string } | undefined {
		const slot = this.#slots.get(languageId);
		if (slot === undefined) return { reason: "lsp-unavailable", message: "No server has been started for this language yet." };
		if (slot.state === "failed") return { reason: slot.reason, message: slot.message };
		if (slot.state === "starting") return { reason: "lsp-unavailable", message: "The server is still starting." };
		return undefined;
	}

	/**
	 * Report every requested language's server state, for a card to show.
	 *
	 * The composition matters: `unavailability` answers "why is there no SESSION",
	 * and it answers `lsp-unavailable` both when no server was found and when one
	 * simply has not been started yet. Those are different problems to a reader —
	 * one needs an install, the other needs patience — so the absence of a
	 * discovered server is reported as `server-missing` here, using the reason
	 * that already exists for it rather than inventing a second vocabulary.
	 *
	 * @param languageIds - the languages to report on, in order.
	 * @returns one status per requested language; never throws.
	 */
	/**
	 * Forget what discovery found, so the next question is asked again.
	 *
	 * Discovery is memoised for the manager's lifetime, which is right for a
	 * machine whose PATH does not change — and wrong the moment this plugin
	 * INSTALLS a server into its own prefix, which is a filesystem change nothing
	 * else can see. Without this the card kept reporting 未找到 after a successful
	 * install: the client re-read the list, and the server answered from a cache
	 * taken before the install existed.
	 *
	 * The FAILED SLOTS go with it, and that half is easy to miss. A language whose
	 * server was missing is remembered as `failed`, and `warm` refuses to try a
	 * language that already has a slot — so re-discovering alone would find the new
	 * server and still never start it.
	 *
	 * A live session is left alone: re-discovery is about what exists on disk, not
	 * about tearing down something that is already talking.
	 *
	 * @returns the languages whose failed state was cleared.
	 */
	rescan(): string[] {
		this.#discovered = undefined;
		this.#discovering = undefined;
		const cleared: string[] = [];
		for (const [languageId, slot] of [...this.#slots]) {
			if (slot.state === "failed") {
				this.#slots.delete(languageId);
				cleared.push(languageId);
			}
		}
		return cleared;
	}

	async status(languageIds: readonly string[]): Promise<LspLanguageStatus[]> {
		const servers = await this.#servers();
		return languageIds.map((languageId) => {
			const server = servers.find((candidate) => candidate.languages.includes(languageId));
			const ready = this.#slots.get(languageId)?.state === "ready";
			const found =
				server === undefined
					? undefined
					: {
							displayName: server.displayName,
							command: server.command,
							executable: server.executable,
							origin: server.origin,
						};
			if (server === undefined) {
				// SHORT, because a row is read at a glance and the action is a control.
				//
				// The first version explained itself in a full sentence per row, which
				// pushed the install button off the right edge of every line — the
				// explanation crowded out the one thing the reader could act on. The
				// button says what can be done; the sentence does not need to.
				//
				// Both wordings stay truthful about WHICH situation the reader is in:
				// `canInstall` decides between "we will do it" and "this one is yours".
				//
				// The refusal now says WHICH of three situations the reader is in, because
				// they have three different next moves and the old single sentence covered
				// none of them: no catalog entry at all (name a command yourself), an
				// entry this PLATFORM cannot install (the same), or an entry that simply
				// has no installer (install the named executable).
				const installable = canInstallServer(languageId);
				// The entry is needed for the message's second half, and the message is
				// the only place this reason is ever read.
				const entryFor = serverEntryFor(languageId);
				return {
					languageId,
					ready,
					reason: "server-missing" as BackendReason,
					canInstall: installable,
					message: installable
						? "可一键安装"
						: entryFor === undefined
							? // NO CATALOG ENTRY AT ALL. "Install it into PATH" would imply this
								// plugin knows WHAT to install, and for `julia` it does not — its
								// server is launched with a project path in its argv.
								"插件没有它的内置命令，可用下方「指定服务器」直接填"
							: `需自行安装 ${entryFor.command}（本机无内置安装命令）`,
				};
			}
			const unavailable = this.unavailability(languageId);
			return {
				languageId,
				ready,
				...(found === undefined ? {} : { server: found }),
				...(unavailable === undefined ? {} : { reason: unavailable.reason, message: unavailable.message }),
				canInstall: canInstallServer(languageId),
			};
		});
	}

	/** The languages with a live session. */
	get readyLanguages(): string[] {
		return [...this.#slots.entries()].filter(([, slot]) => slot.state === "ready").map(([id]) => id);
	}

	/** Shut every server down and release the processes. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		const launched = this.#launched;
		this.#launched = [];
		this.#slots.clear();
		await Promise.all(
			launched.map(async ({ session, transport }) => {
				try {
					await session.shutdown();
				} catch {
					// A server that will not shut down is still killed below.
					try {
						await transport.kill();
					} catch {
						/* already gone */
					}
				}
			}),
		);
	}
}

/** Classify a startup failure into the reason the caller reports. */
function reasonFor(error: unknown): BackendReason {
	const message = error instanceof Error ? error.message : String(error);
	if (/did not answer within/.test(message)) return "lsp-timeout";
	return "lsp-unavailable";
}

/** The argv a discovered server is launched with. */
export { serverArgv };

let singleton: LspManager | undefined;

/** The process-wide manager, created on first use. */
export function getLspManager(): LspManager | undefined {
	return singleton;
}

/** Install (or clear) the process-wide manager. */
export function setLspManager(manager: LspManager | undefined): void {
	singleton = manager;
}
