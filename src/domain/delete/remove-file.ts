/**
 * The shared REMOVE step: delete → announce absence → reclaim the store rows.
 *
 * `delete` and `apply_patch`'s `remove` section both take a file off the disk,
 * and there is exactly one way to do it in this plugin (#416): the guarded
 * delete, then the host-consistency bookkeeping (the file is gone, so nothing
 * may keep a present observation, a stale alignment notice or an LSP document
 * for it), then the store's purge.
 *
 * The caller owns the ERROR vocabulary (a per-path failure vs. the patch's
 * stopped-commit report); this module owns the file-side facts.
 *
 * @module dsh-hashline-edittool/delete/remove-file
 */

import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO, FileProbe } from "../../infra/fs-bridge.js";
import { clearAlignmentNotice } from "../session/anchor-state.js";
import type { HashStore, PurgeReport } from "../session/hash-store.js";
import { notifyDocumentClosed } from "../../lsp/sync.js";

/** What one remove needs. */
export interface RemoveFileInput {
	io: FileIO;
	/** The calling execution: the absence observation rides on it. */
	exec: ToolExecution;
	/** The store, when it could be opened (its absence is a warning, not a failure). */
	store: HashStore | undefined;
	/** The path as the model wrote it. */
	displayPath: string;
	cwd: string;
	/** The probe taken before approval — the delete's fence. */
	probe: FileProbe;
	signal?: AbortSignal;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
}

/** What one remove produced. */
export interface RemoveFileResult {
	/** What the delete did: the file went, or it was already gone. */
	kind: "deleted" | "absent";
	/** The canonical path — the store's purge key. */
	canonicalPath: string;
	/** What the store's purge reclaimed, when a store was there. */
	reclaimed?: PurgeReport;
	/** A warning that did not stop the removal. */
	warning?: string;
}

/**
 * Remove one file the way this plugin removes files.
 *
 * @param input - the path, its probe and the call's context.
 * @returns the canonical path plus whatever the store reclaimed.
 */
export async function removeFile(input: RemoveFileInput): Promise<RemoveFileResult> {
	const { io, exec, store, displayPath, cwd, probe, signal, sandboxPolicy } = input;
	const outcome = await io.deleteFile(displayPath, cwd, probe, signal, sandboxPolicy);

	// Host consistency: the file is gone, so nothing should keep a present
	// observation, a stale alignment notice, or an LSP document for it. Only
	// `fs/observed` absent — never a write intent.
	const absentRecorded = await io.emitAbsent(outcome.path, exec, signal);
	clearAlignmentNotice(outcome.path);
	notifyDocumentClosed(outcome.path);

	let reclaimed: PurgeReport | undefined;
	let warning: string | undefined;
	if (store !== undefined) {
		try {
			reclaimed = store.purgePath(outcome.path);
		} catch (error) {
			warning = `store reclaim failed; the sweep/TTL will retry: ${error instanceof Error ? error.message : String(error)
				}`;
		}
	}
	if (!absentRecorded) {
		warning = `${warning === undefined ? "" : `${warning} `}the absence observation was not recorded (no observation policy mounted, or the path was recreated).`;
	}

	return {
		kind: outcome.kind,
		canonicalPath: outcome.path,
		...(reclaimed !== undefined ? { reclaimed } : {}),
		...(warning !== undefined ? { warning } : {}),
	};
}
