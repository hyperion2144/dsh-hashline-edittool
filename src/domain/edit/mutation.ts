/**
 * Commit — one file's landing as ONE domain transaction.
 *
 * The seam owns persist-undo → atomic write → restore-on-failure → the
 * served-mirror settlement, under ONE failure policy: a write that landed is
 * never un-landed by a settlement failure — the lost mirror becomes a
 * `[E_SERVED_RECORD]` warning the caller reports (issue #136). `edit`,
 * `ast_edit` and `apply_patch` all land files through here; what each caller
 * keeps is its error vocabulary (`undoUnavailableMessage`), never the policy.
 *
 * The engine half — `runFileEdits`, the anchor remap, the noop guard — stays
 * in edit-engine.ts: this seam owns the LANDING, not the edit.
 *
 * @module dsh-hashline-edittool/mutation
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { FileIO } from "../../infra/fs-bridge.js";
import type { FsSandboxController } from "../../infra/sandbox.js";
import type { LineEnding } from "../../render/edit-diff.js";
import { persistUndoAndWrite } from "./edit-engine.js";
import { recordServedAfterEdit, reconcileServed } from "../session/session-view.js";


/** One file to land: its before/after text and the rows the call served. */
export interface CommitFile {
	absolutePath: string;
	displayPath: string;
	originalNormalized: string;
	bom: string;
	originalEnding: LineEnding;
	originalHashes: string[];
	result: string;
	/**
	 * The rows this call served for the file. Present whenever the landing
	 * must keep those anchors writable for the next call; the settlement
	 * records them and reconciles the mirror against the landed text.
	 */
	servedRows?: Array<{ position: number; anchor: string }>;
}

/** One file's settlement outcome — a warning, or nothing. */
export interface CommitOutcome {
	/**
	 * The settlement failed AFTER a successful write. The write stands; the
	 * caller reports this so the model re-reads before its next edit instead
	 * of trusting a mirror that no longer matches the file (issue #136).
	 */
	servedWarning?: string;
}

/**
 * Land `files` on disk: every undo entry persisted first, then the writes,
 * then the served-mirror settlement — one transaction per call.
 *
 * @returns one {@link CommitOutcome} per file, in order.
 */
export async function commit(opts: {
	io: FileIO;
	files: readonly CommitFile[];
	exec: ToolExecution;
	sandbox: FsSandboxController;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
	signal?: AbortSignal;
	undoUnavailableMessage: (displayPath: string) => string;
	restoreUnwrittenUndos?: boolean;
	/** The session whose served mirror is settled. Absent → no settlement. */
	sessionKey?: string;
}): Promise<CommitOutcome[]> {
	await persistUndoAndWrite({
		io: opts.io,
		files: opts.files.map((file) => ({
			absolutePath: file.absolutePath,
			displayPath: file.displayPath,
			originalNormalized: file.originalNormalized,
			bom: file.bom,
			originalEnding: file.originalEnding,
			originalHashes: file.originalHashes,
			result: file.result,
		})),
		exec: opts.exec,
		sandbox: opts.sandbox,
		sandboxPolicy: opts.sandboxPolicy,
		signal: opts.signal,
		undoUnavailableMessage: opts.undoUnavailableMessage,
		restoreUnwrittenUndos: opts.restoreUnwrittenUndos,
	});
	return settleServed(opts);
}

/** Record and reconcile the served mirror for every landed file (issue #136). */
async function settleServed(opts: {
	files: readonly CommitFile[];
	sessionKey?: string;
}): Promise<CommitOutcome[]> {
	if (opts.sessionKey === undefined) {
		return opts.files.map(() => ({}));
	}
	const outcomes: CommitOutcome[] = [];
	for (const file of opts.files) {
		if (file.servedRows === undefined || file.servedRows.length === 0) {
			outcomes.push({});
			continue;
		}
		try {
			// Awaited so the next edit in the same batch (or the model's next
			// tool call) sees the migrated served mirror — otherwise the
			// post-edit follow-up would race and hit [E_RANGE_UNVERIFIED] on
			// the unchanged lines below the diff region.
			await recordServedAfterEdit(opts.sessionKey, file.absolutePath, file.servedRows);
			// The write RELEASED the anchors of the lines it replaced; drop
			// them from the served mirror so served == anchor_lines, not
			// served ⊃ live (#171).
			await reconcileServed(opts.sessionKey, file.absolutePath, file.result);
			outcomes.push({});
		} catch (error) {
			// issue #136: the write itself succeeded; a lost served mirror must
			// still reach the model, or the next edit rejects with "never
			// served" out of nowhere.
			outcomes.push({
				servedWarning: `[E_SERVED_RECORD] served state could not be recorded for ${file.displayPath} (${error instanceof Error ? error.message : String(error)
					}); re-read before the next edit.`,
			});
		}
	}
	return outcomes;
}
