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
import { toLF, stripBOM, genDiff, restoreEndings } from "../render/edit-diff.js";
import { cntDiff, splitLines } from "../infra/utils.js";
import { assertUndoRequest, normalizeRequest as normReq, lineNumbersSchema } from "../contract/contract.js";
import { contentChecksum, contextLinesCfg } from "../hashline/hash-assign.js";
import { changedRange } from "../hashline/anchor-pipeline.js";
import { getUndo, clearUndo, popUndo, undoDepth } from "../domain/edit/undo-edit.js";
import { recordServedTruncated, reconcileServed, anchorForInWorkspace } from "../domain/session/session-view.js";
import { restoreAnchorBinding } from "../domain/session/anchor-entry.js";
import { UNDO_DESCRIPTION } from "../domain/edit/prompts.js";
import { anchorsFor } from "../domain/session/anchor-state.js";
import {
	computeHunkDiffs,
	diffsFromMeta,
	diffRowsFromGenDiff,
	type FileDiff,
} from "../render/edit-card.js";
import type { FileIO } from "../infra/fs-bridge.js";
import { execCwd, execSessionKey, openWorkspaceStore } from "../domain/session/session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { withWorkspace } from "../domain/session/session-view.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { notifyDocumentWritten } from "../lsp/sync.js";
import { responseBudgetChars, spillModelTextOverflow } from "../infra/response-stream.js";
import {
	deliverDiagnosticsAfterWrite,
	diagnosticsMeta,
	formatDiagnosticsSection,
	prepareWriteDiagnostics,
	type DiagMetaEntry,
} from "../lsp/auto-diag.js";

/** The hashline undo tool's canonical value (returned from `execute`). */
type UndoCanonicalValue = {
	path: string;
	before: string;
	after: string;
	added: number;
	removed: number;
	modelText: string;
	empty: boolean;
	/** #131: inline diagnostics meta, present only when a push arrived in the window. */
	diagnostics?: DiagMetaEntry[];
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
					error: errorFieldSchema,
					empty: { type: "boolean", required: true },
					// The card's structured rows (declared because the DSL validates the
					// returned value): the revert's diff, with the anchors the reader sees.
					// #131: inline LSP diagnostics, when a push arrived in the window.
					diagnostics: { type: "array" },
					diffRows: { type: "array" },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as UndoCanonicalValue).modelText },
			],
			// The card's data, projected from the value: the hunks of the revert and
			// the anchored rows beside them — the same two fields `edit` emits, so an
			// undo wears the edit card instead of the default view.
			presentationMeta: (_args, value) => {
				const v = value as UndoCanonicalValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
				if (v.empty) return { diffs: [] } as never;
				const diffs = computeHunkDiffs(v.path, v.before, v.after);
				const diffRows = Array.isArray(v.diffRows) && v.diffRows.length > 0 ? v.diffRows : undefined;
				const diagMeta = (v as { diagnostics?: unknown }).diagnostics;
				return {
					diffs,
					...(diffRows !== undefined ? { diffRows } : {}),
					...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
				} as never;
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
			// The revert allocates anchors for the restored content's diff window,
			// and the anchor port writes only to an OPEN store (#171 probe).
			await openWorkspaceStore(cwd);
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
			// Stale check (#176): a row written by this build carries a checksum of the
			// post-edit body, so compare checksums; a legacy row carries the body, so
			// compare text. Both answer the same question — "is the file still what my
			// edit produced?" — and the checksum form is what let the undo stack stop
			// storing a second full copy of every edited file.
			const stillPostEdit =
				undo.resultChecksum !== undefined && undo.resultChecksum !== ""
					? contentChecksum(currentRaw) === undo.resultChecksum
					: currentRaw === undo.bom + restoreEndings(undo.resultContent, undo.originalEnding);
			if (!stillPostEdit) {
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
			// LAZY (#169): the `-` side is a pure VIEW — removal rows are historical,
			// nothing is allocated for them.
			const currentHashes = anchorsFor(absolutePath, currentNormalized);
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
			// The revert's diff is rendered AFTER the write (see below): its `+`
			// rows must carry the anchors the RESTORED content actually has now,
			// not the historical undo.hashes — advertised anchors may never be
			// lies (persisted == served == visible, #169).
			const restoredRange = changedRange(currentNormalized, undo.content);
			// #131: baseline BEFORE the revert, so the wait measures pushes
			// against a pre-write baseline.
			const diagCtx = prepareWriteDiagnostics(absolutePath, execCwd(exec));
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
			notifyDocumentWritten(absolutePath, undo.bom + restoreEndings(undo.content, undo.originalEnding));
			// LAZY (#169): the restored content is live — realign the sparse state
			// against it, allocate EXACTLY the revert diff's window rows, and render
			// the `+` side with those anchors.
			//
			// #223 / contract §2 "undo": this is a SNAPSHOT ROLLBACK, not a remap.
			// The binding saved with the undo entry (`hashes`) is put back WHOLESALE
			// before anything is rendered, so the anchors the model held before the
			// edit are the anchors it holds after the revert — content, binding and
			// checksum together. Remapping instead would keep the undon edit's
			// anchors and lose those handles, and a model that undoes and re-submits
			// its previous edit would be rejected for holding anchors it did use.
			restoreAnchorBinding({ path: absolutePath, content: undo.content, hashes: undo.hashes });
			const dryWindow = genDiff(
				currentNormalized,
				undo.content,
				contextLinesCfg(),
				undefined,
				undefined,
				lineNumbers,
			);
			const restoredHashes = anchorsFor(absolutePath, undo.content);
			const windowLineNos = [
				...new Set(dryWindow.servedRows.map((r) => r.position + 1)),
			].sort((a, b) => a - b);
			// #223: mint + serve in one transaction, through the single entry point.
			const windowAllocated = await anchorForInWorkspace({
				cwd,
				absolutePath,
				content: undo.content,
				lines: windowLineNos,
				sessionKey,
			});
			for (let wi = 0; wi < windowLineNos.length; wi++) {
				restoredHashes[windowLineNos[wi]! - 1] = windowAllocated[wi]!;
			}
			const undoDiffResult = genDiff(
				currentNormalized,
				undo.content,
				// The CONFIGURED context, like the sibling diff above: a hardcoded 1 here
				// made the revert's diff — model text AND card rows — ignore
				// `context_lines`.
				contextLinesCfg(),
				restoredHashes,
				currentHashes,
				lineNumbers,
			);
			const undoDiff = undoDiffResult.diff;
			// #131: the revert is a real write, so it reports like one — inline
			// inside the window, else the bounded async wait. OUTSIDE the write
			// try on purpose: delivery never throws, and a diagnostics problem
			// must not be mistaken for a sandbox write failure.
			const diagnostics =
				diagCtx === undefined
					? undefined
					: await deliverDiagnosticsAfterWrite({
							...diagCtx,
							toolName: "undo_last_edit",
							text: undo.content,
							absolutePath,
							displayPath: path,
							io,
							exec,
						});
			const diagMeta = diagnostics === undefined ? undefined : diagnosticsMeta([diagnostics]);
			const diagSection = diagnostics === undefined ? "" : formatDiagnosticsSection([diagnostics]);

			// The `snapshots` row that used to be written here is GONE with the table
			// (contract §8). It was a legacy cache keyed by (path, checksum,
			// line_count) whose only reader, `getSnapshot`, had no caller left — so the
			// write persisted nothing anyone would ever look up. What actually makes
			// the restored binding durable is `restoreAnchorBinding` above, which
			// writes `anchor_lines` + `anchor_meta` for the reverted content.
			//
			// The LAZY note it also carried still holds: no explicit re-seed is needed,
			// because the sparse state detects the content change on the next access.

			// CONSUME the entry, do not wipe the history: the entry below it is the
			// next edit to revert, which is what makes this a stack (#151/P5).
			await popUndo(absolutePath);
			const remaining = await undoDepth(absolutePath);

			const parts: string[] = [`Undone last edit on ${path}.`];
			if (linesAddedByEdit > 0 || linesRemovedByEdit > 0) {
				parts.push(
					`Removed ${linesAddedByEdit} line(s) that were added and restored ${linesRemovedByEdit} line(s) that were removed.`,
				);
			}
			parts.push(
				"File reverted to previous state. The revert diff\u2019s `+` rows (restored lines) carry fresh anchors for follow-up edits; `-` rows are the removed lines — their anchors are dead.",
			);
			if (remaining > 0) {
				parts.push(
					`${remaining} earlier edit(s) on this file can still be undone with another undo_last_edit call.`
				);
			}

			if (undoDiffResult.servedRows.length > 0) {
				try {
					await recordServedTruncated(
						sessionKey,
						absolutePath,
						undoDiffResult.servedRows.map((r) => ({ position: r.position, anchor: r.anchor })),
						splitLines(undo.content).length,
						restoredRange?.firstChangedLine ?? 0,
					);
				// The revert released whatever the undone edit had made live; drop
				// those from the mirror so served == anchor_lines (#171).
				await reconcileServed(sessionKey, absolutePath, undo.content);
				} catch (error) {
					// issue #136: the revert itself succeeded; a lost served mirror must
					// still reach the model or the next edit rejects with "never served".
					parts.push(
						`[E_SERVED_RECORD] served state could not be recorded (${
							error instanceof Error ? error.message : String(error)
						}); re-read before the next edit.`,
					);
				}
			}

			const fullReport =
				diagSection === ""
					? [parts.join("\n"), "", "Diff of the revert:", "", undoDiff].join("\n")
					: [parts.join("\n"), "", "Diff of the revert:", "", undoDiff, "", diagSection].join("\n");
			const streamedUndo = await spillModelTextOverflow({
				sessionKey,
				producer: "undo_last_edit",
				consumer: "read",
				kind: "report-segment",
				modelText: fullReport,
				budgetChars: responseBudgetChars(),
			});
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
				// The CARD's rows: the revert's own diff, built once and used by both
				// the meta and the model text, so the gutter anchors the same lines
				// the reader sees (ADR-0005 — never a re-parse of `modelText`).
				diffRows: diffRowsFromGenDiff(undoDiffResult.rows),
				...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
				modelText: streamedUndo.modelText,
				empty: false,
			} satisfies UndoCanonicalValue;
		}).catch((error: unknown) => ({
			path: pathFromArgs(args) ?? "",
			before: "",
			after: "",
			added: 0,
			removed: 0,
			empty: true,
			...(thrownErrorResult(error, { path: pathFromArgs(args) }) as unknown as Record<string, unknown>),
		}) as never);
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
