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
 * The other half of that bargain is that a server nobody is using must not stay
 * resident for the rest of the session: warming is cheap to undo, but a
 * TypeScript server holding a large repository's index is not. So every session
 * remembers when it was last handed out, and an idle timer shuts the quiet
 * ones down (#306).
 *
 * Every refusal names its reason, because the reasons have different remedies:
 * a missing server means install one, a timeout means retry, and a too-large
 * file means the heuristic is genuinely the only option.
 *
 * A failed start is not a verdict either: the slot retries on its own once
 * its backoff window has passed, and `forceWarm` restarts one on demand
 * (#318).
 *
 * @module dsh-hashline-edittool/lsp/manager
 */
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "../infra/constants.js";
import { LspSession, type LspTransport } from "./session.js";
import { canInstallFormatServer, canInstallServer, serverEntryFor } from "./install-server.js";
import {
	discoverServers,
	serverArgv,
	serverForLanguage,
	type DiscoveredServer,
	type DiscoveryOptions,
	type ServerOrigin,
} from "./discovery.js";
import {
	LSP_CAN_INSTALL,
	LSP_SERVER_NOT_STARTED,
	LSP_SERVER_STARTING,
	LSP_NO_BUILTIN_COMMAND,
	lspSelfInstall,
	type LocalizedText,
} from "../render/wire-text.js";

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
	/**
	 * Why not, in the reader's own words.
	 *
	 * A KEY + params when the host COMPOSED the sentence (ADR-0024): the host
	 * cannot read the reader's language, so it names the wording and hands over
	 * the facts. A plain string when the host is reporting a TECHNICAL FACT — the
	 * stderr tail, the timeout sentence — which reads the same in every language.
	 */
	readonly message?: string | LocalizedText;
	/**
	 * Whether the plugin can install this one itself.
	 *
	 * Present so the card can offer the action EXACTLY where it will work. A
	 * server that comes from `go install` or rustup is still found and still
	 * reported, and the card names the toolchain that owns it rather than showing
	 * a button that fails.
	 */
	readonly canInstall?: boolean;
	/**
	 * The FORMAT slot's server, as discovery found it (ADR-0038) — present even
	 * when no secondary is named: the card's format-server line reads this to
	 * show what a named secondary would resolve to, and the format install
	 * offer rides on it.
	 */
	readonly formatServer?: {
		readonly displayName: string;
		readonly command: string;
		readonly executable: string;
		readonly origin: ServerOrigin;
	};
	/** Whether this language's format server can be installed HERE. */
	readonly formatCanInstall?: boolean;
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
	/**
	 * How long a session may sit unused before it is reclaimed (#306).
	 *
	 * A FUNCTION, read at use time: the value comes from the settings surface,
	 * and a change must take effect without a restart. 0 means "never reclaim".
	 */
	readonly idleTimeoutMs?: () => number;
	/**
	 * The base backoff before a failed start is retried (#318). Each further
	 * failure doubles the wait, capped at 60s. Tests shrink it; production
	 * uses the default.
	 */
	retryBaseDelayMs?: number;
	/**
	 * The user's named FORMATTING secondary servers (ADR-0038), in the same
	 * `{ command, languages }` shape discovery wants. A FUNCTION, read at each
	 * format-slot start: a settings change reaches the next start without a
	 * restart.
	 */
	readonly formatConfigured?: () => readonly {
		readonly command: string;
		readonly languages: readonly string[];
	}[];
}

/** The transport shape the manager needs (the session's, plus diagnostics). */
export interface ServerTransportLike extends LspTransport {
	readonly pid?: number;
	stderrTail?(): string;
}

/** One language's slot. */
type Slot =
	| { readonly state: "starting" }
	| {
			readonly state: "ready";
			readonly session: LspSession;
			readonly transport: ServerTransportLike;
			/** When the session was last handed out — the idle clock's zero. */
			lastUsedAt: number;
			/** The armed idle shutdown, when there is one. */
			idleTimer?: ReturnType<typeof setTimeout>;
	  }
	| {
			readonly state: "failed";
			readonly reason: BackendReason;
			readonly message: string;
			/** When this failure was recorded — the retry backoff's zero (#318). */
			attemptedAt: number;
	  };

/** A server this manager launched, for teardown. */
interface Launched {
	readonly transport: ServerTransportLike;
	readonly session: LspSession;
}

/**
 * Which job a slot serves (ADR-0038). Every language has at most one PRIMARY
 * slot — diagnostics, completion, navigation, the `lsp.servers.<id>` world —
 * and a FORMAT slot exists only when `format.servers.<id>` names a secondary.
 * Only formatting resolves the format role; every other caller keeps the
 * primary slot whether or not a secondary exists.
 */
export type LspSlotRole = "primary" | "format";

/** The slot table's key for one language+role: primary keys stay bare ids. */
const FORMAT_KEY_PREFIX = "format:";
function slotKey(languageId: string, role: LspSlotRole): string {
	return role === "primary" ? languageId : `${FORMAT_KEY_PREFIX}${languageId}`;
}

/** Default document ceiling, matching the platform LSP provider's. */
const DEFAULT_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
/**
 * The backoff before a FAILED start is retried (#318): the first retry waits
 * this long, and each further failure doubles the wait. Long enough that a
 * cold start recovers on its own between two calls, short enough that a
 * transient crash is noticed within a session.
 */
const RETRY_BASE_DELAY_MS = 5_000;
/** The backoff ceiling: no failed start waits longer than this to retry. */
const RETRY_MAX_DELAY_MS = 60_000;
/**
 * How often an idle session re-checks the setting while reaping is off.
 *
 * A probe rather than a decision: turning reaping back on must be noticed even
 * for a session nobody touches again — and that is exactly the session the
 * reaper is for.
 */
const IDLE_PROBE_MS = 60_000;

/** Owns the sessions. */
export class LspManager {
	#options: LspManagerOptions;
	#slots = new Map<string, Slot>();
	#launched: Launched[] = [];
	#disposed = false;
	/** Discovery results per role — the format role resolves its OWN named list. */
	#discovered = new Map<LspSlotRole, DiscoveredServer[]>();
	#discovering = new Map<LspSlotRole, Promise<DiscoveredServer[]>>();
	/** In-flight idle reclamations, so `dispose` can wait for them. */
	#reaping = new Set<Promise<void>>();
	/** Failed starts per language — the retry backoff's attempt count (#318). */
	#failures = new Map<string, number>();

	constructor(options: LspManagerOptions) {
		this.#options = options;
	}

	/** The per-call deadline for requests. */
	get maxDocumentBytes(): number {
		return this.#options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
	}

	/**
	 * Discover servers for one role; concurrent callers share the search.
	 *
	 * The PRIMARY role keeps the constructor-captured `configured` list, and
	 * discovery is memoised for the manager's lifetime as before. The FORMAT
	 * role (ADR-0038) resolves the user's named SECONDARY servers instead —
	 * read at call time, so a settings change reaches the next format start
	 * without a restart — and keeps its own cache.
	 */
	#servers(role: LspSlotRole): Promise<DiscoveredServer[]> {
		const cached = this.#discovered.get(role);
		if (cached !== undefined) return Promise.resolve(cached);
		const pending = this.#discovering.get(role);
		if (pending !== undefined) return pending;
		const configured =
			role === "format"
				? (this.#options.formatConfigured?.() ?? [])
				: this.#options.configured;
		const run = discoverServers({
			...(this.#options.projectRoot === undefined ? {} : { projectRoot: this.#options.projectRoot }),
			...(this.#options.pathDirs === undefined ? {} : { pathDirs: this.#options.pathDirs }),
			...(configured === undefined ? {} : { configured }),
			...(this.#options.isExecutable === undefined ? {} : { isExecutable: this.#options.isExecutable }),
			...(this.#options.executableSuffixes === undefined ? {} : { executableSuffixes: this.#options.executableSuffixes }),
			// The format role's catalog scan must SEE the formatter-only entries
			// (ADR-0038); the primary scan must not — a formatter can never be a
			// language's primary server.
			...(role === "format" ? { includeFormatterOnly: true } : {}),
		}).then((servers) => {
			this.#discovered.set(role, servers);
			this.#discovering.delete(role);
			return servers;
		});
		this.#discovering.set(role, run);
		return run;
	}

	// ── idle reclamation (#306) ───────────────────────────────────────────────

	/**
	 * The idle window, as the settings surface currently says it.
	 *
	 * Read at USE TIME, never captured: the value comes from a volatile
	 * setting, and a change must take effect without a restart. 0 means
	 * "never reclaim".
	 */
	#idleTimeout(): number {
		let raw: number;
		try {
			raw = this.#options.idleTimeoutMs?.() ?? DEFAULT_LSP_IDLE_TIMEOUT_MS;
		} catch {
			// A settings surface that throws must not break the tool call that
			// happened to read the window.
			raw = DEFAULT_LSP_IDLE_TIMEOUT_MS;
		}
		return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LSP_IDLE_TIMEOUT_MS;
	}

	/**
	 * Mark a session as used, and (re-)arm its idle shutdown.
	 *
	 * Handing a session out IS a use — and so is keeping a server in step with
	 * our writes. The timestamp is the idle clock's zero; the timer is only a
	 * wake-up, because the window may change while it runs.
	 */
	#touchIdle(key: string): void {
		const slot = this.#slots.get(key);
		if (slot?.state !== "ready") return;
		slot.lastUsedAt = Date.now();
		const window = this.#idleTimeout();
		this.#armIdle(key, window > 0 ? window : IDLE_PROBE_MS);
	}

	/**
	 * Arm the idle shutdown for one language's session.
	 *
	 * The timer is unref'd: a language server that is being reclaimed must
	 * never be the reason the process stays alive.
	 */
	#armIdle(key: string, delayMs: number): void {
		const slot = this.#slots.get(key);
		if (slot?.state !== "ready" || this.#disposed) return;
		if (slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
		slot.idleTimer = undefined;
		const timer = setTimeout(() => {
			slot.idleTimer = undefined;
			void this.#reapIdle(key);
		}, delayMs);
		timer.unref?.();
		slot.idleTimer = timer;
	}

	/**
	 * Reclaim one language's session, if it really is idle.
	 *
	 * The SLOT goes first and the PROCESS second: a caller that asks for the
	 * language while the old server is still shutting down must be told "cold"
	 * (and warm a fresh one), not handed a session that is about to die.
	 */
	async #reapIdle(key: string): Promise<void> {
		if (this.#disposed) return;
		const slot = this.#slots.get(key);
		if (slot?.state !== "ready") return;
		const window = this.#idleTimeout();
		if (window <= 0) {
			// Reclaim is off. Keep a probe armed so turning it back on is noticed
			// even for a session nobody touches again.
			this.#armIdle(key, IDLE_PROBE_MS);
			return;
		}
		const elapsed = Date.now() - slot.lastUsedAt;
		if (elapsed < window) {
			// The window grew while the timer ran: wait out the rest of it.
			this.#armIdle(key, window - elapsed);
			return;
		}
		if (slot.session.hasPendingRequests) {
			// A server that is mid-answer is WORKING, not idle: killing it now
			// would break a request that is already in flight.
			this.#armIdle(key, window);
			return;
		}
		this.#slots.delete(key);
		this.#forget(slot.session);
		const task = this.#terminate(slot.session, slot.transport);
		this.#reaping.add(task);
		// `then` with BOTH handlers, not `finally`: a derived promise that
		// rejects is an unhandled rejection, and a failed termination must
		// never take the session down with it.
		void task.then(
			() => {
				this.#reaping.delete(task);
			},
			() => {
				this.#reaping.delete(task);
			},
		);
	}

	/** Stop a session and release its process. */
	async #terminate(session: LspSession, transport: ServerTransportLike): Promise<void> {
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
	}

	/** Drop a session from the teardown list: it is being stopped on purpose. */
	#forget(session: LspSession): void {
		const index = this.#launched.findIndex((entry) => entry.session === session);
		if (index >= 0) this.#launched.splice(index, 1);
	}

	/**
	 * Start warming a language's server, if it is not already starting or up.
	 *
	 * A FAILED slot is not a dead end: once its backoff window has passed,
	 * the slot gives way and the start is tried again (#318). Until then
	 * the refusal stands — a server that crashes the instant it starts must
	 * not be respawned in a tight loop by every read that comes by.
	 *
	 * @param languageId - registry id.
	 * @param workspaceRoot - the root to advertise.
	 */
	warm(languageId: string, workspaceRoot: string, role: LspSlotRole = "primary"): void {
		if (this.#disposed) return;
		const existing = this.#slots.get(slotKey(languageId, role));
		if (existing?.state === "failed") {
			// Retry only when the backoff window has passed (#318); until
			// then the failed refusal stands.
			if (!this.#retryDue(slotKey(languageId, role), existing)) return;
		} else if (existing !== undefined) {
			return; // already starting or ready
		}
		this.#slots.set(slotKey(languageId, role), { state: "starting" });
		void this.#start(slotKey(languageId, role), languageId, workspaceRoot, role);
	}

	/**
	 * Whether a failed slot's retry backoff window has passed.
	 *
	 * The wait doubles with each failed attempt and is capped, so a start
	 * that keeps crashing never spins — and a cold start that merely needed
	 * longer than the handshake deadline recovers on its own.
	 */
	#retryDue(key: string, slot: Extract<Slot, { state: "failed" }>): boolean {
		const attempts = this.#failures.get(key) ?? 1;
		const base = this.#options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
		const delay = Math.min(base * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS);
		return Date.now() - slot.attemptedAt >= delay;
	}

	async #start(
		key: string,
		languageId: string,
		workspaceRoot: string,
		role: LspSlotRole,
	): Promise<void> {
		let session: LspSession | undefined;
		let transport: ServerTransportLike | undefined;
		try {
			const servers = await this.#servers(role);
			const server = serverForLanguage(servers, languageId);
			if (server === undefined) {
				this.#markFailed(
					key,
					"server-missing",
					role === "format"
						? `No FORMATTING server for ${languageId} was found on PATH or in the project's bin directory. ` +
						`Name one under hashline.format.servers.`
						: `No language server for ${languageId} was found on PATH or in the project's bin directory.`,
				);
				return;
			}
			({ transport } = this.#options.spawn(server, workspaceRoot));
			session = new LspSession(transport, {
				requestTimeoutMs: this.#options.initializeTimeoutMs ?? 10_000,
			});
			this.#launched.push({ transport, session });
			await session.initialize(workspaceRoot);
			if (this.#disposed) {
				// Raced with disposal: do not leave an orphan behind.
				await session.shutdown();
				return;
			}
			this.#slots.set(key, {
				state: "ready",
				session,
				transport,
				lastUsedAt: Date.now(),
			});
			// A start that made it all the way up resets the retry backoff:
			// the next failure counts as the FIRST failure again (#318).
			this.#failures.delete(key);
			// The idle clock starts now: a server nobody asks for must not hold
			// its index for the rest of the session.
			this.#touchIdle(key);
		} catch (error) {
			const baseMessage = error instanceof Error ? error.message : String(error);
			// "exit 1" alone has sent people chasing the wrong thing: when the
			// server printed why it gave up, that stderr belongs in the refusal
			// (last 1 200 characters, so a chatty server cannot flood a card).
			const tail = transport?.stderrTail?.().trim();
			const message =
				tail === undefined || tail === ""
					? baseMessage
					: `${baseMessage}\n--- server stderr (tail) ---\n${tail.length > 1_200 ? tail.slice(-1_200) : tail}`;
			// A handshake that failed leaves a process nobody will talk to
			// again — shut it down so it cannot hold its whole index for the
			// rest of the session, which is the leak the idle reaper exists
			// to stop. The slot records the failure; the retry backoff
			// decides when it is tried again (#318).
			if (session !== undefined) {
				this.#forget(session);
				try {
					await session.shutdown();
				} catch {
					/* already gone */
				}
			}
			this.#markFailed(key, reasonFor(error), message);
		}
	}

	/**
	 * Record a failed start: the slot, the attempt count, and the log line.
	 *
	 * One path for both "the server was never found" and "the server was
	 * found but the handshake failed" — the slot shape, the counter, and
	 * the onFailure notification must not drift between them.
	 */
	#markFailed(key: string, reason: BackendReason, message: string): void {
		const attempts = (this.#failures.get(key) ?? 0) + 1;
		this.#failures.set(key, attempts);
		this.#slots.set(key, { state: "failed", reason, message, attemptedAt: Date.now() });
		this.#options.onFailure?.(
			key.startsWith(FORMAT_KEY_PREFIX) ? key.slice(FORMAT_KEY_PREFIX.length) : key,
			message,
		);
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
		// Handing the session out IS the use that keeps it alive.
		this.#touchIdle(languageId);
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
	openDocumentFor(languageId: string, uri: string, role: LspSlotRole = "primary"): ((text: string) => void) | undefined {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot?.state !== "ready") return undefined;
		// Keeping a server in step with our writes is a use too: a server that
		// is being written to is not idle.
		this.#touchIdle(slotKey(languageId, role));
		return (text: string) => {
			this.#touchIdle(slotKey(languageId, role));
			// The session this closure was made for may have been reclaimed since:
			// the CURRENT one is the server that must learn about the document, and
			// a dead server must not be written to.
			const current = this.#slots.get(slotKey(languageId, role));
			if (current?.state !== "ready") return;
			const session = current.session;
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
	 * Tell a READY server that a document is gone. Never warms one: a delete
	 * must not start a language server just to say goodbye.
	 *
	 * @param languageId - registry id.
	 * @param uri - the document's `file://` URI.
	 * @returns true when a document was actually closed on a live session.
	 */
	closeDocumentFor(languageId: string, uri: string, role: LspSlotRole = "primary"): boolean {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot?.state !== "ready") return false;
		this.#touchIdle(slotKey(languageId, role));
		return slot.session.didClose(uri);
	}

	/**
	 * The ready session for a language, or `undefined` — WITHOUT warming.
	 *
	 * Synchronous on purpose: the status/card paths ask "is it up right now" and
	 * must not start a server by asking. Use `waitForSession` when the caller's
	 * job is the protocol itself.
	 */
	readySessionFor(languageId: string, role: LspSlotRole = "primary"): LspSession | undefined {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot?.state !== "ready") return undefined;
		this.#touchIdle(slotKey(languageId, role));
		return slot.session;
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
	 * @param role - which slot to resolve (default primary; the format role is ADR-0038).
	 * @returns the session, or `undefined` when it failed or timed out.
	 */
	async waitForSession(
		languageId: string,
		workspaceRoot: string,
		timeoutMs: number = LspManager.START_TIMEOUT_MS,
		role: LspSlotRole = "primary",
	): Promise<LspSession | undefined> {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot?.state === "ready") {
			this.#touchIdle(slotKey(languageId, role));
			return slot.session;
		}
		if (this.#disposed) return undefined;
		this.warm(languageId, workspaceRoot, role);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const current = this.#slots.get(slotKey(languageId, role));
			if (current?.state === "ready") {
				this.#touchIdle(slotKey(languageId, role));
				return current.session;
			}
			if (current?.state === "failed") return undefined;
		}
		return undefined;
	}

	/**
	 * The live session, RESTARTING a failed server on demand — no backoff.
	 *
	 * The backoff exists so a crashing server is not respawned in a tight
	 * loop by the read path. An explicit warm-up is not the read path: the
	 * caller asked for a start right now, so the failed slot gives way
	 * immediately and the outcome — either way — is reported (#318).
	 *
	 * @param languageId - the registry id to (re)start and wait on.
	 * @param workspaceRoot - passed to the warm-up.
	 * @param timeoutMs - how long to hold before giving up (default 15s).
	 * @returns the session, or `undefined` when it failed or timed out.
	 */
	async forceWarm(
		languageId: string,
		workspaceRoot: string,
		timeoutMs: number = LspManager.START_TIMEOUT_MS,
		role: LspSlotRole = "primary",
	): Promise<LspSession | undefined> {
		if (this.#disposed) return undefined;
		if (this.#slots.get(slotKey(languageId, role))?.state === "failed") this.#slots.delete(slotKey(languageId, role));
		return this.waitForSession(languageId, workspaceRoot, timeoutMs, role);
	}

	/** The live session for a language, warming it if this is the first ask. */
	async sessionFor(languageId: string, workspaceRoot: string, role: LspSlotRole = "primary"): Promise<LspSession | undefined> {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot?.state === "ready") {
			this.#touchIdle(slotKey(languageId, role));
			return slot.session;
		}
		this.warm(languageId, workspaceRoot, role);
		return undefined;
	}


	/** Why a language has no session, for diagnostics and the settings card. */
	unavailability(languageId: string, role: LspSlotRole = "primary"): { reason: BackendReason; message: string | LocalizedText } | undefined {
		const slot = this.#slots.get(slotKey(languageId, role));
		if (slot === undefined) return { reason: "lsp-unavailable", message: LSP_SERVER_NOT_STARTED };
		if (slot.state === "failed") return { reason: slot.reason, message: slot.message };
		if (slot.state === "starting") return { reason: "lsp-unavailable", message: LSP_SERVER_STARTING };
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
	 * The FAILED SLOTS go with it, and that half is easy to miss. A language
	 * whose server was missing is remembered as `failed` — retry backoff and
	 * all — so re-discovering alone would find the new server and still leave
	 * the stale refusal standing until its window passed.
	 *
	 * A live session is left alone: re-discovery is about what exists on disk, not
	 * about tearing down something that is already talking.
	 *
	 * @returns the languages whose failed state was cleared.
	 */
	rescan(): string[] {
		this.#discovered.clear();
		this.#discovering.clear();
		this.#failures.clear(); // the retry backoffs go with the slots
		const cleared: string[] = [];
		for (const [languageId, slot] of [...this.#slots]) {
			if (slot.state === "failed") {
				this.#slots.delete(languageId);
				cleared.push(languageId.startsWith(FORMAT_KEY_PREFIX) ? languageId.slice(FORMAT_KEY_PREFIX.length) : languageId);
			}
		}
		return cleared;
	}

	async status(languageIds: readonly string[], role: LspSlotRole = "primary"): Promise<LspLanguageStatus[]> {
		const servers = await this.#servers(role);
		// The FORMAT role's discovery facts ride along (ADR-0038): the card's
		// format-server line and its install offer read these.
		const formatServers = await this.#servers("format");
		return languageIds.map((languageId) => {
			const server = servers.find((candidate) => candidate.languages.includes(languageId));
			const formatServer = formatServers.find((candidate) => candidate.languages.includes(languageId));
			const ready = this.#slots.get(slotKey(languageId, role))?.state === "ready";
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
						? LSP_CAN_INSTALL
						: entryFor === undefined
							? // NO CATALOG ENTRY AT ALL. "Install it into PATH" would imply this
								// plugin knows WHAT to install, and for `julia` it does not — its
								// server is launched with a project path in its argv.
								LSP_NO_BUILTIN_COMMAND
							: lspSelfInstall(entryFor.command),
				};
			}
			const unavailable = this.unavailability(languageId, role);
			return {
				languageId,
				ready,
				...(found === undefined ? {} : { server: found }),
				...(unavailable === undefined ? {} : { reason: unavailable.reason, message: unavailable.message }),
				canInstall: canInstallServer(languageId),
				...(canInstallFormatServer(languageId) ? { formatCanInstall: true as const } : {}),
				...(formatServer === undefined
					? {}
					: {
						formatServer: {
							displayName: formatServer.displayName,
							command: formatServer.command,
							executable: formatServer.executable,
							origin: formatServer.origin,
						},
					}),
			};
		});
	}

	/** The languages with a live session. */
	get readyLanguages(): string[] {
		return [...this.#slots.entries()]
			.filter(([key, slot]) => slot.state === "ready" && !key.startsWith(FORMAT_KEY_PREFIX))
			.map(([id]) => id);
	}

	/**
	 * Every language's slot state, read-only — what `lsp { operation: "status" }`
	 * reports.
	 *
	 * Never starts or restarts anything: a status question must not have
	 * side effects on the manager. A failed row carries its reason, message,
	 * and attempt count, so the reader can tell a crashing server from one
	 * that was never installed (#318).
	 */
	snapshot(): Array<{
		languageId: string;
		state: "starting" | "ready" | "failed";
		reason?: BackendReason;
		message?: string;
		/** Failed starts so far — absent when the slot has never failed. */
		attempts?: number;
	}> {
		return [...this.#slots.entries()]
			.filter(([key]) => !key.startsWith(FORMAT_KEY_PREFIX))
			.map(([languageId, slot]) => {
			if (slot.state === "failed") {
				return {
					languageId,
					state: "failed",
					reason: slot.reason,
					message: slot.message,
					attempts: this.#failures.get(languageId) ?? 1,
				};
			}
			return { languageId, state: slot.state };
		});
	}

	/**
	 * Whether `dispose()` has run. #427 review: the tool surface checks this
	 * BEFORE composing a no-server refusal — "the client was shut down (the
	 * plugin re-mounted)" is a different sentence with a different remedy
	 * (restart the session) than "no server for this language".
	 */
	get disposed(): boolean {
		return this.#disposed;
	}

	/** Shut every server down and release the processes. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const slot of this.#slots.values()) {
			if (slot.state === "ready" && slot.idleTimer !== undefined) clearTimeout(slot.idleTimer);
		}
		const launched = this.#launched;
		this.#launched = [];
		const reaping = [...this.#reaping];
		this.#slots.clear();
		this.#failures.clear();
		await Promise.all([
			...launched.map(async ({ session, transport }) => {
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
			// A reclamation that is already in flight owns a process the list
			// above no longer mentions: wait for it, so `dispose` really does
			// release every process it started. A failed termination is not a
			// reason to fail the dispose.
			...reaping.map((task) => task.catch(() => undefined)),
		]);
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

/**
 * One readable sentence about why no server is usable — the message the
 * no-server refusals embed. `unavailability()` may hand back a host-composed
 * key+params object (ADR-0024), and a bare `${}` of that printed
 * `[object Object]` into every refusal (measured, PR #427 review); a string
 * travels as-is, anything else falls back to the honest neutral sentence.
 */
export function describeUnavailable(
	why: { message?: string | LocalizedText } | undefined,
): string {
	const message = why?.message;
	if (typeof message === "string" && message !== "") return message;
	if (message !== undefined && typeof message === "object" && "key" in message) {
		return String((message as { key: unknown }).key);
	}
	return "it did not start in time";
}

/**
 * Install (or clear) the process-wide manager.
 *
 * #427 review: a plugin re-mount can run `apply()` more than once, and the
 * naive `singleton = manager` left the OLD instance un-owned while the NEW
 * scope's teardown disposed whichever instance the singleton pointed at —
 * every LSP call then failed until the session restarted. Two rules fix it:
 * the same instance is a no-op, and a different one takes the role only
 * after the previous owner's processes are shut down.
 */
export function setLspManager(manager: LspManager | undefined): void {
	if (singleton === manager) return;
	const previous = singleton;
	// The NEW instance owns the role IMMEDIATELY; the previous one's processes
	// are torn down in the background. `?.()` — a manager-shaped value without
	// a shutdown (a stub in a test) still installs cleanly.
	singleton = manager;
	void previous?.dispose?.();
}
