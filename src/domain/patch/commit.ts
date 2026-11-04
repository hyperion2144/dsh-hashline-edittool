/**
 * Commit — the patch operations, applied in patch order until one fails.
 *
 * The contract here is deliberately NOT a transaction: preflight already
 * proved the whole patch, so a failure at this point is the world moving
 * between the two phases (a file deleted, a lock taken, a sandbox refusal),
 * and the honest answer is to report what really happened rather than to
 * pretend the patch can be undone. Nothing is rolled back, and the operations
 * that never ran are reported as `skipped` — the model needs the difference
 * between "refused before writing" and "wrote three files, then hit a wall".
 *
 * Each completed file operation settles its own store state immediately, so a
 * commit that stops midway leaves the anchors of the files it DID touch
 * exactly as a single `edit` would have.
 *
 * @module dsh-hashline-edittool/patch/commit
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO, FileProbe } from "../../infra/fs-bridge.js";
import type { FileEditResult } from "../edit/edit-engine.js";
import type { FsSandboxController } from "../../infra/sandbox.js";
import { abortIf } from "../../infra/utils.js";
import { notifyDocumentClosed } from "../../lsp/sync.js";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { commit } from "../edit/mutation.js";
import { clearAlignmentNotice } from "../session/anchor-state.js";
import type { HashStore } from "../session/hash-store.js";
import { reconcileServed, recordServedAfterEdit } from "../session/session-view.js";
import type { PatchOperation, PatchOperationKind } from "./plan.js";
import type { PreparedOperation } from "./preflight.js";

/** `completed` is the only state that touched the disk for certain. */
export type PatchOperationStatus = "completed" | "failed" | "unknown" | "skipped";

/** One file's before/after text — the card's diff, never the model's text. */
export interface PatchChange {
	path: string;
	before: string | null;
	after: string;
}

/** One operation after the commit phase, as the caller reports it. */
export interface CommittedOperation {
	index: number;
	kind: PatchOperationKind;
	path: string;
	destination?: string;
	line: number;
	hunkLine?: number;
	status: PatchOperationStatus;
	code?: string;
	message?: string;
	changes?: PatchChange[];
	/**
	 * The resolved edit result behind an update (or a move with hunks): the diff
	 * blocks and anchors the response is built from. INTERNAL — it never
	 * reaches the model value, which carries the projection instead.
	 */
	file?: FileEditResult;
	/** Canonical paths the operation really touched (for `affectedPaths`). */
	absolutePath: string;
	destinationPath?: string;
}

/** The commit phase's answer. */
export interface PatchCommitResult {
	operations: CommittedOperation[];
	/** True when an operation failed and the rest never ran. */
	stopped: boolean;
	/** True when the call was aborted between operations. */
	cancelled: boolean;
	warnings: string[];
}

/** Everything the commit phase needs from the call. */
export interface PatchCommitInput {
	prepared: readonly PreparedOperation[];
	io: FileIO;
	cwd: string;
	sessionKey: string;
	exec: ToolExecution;
	sandbox: FsSandboxController;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
	store?: HashStore;
	signal?: AbortSignal;
	/** Shared warning sink: a store that failed to settle is reported, not thrown. */
	warnings: string[];
}

const CODE_MARKER = /\[(E_[A-Z0-9_]+)\]/;

/**
 * The refusal codes a mutation reports are `failed`; anything else is `unknown`.
 *
 * The line matters: `[E_*]` is a domain answer the model can retry with, while
 * a bare I/O throw means the write may or may not have landed. Claiming
 * `failed` for the second case would invite a retry that duplicates the change.
 */
function settledCode(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return CODE_MARKER.exec(message)?.[1];
}

function messageOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const match = CODE_MARKER.exec(message);
	return match === null
		? message
		: message.slice(match.index + match[0].length).replace(/^ /, "");
}

/** The undo-unavailable message, per the patch's own vocabulary. */
function undoUnavailable(displayPath: string): string {
	return `[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the patch was NOT applied to ${displayPath}. Retry, or use write if the store cannot be recovered.`;
}

/** Write one prepared edit result and settle its store rows. */
async function writeFileResult(
	input: PatchCommitInput,
	file: NonNullable<Extract<PreparedOperation, { file?: unknown }>["file"]>,
	absolutePath: string,
	displayPath: string,
): Promise<void> {
	const { io, exec, sandbox, sandboxPolicy, signal, sessionKey } = input;
	await commit({
		io,
		files:
			file.appliedCount > 0
				? [
					{
						absolutePath,
						displayPath,
						originalNormalized: file.originalNormalized,
						bom: file.bom,
						originalEnding: file.originalEnding,
						originalHashes: file.originalHashes,
						result: file.result,
					},
				]
				: [],
		exec,
		sandbox,
		sandboxPolicy,
		signal,
		undoUnavailableMessage: undoUnavailable,
		restoreUnwrittenUndos: true,
	});
	if (file.appliedCount === 0 || !file.servedRows || file.servedRows.length === 0) {
		return;
	}
	await recordServedAfterEdit(sessionKey, absolutePath, file.servedRows);
	await reconcileServed(sessionKey, absolutePath, file.result);
}

/** Move one file through the bridge and migrate its store rows. */
async function moveFile(
	input: PatchCommitInput,
	displayPath: string,
	destination: string,
	probe: FileProbe,
): Promise<{ from: string; to: string }> {
	const { io, cwd, exec, signal, sandboxPolicy, store, warnings } = input;
	const outcome = await io.renameFile(
		displayPath,
		destination,
		cwd,
		probe,
		signal,
		sandboxPolicy,
	);
	// Host consistency: the old path is gone, the new one exists. Observations
	// only — a rename never derives a write guard.
	const absentRecorded = await io.emitAbsent(outcome.from, exec, signal);
	clearAlignmentNotice(outcome.from);
	notifyDocumentClosed(outcome.from);
	await io.emitObserved(outcome.to, exec, signal);
	if (store !== undefined) {
		try {
			store.renamePath(outcome.from, outcome.to);
		} catch (error) {
			warnings.push(
				`store migration failed for ${outcome.from} → ${outcome.to}; the sweep/TTL will reclaim the old rows: ${error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	if (!absentRecorded) {
		warnings.push(
			`the old path's absence observation was not recorded for ${outcome.from} (no observation policy mounted, or the path was recreated).`,
		);
	}
	return outcome;
}

/**
 * Apply the prepared operations in order.
 *
 * @param input - the prepared operations plus the call's IO/sandbox context.
 * @returns every operation's settled state, plus the stop/cancel facts.
 */
export async function commitPatch(
	input: PatchCommitInput,
): Promise<PatchCommitResult> {
	const { io, exec, signal, sandboxPolicy, store, warnings } = input;
	const operations: CommittedOperation[] = [];
	let stopped = false;
	let cancelled = false;

	for (const prepared of input.prepared) {
		const operation: PatchOperation = prepared.operation;
		const base = {
			index: operation.index,
			kind: operation.kind,
			path: operation.path,
			...(operation.destination !== undefined
				? { destination: operation.destination }
				: {}),
			line: operation.line,
			absolutePath: prepared.absolutePath,
		};

		if (stopped || signal?.aborted === true) {
			if (signal?.aborted === true) cancelled = true;
			operations.push({ ...base, status: "skipped" });
			continue;
		}

		try {
			abortIf(signal);
			if (prepared.kind === "add") {
				await io.writeText(
					prepared.absolutePath,
					prepared.content,
					signal,
					exec,
					sandboxPolicy,
				);
				// The path was absent at preflight, but a deleted file's rows can
				// linger until the sweep. Nothing is served for a `new` file.
				if (store !== undefined) store.purgePath(prepared.absolutePath);
				operations.push({
					...base,
					status: "completed",
					changes: [
						{ path: prepared.absolutePath, before: null, after: prepared.content },
					],
				});
				continue;
			}

			if (prepared.kind === "delete") {
				const outcome = await io.deleteFile(
					operation.path,
					input.cwd,
					prepared.probe,
					signal,
					sandboxPolicy,
				);
				const absentRecorded = await io.emitAbsent(outcome.path, exec, signal);
				clearAlignmentNotice(outcome.path);
				notifyDocumentClosed(outcome.path);
				if (store !== undefined) {
					try {
						store.purgePath(outcome.path);
					} catch (error) {
						warnings.push(
							`store reclaim failed for ${outcome.path}; the sweep/TTL will retry: ${error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
				if (!absentRecorded) {
					warnings.push(
						`the absence observation was not recorded for ${outcome.path} (no observation policy mounted, or the path was recreated).`,
					);
				}
				operations.push({
					...base,
					status: "completed",
					absolutePath: outcome.path,
					changes: [{ path: outcome.path, before: prepared.before, after: "" }],
				});
				continue;
			}

			if (prepared.kind === "move") {
				const hadHunks = prepared.file !== undefined;
				// RENAME FIRST, then write the hunks at the destination.
				//
				// The provider's rename fence compares the probe taken at preflight
				// against the file's fingerprint NOW. Writing a hunk changes that
				// fingerprint, so "write then rename" could never succeed: the fence
				// reported `[E_RENAME_STALE]` for the write this very operation had
				// just performed, leaving the source edited, the move undone, and the
				// report claiming 0 of 1 completed. Renaming first keeps the fence
				// answering the only question it can answer — did somebody ELSE touch
				// the file — and lands the hunks where the operation says they belong.
				const moved = await moveFile(
					input,
					operation.path,
					prepared.operation.section.destination ?? operation.destination ?? "",
					prepared.probe,
				);
				if (prepared.file !== undefined) {
					// The resolved result belongs to the source's snapshot, which is the
					// destination's content now; its anchors were served at the source
					// and `renamePath` has just migrated those rows to the destination.
					await writeFileResult(
						input,
						prepared.file,
						moved.to,
						prepared.operation.section.destination ?? operation.destination ?? operation.path,
					);
				}
				operations.push({
					...base,
					status: "completed",
					absolutePath: moved.from,
					destinationPath: moved.to,
					...(prepared.file !== undefined ? { file: prepared.file } : {}),
					changes:
						hadHunks && prepared.file !== undefined
							? [
								{
									path: moved.to,
									before: prepared.file.originalNormalized,
									after: prepared.file.result,
								},
							]
							: [],
				});
				continue;
			}

			await writeFileResult(
				input,
				prepared.file,
				prepared.absolutePath,
				operation.path,
			);
			operations.push({
				...base,
				status: "completed",
				file: prepared.file,
				...(prepared.file.appliedCount > 0
					? {
						changes: [
							{
								path: prepared.absolutePath,
								before: prepared.file.originalNormalized,
								after: prepared.file.result,
							},
						],
					}
					: {}),
			});
		} catch (error) {
			const code = settledCode(error);
			if (code === undefined) {
				// The mutation may or may not have landed. Saying `failed` would
				// invite a duplicate retry, so the state is `unknown` and the message
				// tells the model how to settle it.
				stopped = true;
				operations.push({
					...base,
					status: "unknown",
					message: `${messageOf(error)} — re-read the affected files before retrying.`,
				});
				continue;
			}
			stopped = true;
			operations.push({
				...base,
				status: "failed",
				code,
				message: messageOf(error),
			});
		}
	}

	return { operations, stopped, cancelled, warnings };
}
