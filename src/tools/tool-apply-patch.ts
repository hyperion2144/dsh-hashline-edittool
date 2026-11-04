/**
 * The dsh `apply_patch` tool: one change set across files in a single call.
 *
 * WHY A SECOND TOOL. `edit` answers "change this range of this file", and its
 * failure model follows from that: per-file atomic, several files may settle
 * differently. A patch answers "make this change set true", and its failure
 * model is the opposite — the whole set is refused together, or it is applied
 * in order and stops at the first wall without pretending it can undo. Two
 * different promises cannot share one tool without one of them lying, which is
 * why ADR-0034 keeps them apart.
 *
 * WHAT THIS FILE OWNS: the tool contract (schema, description, card, model
 * text) and the wiring between the four domain modules — parse → preflight →
 * commit → text. The interesting decisions live there; everything here is
 * transport.
 *
 * @module dsh-hashline-edittool/tool-apply-patch
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { getEffectiveConfig, isJsonOutput, lineNumbersEnabled } from "../config.js";
import {
	errorFieldSchema,
	pathFromArgs,
	thrownErrorResult,
	type ErrorMeta,
} from "../infra/error-result.js";
import { buildErrorResult } from "../infra/error-result.js";
import type { FileIO } from "../infra/fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { responseBudgetChars, spillModelTextOverflow } from "../infra/response-stream.js";
import { applyPatchDescription } from "../domain/edit/prompts.js";
import { withLiveWorkspace } from "../domain/session/live-cwd.js";
import { execSessionKey, openWorkspaceStore } from "../domain/session/session-view.js";
import { loadHashStore, type HashStore } from "../domain/session/hash-store.js";
import { parsePatch } from "../domain/patch/parse.js";
import { PatchParseError } from "../domain/patch/types.js";
import { preflightPatch } from "../domain/patch/preflight.js";
import { commitPatch, type CommittedOperation } from "../domain/patch/commit.js";
import {
	refusalBody,
	refusalHead,
	stoppedText,
	successText,
} from "../domain/patch/text.js";
import { editDiffLegend } from "../domain/edit/edit-response.js";
import {
	buildPatchCard,
	patchRowTitle,
	renderPatchDiffGroups,
	type PatchCardData,
} from "../render/patch-card.js";
import type { FileFailureMeta } from "../infra/error-result.js";
import { diffsFromMeta, type FileDiff } from "../render/edit-card.js";

/**
 * The patch tool's canonical value.
 *
 * Every field is declared in `output.schema` (`additionalProperties: false`),
 * and the split is the point: `modelText` is what the model reads, `diffs` /
 * `diffRowGroups` are what the card draws, and `operations` is the truthful
 * per-operation ledger both of them are derived from.
 */
interface PatchValue {
	modelText: string;
	stopped: boolean;
	cancelled: boolean;
	operations: PatchOperationValue[];
	affectedPaths: string[];
	diffs: FileDiff[];
	diffRowGroups: { path: string; rows: unknown[] }[];
	warnings?: string[];
	error?: ErrorMeta;
}

/** One operation as the value reports it (no internal fields). */
interface PatchOperationValue {
	index: number;
	kind: string;
	path: string;
	destination?: string;
	destinationPath?: string;
	line: number;
	hunkLine?: number;
	status: string;
	code?: string;
	message?: string;
	changes?: { path: string; before: string | null; after: string }[];
}

/** Project a committed operation onto the value's shape. */
function operationValue(operation: CommittedOperation): PatchOperationValue {
	return {
		index: operation.index,
		kind: operation.kind,
		path: operation.path,
		...(operation.destination !== undefined
			? { destination: operation.destination }
			: {}),
		...(operation.destinationPath !== undefined
			? { destinationPath: operation.destinationPath }
			: {}),
		line: operation.line,
		...(operation.hunkLine !== undefined ? { hunkLine: operation.hunkLine } : {}),
		status: operation.status,
		...(operation.code !== undefined ? { code: operation.code } : {}),
		...(operation.message !== undefined ? { message: operation.message } : {}),
		...(operation.changes !== undefined ? { changes: operation.changes } : {}),
	};
}

/** Every canonical path a completed operation really touched. */
function affectedPaths(operations: readonly CommittedOperation[]): string[] {
	const paths: string[] = [];
	for (const operation of operations) {
		if (operation.status !== "completed") continue;
		paths.push(operation.absolutePath);
		if (operation.destinationPath !== undefined) paths.push(operation.destinationPath);
	}
	return paths;
}

/**
 * Compose the model text under the response budget.
 *
 * The summary always rides — it is the answer. The anchor groups are the
 * payload that can be deferred, and a group that does not fit degrades to the
 * contract's notice rather than to a truncated diff: a half-served diff shows
 * anchors the model would then misuse.
 */
function composeModelText(
	operations: readonly CommittedOperation[],
	lineNumbers: boolean,
	stopped: boolean,
	budget: number,
): string {
	const head = stopped
		? stoppedText(operations, lineNumbers, [])
		: successText(operations, lineNumbers, []);
	const groups = renderPatchDiffGroups(operations, lineNumbers);
	const kept: string[] = [];
	const truncated: string[] = [];
	let used = head.length;
	for (const group of groups) {
		const cost = group.text.length + 2;
		if (used + cost <= budget) {
			kept.push(group.text);
			used += cost;
		} else {
			truncated.push(group.path);
		}
	}
	const parts = [head];
	if (kept.length > 0) {
		parts.push(`${editDiffLegend(lineNumbers)}\n${kept.join("\n\n")}`);
	}
	if (truncated.length > 0) {
		parts.push(
			truncated.map((path) => `(truncated; re-read ${path} for anchors)`).join("\n"),
		);
	}
	return parts.join("\n\n");
}

/**
 * The parse failure, as an error value.
 *
 * The message is the parser's own (`Invalid patch at line <n>: <reason>`) and
 * the offending input line rides as `context` — the model wrote that line, and
 * quoting it back is how it finds it.
 */
function parseError(error: PatchParseError, patch: string): ReturnType<typeof buildErrorResult> {
	const lines = patch.split("\n");
	const offending = lines[error.lineNumber - 1];
	return buildErrorResult({
		code: "E_INVALID_PATCH",
		message: error.message,
		...(offending !== undefined ? { context: `  ${offending}` } : {}),
		mode: isJsonOutput() ? "json" : "text",
	});
}

/**
 * Register the `apply_patch` tool on the calling agent's scope.
 *
 * @param _rootCtx - host context (unused; signature symmetry).
 * @param agentCtx - the agent's scoped context.
 * @param io - the filesystem bridge.
 * @param sandbox - the escalation controller.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildApplyPatchTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "apply_patch",
		description: applyPatchDescription(getEffectiveConfig()),
		parameters: {
			patch: {
				type: "string",
				required: true,
				description:
					"The change set. Section headers at column 0 (`file <path>`, `new <path>`, `move <from> -> <to>`, `remove <path>`), hunk headers inside a `file`/`move` section (`replace <anchor>`, `replace <start>..<end>`, `insert <anchor>`, `delete <anchor>`, `delete <start>..<end>`), and every content line prefixed with `+` (a bare `+` is an empty line). Anchors come from this session's read/grep/diff rows; the patch never repeats old file content.",
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					modelText: { type: "string", required: true },
					stopped: { type: "boolean" },
					cancelled: { type: "boolean" },
					operations: { type: "array" },
					affectedPaths: { type: "array", items: { type: "string" } },
					// The card channel: same diff payload `edit` sends, plus the
					// per-file rows the gutter renders (issue #71's shape).
					diffs: { type: "array" },
					diffRowGroups: { type: "array" },
					warnings: { type: "array", items: { type: "string" } },
					error: errorFieldSchema,
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as unknown as PatchValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as unknown as PatchValue;
				if (v.error !== undefined) return { error: v.error } as never;
				const failures: FileFailureMeta[] = v.operations
					.filter((operation) => operation.status === "failed" || operation.status === "unknown")
					.map((operation) => ({
						path: operation.path,
						code: operation.code ?? "E_PATCH_FAILED",
						message: operation.message ?? "the operation failed.",
					}));
				return {
					diffs: v.diffs,
					// `diffRowGroups` is ALWAYS present (one tab per completed operation,
					// even a row-less move): the client's strip keys off this array, and an
					// omitted one collapses every file into a single tab.
					diffRowGroups: v.diffRowGroups,
					stopped: v.stopped,
					// The folded row's title travels as a key + params: the wording and the
					// count are the client's to render in the reader's language.
					rowTitle: patchRowTitle(v.operations.length, v.stopped),
					// A stopped commit reuses the multi-file failure list `edit` ships, so
					// the failed operations render beside the diffs of the ones that ran.
					...(failures.length > 0 ? { failures } : {}),
				} as never;
			},
		},
		presentCall: (args) => {
			const patch = (args as { patch?: unknown }).patch;
			if (typeof patch !== "string" || patch.trim() === "") return undefined;
			// Pure on `args`: count sections without touching the filesystem. The
			// tool is a change set, so its call row counts files, not edits.
			const sections = patch.split("\n").filter((line) =>
				/^(file|new|move|remove) /.test(line),
			);
			const count = sections.length;
			return {
				card: "generic",
				title:
					count === 0
						? "Apply patch (no operations)"
						: `Apply patch (${count} file${count === 1 ? "" : "s"})`,
				// A patch writes files, so the call row reuses the edit family's
				// affordances (a change set is an edit of several files at once).
				kind: "edit",
				locations: sections.map((line) => ({
					path: line.slice(line.indexOf(" ") + 1).split(" -> ")[0] ?? "",
				})),
			};
		},
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const diffs = diffsFromMeta(result.meta);
			const meta = result.meta as { stopped?: unknown } | undefined;
			return {
				card: "diff",
				title: meta?.stopped === true ? "Apply patch (stopped)" : "Apply patch",
				diffs: diffs ?? [],
			};
		},
		async execute(args, exec) {
			return withLiveWorkspace(exec, async (cwd) => {
				// The patch allocates anchors (and re-serves the changed windows), and
				// the anchor port writes only into an OPEN store.
				await openWorkspaceStore(cwd);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;
				const lineNumbers = lineNumbersEnabled();
				const patch = typeof args.patch === "string" ? args.patch : "";

				let sections;
				try {
					sections = parsePatch(patch);
				} catch (error) {
					if (error instanceof PatchParseError) {
						return parseError(error, patch) as never;
					}
					throw error;
				}

				if (sections.length === 0) {
					// An empty patch is a success: the change set it describes is the
					// one already in place, and inventing a failure would teach the
					// model nothing.
					const value: PatchValue = {
						modelText: successText([], lineNumbers, []),
						stopped: false,
						cancelled: false,
						operations: [],
						affectedPaths: [],
						diffs: [],
						diffRowGroups: [],
					};
					return value as never;
				}

				const sandboxPolicy = await sandbox.resolvePolicy(
					"apply_patch",
					args as unknown as FsEscalationArgs,
					exec,
				);

				const preflight = await preflightPatch({
					sections,
					io,
					cwd,
					sessionKey,
					exec,
					lineNumbers,
					signal,
				});

				if (preflight.refusals.length > 0) {
					return buildErrorResult({
						code: "E_PATCH_REFUSED",
						message: refusalHead(preflight.refusals.length),
						context: refusalBody(preflight.refusals),
						mode: isJsonOutput() ? "json" : "text",
					}) as never;
				}

				const warnings: string[] = [];
				let store: HashStore | undefined;
				try {
					store = await loadHashStore(cwd);
				} catch (error) {
					warnings.push(
						`the hash store could not be opened; the files are still written, but anchor rows are left to the sweep/TTL: ${error instanceof Error ? error.message : String(error)
						}`,
					);
				}

				const committed = await commitPatch({
					prepared: preflight.prepared,
					io,
					cwd,
					sessionKey,
					exec,
					sandbox,
					sandboxPolicy,
					store,
					signal,
					warnings,
				});

				const stopped = committed.stopped || committed.cancelled;
				const head = composeModelText(
					committed.operations,
					lineNumbers,
					stopped,
					responseBudgetChars(),
				);
				const streamed = await spillModelTextOverflow({
					sessionKey,
					producer: "apply_patch",
					consumer: "read",
					kind: "report-segment",
					modelText: head,
					budgetChars: responseBudgetChars(),
				});
				const card: PatchCardData = buildPatchCard(committed.operations, lineNumbers);
				const value: PatchValue = {
					modelText: streamed.modelText,
					stopped: committed.stopped,
					cancelled: committed.cancelled,
					operations: committed.operations.map(operationValue),
					affectedPaths: affectedPaths(committed.operations),
					diffs: card.diffs,
					diffRowGroups: card.diffRowGroups,
					...(warnings.length > 0 ? { warnings } : {}),
				};
				return value as never;
			}).catch((error: unknown) =>
				thrownErrorResult(error, { path: pathFromArgs(args) }) as never,
			);
		},
	});
}

/**
 * Register the `apply_patch` tool on the calling agent's scope (own layer).
 *
 * It shadows a same-named tool only when one is present: the host registers
 * `apply_patch` on the preset layer, and a plugin-layer tool cannot shadow a
 * preset one — so the probe decides WHERE to register, not whether. See
 * `src/index.ts`'s {@link import("../index.js")} wiring.
 *
 * The definition comes back with the disposer because the caller probes the
 * registry: a definition this plugin registered must never be mistaken for a
 * built-in to shadow (`ownToolDefinitions`).
 */
/** What a registration hands back: the definition (for the own-tool probe) and its disposer. */
export interface ApplyPatchRegistration {
	definition: object;
	dispose: () => void;
}

export function registerApplyPatchTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): ApplyPatchRegistration {
	const definition = buildApplyPatchTool(io, sandbox);
	return { definition, dispose: agentCtx.tools.register(definition) };
}
