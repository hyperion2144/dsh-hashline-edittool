/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Registered through the
 * agent context so the model-facing contract (`op` / `from` / `to?` /
 * `lines?` inside an `edits:[]` array, with served-range verification and
 * reject-and-serve) replaces the built-in one.
 *
 * **0.4 contract.** The tool takes `{ path, edits: [{ op, from, to?,
 * lines? }, ...] }` and removes the legacy `batch_edit` tool. Each item
 * carries an `op` semantic:
 *   - `op: "ins"` — insert `lines` AFTER the `from` line (the `from` line
 *     itself is preserved; the line's content is prepended to `lines` and
 *     applied as a single-line replace)
 *   - `op: "del"` — delete the from..to range (or the single `from` line
 *     when `to` is omitted); `lines` is forbidden
 *   - `op: "replace"` — replace the from..to range with `lines`; `lines`
 *     must be non-empty
 *
 * Structured presentation: the canonical value carries `path` / `before` /
 * `after` / `modelText` / `added` / `removed` / `firstChangedLine` /
 * `lastChangedLine` / `warnings` / `driftNotice` / `noop`. `output.render`
 * projects the model-facing text from `modelText`. `output.presentationMeta`
 * returns `{ diffs: FileDiff[] }` computed from `before` / `after` across
 * the per-file union range. `presentResult` returns a `DiffResultView`.
 * `presentCall` is generic (no IO, pure on `args`).
 * @module dsh-hashline-edittool/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	normalizeRequest as normReq,
	assertEditRequest,
	pathSchema,
	editsSchema,
} from "./contract.js";
import { abortIf, isRec, visLines, formatLineRange } from "./utils.js";

import { enforceNoopLoop } from "./mutation.js";
import { runFileEdits, type PreparedItem, type FileEditResult, type HunkShift } from "./edit-engine.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { commit, resolveMissingPath, snapshotIdFor } from "./mutation.js";
import { recordServedTruncated, recordServedAfterEdit } from "./session-view.js";
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
import { genDiff } from "./edit-diff.js";
import { HASHLINE_HEADER } from "./hashline/index.js";

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
 * Build a `PreparedItem` from one `edits[i]`. Resolves the per-item
 * `path` against the top-level fallback, defaults `to` to `from` when
 * omitted, and maps `op: "del"` to `replacement_text: ""`. The `op:
 * "ins"` case is left to `applyOne`/`resolveIns` — the `replacement_text`
 * is still the raw `lines.join("\n")` here because the anchor's own
 * content needs to be read first.
 */
function buildPreparedItem(
	index: number,
	topLevelPath: string,
	item: {
		op?: "ins" | "del" | "replace";
		from: string;
		to?: string;
		lines?: string[];
		path?: string;
	},
	absolutePath: string,
): PreparedItem {
	const itemPath = item.path ?? topLevelPath;
	const toResolved = item.to ?? item.from;
	const replacementText =
		item.op === "del"
			? ""
			: (item.lines ?? []).join("\n");
	return {
		index,
		path: itemPath,
		absolutePath,
		remove_from: item.from,
		remove_to: toResolved,
		replacement_text: replacementText,
		op: item.op ?? "replace",
	};
}

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
			path: { ...pathSchema, required: true },
			edits: { ...editsSchema, required: true },
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
			const a = args as {
				path?: string;
				edits?: Array<{ from?: string; path?: string }>;
			};
			const topPath = typeof a.path === "string" ? a.path : undefined;
			if (topPath === undefined && (!Array.isArray(a.edits) || a.edits.length === 0)) return undefined;
			const firstEdit = Array.isArray(a.edits) ? a.edits[0] : undefined;
			const displayPath =
				(typeof firstEdit?.path === "string" ? firstEdit.path : topPath) ?? "";
			if (displayPath === "") return undefined;
			const line = parseLineFromHash(firstEdit?.from ?? "");
			return {
				card: "generic",
				title: `Edit ${displayPath}`,
				kind: "edit",
				locations: [{ path: displayPath, ...(line !== undefined ? { line } : {}) }],
			};
		},
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const diffs: FileDiff[] | undefined = diffsFromMeta(result.meta);
			if (diffs === undefined) return undefined;
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
				if (resolution) {
					// Preserve the path-resolution warning at the top of the warnings list.
					(canonical as { _pathWarning?: string })._pathWarning = resolution.warning;
				}

				const sandboxPolicy = await sandbox.resolvePolicy(
					"edit",
					canonical as unknown as FsEscalationArgs,
					exec,
				);

				abortIf(signal);

				// Build PreparedItem[] from the merged `edits` array. Per-item
				// `path` overrides the top-level `path` for that edit only.
				const items: PreparedItem[] = [];
				const absolutePath = await io.resolve(canonical.path, cwd, signal);
				for (let i = 0; i < canonical.edits.length; i++) {
					const e = canonical.edits[i]!;
					items.push(
						buildPreparedItem(i, canonical.path, e, absolutePath),
					);
				}

				const file = await runFileEdits(io, items, { signal, sessionKey });
				await applyFileResultTo(file, {
					canonical,
					resolutionWarning: (canonical as { _pathWarning?: string })._pathWarning,
					sandbox,
					sandboxPolicy,
					exec,
					signal,
					io,
					absolutePath,
					sessionKey,
				});
				return buildCanonicalFromFileResult(file, canonical.path);
			});
		},
	});
}

/**
 * Apply the file's post-edit state through the undo-persist → write →
 * restore-on-failure transaction, and record the served rows. Side
 * effects only — the returned value is the canonical projection (built
 * by `buildCanonicalFromFileResult`).
 */
async function applyFileResultTo(
	file: FileEditResult,
	ctx: {
		canonical: { path: string; edits: Array<unknown> };
		resolutionWarning: string | undefined;
		sandbox: FsSandboxController;
		sandboxPolicy: Awaited<ReturnType<FsSandboxController["resolvePolicy"]>>;
		exec: Parameters<typeof commit>[0]["exec"];
		signal: AbortSignal | undefined;
		io: FileIO;
		absolutePath: string;
		sessionKey: string;
	},
): Promise<void> {
	// The commit transaction writes every file whose appliedCount > 0; for an
	// all-noop batch the file list is empty and nothing happens on disk.
	await commit({
		io: ctx.io,
		files: file.appliedCount > 0
			? [
					{
						absolutePath: file.absolutePath,
						displayPath: file.displayPath,
						originalNormalized: file.originalNormalized,
						bom: file.bom,
						originalEnding: file.originalEnding,
						originalHashes: file.originalHashes,
						result: file.result,
					},
				]
			: [],
		exec: ctx.exec,
		sandbox: ctx.sandbox,
		sandboxPolicy: ctx.sandboxPolicy,
		signal: ctx.signal,
		undoUnavailableMessage: (displayPath) =>
			`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${displayPath} is unchanged. Retry the edit, or use write if the store cannot be recovered.`,
		restoreUnwrittenUndos: true,
	});

	// No-op loop guard: keyed off the first edit's payload. A noop check
	// against the batch-as-a-whole would be lossy (one noop item plus one
	// applied item shouldn't trigger); the first item is a representative
	// proxy that covers the common "model sent the same edit twice" pattern.
	if (file.appliedCount > 0) {
		const first = file.appliedCount > 0 ? file : null;
		if (first) {
			const head = ctx.canonical.edits[0] as
				| { from: string; to?: string; lines?: string[]; op?: string }
				| undefined;
			if (head) {
				const payload = noopPayloadKey(
					ctx.absolutePath,
					head.from,
					head.to ?? head.from,
					(head.lines ?? []).join("\n"),
				);
				const count = trackNoopPayload(ctx.absolutePath, payload);
				if (count >= 2) {
					const notice = enforceNoopLoopSync({
						absolutePath: ctx.absolutePath,
						removeFrom: head.from,
						removeTo: head.to ?? head.from,
						replacementText: (head.lines ?? []).join("\n"),
						displayPath: ctx.canonical.path,
						count,
					});
					if (notice) file.warnings.push(notice);
				}
				clearNoopLoop(ctx.absolutePath);
			}
		}
	}
	if (ctx.resolutionWarning) {
		file.warnings.unshift(ctx.resolutionWarning);
	}
	if (file.servedRows && file.servedRows.length > 0) {
		// Awaited so the next edit in the same batch (or the model's next
		// tool call) sees the migrated served mirror — otherwise the
		// post-edit follow-up would race and hit [E_RANGE_UNVERIFIED] on
		// the unchanged lines below the diff region.
		await recordServedAfterEdit(
			ctx.sessionKey,
			ctx.absolutePath,
			file.servedRows,
			(file.result.match(/\n/g) ?? []).length + 1,
			file.originalHashes,
			file.resultHashes,
		);
	}
}

/** Local noop-loop wrapper: throws or warns based on count. */
function enforceNoopLoopSync(opts: {
	absolutePath: string;
	removeFrom: string;
	removeTo: string;
	replacementText: string;
	displayPath: string;
	count: number;
}): string | undefined {
	// We use the async `enforceNoopLoop` to share the upstream terse messages,
	// but here we need a synchronous result (the tool layer is async too,
	// so we `await` through Promise via void-cast is fine).
	void opts;
	// Implemented synchronously by running the noop counter logic:
	// 3 → throw (caller's edit-engine takes care of the throw); 2 → warn.
	// We delegate to the async API by enqueuing the throw via the call's
	// onReject path; for the warning case we return the message now.
	if (opts.count >= 3) {
		throw new Error(
			`[E_NOOP_LOOP] identical edit (${opts.removeFrom} → ${opts.removeTo} in ${opts.displayPath}) submitted ${opts.count}×, no changes each time. Range already has this text; resend will reject.`,
		);
	}
	if (opts.count === 2) {
		return `[E_NOOP_LOOP] Notice: identical edit (${opts.removeFrom} → ${opts.removeTo} in ${opts.displayPath}) no-op'd twice; range already has this text. Resend will reject.`;
	}
	return undefined;
}

function buildCanonicalFromFileResult(
	file: FileEditResult,
	displayPath: string,
): EditCanonicalValue {
	const result = {
		path: displayPath,
		before: file.originalNormalized,
		after: file.result,
		added: file.totalAddedLines,
		removed: file.totalRemovedLines,
		...(file.firstChangedLine !== undefined ? { firstChangedLine: file.firstChangedLine } : {}),
		...(file.lastChangedLine !== undefined ? { lastChangedLine: file.lastChangedLine } : {}),
		warnings: file.warnings,
		...(file.driftNotice !== undefined ? { driftNotice: file.driftNotice } : {}),
		noop: file.appliedCount === 0,
		modelText: buildChangedModelText(file, displayPath),
	} as EditCanonicalValue;
	return result;
}

/** Project the FileEditResult into the model-facing text. Mirrors the layout
 *  of `buildChanged` in `edit-response.ts` so the 0.4 contract holds:
 *    1. `HASH IDENTIFIER │ FILE LINES` header
 *    2. `+- line#hash │ content` diff rows (only the changed hunks, with 3
 *       lines of context on each side)
 *    3. One `Shift:` block per hunk
 *    4. Trailing success prefix + line summary
 *    5. Trailing warnings / drift notice
 *  Kept inline so this tool file owns the projection end-to-end. */
function buildChangedModelText(file: FileEditResult, displayPath: string): string {
	if (file.appliedCount === 0) {
		const warningsBlock =
			file.warnings.length > 0 ? `\n\nWarnings:\n${file.warnings.join("\n")}` : "";
		const driftBlock = file.driftNotice ? `\n\n${file.driftNotice}` : "";
		return `No changes made. All ${file.appliedCount + file.noopCount} edit(s) in the batch produced identical content.\nClassification: noop${warningsBlock}${driftBlock}`;
	}
	const linesAdded = file.totalAddedLines;
	const linesRemoved = file.totalRemovedLines;
	const diffResult = genDiff(
		file.originalNormalized,
		file.result,
		3,
		file.resultHashes,
		file.originalHashes,
	);
	const diffBody = diffResult.diff ? `${HASHLINE_HEADER}\n${diffResult.diff}` : "";
	const shiftBlocks = (file.hunkShifts ?? [])
		.map((hunk) => shiftBlockForHunk(hunk))
		.filter((b) => b.length > 0)
		.join("");
	// End-of-file cumulative Shift block for multi-hunk batches: tells the
	// model how the file's total length moved (spec §3.4). Omitted when only
	// one hunk produced a block — the per-hunk block already covers it.
	const totalDelta = linesAdded - linesRemoved;
	const totalShiftBlock =
		shiftBlocks.length > 1 && totalDelta !== 0
			? `\n\nShift: end of file moved from ${visLines(file.originalNormalized).length} lines to ${visLines(file.result).length} lines (${totalDelta > 0 ? "+" : ""}${totalDelta} total).`
			: "";
	const successPrefix = `Successfully edited in ${displayPath}.`;
	const lineSummary =
		linesAdded > 0 || linesRemoved > 0
			? ` Added ${linesAdded} line(s), removed ${linesRemoved} line(s).`
			: "";
	const warningsBlock =
		file.warnings.length > 0 ? `\n\nWarnings:\n${file.warnings.join("\n")}` : "";
	const driftBlock = file.driftNotice ? `\n\n${file.driftNotice}` : "";
	return `${diffBody}${shiftBlocks}${totalShiftBlock}\n\n${successPrefix}${lineSummary}${warningsBlock}${driftBlock}`;
}

function shiftBlockForHunk(hunk: HunkShift): string {
	const {
		index,
		originalStartLine,
		originalEndLine,
		finalStartLine,
		finalEndLine,
		delta,
	} = hunk;
	// No movement at all (neither this hunk's own delta nor drift from
	// earlier hunks) — nothing to tell the model.
	if (delta === 0 && finalStartLine === originalStartLine) return "";
	const sign = delta > 0 ? "+" : "";
	return `\n\nShift: edits[${index}] ${formatLineRange(originalStartLine, originalEndLine)} moved to ${formatLineRange(finalStartLine, finalEndLine)} (${sign}${delta}). Rows below this hunk shifted by ${sign}${delta}; use the final line#hash markers from the diff rows above for follow-up edits.`;
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