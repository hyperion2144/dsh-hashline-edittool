/**
 * Main-thread owner of the parse worker: spawn, request correlation, crash
 * recovery, recycling and idle shutdown.
 *
 * The main thread never constructs a `Parser` (see `./worker.ts` for why). It
 * sends text down and gets symbols back — the worker is stateless from this
 * side's point of view except for the tree cache it keeps, which is keyed by
 * content so that repeated reads of the same file are free.
 *
 * Three rules from `docs/adr/0007` are implemented here rather than in the
 * worker, because they are decisions about the worker's *lifetime*:
 *
 * - **An abort means terminate, not cleanup.** Dropping references frees
 *   nothing (measured: `gc()` × 6 released 0 bytes), so recovery is
 *   `terminate()` + respawn.
 * - **One retry, then a mark.** The first abort may have been accumulated
 *   arena pressure rather than the file; if the fresh worker aborts on the
 *   same file too, it is the file — remember `(path, size)` and stop.
 * - **Recycle a wasted high-water mark.** The arena never shrinks, so a
 *   correct LRU still leaves it inflated by historical peaks. When the arena
 *   is large but the retained node count is low, the peak is waste.
 *
 * @module dsh-hashline-edittool/ast/client
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { AST_WORKER_IDLE_MS, AST_WORKER_RECYCLE_HEAP_BYTES, AST_WORKER_RECYCLE_RETAINED_NODES } from "../infra/constants.js";
import { E_AST_TOO_LARGE, E_AST_WORKER_FAILED } from "./codes.js";
import type { LanguageId } from "./language.js";
import type { SymbolRecord } from "./symbols.js";
import type { AstWorkerRequest, AstWorkerResponse, GrepMatch } from "./worker.js";

/** One request the client makes of the worker. */
export interface ParseInput {
	readonly path: string;
	readonly text: string;
	readonly languageId: LanguageId;
}

/** A failure the caller can act on. */
export class AstError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code} ${message}`);
		this.name = "AstError";
	}
}

/**
 * A spawnable worker. Injected so tests can drive the client's lifetime rules
 * in-process without a thread; production uses `node:worker_threads`.
 */
export interface WorkerLike {
	postMessage(message: AstWorkerRequest): void;
	onMessage(listener: (response: AstWorkerResponse) => void): void;
	onExit(listener: () => void): void;
	terminate(): void | Promise<void>;
}

/** Factory the client uses to (re)create its worker. */
export type WorkerFactory = () => WorkerLike;

/** How the client talks to the outside world, injectable for tests. */
export interface AstClientOptions {
	readonly spawn?: WorkerFactory;
	readonly idleMs?: number;
	/** Clock, injectable so idle behaviour is testable without waiting. */
	readonly now?: () => number;
}

/** Spawn a real worker thread running the built `worker.js` next to this file. */
function threadFactory(): WorkerLike {
	const worker = new Worker(new URL("./worker.js", import.meta.url));
	return {
		postMessage: (message) => worker.postMessage(message),
		onMessage: (listener) => worker.on("message", listener),
		onExit: (listener) => worker.on("exit", listener),
		terminate: () => worker.terminate().then(() => undefined),
	};
}

/** A pending request awaiting its response. */
interface Pending {
	resolve: (response: AstWorkerResponse) => void;
	reject: (error: Error) => void;
}

/**
 * Owns one worker at a time. Requests are serialized by the worker's own
 * message queue; only the spawn/teardown transitions are ordered here.
 */
export class AstClient {
	#spawn: WorkerFactory;
	#worker: WorkerLike | undefined;
	#pending = new Map<number, Pending>();
	#nextId = 1;
	#spawning: Promise<void> | undefined;
	#idleMs: number;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Files that aborted twice, by `path\0size`; a size change clears the mark. */
	#aborted = new Map<string, number>();
	#disposed = false;

	constructor(options: AstClientOptions = {}) {
		this.#spawn = options.spawn ?? threadFactory;
		this.#idleMs = options.idleMs ?? AST_WORKER_IDLE_MS;
	}

	/** Spawn the worker if it is not running. */
	async #ensureWorker(): Promise<WorkerLike> {
		if (this.#worker !== undefined) return this.#worker;
		if (this.#spawning !== undefined) {
			await this.#spawning;
			return this.#requireWorker();
		}
		this.#spawning = (async () => {
			const worker = this.#spawn();
			worker.onMessage((response) => this.#settle(response));
			worker.onExit(() => this.#onExit(worker));
			this.#worker = worker;
		})();
		try {
			await this.#spawning;
		} finally {
			this.#spawning = undefined;
		}
		return this.#requireWorker();
	}

	#requireWorker(): WorkerLike {
		const worker = this.#worker;
		if (worker === undefined) throw new AstError(E_AST_WORKER_FAILED, "Parse worker is not running.");
		return worker;
	}

	/** Resolve the pending request a response belongs to. */
	#settle(response: AstWorkerResponse): void {
		const entry = this.#pending.get(response.id);
		if (entry === undefined) return;
		this.#pending.delete(response.id);
		entry.resolve(response);
	}

	/** Fail everything outstanding when the worker goes away underneath us. */
	#onExit(worker: WorkerLike): void {
		if (this.#worker !== worker) return;
		this.#worker = undefined;
		for (const [id, entry] of this.#pending) {
			this.#pending.delete(id);
			entry.reject(new AstError(E_AST_WORKER_FAILED, "Parse worker exited before answering."));
		}
	}

	/** Terminate the current worker and drop its cache. */
	async #terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = undefined;
		if (worker === undefined) return;
		try {
			await worker.terminate();
		} catch {
			// Terminating an already-dead thread is not an error worth surfacing.
		}
	}

	/** Send one request and await its response. */
	#send(request: AstWorkerRequest): Promise<AstWorkerResponse> {
		const worker = this.#requireWorker();
		return new Promise<AstWorkerResponse>((resolve, reject) => {
			this.#pending.set(request.id, { resolve, reject });
			worker.postMessage(request);
		});
	}

	/** Arm (or re-arm) the idle shutdown. */
	#touchIdle(): void {
		if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
		if (this.#idleMs <= 0 || this.#disposed) return;
		this.#idleTimer = setTimeout(() => {
			void this.#terminate();
		}, this.#idleMs);
		this.#idleTimer.unref?.();
	}

	/**
	 * Parse a file and enumerate its symbols.
	 *
	 * @param input - path (for messages), source text and language id.
	 * @returns the file's symbols.
	 * @throws {AstError} with `E_AST_TOO_LARGE`, `E_AST_WORKER_ABORTED` or `E_AST_WORKER_FAILED`.
	 */
	async parseSymbols(input: ParseInput): Promise<SymbolRecord[]> {
		if (this.#disposed) throw new AstError(E_AST_WORKER_FAILED, "AST client is disposed.");
		const mark = `${input.path}\0${input.text.length}`;
		if (this.#aborted.has(mark)) {
			throw new AstError(
				E_AST_TOO_LARGE,
				`${input.path} has aborted the parser twice at this size; AST reading is disabled for it until the file changes. Use line mode.`,
			);
		}

		let attempt = 0;
		for (;;) {
			attempt += 1;
			await this.#ensureWorker();
			const response = await this.#send({ id: this.#nextId++, op: "parse", path: input.path, text: input.text, languageId: input.languageId });
			if (!response.ok) {
				if (response.aborted === true) {
					// The instance is dead and cannot be salvaged in place.
					await this.#terminate();
					if (attempt === 1) continue; // one retry on a fresh worker
					this.#aborted.set(mark, input.text.length);
					throw new AstError(
						E_AST_TOO_LARGE,
						`${input.path} aborted the parse worker again after a restart; AST reading is disabled for it until the file changes. ${response.message}`,
					);
				}
				throw new AstError(response.code, response.message);
			}
			if (response.op !== "parse") {
				throw new AstError(E_AST_WORKER_FAILED, "Parse worker answered a parse request with an arena report.");
			}
			this.#touchIdle();
			void this.#maybeRecycle(response.arenaBytes, response.nodeCount);
			return response.symbols;
		}
	}

	/**
	 * Search a file by structural pattern.
	 *
	 * No abort-retry loop like `parseSymbols`: a pattern that the grammar cannot
	 * parse is a REFUSAL, not a size problem, and retrying it on a fresh worker
	 * would produce the same refusal more slowly. A parse that dies of size still
	 * reports `aborted`, and that surfaces as the worker failure it is.
	 *
	 * @param input - path (for messages), source text, language id and pattern.
	 * @returns one entry per match, in document order.
	 * @throws {AstError} with `E_AST_PATTERN` for a pattern the grammar refuses.
	 */
	async grepPattern(input: ParseInput & { readonly pat: string }): Promise<readonly GrepMatch[]> {
		if (this.#disposed) throw new AstError(E_AST_WORKER_FAILED, "AST client is disposed.");
		await this.#ensureWorker();
		const response = await this.#send({
			id: this.#nextId++,
			op: "grep",
			path: input.path,
			text: input.text,
			languageId: input.languageId,
			pat: input.pat,
		});
		if (!response.ok) {
			// A dead instance is still worth terminating: the next call must not
			// inherit a broken worker.
			if (response.aborted === true) await this.#terminate();
			throw new AstError(response.code, response.message);
		}
		if (response.op !== "grep") {
			throw new AstError(E_AST_WORKER_FAILED, "The worker answered a grep request with something else.");
		}
		this.#touchIdle();
		return response.matches;
	}

	/**
	 * Find identifier occurrences of a name in one file.
	 *
	 * Used by the reference scan's confirmation step: a text-candidate line is
	 * only reported once the parser agrees an identifier node with that exact
	 * text sits there, which is what keeps matches out of comments and strings.
	 *
	 * @param input - path, source text, language id and the bare name.
	 * @returns 1-indexed line / 0-indexed column pairs.
	 */
	async findIdentifiers(input: ParseInput & { name: string }): Promise<Array<{ line: number; column: number }>> {
		if (this.#disposed) throw new AstError(E_AST_WORKER_FAILED, "AST client is disposed.");
		await this.#ensureWorker();
		const response = await this.#send({
			id: this.#nextId++,
			op: "identifiers",
			path: input.path,
			text: input.text,
			languageId: input.languageId,
			name: input.name,
		});
		if (!response.ok) throw new AstError(response.code, response.message);
		if (response.op !== "identifiers") {
			throw new AstError(E_AST_WORKER_FAILED, "Parse worker answered an identifier request with the wrong report.");
		}
		this.#touchIdle();
		return response.hits;
	}

	/**
	 * Compute a file's structural-summary elision spans.
	 *
	 * @param input - path, source text, language id and the two floors.
	 * @returns the top-level spans to fold.
	 */
	async summarySpans(
		input: ParseInput & { minBodyLines: number; minCommentLines: number },
	): Promise<Array<{ startLine: number; endLine: number; openerLine: number; closerLine: number; kind: "body" | "imports" | "comment" }>> {
		if (this.#disposed) throw new AstError(E_AST_WORKER_FAILED, "AST client is disposed.");
		await this.#ensureWorker();
		const response = await this.#send({
			id: this.#nextId++,
			op: "summary",
			path: input.path,
			text: input.text,
			languageId: input.languageId,
			minBodyLines: input.minBodyLines,
			minCommentLines: input.minCommentLines,
		});
		if (!response.ok) throw new AstError(response.code, response.message);
		if (response.op !== "summary") {
			throw new AstError(E_AST_WORKER_FAILED, "Parse worker answered a summary request with the wrong report.");
		}
		this.#touchIdle();
		return response.spans;
	}

	/**
	 * Whether a text still parses — the post-edit write gate.
	 *
	 * @param input - path, source text and language id.
	 * @returns true when the tree contains no `ERROR` node.
	 */
	async parsesCleanly(input: ParseInput): Promise<boolean> {
		if (this.#disposed) throw new AstError(E_AST_WORKER_FAILED, "AST client is disposed.");
		await this.#ensureWorker();
		const response = await this.#send({
			id: this.#nextId++,
			op: "validate",
			path: input.path,
			text: input.text,
			languageId: input.languageId,
		});
		if (!response.ok) throw new AstError(response.code, response.message);
		if (response.op !== "validate") {
			throw new AstError(E_AST_WORKER_FAILED, "Parse worker answered a validate request with the wrong report.");
		}
		this.#touchIdle();
		return !response.hasError;
	}

	/**
	 * Recycle the worker when its arena is inflated beyond what the cache
	 * justifies. Both conjuncts are required: a large arena *with* a large
	 * retained set is a working cache, not waste.
	 */
	async #maybeRecycle(arenaBytes: number, retainedNodes: number): Promise<void> {
		const retained = await this.retainedNodes();
		if (arenaBytes <= AST_WORKER_RECYCLE_HEAP_BYTES) return;
		if (retained >= AST_WORKER_RECYCLE_RETAINED_NODES) return;
		void retainedNodes;
		await this.#terminate();
	}

	/** Ask the worker for its retained node count. */
	private async retainedNodes(): Promise<number> {
		try {
			const response = await this.#send({ id: this.#nextId++, op: "arena" });
			return response.ok && "retainedNodes" in response ? response.retainedNodes : 0;
		} catch {
			return 0;
		}
	}

	/** The live arena size in bytes (0 when no worker has run yet). */
	async arenaBytes(): Promise<number> {
		await this.#ensureWorker();
		const response = await this.#send({ id: this.#nextId++, op: "arena" });
		return response.ok && "arenaBytes" in response ? response.arenaBytes : 0;
	}

	/**
	 * Whether this client has been disposed. A disposed client never revives —
	 * every op refuses — so a caller that finds this true must build a new one.
	 */
	get disposed(): boolean {
		return this.#disposed;
	}
	/**
	 * Drop cached trees and stop the worker.
	 *
	 * Clearing the singleton is part of the contract, not a detail: nothing
	 * revives a disposed instance (every op refuses with
	 * `E_AST_WORKER_FAILED: AST client is disposed.`), so leaving it in place
	 * would make "AST off" a ONE-WAY DOOR — the settings card offers that switch,
	 * and flipping it back would leave every AST feature dead until the process
	 * restarted. Dropping it here lets the next caller build a live one.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		// Before the first `await`, so the singleton is clear synchronously: the
		// config layer disposes fire-and-forget, and a re-enable may land while
		// the terminate is still in flight.
		if (singleton === this) singleton = undefined;
		await this.#terminate();
	}
}

let singleton: AstClient | undefined;

/** The process-wide AST client. */
export function getAstClient(): AstClient {
	singleton ??= new AstClient();
	return singleton;
}

/** Replace the process-wide client (tests). */
export function setAstClient(client: AstClient | undefined): void {
	singleton = client;
}

/** Path helper kept here so the worker URL resolution has one home. */
export function workerEntryPath(): string {
	return fileURLToPath(new URL("./worker.js", import.meta.url));
}
