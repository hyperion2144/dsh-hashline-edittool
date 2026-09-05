/**
 * The dsh `undo_last_edit` tool: reverts the last hashline edit on a file,
 * only when the file still matches the stored post-edit content — a later
 * external write clears the history instead of being overwritten.
 *
 * Structured presentation: the canonical value carries `path` / `before`
 * (post-edit content) / `after` (pre-edit content, i.e. the revert target).
 * `output.render` projects the model-facing text. `output.presentationMeta`
 * returns `{ diffs: FileDiff[] }` — the diff of the revert. `presentResult`
 * emits a `DiffResultView`. `presentCall` is generic.
 * @module dsh-hashline-edittool/tool-undo
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { toLF, stripBOM, genDiff, restoreEndings } from "./edit-diff.js";
import { cntDiff, splitLines } from "./utils.js";
import { assertUndoRequest, normalizeRequest as normReq, lineNumbersSchema } from "./contract.js";
import { upsertSnapshotFor } from "./hash-store.js";
import { contentChecksum, contextLinesCfg } from "./hashline/hash-assign.js";
import { lineHashes } from "./hashline/hash.js";
import { changedRange } from "./hashline/anchor-pipeline.js";
import { getUndo, clearUndo } from "./undo-edit.js";
import { recordServedTruncated } from "./session-view.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import {
	computeHunkDiffs,
	diffsFromMeta,
	type FileDiff,
} from "./presentation-helpers.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./session-view.js";

/** The hashline undo tool's canonical value (returned from `execute`). */
type UndoCanonicalValue = {
	path: string;
	before: string;
	after: string;
	added: number;
	removed: number;
	modelText: string;
	empty: boolean;
} & { [key: string]: unknown };

/**
 * Register the `undo_last_edit` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildUndoTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "undo_last_edit",
		description: UNDO_DESCRIPTION,
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Path to the file to undo",
			},
			line_numbers: {
				...lineNumbersSchema,
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					before: { type: "string", required: true },
					after: { type: "string", required: true },
					added: { type: "integer", required: true },
					removed: { type: "integer", required: true },
					modelText: { type: "string", required: true },
					empty: { type: "boolean", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as UndoCanonicalValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as UndoCanonicalValue;
				if (v.empty) return { diffs: [] } as never;
				const diffs = computeHunkDiffs(v.path, v.before, v.after);
				return { diffs } as never;
			},
		},
		presentCall: (args) => {
			const a = args as { path?: string };
			if (typeof a.path !== "string") return undefined;
			return {
				card: "generic",
				title: `Undo ${a.path}`,
				kind: "edit",
				locations: [{ path: a.path }],
			};
		},
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const diffs: FileDiff[] | undefined = diffsFromMeta(result.meta);
			if (diffs === undefined) return undefined;
			const path = diffs[0]?.path ?? "";
			return { card: "diff", title: `Undo ${path}`, diffs };
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
			const cwd = execCwd(exec);
			const sessionKey = execSessionKey(exec);
			const signal = exec.signal;

			const canonical = normReq(args);
			assertUndoRequest(canonical);
			const lineNumbers = canonical.line_numbers !== false;
			const path = canonical.path;
			const absolutePath = await io.resolve(path, cwd, signal);
			const sandboxPolicy = await sandbox.resolvePolicy("undo_last_edit", canonical as unknown as FsEscalationArgs, exec);
			const undo = await getUndo(absolutePath);
			if (!undo) {
				return {
					path: absolutePath,
					before: "",
					after: "",
					added: 0,
					removed: 0,
					modelText: `No undo history for ${path}. There is no previous edit to revert.`,
					empty: true,
				} satisfies UndoCanonicalValue;
			}

			let currentRaw: string;
			try {
				currentRaw = await io.readText(absolutePath, signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("[E_NOT_FOUND]")) {
					await clearUndo(absolutePath);
					return {
						path: absolutePath,
						before: "",
						after: "",
						added: 0,
						removed: 0,
						modelText: `[E_UNDO_STALE] Cannot undo last edit on ${path}: the file no longer exists. Call read() to inspect the current state.`,
						empty: true,
					} satisfies UndoCanonicalValue;
				}
				throw error;
			}
			if (
				currentRaw !==
				undo.bom + restoreEndings(undo.resultContent, undo.originalEnding)
			) {
				await clearUndo(absolutePath);
				return {
					path: absolutePath,
					before: "",
					after: "",
					added: 0,
					removed: 0,
					modelText: `[E_UNDO_STALE] Cannot undo last edit on ${path}: the file was modified after the edit, so undoing would overwrite those changes. Call read() to inspect the current state.`,
					empty: true,
				} satisfies UndoCanonicalValue;
			}

			const { text: currentStripped } = stripBOM(currentRaw);
			const currentNormalized = toLF(currentStripped);
			const currentHashes = await lineHashes(currentNormalized, absolutePath);
			const diffResult = genDiff(
				undo.content,
				currentNormalized,
				contextLinesCfg(),
				undefined,
				undo.hashes,
				lineNumbers,
			);
			const linesAddedByEdit = cntDiff(diffResult.diff, "+");
			const linesRemovedByEdit = cntDiff(diffResult.diff, "-");
			const undoDiffResult = genDiff(
				currentNormalized,
				undo.content,
				1,
				undo.hashes,
				currentHashes,
				lineNumbers,
			);
			const undoDiff = undoDiffResult.diff;
			const restoredRange = changedRange(currentNormalized, undo.content);

			try {
				await io.writeText(
					absolutePath,
					undo.bom + restoreEndings(undo.content, undo.originalEnding),
					signal,
					exec,
					sandboxPolicy,
				);
			} catch (error) {
				throw sandbox.mapError(error, sandboxPolicy);
			}

			try {
				await upsertSnapshotFor(
					absolutePath,
					contentChecksum(undo.content),
					splitLines(undo.content).length,
					undo.hashes,
				);
			} catch (error) {
				console.error(
					"Failed to restore hash store snapshot after undo:",
					error,
				);
			}

			await clearUndo(absolutePath);

			const parts: string[] = [`Undone last edit on ${path}.`];
			if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
				parts.push(
					`Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
				);
			}
			parts.push(
				"File reverted to previous state. The revert diff\u2019s `+` rows (restored lines) carry fresh anchors for follow-up edits; `-` rows are the removed lines — their anchors are dead.",
			);

			if (undoDiffResult.servedRows.length > 0) {
await recordServedTruncated(
				sessionKey,
					absolutePath,
					undoDiffResult.servedRows.map((r) => ({ position: r.position, anchor: r.anchor })),
					splitLines(undo.content).length,
					restoredRange?.firstChangedLine ?? 0,
				);
			}

			return {
				path: absolutePath,
				// `before` is the post-edit content (what the file had), `after`
				// is the pre-edit content (the revert target). Naming aligns with
				// dsh-tool-fs: `before` = pre-change state, `after` = post-change.
				// For the undo, the "change" is the revert itself.
				before: currentNormalized,
				after: undo.content,
				added: linesAddedByEdit,
				removed: linesRemovedByEdit,
				modelText: [parts.join("\n"), "", "Diff of the revert:", "", undoDiff].join("\n"),
				empty: false,
			} satisfies UndoCanonicalValue;
			})
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerUndoTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildUndoTool(io, sandbox));
}
