/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Registered through the
 * agent context so the model-facing contract (remove_from/remove_to hashes,
 * served-range verification, reject-and-serve) replaces the built-in one.
 *
 * Structured presentation: the canonical value carries `path` / `before` /
 * `after` / `modelText` / `added` / `removed` / `firstChangedLine` /
 * `lastChangedLine` / `warnings` / `driftNotice`. `output.render` projects
 * the model-facing text from `modelText`. `output.presentationMeta` returns
 * `{ diffs: FileDiff[] }` computed from `before` / `after`. `presentResult`
 * returns a `DiffResultView` carrying the diffs. `presentCall` is generic
 * (no IO, pure on `args`) — a call-time presenter has no access to the
 * file's prior content per the dsh-tools spec.
 * @module dsh-hashline-edittool/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertEditRequest, pathSchema, removeFromSchema, removeToSchema, replacementTextSchema } from "./contract.js";
import { abortIf, isRec, splitLines } from "./utils.js";

import {
	enforceNoopLoop,
	commit,
	resolveMissingPath,
} from "./mutation.js";
import {
	applySingle,
	snapshotIdFor,
} from "./mutation.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { buildNoop, buildChanged, type RMeta } from "./mutation.js";
import { recordServedTruncated } from "./session-view.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import {
	computeHunkDiffs,
	diffsFromMeta,
	parseLineFromHash,
	type FileDiff,
} from "./presentation-helpers.js";
import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { withWorkspace } from "./session-view.js";

/** The hashline edit tool's canonical value (returned from `execute`). */
type EditCanonicalValue = {
	path: string;
	before: string;
	after: string;
	added: number;
	removed: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	warnings: string[];
	driftNotice?: string;
	noop: boolean;
	modelText: string;
} & { [key: string]: unknown };

/**
 * Register the hash-anchored `edit` tool on the calling agent's scope.
 * @param _rootCtx - host context (logger, lifecycle).
 * @param agentCtx - the agent's scoped context; registrations here land on the
 *   agent's OWN scope layer, shadowing the preset's built-in `edit`.
 * @param io - the filesystem bridge (ctx.fs backed in deployment).
 * @returns the exact disposer that unregisters the tool.
 */
export function buildEditTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "edit",
		description: EDIT_DESCRIPTION,
		parameters: {
			path: pathSchema,
			remove_from: removeFromSchema,
			remove_to: removeToSchema,
			replacement_text: replacementTextSchema,
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
					firstChangedLine: { type: "integer" },
					lastChangedLine: { type: "integer" },
					warnings: { type: "array", items: { type: "string" } },
					driftNotice: { type: "string" },
					noop: { type: "boolean", required: true },
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as EditCanonicalValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as EditCanonicalValue;
				if (v.noop) return { diffs: [] } as never;
				const diffs = computeHunkDiffs(v.path, v.before, v.after);
				return { diffs } as never;
			},
		},
		presentCall: (args) => {
			const a = args as { path?: string; remove_from?: string };
			if (typeof a.path !== "string") return undefined;
			const line = parseLineFromHash(a.remove_from ?? "");
			return {
				card: "generic",
				title: `Edit ${a.path}`,
				kind: "edit",
				locations: [{ path: a.path, ...(line !== undefined ? { line } : {}) }],
			};
		},
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const diffs: FileDiff[] | undefined = diffsFromMeta(result.meta);
			if (diffs === undefined) return undefined;
			// Extract the path from result.content's model text. We don't have
			// a guaranteed way to reach the canonical `value` here (only
			// `args` + `result.meta` + `result.content`), so derive the path
			// from the title embedded in result.content — but cleaner: rely on
			// args via the soft-validated meta path.
			const only = result.content.length === 1 ? result.content[0] : undefined;
			const text = only?.type === "text" ? only.text : undefined;
			if (text === undefined) return undefined;
			// Use the first diff's `path` for the title (all diffs in a single
			// edit share the same path).
			const path = diffs[0]?.path ?? "";
			return { card: "diff", title: `Edit ${path}`, diffs };
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;

				const canonical = normReq(args);
				const resolution = isRec(canonical)
					? await resolveMissingPath(canonical)
					: undefined;
				if (resolution && isRec(canonical)) {
					canonical.path = resolution.path;
				}
				assertEditRequest(canonical);
				// Default missing `remove_to` to `remove_from` — a single-line edit.
				if (canonical.remove_to === undefined || canonical.remove_to === "") {
					canonical.remove_to = canonical.remove_from;
				}
				const sandboxPolicy = await sandbox.resolvePolicy(
					"edit",
					canonical as unknown as FsEscalationArgs,
					exec,
				);

				const normalizedParams = canonical;
				const displayPath = normalizedParams.path;
				const path = displayPath;
				abortIf(signal);

				const pipeline = await applySingle(io, normalizedParams, cwd, {
					signal,
					sessionKey,
				});
				const {
					originalNormalized,
					originalHashes,
					result,
					bom,
					originalEnding,
					hadUtf8DecodeErrors,
					warnings,
					noopEdit,
					firstChangedLine,
					lastChangedLine,
					resultHashes,
					totalAddedLines,
					totalRemovedLines,
					driftNotice,
					range,
					absolutePath,
				} = pipeline;

				if (resolution) {
					warnings.unshift(resolution.warning);
				}

				const editsAttempted = 1;
				if (originalNormalized === result) {
					const payload = noopPayloadKey(
						absolutePath,
						canonical.remove_from,
						canonical.remove_to,
						canonical.replacement_text,
					);
					const count = trackNoopPayload(absolutePath, payload);
					const notice = await enforceNoopLoop({
						absolutePath,
						removeFrom: canonical.remove_from,
						removeTo: canonical.remove_to,
						replacementText: canonical.replacement_text,
						displayPath: path,
						count,
						sessionKey,
						originalHashes,
						originalNormalized,
						range,
					});
					if (notice) warnings.push(notice);

					const noopSnapshotId = await snapshotIdFor(io, absolutePath, signal);
					const noopResult = buildNoop({
						path,
						noopEdit,
						snapshotId: noopSnapshotId,
						editMeta: {
							editsAttempted,
							noopEditsCount: noopEdit ? 1 : 0,
							addedLines: 0,
							removedLines: 0,
						},
						warnings,
						driftNotice,
					});
					return {
						path: displayPath,
						before: originalNormalized,
						after: result,
						added: 0,
						removed: 0,
						...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
						...(lastChangedLine !== undefined ? { lastChangedLine } : {}),
						warnings,
						...(driftNotice !== undefined ? { driftNotice } : {}),
						noop: true,
						modelText: noopResult.content[0]!.text,
					} satisfies EditCanonicalValue;
				}

				clearNoopLoop(absolutePath);

				if (hadUtf8DecodeErrors) {
					warnings.push(
						"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
					);
				}

				abortIf(signal);
				await commit({
					io,
					files: [
						{
							absolutePath,
							displayPath: path,
							originalNormalized,
							bom,
							originalEnding,
							originalHashes,
							result,
						},
					],
					exec,
					sandbox,
					sandboxPolicy,
					signal,
					undoUnavailableMessage: (displayPath) =>
						`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${displayPath} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
					restoreUnwrittenUndos: true,
				});
				const updatedSnapshotId = await snapshotIdFor(io, absolutePath, signal);

				const editMeta: RMeta = {
					editsAttempted,
					noopEditsCount: noopEdit ? 1 : 0,
					firstChangedLine,
					lastChangedLine,
					addedLines: totalAddedLines,
					removedLines: totalRemovedLines,
				};

				const successInput = {
					path,
					originalNormalized,
					originalHashes,
					result,
					resultHashes,
					warnings,
					snapshotId: updatedSnapshotId,
					editMeta,
					driftNotice,
				};
				const changed = buildChanged(successInput);
				if (
					changed.details.servedRows &&
					changed.details.servedRows.length > 0
				) {
					await recordServedTruncated(
						sessionKey,
						absolutePath,
						changed.details.servedRows,
						splitLines(result).length,
						range.startLine - 1,
					);
				}
				return {
					path: displayPath,
					before: originalNormalized,
					after: result,
					added: totalAddedLines,
					removed: totalRemovedLines,
					...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
					...(lastChangedLine !== undefined ? { lastChangedLine } : {}),
					warnings,
					...(driftNotice !== undefined ? { driftNotice } : {}),
					noop: false,
					modelText: changed.content[0]!.text,
				} satisfies EditCanonicalValue;
			});
		},
	});
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerEditTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildEditTool(io, sandbox));
}
