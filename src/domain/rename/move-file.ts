/**
 * The shared MOVE step: rename → announce both ends → migrate the store rows.
 *
 * `rename` and `apply_patch`'s `move` section both move a file, and there is
 * exactly one way to do it in this plugin (#416): the guarded rename (the
 * fence answers "did somebody ELSE touch this file"), then the host-consistency
 * bookkeeping (the old path is gone, the new one exists), then the store's
 * four-family path migration (ADR-0024) — the anchors the model already holds
 * stay valid at the destination.
 *
 * The caller owns the ERROR vocabulary; this module owns the file-side facts.
 *
 * @module dsh-hashline-edittool/rename/move-file
 */

import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO, FileProbe } from "../../infra/fs-bridge.js";
import { clearAlignmentNotice } from "../session/anchor-state.js";
import type { HashStore, MigrateReport } from "../session/hash-store.js";
import { notifyDocumentClosed } from "../../lsp/sync.js";

/** What one move needs. */
export interface MoveFileInput {
	io: FileIO;
	/** The calling execution: the observations ride on it. */
	exec: ToolExecution;
	/** The store, when it could be opened (its absence is a warning, not a failure). */
	store: HashStore | undefined;
	/** The source path as the model wrote it. */
	from: string;
	/** The destination path as the model wrote it. */
	to: string;
	cwd: string;
	/** The source probe taken before approval — the rename's fence. */
	probe: FileProbe;
	signal?: AbortSignal;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
}

/** What one move produced. */
export interface MoveFileResult {
	/** The canonical source path (the store's old key). */
	from: string;
	/** The canonical destination path (the store's new key). */
	to: string;
	/** The destination's change-version, when the backend can report one. */
	version?: string;
	/** What the store's migration carried over, when a store was there. */
	migrated?: MigrateReport;
	/** A warning that did not stop the move. */
	warning?: string;
}

/**
 * Move one file the way this plugin moves files.
 *
 * @param input - both ends, the source probe and the call's context.
 * @returns both canonical paths plus the store's migration report.
 */
export async function moveFile(input: MoveFileInput): Promise<MoveFileResult> {
	const { io, exec, store, from, to, cwd, probe, signal, sandboxPolicy } = input;
	const outcome = await io.renameFile(from, to, cwd, probe, signal, sandboxPolicy);

	// Host consistency: the old path is gone, the new one exists. Observations
	// only — a rename never derives a write guard.
	const absentRecorded = await io.emitAbsent(outcome.from, exec, signal);
	clearAlignmentNotice(outcome.from);
	notifyDocumentClosed(outcome.from);
	await io.emitObserved(outcome.to, exec, signal);
	const version = await io.statVersion(outcome.to, signal);

	let migrated: MigrateReport | undefined;
	let warning: string | undefined;
	if (store !== undefined) {
		try {
			migrated = store.renamePath(outcome.from, outcome.to);
		} catch (error) {
			warning = `store migration failed; the sweep/TTL will reclaim the old path's rows: ${error instanceof Error ? error.message : String(error)
				}`;
		}
	}
	if (!absentRecorded) {
		warning = `${warning === undefined ? "" : `${warning} `}the old path's absence observation was not recorded (no observation policy mounted, or the path was recreated).`;
	}

	return {
		from: outcome.from,
		to: outcome.to,
		...(version !== undefined ? { version } : {}),
		...(migrated !== undefined ? { migrated } : {}),
		...(warning !== undefined ? { warning } : {}),
	};
}
