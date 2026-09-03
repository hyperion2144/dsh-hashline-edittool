/**
 * The dsh `edit` tool: hash-anchored literal range edits that shadow the
 * built-in `edit` on the agent's own scope layer. Registered through the
 * agent context so the model-facing contract (`op` / `anchor_start` /
 * `anchor_end?` / `lines?` inside an `edits:[]` array, with served-range
 * verification and reject-and-serve) replaces the built-in one.
 *
 * **0.4 contract.** The tool takes `{ path, edits: [{ op, anchor_start,
 * anchor_end?, lines? }, ...] }` and removes the legacy `batch_edit` tool.
 * Each item carries an `op` semantic:
 *   - `op: "ins"` — insert `lines` AFTER the `anchor_start` line (the
 *     `anchor_start` line itself is preserved; the line's content is
 *     prepended to `lines` and applied as a single-line replace)
 *   - `op: "del"` — delete the anchor_start..anchor_end range (or the
 *     single `anchor_start` line when `anchor_end` is omitted); `lines` is
 *     forbidden
 *   - `op: "replace"` — replace the anchor_start..anchor_end range with
 *     `lines`; `lines` must be non-empty
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
	lineNumbersSchema,
} from "./contract.js";
import { abortIf, isRec, visLines } from "./utils.js";
import { isJsonOutput, getEffectiveConfig } from "./config.js";
import { contextLinesCfg } from "./hashline/hash-assign.js";

import { enforceNoopLoop } from "./mutation.js";
import { runFileEdits, type PreparedItem, type FileEditResult } from "./edit-engine.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "./noop-guard.js";
import { commit, resolveMissingPath, snapshotIdFor } from "./mutation.js";
import { recordServedTruncated, recordServedAfterEdit } from "./session-view.js";
import { editDescription } from "./prompts.js";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
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
import { hashlineHeader } from "./hashline/index.js";

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
 * `path` against the top-level fallback, defaults `anchor_end` to `anchor_start` when
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
		anchor_start: string;
		anchor_end?: string;
		lines?: string[];
		path?: string;
	},
	absolutePath: string,
): PreparedItem {
	const itemPath = item.path ?? topLevelPath;
	// v2.0.3: anchor_end optional — omitted defaults to the anchor_start line
	// (single-line replace/delete). A multi-line replace without anchor_end was
	// already rejected by assertEditItem (the host runner may pass frozen args,
	// so the fold happens here by CONSTRUCTING the PreparedItem, not mutating).
	const toResolved = item.anchor_end ?? item.anchor_start;
	const replacementText =
		item.op === "del"
			? ""
			: (item.lines ?? []).join("\n");
	return {
		index,
		path: itemPath,
		absolutePath,
		remove_from: item.anchor_start,
		remove_to: toResolved,
		replacement_text: replacementText,
		op: item.op ?? "replace",
	};
}

/**
 * Extract the root-cause error code + the single-file error text verbatim
 * from a per-file batch failure string.
 *
 * A failed per-file batch surfaces as `[E_BATCH_ABORT] edits[i] (path) failed:
 * <inner full message>\nThe whole batch was rejected ...` where `<inner full
 * message>` is the single-file throw's own message (which may itself contain
 * the ±3 echo block + fresh-marker hint). Per the multi-file contract the
 * fail entry must carry the single-file error text UNCHANGED (the container
 * is per-file; the content is the single-file error), so we strip only the
 * batch wrapper prefix and the batch-abort tail — never the echo.
 */
function extractFailure(message: string): { code: string; message: string } {
	// Last error code wins: E_BATCH_ABORT wraps the inner cause.
	const codes = message.match(/\[(E_[A-Z_]+)\]/g) ?? [];
	const code = codes.length > 0 ? codes[codes.length - 1]! : "[E_INVALID_PATCH]";
	// Inner full message: strip the batch wrapper prefix and the batch tail;
	// keep everything else verbatim (echo block, fresh-marker hint included).
	let inner = message
		.replace(/^\[E_BATCH_ABORT\]\s*edits\[\d+\]\s*\([^)]*\)\s*failed:\s*/i, "")
		.replace(/\nThe whole batch was rejected[\s\S]*$/, "")
		.trim();
	// The inner error repeats the code at its head (`[E_STALE] 2 stale...`);
	// the fail block composes "Edit for <path> failed: <code> <message>", so drop
	// the leading code from message to avoid duplicating it.
	if (inner.startsWith(code)) inner = inner.slice(code.length).trim();
	return { code, message: inner.length > 0 ? inner : message };
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
		description: editDescription(getEffectiveConfig()),
	parameters: {
			path: { ...pathSchema },
			edits: { ...editsSchema, required: true },
			line_numbers: { ...lineNumbersSchema },
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					// 单文件形态 (0.4 compat)
					path: { type: "string" },
					before: { type: "string" },
					after: { type: "string" },
					added: { type: "integer" },
					removed: { type: "integer" },
					firstChangedLine: { type: "integer" },
					lastChangedLine: { type: "integer" },
					warnings: { type: "array", items: { type: "string" } },
					driftNotice: { type: "string" },
					noop: { type: "boolean" },
					// 多文件形态
					ok: { type: "boolean" },
					success: { type: "array" },
					fail: { type: "array" },
					// 两种形态都有
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as EditCanonicalValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as EditCanonicalValue & { success?: unknown[]; fail?: unknown[] };
				// 多文件形态: 无 before/after 整文件内容, 无法算 hunk diffs → 空 diffs
				if (Array.isArray(v.success) || Array.isArray(v.fail)) return { diffs: [] } as never;
				if (v.noop) return { diffs: [] } as never;
				const diffs = computeHunkDiffs(v.path, v.before, v.after);
				return { diffs } as never;
			},
		},
		presentCall: (args) => {
			const a = args as {
				path?: string;
				edits?: Array<{ anchor_start?: string; path?: string }>;
			};
			const topPath = typeof a.path === "string" ? a.path : undefined;
			if (topPath === undefined && (!Array.isArray(a.edits) || a.edits.length === 0)) return undefined;
			const firstEdit = Array.isArray(a.edits) ? a.edits[0] : undefined;
			const displayPath =
				(typeof firstEdit?.path === "string" ? firstEdit.path : topPath) ?? "";
			if (displayPath === "") return undefined;
			const line = parseLineFromHash(firstEdit?.anchor_start ?? "");
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
				const lineNumbers = canonical.line_numbers === true;
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

				// ---- 按 resolved 路径分组: 每组 = (displayPath, items) ----
				// per-item `path` ?? top-level `path` 决定每个 edit 的目标文件
				// (ADR-0002: 顶层 path 缺省时 assertEditRequest 已保证每个 item 带 path)
				const topLevelPath = canonical.path;
				const groups = new Map<
					string,
					Array<{ index: number; edit: (typeof canonical.edits)[number] }>
				>();
				// ins 传了 anchor_end: 不拒绝 (宽松), 提示用户不要传 — 按目标文件记录
				const insAnchorEndWarningsByPath = new Map<string, string[]>();
				for (let i = 0; i < canonical.edits.length; i++) {
					const e = canonical.edits[i]!;
					// ADR-0002 normalizer: item.path === topLevelPath 折叠为缺省（冗余声明不算多文件）
					const itemPath =
						e.path !== undefined && e.path === topLevelPath ? undefined : e.path;
					const path = itemPath ?? (topLevelPath as string);
					if (e.op === "ins" && e.anchor_end !== undefined) {
						const list = insAnchorEndWarningsByPath.get(path) ?? [];
						list.push(
							`edits[${i}].op:"ins" ignores anchor_end — ins inserts after anchor_start; drop the field.`,
						);
						insAnchorEndWarningsByPath.set(path, list);
					}
					const gList = groups.get(path) ?? [];
					gList.push({ index: i, edit: e });
					groups.set(path, gList);
				}

				// ---- 单文件快捷路径 (0.4 兼容, ADR-0004 D4): 仅一组时维持旧形态 ----
				if (groups.size === 1) {
					const [displayPath, group] = groups.entries().next().value as [
						string,
						Array<{ index: number; edit: (typeof canonical.edits)[number] }>,
					];
					const absolutePath = await io.resolve(displayPath, cwd, signal);
					const items = group.map(({ index, edit }) =>
						buildPreparedItem(index, displayPath, edit, absolutePath),
					);
					const file = await runFileEdits(io, items, { signal, sessionKey });
					await applyFileResultTo(file, {
						canonical,
						displayPath,
						resolutionWarning: (canonical as { _pathWarning?: string })._pathWarning,
						extraWarnings: insAnchorEndWarningsByPath.get(displayPath),
						sandbox,
						sandboxPolicy,
						exec,
						signal,
						io,
						absolutePath,
						sessionKey,
					});
					const canonicalValue = buildCanonicalFromFileResult(file, displayPath, lineNumbers);
					return isJsonOutput()
						? {
							...canonicalValue,
							// Schema-valid structured value; modelText carries the pure-JSON
							// envelope the model parses.
							modelText: JSON.stringify(buildEditJson(file, displayPath)),
						}
						: canonicalValue;
				}

				// ---- 多文件: 每组并发 + per-file atomic (ADR-0003) ----
				// 某文件失败只进 fail[]，不影响其他文件的结果
				const outcomes = await Promise.all(
					[...groups.entries()].map(async ([displayPath, group]) => {
						try {
							const absolutePath = await io.resolve(displayPath, cwd, signal);
							const items = group.map(({ index, edit }) =>
								buildPreparedItem(index, displayPath, edit, absolutePath),
							);
							const file = await runFileEdits(io, items, { signal, sessionKey });
							await applyFileResultTo(file, {
								canonical,
								displayPath,
								resolutionWarning: (canonical as { _pathWarning?: string })._pathWarning,
								extraWarnings: insAnchorEndWarningsByPath.get(displayPath),
								sandbox,
								sandboxPolicy,
								exec,
								signal,
								io,
								absolutePath,
								sessionKey,
							});
							return { ok: true as const, displayPath, file };
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							const detected = extractFailure(message);
							return {
								ok: false as const,
								displayPath,
								code: detected.code,
								message: detected.message,
							};
						}
					}),
				);

				const successes = outcomes.filter((o) => o.ok);
				const fails = outcomes.filter((o) => !o.ok);
				const success = successes.map((o) =>
					buildEditJson((o as { ok: true; file: FileEditResult; displayPath: string }).file, o.displayPath),
				);
				const fail = fails.map((o) => ({
					path: o.displayPath,
					code: o.code,
					message: o.message,
				}));

				if (!isJsonOutput()) {
					// text 模式: 聚合 prose (ADR-0004 D1) — 成功块在前, 失败块在后
					const appliedTotal = successes.reduce((n, o) => n + o.file.appliedCount, 0);
					const noopTotal = successes.reduce((n, o) => n + o.file.noopCount, 0);
					const totalEdits = canonical.edits.length;
					const summary =
						`Successfully edited ${successes.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied` +
						`${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.`;
					const blocks = outcomes.map((o) =>
						o.ok
							? `--- ${o.displayPath} ---\n${buildChangedModelText(o.file, o.displayPath, lineNumbers)}`
							: `Edit for ${o.displayPath} failed: ${o.code} ${o.message}`,
					);
					return { success, fail, modelText: `${summary}\n\n${blocks.join("\n\n")}` };
				}

				// json 模式: stringified envelope (ADR-0004 D2)
				const modelText = JSON.stringify({
					ok: success.length > 0,
					success,
					fail,
				});
				return { ok: success.length > 0, success, fail, modelText };
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
		canonical: { path?: string; edits: Array<unknown> };
		displayPath: string;
		resolutionWarning: string | undefined;
		extraWarnings?: string[];
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
				| { anchor_start: string; anchor_end?: string; lines?: string[]; op?: string }
				| undefined;
			if (head) {
				const payload = noopPayloadKey(
					ctx.absolutePath,
					head.anchor_start,
					head.anchor_end ?? head.anchor_start,
					(head.lines ?? []).join("\n"),
				);
				const count = trackNoopPayload(ctx.absolutePath, payload);
				if (count >= 2) {
					const notice = enforceNoopLoopSync({
						absolutePath: ctx.absolutePath,
						removeFrom: head.anchor_start,
						removeTo: head.anchor_end ?? head.anchor_start,
						replacementText: (head.lines ?? []).join("\n"),
						displayPath: ctx.displayPath,
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
	if (ctx.extraWarnings && ctx.extraWarnings.length > 0) {
		file.warnings.push(...ctx.extraWarnings);
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
	lineNumbers = false,
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
		modelText: buildChangedModelText(file, displayPath, lineNumbers),
	} as EditCanonicalValue;
	return result;
}

/** Project the FileEditResult into the model-facing text. Mirrors the layout
 *  of `buildChanged` in `edit-response.ts` so the 0.4 contract holds:
 *    1. `ANCHOR:FILELINE` header
 *    2. `+- line#hash │ content` diff rows (only the changed hunks, with 3
 *       lines of context on each side)
 *    3. One `Shift:` block per hunk
 *    4. Trailing success prefix + line summary
 *    5. Trailing warnings / drift notice
 *  Kept inline so this tool file owns the projection end-to-end. */
function buildChangedModelText(
	file: FileEditResult,
	displayPath: string,
	lineNumbers = false,
): string {
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
		contextLinesCfg(),
		file.resultHashes,
		file.originalHashes,
		lineNumbers,
	);
	const diffBody = diffResult.diff ? `${hashlineHeader()}\n${diffResult.diff}` : "";
	const successPrefix = `Successfully edited in ${displayPath}.`;
	const lineSummary =
		linesAdded > 0 || linesRemoved > 0
			? ` Added ${linesAdded} line(s), removed ${linesRemoved} line(s).`
			: "";
	const warningsBlock =
		file.warnings.length > 0 ? `\n\nWarnings:\n${file.warnings.join("\n")}` : "";
	const driftBlock = file.driftNotice ? `\n\n${file.driftNotice}` : "";
	return `${diffBody}\n\n${successPrefix}${lineSummary}${warningsBlock}${driftBlock}`;


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


/** Pure-JSON edit result: per-hunk before/after + final window lines. */
function buildEditJson(
	file: FileEditResult,
	displayPath: string,
): {
	ok: boolean;
	path: string;
	diff: Record<string, string>;
	hints: string[];
	warnings: string[];
	errors: JsonValue[];
} {
	// The json view of the diff is anchor-keyed, exactly like read's lines:
	// every row is `key: content`, where the key carries the row type in its
	// prefix — "-<old line#old hash>" for a removed row, "+<final line#new
	// hash>" for an added row, and the BARE anchor for context rows. No kind
	// field, no before/after windows.
	const diff = genDiff(
		file.originalNormalized,
		file.result,
		contextLinesCfg(),
		file.resultHashes,
		file.originalHashes,
	);
	const hints = (file.hunkShifts ?? [])
		.filter((h) => h.delta !== 0 || h.finalStartLine !== h.originalStartLine)
		.map(
			(h) =>
				`edits[${h.index}]: original ${h.originalStartLine === h.originalEndLine ? "line " + h.originalStartLine : "lines " + h.originalStartLine + ".." + h.originalEndLine} moved to ${h.finalStartLine === h.finalEndLine ? "line " + h.finalStartLine : "lines " + h.finalStartLine + ".." + h.finalEndLine} (${(h.delta > 0 ? "+" : "") + h.delta})`,
		);
	const diffDict: Record<string, string> = {};
	for (const r of diff.rows) {
		const key = r.kind === "-" ? `-${r.anchor}` : r.kind === "+" ? `+${r.anchor}` : r.anchor;
		diffDict[key] = r.content;
	}
	return {
		ok: true,
		path: displayPath,
		diff: diffDict,
		hints,
		warnings: file.warnings,
		errors: [],
	};
}


