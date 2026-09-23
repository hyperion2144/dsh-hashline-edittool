/**
 * IO seam for the hashline tool layer. The tools resolve, read, and write
 * through this bridge so they honor the deployment's `ctx.fs` backend — a
 * sandboxed or remote filesystem — instead of reaching around it.
 *
 * The bridge also participates in dsh's `fs/*` event gate exactly like the
 * built-in tools: writes dispatch `fs/write-intent` (so the observation policy
 * derives its create/replace guard and stale-version checks) and every
 * successful read/mutation emits `fs/observed` with the resulting version. A
 * hashline tool that silently skipped those events would leave the policy's
 * observed state stale, and the next built-in `write` on the same file would
 * fail with `FS_NOT_OBSERVED` / `FS_STALE_VERSION`.
 *
 * The local implementation exists for tests and pure-pipeline verification.
 * @module dsh-hashline-edittool/fs-bridge
 */

import { readFile, stat } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { writeAtomic } from "./fs-write.js";
import { fileSnap } from "./file-snap.js";
import { resolveTarget, toCwd } from "./paths.js";

/** Text-IO operations the hashline tools need, keyed by canonical absolute path. */
export interface FileIO {
	/** Resolve a (possibly relative) request path against the session cwd to a canonical absolute path. */
	resolve(path: string, cwd: string, signal?: AbortSignal): Promise<string>;
	/** Read whole text; missing files, directories, and binary content throw. */
	readText(absolutePath: string, signal?: AbortSignal): Promise<string>;
	/**
	 * Atomically write whole text, preserving mode when the file exists. On the
	 * dsh backend this dispatches `fs/write-intent` (policy guard), stamps the
	 * sandbox policy (session workspace root + mode) onto the write, and emits
	 * `fs/observed` with the new version on success, so later built-in tools
	 * see a fresh observation.
	 * @param exec - the calling execution; carries the session the policy keys by.
	 * @param sandboxPolicy - the per-call sandbox mode + workspace root the
	 *   confined backend checks (resolved from the session by the tool layer);
	 *   omitted on an unsandboxed backend.
	 */
	writeText(
		absolutePath: string,
		content: string,
		signal?: AbortSignal,
		exec?: ToolExecution,
		sandboxPolicy?: SandboxExecutionPolicy,
	): Promise<void>;
	/**
	 * Emit `fs/observed` (present at the current version) for a successful
	 * read, so the policy records that this session has seen the file.
	 * @param exec - the calling execution; carries the session the policy keys by.
	 */
	emitObserved(
		absolutePath: string,
		exec?: ToolExecution,
		signal?: AbortSignal,
	): Promise<void>;
	/**
	/**
	 * Emit `fs/observed` with an ABSENT observation for a read that failed
	 * with not-found: the policy then treats the file as confirmed absent,
	 * so a later write falls back to create-if-absent instead of demanding
	 * a re-read it can never satisfy (read → not-found → read loop).
	 * @param exec - the calling execution; carries the session the policy keys by.
	 * @returns true when an absent observation was actually recorded.
	 */
	emitAbsent(
		absolutePath: string,
		exec?: ToolExecution,
		signal?: AbortSignal,
	): Promise<boolean>;
	/** Opaque change-version for snapshot bookkeeping, or undefined when unavailable. */
	statVersion(
		absolutePath: string,
		signal?: AbortSignal,
	): Promise<string | undefined>;
	/**
	 * Byte size of a regular file, or undefined when it cannot be reported.
	 *
	 * Used by `grep`'s memory budget (issue #167) to decide whether a file may
	 * be read BEFORE reading it. `undefined` is the honest "unknown" answer —
	 * the caller then reads at its own risk rather than skipping a file it could
	 * have searched. Deliberately a size probe and not a `stat` wrapper: the
	 * tool layer has no business seeing the backend's version tokens.
	 */
	statSize(
		absolutePath: string,
		signal?: AbortSignal,
	): Promise<number | undefined>;
}

/**
 * Map an `ctx.fs` failure onto the hashline model-facing vocabulary so the
 * model sees the same structured error codes as the pure pipeline.
 * @param error - the thrown FsError or any error.
 * @param displayPath - the path as the model wrote it.
 * @returns the mapped error, rethrown.
 */
export function mapFsError(error: unknown, displayPath: string): never {
	if (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === "string"
	) {
		const code = (error as unknown as { code: string }).code;
		if (code === "FS_NOT_FOUND") {
			throw new Error(`[E_NOT_FOUND] File not found: ${displayPath}`);
		}
		if (code === "FS_PERMISSION_DENIED") {
			throw new Error(`[E_ACCESS] Cannot access file: ${displayPath}`);
		}
		if (code === "FS_NOT_TEXT" || code === "FS_NOT_REGULAR_FILE") {
			throw new Error(
				`[E_NOT_TEXT] Path is not a readable UTF-8 text file: ${displayPath}. Hashline editing only supports text files.`,
			);
		}
		if (code === "FS_STALE_VERSION") {
			throw new Error(
				`[E_RANGE_STALE] The file changed on disk since it was read (version guard rejected the write). Call read() to get fresh anchors, then retry.`,
			);
		}
		if (code === "FS_NOT_OBSERVED") {
			throw new Error(
				`[E_NOT_OBSERVED] The file has not been observed in this session (read-before-write policy). Call read() first, then retry the edit.`,
			);
		}
		if (code === "FS_ABORTED") {
			throw new Error("Operation aborted");
		}
	}
	// Windows atomic-replace failures (dsh-fs-local calls ReplaceFileW):
	// error 1175 = ERROR_UNABLE_TO_MOVE_REPLACEMENT — the target is held open
	// by another process (IDE watcher, antivirus scan, cloud sync) or the
	// replace cannot cross volumes. Surface a diagnosis instead of the raw
	// syscall text.
	const message = error instanceof Error ? error.message : String(error);
	if (/replacefilew|win32 1175|unable to move replacement/i.test(message)) {
		throw new Error(
			`[E_WIN_REPLACE] The file could not be atomically replaced on Windows (ReplaceFileW): another process is likely holding the target open (editor/IDE watcher, antivirus scan, cloud sync) or the path is write-protected. Close programs using the file and retry; if it persists, write to a new path and remove the old one.`,
		);
	}
	throw error;
}

/**
 * One guarded write attempt: resolve → `fs/write-intent` → `fs.writeText` →
 * `fs/observed`. Errors propagate to the caller (mapFsError / retry logic).
 */
async function writeWithIntent(
	fs: FileSystem,
	ctx: Context,
	absolutePath: string,
	content: string,
	signal: AbortSignal | undefined,
	exec: ToolExecution | undefined,
	sandboxPolicy: SandboxExecutionPolicy | undefined,
): Promise<void> {
	const target = await fs.resolve(absolutePath, {
		...(signal !== undefined ? { signal } : {}),
	});
	// Single-slot decision: the observation policy produces
	// createIfAbsent / replaceIfVersion; the bare default is
	// undefined (unconditional) when no policy is mounted.
	const intent = await ctx.waterfall(
		"fs/write-intent",
		target,
		exec,
		() => undefined,
	);
	// The sandbox policy (session workspace root + mode) is what a
	// confined backend checks: without it the backend falls back to
	// the deployment default root and denies writes inside the
	// session workspace under workspace-write.
	const outcome = await fs.writeText(
		target,
		content,
		intent,
		signal,
		sandboxPolicy,
	);
	// Record the present observation (a no-op when no policy
	// plugin listens), so later built-in tools see the new version.
	ctx.emit(
		"fs/observed",
		target,
		{ kind: "present", version: outcome.version },
		exec,
	);
}
/** FileIO over the deployment's `ctx.fs` service. */
export function ctxFsIO(fs: FileSystem, ctx: Context): FileIO {
	return {
		async resolve(path, cwd, signal) {
			const target = await fs.resolve(path, {
				...(cwd !== undefined ? { cwd } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			return fs.processPath(target);
		},
		async readText(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				return await fs.readText(target, signal);
			} catch (error) {
				return mapFsError(error, absolutePath);
			}
		},
		async writeText(absolutePath, content, signal, exec, sandboxPolicy) {
			try {
				await writeWithIntent(fs, ctx, absolutePath, content, signal, exec, sandboxPolicy);
			} catch (error) {
				// issue #136 dead loop: a file that was OBSERVED (read/written
				// earlier this session) but has since been DELETED on disk can
				// never satisfy the version guard — the demanded re-read throws
				// not-found, so the stale observation never updates and every
				// write bounces forever. Confirm the absence, record it, and
				// retry once: the policy then treats the write as a create. A
				// file that still exists keeps the guard's re-read demand (its
				// content genuinely changed).
				if (
					exec !== undefined &&
					(error as { code?: unknown })?.code === "FS_STALE_VERSION" &&
					(await this.emitAbsent(absolutePath, exec, signal))
				) {
					try {
						await writeWithIntent(fs, ctx, absolutePath, content, signal, exec, sandboxPolicy);
						return;
					} catch (retryError) {
						return mapFsError(retryError, absolutePath);
					}
				}
				// FS_SANDBOX_DENIED passes through raw; the tool layer maps it
				// to the shared [sandbox: …] marker + escalation hint via its
				// sandbox controller.
				return mapFsError(error, absolutePath);
			}
		},
		async emitObserved(absolutePath, exec, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				if (info !== undefined) {
					ctx.emit(
						"fs/observed",
						target,
						{ kind: "present", version: info.version },
						exec,
					);
				}
			} catch (error) {
				// A failed observation must not fail the read that preceded it.
				console.error(
					`dsh-hashline-edittool: fs/observed emission failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		async emitAbsent(absolutePath, exec, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				if (info === undefined) {
					ctx.emit("fs/observed", target, { kind: "absent" }, exec);
					return true;
				}
				return false;
			} catch (error) {
				// Re-resolve may race a recreate; only absence is worth recording.
				const code = (error as { code?: string })?.code;
				if (code === "FS_NOT_FOUND") {
					try {
						const target = await fs.resolve(absolutePath, {
							...(signal !== undefined ? { signal } : {}),
						});
						ctx.emit("fs/observed", target, { kind: "absent" }, exec);
						return true;
					} catch {
						// resolve itself failed — nothing to record
						return false;
					}
				}
				console.error(
					`dsh-hashline-edittool: fs/observed(absent) emission failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
		},
		async statVersion(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				return info?.version ?? undefined;
			} catch {
				return undefined;
			}
		},
		async statSize(absolutePath, signal) {
			try {
				const target = await fs.resolve(absolutePath, {
					...(signal !== undefined ? { signal } : {}),
				});
				const info = await fs.stat(target, signal);
				// `size` is optional in the fs contract: an "other" entry (socket,
				// device) has none, and so may a backend that cannot report it.
				return info?.type === "file" ? info.size : undefined;
			} catch {
				// An unresolvable or unreadable path is not the budget's business:
				// the read that follows reports the real error.
				return undefined;
			}
		},
	};
}

/** FileIO over the host filesystem directly (tests, previews, fallback). */
export function localIO(): FileIO {
	return {
		async resolve(path, cwd) {
			return resolveTarget(toCwd(path, cwd ?? process.cwd()));
		},
		async readText(absolutePath, signal) {
			signal?.throwIfAborted();
			return readFile(absolutePath, "utf-8");
		},
		async writeText(absolutePath, content, signal, _exec, _sandboxPolicy) {
			signal?.throwIfAborted();
			await writeAtomic(absolutePath, content);
		},
		async emitObserved() {
			// No policy event gate on the host filesystem; nothing to record.
		},
		async emitAbsent() {
			// No policy event gate on the host filesystem; nothing to record.
			return false;
		},
		async statVersion(absolutePath) {
			try {
				return (await fileSnap(absolutePath)).snapshotId;
			} catch {
				return undefined;
			}
		},
		async statSize(absolutePath) {
			try {
				const st = await stat(absolutePath);
				return st.isFile() ? st.size : undefined;
			} catch {
				return undefined;
			}
		},
	};
}
