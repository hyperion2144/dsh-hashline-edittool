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
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
	normalizeRequest as normReq,
	assertEditRequest,
	pathSchema,
	buildEditsSchema,
	anchorOf,
	declaredLineOf,
	lineNumbersSchema,
	type EditOp,
} from "../contract/contract.js";
import { isJsonOutput, getEffectiveConfig } from "../config.js";
// Marker parsing, not symbol reading: `lineHintOf` moved beside the other
// `<line>:<anchor>` handling when the block-op path was removed.
import { lineHintOf } from "../hashline/declaration.js";
import type { AnchorRef } from "../hashline/declaration.js";
import { abortIf, isRec, visLines } from "../infra/utils.js";
import { contextLinesCfg } from "../hashline/hash-assign.js";

import { enforceNoopLoop } from "../domain/edit/mutation.js";
import { runFileEdits, type PreparedItem, type FileEditResult } from "../domain/edit/edit-engine.js";
import {
	clearNoopLoop,
	noopPayloadKey,
	trackNoopPayload,
} from "../domain/edit/noop-guard.js";
import { commit, resolveMissingPath, snapshotIdFor } from "../domain/edit/mutation.js";
import { recordServedTruncated, recordServedAfterEdit } from "../domain/session/session-view.js";
import { editDescription } from "../domain/edit/prompts.js";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import {
	computeHunkDiffs,
	diffsFromMeta,
	parseLineFromHash,
	type FileDiff,
} from "../render/edit-card.js";
import type { FileIO } from "../infra/fs-bridge.js";
import { execCwd, execSessionKey } from "../domain/session/session-view.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { withWorkspace } from "../domain/session/session-view.js";
import { genDiff } from "../render/edit-diff.js";
import { EDIT_DIFF_LEGEND } from "../domain/edit/edit-response.js";
import { diffDictFrom, diffRowsFromGenDiff, type EditDiffRow } from "../render/edit-card.js";

import {
	deliverDiagnosticsAfterWrite,
	diagnosticsJson,
	diagnosticsMeta,
	formatDiagnosticsSection,
	prepareWriteDiagnostics,
	type DiagMetaEntry,
	type FileDiagnostics,
} from "../lsp/auto-diag.js";

/** The edit value with an optional inline diagnostics attachment (#131). */
type EditValue = EditCanonicalValue & { diagnostics?: DiagMetaEntry[] };
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
	/** Structured diff-window rows for the web card (rendering channel, issue #71). */
	diffRows?: EditDiffRow[];
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
/** The raw reference string of an anchor field (declaration form → its anchor). */
function rawAnchor(field: AnchorRef): string {
	return typeof field === "string" ? field : String((field as { anchor?: unknown }).anchor ?? "");
}

//
// Exported so `ast_edit` builds its items the SAME way rather than re-deriving
// the anchor folding: a second implementation would drift, and the drift would
// show up as edits that land on the wrong lines only for one of the two tools.
export function buildPreparedItem(
	index: number,
	topLevelPath: string,
	item: {
		op?: EditOp;
		// Both optional here: which one is REQUIRED depends on `op`, and the
		// contract has already enforced that. `ins` arrives with `anchor_after`
		// and no `anchor_start`; the other two, the reverse.
		anchor_start?: AnchorRef;
		anchor_after?: AnchorRef;
		anchor_end?: AnchorRef;
		lines?: string[];
		pattern?: string;
		replacement?: string;
		flags?: string;
		path?: string;
	},
	absolutePath: string,
): PreparedItem {
	const itemPath = item.path ?? topLevelPath;
	// v2.0.3: anchor_end optional — omitted defaults to the anchor_start line
	// (single-line replace/delete). A multi-line replace without anchor_end was
	// already rejected by assertEditItem (the host runner may pass frozen args,
	// so the fold happens here by CONSTRUCTING the PreparedItem, not mutating).
	// require_line_content: the `{ anchor, line }` declaration form folds to
	// the anchor string here, with the declared text carried as expected*
	// fields for the pipeline gate (declaration.ts). An OMITTED anchor_end
	// declares nothing for the end boundary (contract #76: only start).
	const startAnchor = item.op === "ins" ? item.anchor_after : item.anchor_start;
	if (startAnchor === undefined) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}] has no anchor: op:"ins" takes "anchor_after", the other ops take "anchor_start".`,
		);
	}
	const toResolved = item.anchor_end !== undefined ? anchorOf(item.anchor_end) : anchorOf(startAnchor);
	const replacementText =
		item.op === "del"
			? ""
			: (item.lines ?? []).join("\n");
	return {
		index,
		path: itemPath,
		absolutePath,
		remove_from: anchorOf(startAnchor),
		remove_to: toResolved,
		replacement_text: replacementText,
		op: item.op ?? "replace",
		// `op: "sed"` carries its substitution through untouched: the regex runs
		// in the engine, over the resolved range's own lines.
		...(item.pattern !== undefined ? { pattern: item.pattern } : {}),
		...(item.replacement !== undefined ? { replacement: item.replacement } : {}),
		...(item.flags !== undefined ? { flags: item.flags } : {}),
		anchorEndAsserted: item.anchor_end !== undefined,
		// The numeric hints, when the caller wrote the `<line>:<anchor>` form.
		// `anchorOf` is what strips them, so read them off the raw field.
		...(lineHintOf(rawAnchor(startAnchor)) === undefined
			? {}
			: { lineStart: lineHintOf(rawAnchor(startAnchor)) }),
		...(item.anchor_end !== undefined && lineHintOf(rawAnchor(item.anchor_end)) !== undefined
			? { lineEnd: lineHintOf(rawAnchor(item.anchor_end)) }
			: {}),
		expectedStart: declaredLineOf(startAnchor),
		...(item.anchor_end !== undefined
			? { expectedEnd: declaredLineOf(item.anchor_end) }
			: {}),
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
 * One file's slice of an `edit` call, applied end to end.
 *
 * This is the unit the single-file fast path and the multi-file path used to
 * RESTATE inline — 32 byte-identical lines each, which had already drifted
 * (the multi-file JSON return dropped the diff payloads its text-mode twin
 * carried). The invariant it owns: every applied file is resolved,
 * diagnostics-baselined BEFORE the write, run through the engine, committed
 * through the undo-persist transaction, served-migrated, and awaited for
 * inline diagnostics in the same window.
 *
 * Failure policy is the CALLER's, not this unit's: the raw error comes back
 * untouched so the single-file path can re-throw it byte-identically (the 0.4
 * contract rejects), while the multi-file path runs it through
 * {@link extractFailure} for its `fail[]` entry.
 */
type FileGroupCall = {
	io: FileIO;
	cwd: string;
	signal: AbortSignal | undefined;
	sessionKey: string;
	lineNumbers: boolean;
	exec: ToolRunContext;
	canonical: { path?: string; edits: Array<unknown> };
	sandbox: FsSandboxController;
	sandboxPolicy: Awaited<ReturnType<FsSandboxController["resolvePolicy"]>>;
	insAnchorEndWarningsByPath: Map<string, string[]>;
};

type FileGroupOutcome =
	| { ok: true; displayPath: string; file: FileEditResult; diagnostics: FileDiagnostics | undefined }
	| { ok: false; displayPath: string; error: unknown };

async function applyFileGroup(
	call: FileGroupCall,
	displayPath: string,
	group: Array<{ index: number; edit: unknown }>,
): Promise<FileGroupOutcome> {
	const { io, cwd, signal, sessionKey, lineNumbers, exec, canonical, sandbox, sandboxPolicy } = call;
	try {
		const absolutePath = await io.resolve(displayPath, cwd, signal);
		// #131: captured BEFORE anything is written, so the diagnostics wait
		// measures pushes against a pre-write baseline. undefined = skip.
		const diagCtx = prepareWriteDiagnostics(absolutePath, execCwd(exec));
		const items = group.map(({ index, edit }) =>
			buildPreparedItem(index, displayPath, edit as never, absolutePath),
		);
		// `exec` rides along so a rejection's echo can emit `fs/observed` —
		// with `actor: undefined` the policy records NOTHING, which is what
		// made an echoed marker un-writable on the single-file path.
		const file = await runFileEdits(io, items, { signal, sessionKey, lineNumbers, exec });
		await applyFileResultTo(file, {
			canonical,
			displayPath,
			resolutionWarning: (canonical as { _pathWarning?: string })._pathWarning,
			extraWarnings: call.insAnchorEndWarningsByPath.get(displayPath),
			sandbox,
			sandboxPolicy,
			exec,
			signal,
			io,
			absolutePath,
			sessionKey,
		});
		// #131: inline delivery — waits at most the 300ms window, serves the
		// reported anchors, starts the bounded async wait on timeout. Only a
		// REAL write reports: a noop left the file untouched. On the multi-file
		// path the waits of parallel groups OVERLAP inside Promise.all, so the
		// batch still pays ~one inline window, not one per file.
		const diagnostics =
			diagCtx !== undefined && file.appliedCount > 0
				? await deliverDiagnosticsAfterWrite({
						...diagCtx,
						toolName: "edit",
						text: file.result,
						absolutePath,
						displayPath,
						io,
						exec,
					})
				: undefined;
		return { ok: true, displayPath, file, diagnostics };
	} catch (error) {
		return { ok: false, displayPath, error };
	}
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
			edits: buildEditsSchema(getEffectiveConfig().requireLineContent),
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
					// 渲染通道: web diff 卡的结构化行（issue #71）
					diffRows: { type: "array" },
					driftNotice: { type: "string" },
					noop: { type: "boolean" },
					// 多文件形态
					ok: { type: "boolean" },
					success: { type: "array" },
					fail: { type: "array" },
					// issue #82: 多文件聚合 diffs + diffRowGroups (per-file tab)
					multiDiffs: { type: "array" },
					multiDiffRowGroups: { type: "array" },
					// #131: inline LSP diagnostics, when a push arrived in the window.
					diagnostics: { type: "array" },
					// 两种形态都有
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as EditCanonicalValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as EditCanonicalValue & { success?: unknown[]; fail?: unknown[]; multiDiffRowGroups?: unknown };
				// issue #82: multi-file form carries aggregated per-file diffs + diffRowGroups
				// #131: inline diagnostics ride the SAME meta object in every form, so
				// the capsule renders no matter which shape the call settled into.
				const diagMeta = (v as EditValue).diagnostics;
				if (Array.isArray(v.success) || Array.isArray(v.fail)) {
					const md = v.multiDiffs;
					const mdrGroups = v.multiDiffRowGroups;
					if (Array.isArray(md) && md.length > 0) {
						return {
							diffs: md as FileDiff[],
							...(Array.isArray(mdrGroups) && mdrGroups.length > 0 ? { diffRowGroups: mdrGroups } : {}),
							...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
						} as never;
					}
					return { diffs: [], ...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}) } as never;
				}
				if (v.noop) return { diffs: [] } as never;
				const diffs = computeHunkDiffs(v.path, v.before, v.after);
				// 渲染通道（issue #71）: genDiff 的结构化行（新旧行号 + 锚点），
				// web diff 卡的 gutter 直接渲染它，绝不解析 modelText。
				// v.diffRows 已是 diffRowsFromGenDiff 的产物（EditDiffRow[]），
				// 非空即透传（diffRowsFromMeta 的入参是 meta 对象，不能传数组）。
				const diffRows = Array.isArray(v.diffRows) && v.diffRows.length > 0 ? v.diffRows : undefined;
				return {
					diffs,
					...(diffRows !== undefined ? { diffRows } : {}),
					...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
				} as never;
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
				assertEditRequest(canonical, getEffectiveConfig().requireLineContent);
				const lineNumbers = canonical.line_numbers !== false;
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

				// The per-file call context: identical for every file in the batch,
				// built ONCE. Per-file variation (displayPath, its group, its ins
				// warnings) travels as arguments to `applyFileGroup`.
				const call: FileGroupCall = {
					io,
					cwd,
					signal,
					sessionKey,
					lineNumbers,
					exec,
					canonical,
					sandbox,
					sandboxPolicy,
					insAnchorEndWarningsByPath,
				};
				// ---- 单文件快捷路径 (0.4 兼容, ADR-0004 D4): 仅一组时维持旧形态 ----
				if (groups.size === 1) {
					const [displayPath, group] = groups.entries().next().value as [
						string,
						Array<{ index: number; edit: (typeof canonical.edits)[number] }>,
					];
					// One unit, one invariant — see `applyFileGroup`. The 0.4 contract
					// makes the SINGLE-file batch reject: the raw error is re-thrown
					// byte-identically instead of becoming a fail[] entry.
					const outcome = await applyFileGroup(call, displayPath, group);
					if (!outcome.ok) throw outcome.error;
					const { file, diagnostics } = outcome;
					const diagSection = diagnostics === undefined ? "" : formatDiagnosticsSection([diagnostics]);
					const diagMeta = diagnostics === undefined ? undefined : diagnosticsMeta([diagnostics]);
					// The MODEL channel (JSON envelope) uses the marker-keyed projection,
					// aligned with the diff dict; the VALUE field keeps the meta shape
					// (the web card's rendering channel). Two channels, two shapes.
					const diagJson = diagnostics === undefined ? undefined : diagnosticsJson([diagnostics]);
					const canonicalValue = buildCanonicalFromFileResult(file, displayPath, lineNumbers);
					return isJsonOutput()
						? {
							...canonicalValue,
							// Schema-valid structured value; modelText carries the pure-JSON
							// envelope the model parses. #131: diagnostics join the envelope
							// as a FIELD — appending prose would break JSON.parse callers.
							...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
							modelText: JSON.stringify({
								...buildEditJson(file, displayPath),
								...(diagJson !== undefined ? { diagnostics: diagJson } : {}),
							}),
						}
						: {
							...canonicalValue,
							...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
							modelText: diagSection === "" ? canonicalValue.modelText : `${canonicalValue.modelText}\n\n${diagSection}`,
						};
				}

				// ---- 多文件: 每组并发 + per-file atomic (ADR-0003) ----
				// 某文件失败只进 fail[]，不影响其他文件的结果
				const outcomes = await Promise.all(
					[...groups.entries()].map(([displayPath, group]) => applyFileGroup(call, displayPath, group)),
				);

				const successes = outcomes.filter((o) => o.ok);
				const fails = outcomes.filter((o) => !o.ok);
				const success = successes.map((o) =>
					buildEditJson((o as { ok: true; file: FileEditResult; displayPath: string }).file, o.displayPath),
				);
				// ADR-0004: the fail[] container is per-file; its content is the
				// single-file error with the batch wrapper stripped via extractFailure.
				const fail = fails.map((o) => {
					const err = o.error;
					const message = err instanceof Error ? err.message : String(err);
					const detected = extractFailure(message);
					return {
						path: o.displayPath,
						code: detected.code,
						message: detected.message,
					};
				});

				// issue #82: compute per-file diffs + diffRowGroups for multi-file presentationMeta
				const multiDiffs: FileDiff[] = [];
				const multiDiffRowGroups: { path: string; rows: EditDiffRow[] }[] = [];
				for (const o of successes) {
					const file = o.file;
					multiDiffs.push(...computeHunkDiffs(o.displayPath, file.originalNormalized, file.result));
					multiDiffRowGroups.push({
						path: o.displayPath,
						rows: diffRowsFromGenDiff(
							genDiff(file.originalNormalized, file.result, contextLinesCfg(), file.resultHashes, file.originalHashes, true).rows,
						),
					});
				}
				// #131: aggregate every file's inline report (files without one are
				// simply absent — clean files are omitted, not zero-filled).
				const multiDiag = successes.flatMap((o) =>
					(o as { ok: true; displayPath: string; file: FileEditResult; diagnostics?: FileDiagnostics }).diagnostics !== undefined
						? [(o as { ok: true; diagnostics: FileDiagnostics }).diagnostics]
						: [],
				);
				const multiDiagMeta = diagnosticsMeta(multiDiag);
				// The JSON envelope carries the marker-keyed projection (diff-aligned);
				// the value field keeps the meta shape for the web card.
				const multiDiagJson = diagnosticsJson(multiDiag);
				const multiDiagSection = formatDiagnosticsSection(multiDiag);

				if (!isJsonOutput()) {
					// text 模式: 聚合 prose (ADR-0004 D1) — 成功块在前, 失败块在后
					const appliedTotal = successes.reduce((n, o) => n + o.file.appliedCount, 0);
					const noopTotal = successes.reduce((n, o) => n + o.file.noopCount, 0);
					const totalEdits = canonical.edits.length;
					const summary =
						`Successfully edited ${successes.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied` +
						`${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.`;
					const blocks = outcomes.map((o) => {
						if (o.ok) {
							return `--- ${o.displayPath} ---\n${buildChangedModelText(o.file, o.displayPath, lineNumbers)}`;
						}
						const message = o.error instanceof Error ? o.error.message : String(o.error);
						const detected = extractFailure(message);
						return `Edit for ${o.displayPath} failed: ${detected.code} ${detected.message}`;
					});
					return { success, fail, ...(multiDiagMeta.length > 0 ? { diagnostics: multiDiagMeta } : {}), multiDiffs: multiDiffs as never, multiDiffRowGroups: multiDiffRowGroups as never, modelText: multiDiagSection === "" ? `${summary}\n\n${blocks.join("\n\n")}` : `${summary}\n\n${blocks.join("\n\n")}\n\n${multiDiagSection}` };
				}

				// json 模式: stringified envelope (ADR-0004 D2)
				const modelText = JSON.stringify({
					ok: success.length > 0,
					success,
					fail,
					...(multiDiagJson.length > 0 ? { diagnostics: multiDiagJson } : {}),
				});
				return { ok: success.length > 0, success, fail, ...(multiDiagMeta.length > 0 ? { diagnostics: multiDiagMeta } : {}), multiDiffs: multiDiffs as never, multiDiffRowGroups: multiDiffRowGroups as never, modelText };
			});
		},
	});
}

/**
 * Write one prepared result to disk.
 *
 * The ONE place a `FileEditResult` becomes bytes. `edit` and `ast_edit` both
 * go through it, because the alternative is two ideas of what committing means
 * — and the second one is written by whoever adds the next tool, at a moment
 * when they are thinking about matching, not about the undo transaction.
 *
 * A file whose `appliedCount` is 0 is not written at all: an all-noop batch
 * must leave the disk alone rather than rewrite identical bytes and stamp a new
 * undo entry for them.
 *
 * @param file - the prepared result.
 * @param ctx - the write transaction's context.
 */
export async function commitFileResult(
	file: FileEditResult,
	ctx: {
		io: FileIO;
		exec: Parameters<typeof commit>[0]["exec"];
		sandbox: FsSandboxController;
		sandboxPolicy: Awaited<ReturnType<FsSandboxController["resolvePolicy"]>>;
		signal: AbortSignal | undefined;
	},
): Promise<void> {
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
	// ONE implementation, shared with `ast_edit` — see `commitFileResult`. Two
	// copies of "what committing means" drift, and the copy nobody updates is
	// the one that writes the file.
	await commitFileResult(file, {
		io: ctx.io,
		exec: ctx.exec,
		sandbox: ctx.sandbox,
		sandboxPolicy: ctx.sandboxPolicy,
		signal: ctx.signal,
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

export function buildCanonicalFromFileResult(
	file: FileEditResult,
	displayPath: string,
	lineNumbers = true,
): EditCanonicalValue {
	// 渲染通道（issue #71）: genDiff 的结构化 diff 行（新旧行号 + 会话锚点）。
	// 与 modelText 同源同算法，但作为结构化数据走 presentationMeta，
	// web diff 卡的 gutter 直接渲染它，绝不解析 modelText 文本。
	const diffRows = diffRowsFromGenDiff(
		genDiff(
			file.originalNormalized,
			file.result,
			contextLinesCfg(),
			file.resultHashes,
			file.originalHashes,
			true,
		).rows,
	);
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
		diffRows,
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
	lineNumbers = true,
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
	const diffBody = diffResult.diff ? `${EDIT_DIFF_LEGEND}\n${diffResult.diff}` : "";
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
export function buildEditJson(
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
	// The json view of the diff is marker-keyed, exactly like read's lines:
	// every row is `key: content`, where the key is `<anchor>:<line>` with the
	// row type in its prefix — "-<old anchor>:<old line>" for a removed row,
	// "+<final anchor>:<final line>" for an added row, bare marker for context.
	// No kind field, no before/after windows. `ast_edit` shares this builder,
	// so the two tools cannot name a row differently (diffDictFrom).
	const diff = diffDictFrom(
		file.originalNormalized,
		file.result,
		file.resultHashes,
		file.originalHashes,
	);
	const hints = (file.hunkShifts ?? [])
		.filter((h) => h.delta !== 0 || h.finalStartLine !== h.originalStartLine)
		.map(
			(h) =>
				`edits[${h.index}]: original ${h.originalStartLine === h.originalEndLine ? "line " + h.originalStartLine : "lines " + h.originalStartLine + ".." + h.originalEndLine} moved to ${h.finalStartLine === h.finalEndLine ? "line " + h.finalStartLine : "lines " + h.finalStartLine + ".." + h.finalEndLine} (${(h.delta > 0 ? "+" : "") + h.delta})`,
		);
	return {
		ok: true,
		path: displayPath,
		diff,
		hints,
		warnings: file.warnings,
		errors: [],
	};
}


