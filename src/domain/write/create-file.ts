/**
 * The shared CREATE step: format → write → announce.
 *
 * `write` and `apply_patch`'s `new` section both CREATE a file, and there is
 * exactly one way to do it in this plugin (#416): the model's content lands, the
 * automatic format pass may rewrite it (map #275, G3), the language server is
 * told what the file now holds, and the caller learns the content that is
 * really on disk.
 *
 * Everything else — the preview shape, the card, the response text — belongs to
 * the caller. This module owns the file-side facts.
 *
 * @module dsh-hashline-edittool/write/create-file
 */

import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO } from "../../infra/fs-bridge.js";
import { autoFormatMode } from "../../config.js";
import { detectEnding, restoreEndings, stripBOM } from "../../render/edit-diff.js";
import { notifyDocumentWritten } from "../../lsp/sync.js";
import { runAutoFormat, type AutoFormatOutcome } from "../format/auto-format.js";

/** What one create needs. */
export interface CreateFileInput {
	io: FileIO;
	/** The canonical path the file is written to. */
	absolutePath: string;
	/** The content the model handed over. */
	content: string;
	signal?: AbortSignal;
	/** The calling execution: the write's observation rides on it. */
	exec?: ToolExecution;
	sandboxPolicy: SandboxExecutionPolicy | undefined;
}

/** What one create produced. */
export interface CreateFileResult {
	/** The content that is really on disk (the formatted one when a formatter ran). */
	after: string;
	/** The format pass's report, when a formatter ran or was skipped. */
	formatOutcome?: AutoFormatOutcome;
}

/**
 * Write a file the way this plugin writes files.
 *
 * The model's content lands FIRST (so a failing format rewrite leaves the
 * model's own text on disk — the skipped format section says why), then the
 * automatic format pass may rewrite it, and finally the language server is told
 * what the file holds: `notifyDocumentWritten` is the single funnel every write
 * goes through (`src/lsp/write-tracker.ts`).
 *
 * @param input - the file, the content and the call's context.
 * @returns the content on disk plus the format pass's report.
 */
export async function createFile(input: CreateFileInput): Promise<CreateFileResult> {
	const { io, absolutePath, content, signal, exec, sandboxPolicy } = input;
	await io.writeText(absolutePath, content, signal, exec, sandboxPolicy);

	let after = content;
	let formatOutcome: AutoFormatOutcome | undefined;
	if (autoFormatMode() !== "off" && content.trim().length > 0) {
		const shape = stripBOM(content);
		const outcome = await runAutoFormat({
			io,
			absolutePath,
			modelContent: shape.text,
		});
		if (outcome.status === "formatted") {
			const finalContent = shape.bom + restoreEndings(outcome.content, detectEnding(content));
			try {
				await io.writeText(absolutePath, finalContent, signal, exec, sandboxPolicy);
				after = finalContent;
				formatOutcome = outcome;
			} catch (rewriteError) {
				// The disk keeps the model content the first write put there;
				// the skipped section says why the formatted text is not there.
				formatOutcome = {
					...outcome,
					status: "skipped",
					content: shape.text,
					reason: rewriteError instanceof Error ? rewriteError.message : String(rewriteError),
				};
			}
		} else if (outcome.status === "skipped") {
			formatOutcome = outcome;
		}
	}

	notifyDocumentWritten(absolutePath, after);
	return { after, ...(formatOutcome !== undefined ? { formatOutcome } : {}) };
}
