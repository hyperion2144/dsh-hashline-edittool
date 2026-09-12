/**
 * The process substrate for a language server.
 *
 * The platform's `ctx.subprocess` seam is what actually spawns, and this module
 * is the thin adapter that turns one of its handles into the byte-level
 * `LspTransport` a session talks to. Two things are worth knowing about why it
 * is this thin:
 *
 * 1. **The seam owns the hard parts.** Credential scrubbing, executable
 *    lookup, detached process groups, and tree-scoped `SIGTERM → grace →
 *    SIGKILL` (Windows: `taskkill /T`) all live in `dsh-subprocess-local`,
 *    which is loaded by default. Re-implementing any of it here would be a
 *    worse copy of code that already exists.
 * 2. **The seam's own documentation names LSP as a consumer** — *"LSP uses raw
 *    protocol pipes"* — so the raw `stdin`/`stdout` this adapter needs are the
 *    intended use, not a workaround.
 *
 * `stderr` is drained and kept as a bounded tail rather than piped to the
 * parent: a server that crashes at startup explains itself there, and that
 * explanation is the difference between "the server is broken" and a fix.
 *
 * @module dsh-hashline-edittool/lsp/transport
 */
import type { LspTransport } from "./session.js";

/** The handle shape this adapter needs (structurally the seam's `SubprocessHandle`). */
export interface SubprocessLike {
	readonly pid: number;
	readonly stdin: { write(chunk: Buffer): boolean; end?(): void } | undefined;
	readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | undefined;
	readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | undefined;
	readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
	terminate(): void;
	waitForExit(signal?: AbortSignal): Promise<boolean>;
}

/** A transport plus the diagnostics a failed start needs. */
export interface ServerTransport extends LspTransport {
	/** The child's pid, or -1 when the spawn itself failed. */
	readonly pid: number;
	/** The last few KB of the server's stderr — its own account of a crash. */
	stderrTail(): string;
	/** Resolves when the process tree has exited. */
	readonly exited: Promise<number | null>;
}

/** How much stderr to keep for diagnostics. */
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Wrap a spawned language server as an `LspTransport`.
 *
 * @param handle - the subprocess seam's handle.
 * @returns a transport the session can drive.
 */
export function subprocessTransport(handle: SubprocessLike): ServerTransport {
	let stderr = "";
	let exitCode: number | null | undefined;
	const dataListeners: Array<(chunk: Buffer) => void> = [];
	const exitListeners: Array<(code: number | null) => void> = [];

	handle.stdout?.on("data", (chunk: Buffer) => {
		for (const listener of dataListeners) listener(chunk);
	});
	handle.stderr?.on("data", (chunk: Buffer) => {
		// Keep a bounded tail: a server that dies at startup explains itself
		// here, and that explanation is the whole difference between "the
		// server is broken" and a fix.
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
	});

	const exited = handle.done
		.then((outcome) => {
			exitCode = outcome.exitCode;
			return outcome.exitCode;
		})
		.catch(() => {
			exitCode = null;
			return null;
		});

	void exited.then((code) => {
		for (const listener of exitListeners) listener(code);
	});

	return {
		pid: handle.pid,
		write(bytes) {
			// A write to a dead server's pipe throws EPIPE; swallowing it here
			// would hide the death, and the exit listener reports it instead.
			handle.stdin?.write(bytes);
		},
		onData(listener) {
			dataListeners.push(listener);
		},
		onExit(listener) {
			exitListeners.push(listener);
			if (exitCode !== undefined) listener(exitCode);
		},
		kill() {
			handle.terminate();
		},
		stderrTail() {
			return stderr;
		},
		exited,
	};
}
