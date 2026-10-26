/**
 * The dsh `delete` tool: remove regular files and reclaim their hashline
 * state, per the delete-tool spec (`docs/specs/delete-tool-spec.md`).
 *
 * Why a new tool rather than a mode of `bash`: the file removal itself is
 * ordinary, but the state it leaves behind is not. Every successful delete
 * must also purge `anchor_meta` / `anchor_lines` / `served` (every session) /
 * `undo` (every depth) for that exact path, record an ABSENT observation, and
 * tell a running language server the document is gone. None of that exists in
 * the shell path, which is why the store grew dead paths forever.
 *
 * Transport: `ctx.fs` has no delete seam in dsh 0.2.x (research:
 * `docs/research/dsh-removal-seam.md`). The bridge therefore performs a
 * guarded `node:fs.unlink` after rebuilding the sandbox fence from
 * `writableRoots()` / `fs.contains()`, and refuses anything that cannot be
 * proven local. The tool layer owns the policy/approval, the per-path result,
 * and the store observation.
 *
 * @module dsh-hashline-edittool/tool-delete
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isJsonOutput } from "../config.js";
import {
	errorFieldSchema,
	pathFromArgs,
	thrownErrorResult,
	type ErrorMeta,
	type FileFailureMeta,
} from "../infra/error-result.js";
import type { FileIO, FileProbe } from "../infra/fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { execCwd, withWorkspace } from "../domain/session/session-view.js";
import { loadHashStore, type HashStore, type PurgeReport } from "../domain/session/hash-store.js";
import { clearAlignmentNotice } from "../domain/session/anchor-state.js";
import { notifyDocumentClosed } from "../lsp/sync.js";
import { DELETE_DESCRIPTION } from "../domain/edit/prompts.js";

/**
 * The delete tool's domain vocabulary, kept as one literal list so the README
 * error-code contract test sees every code this tool can emit (several are
 * constructed from `domainError` arguments at the call site).
 */
export const DELETE_ERROR_CODES = [
	"[E_DELETE_UNSUPPORTED]",
	"[E_SYMLINK]",
	"[E_NOT_FILE]",
	"[E_DELETE_STALE]",
	"[E_DELETE_FAILED]",
	"[E_ACCESS]",
] as const;

/** Aligns with `edit`'s 32-item cap; a delete batch is not a tree walk. */
const DELETE_MAX_PATHS = 32;

/** One path that was removed (or was already gone). */
export interface DeleteResultValue {
	/** The path as the model wrote it. */
	path: string;
	/** Canonical process path — the store key and observation target. */
	canonicalPath: string;
	status: "deleted" | "already-absent";
	/** What the store purge removed; absent when the store could not be opened. */
	reclaimed?: PurgeReport;
	/** A non-fatal problem (usually the store purge). */
	warning?: string;
}

/** The canonical value returned from `execute`. */
export interface DeleteValue {
	results: DeleteResultValue[];
	failures: FileFailureMeta[];
	totals: {
		deleted: number;
		alreadyAbsent: number;
		failed: number;
	};
	/** Sum of the per-path purges (logical bytes, rows, paths). */
	reclaimed: {
		bytesFreed: number;
		rows: number;
		paths: number;
		undoLayers: number;
		servedRows: number;
		anchorMeta: number;
	};
	vacuum: "pending" | "none";
	warnings: string[];
	modelText: string;
	error?: ErrorMeta;
}

/** Turn any thrown failure into the per-path error shape the card reads. */
function failureFromError(error: unknown, path: string): FileFailureMeta {
	const message = error instanceof Error ? error.message : String(error);
	const match = /\[(E_[A-Z_]+)\]/.exec(message);
	const code = match?.[1];
	const body = match ? message.slice((match.index ?? 0) + match[0].length).trim() : message;
	const [head, ...tail] = body.split("\n\n");
	return {
		path,
		...(code !== undefined ? { code } : {}),
		message: head !== undefined && head.length > 0 ? head : body,
		...(tail.length > 0 ? { context: tail.join("\n\n") } : {}),
	};
}

/** A pre-approval probe that already says "not a regular file" is a per-path failure. */
function typeFailure(path: string, probe: FileProbe): FileFailureMeta | undefined {
	if (probe.kind === "symlink") {
		return {
			path,
			code: "E_SYMLINK",
			message: `Refusing to delete a symbolic link: ${path}. The delete tool handles regular files only; use bash if you mean to remove the link itself.`,
		};
	}
	if (probe.kind === "directory" || probe.kind === "other") {
		return {
			path,
			code: "E_NOT_FILE",
			message: `Path is not a regular file: ${path}. Directories and special files are not deletable here; use bash for directories.`,
		};
	}
	return undefined;
}

/** Small, local byte formatter for the model-facing summary. */
function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
	return `${(n / 1024 / 1024).toFixed(1)}MiB`;
}

/** Validate and deduplicate the request paths, preserving first-seen order. */
function requestPaths(args: unknown): string[] {
	const raw = (args as { paths?: unknown } | undefined)?.paths;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("[E_BAD_SHAPE] delete requires `paths`: a non-empty array of 1-32 strings.");
	}
	if (raw.length > DELETE_MAX_PATHS) {
		throw new Error(
			`[E_BAD_SHAPE] delete accepts at most ${DELETE_MAX_PATHS} paths per call (received ${raw.length}). Split the request.`,
		);
	}
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0) {
			throw new Error("[E_BAD_SHAPE] every `paths` entry must be a non-empty string.");
		}
		if (seen.has(entry)) continue;
		seen.add(entry);
		paths.push(entry);
	}
	return paths;
}

/** The model-facing text mode. */
function renderText(
	value: Omit<DeleteValue, "modelText">,
): string {
	const lines = [
		`[delete result] ${value.totals.deleted} deleted, ${value.totals.alreadyAbsent} already absent, ${value.totals.failed} failed.`,
	];
	for (const result of value.results) {
		const reclaimed =
			result.reclaimed === undefined
				? ""
				: `; anchors ${result.reclaimed.anchorLines}, undo ${result.reclaimed.undoLayers}, served ${result.reclaimed.servedRows}, meta ${result.reclaimed.anchorMeta}` +
					`; freed ${formatBytes(result.reclaimed.bytesFreed)} (logical)`;
		const warning = result.warning === undefined ? "" : ` [warning: ${result.warning}]`;
		lines.push(`- ${result.path} — ${result.status}${reclaimed}${warning}`);
	}
	for (const failure of value.failures) {
		const code = failure.code === undefined ? "" : `[${failure.code}] `;
		lines.push(`- ${failure.path} — failed ${code}${failure.message}`);
	}
	if (value.reclaimed.bytesFreed > 0) {
		lines.push(
			`Reclaimed ${formatBytes(value.reclaimed.bytesFreed)} of logical store space; physical disk returns at store shutdown (VACUUM pending).`,
		);
	} else if (value.results.length > 0) {
		lines.push("No store pages were freed for these paths.");
	}
	if (value.warnings.length > 0) {
		lines.push(`Warnings: ${value.warnings.join(" ")}`);
	}
	return lines.join("\n");
}

/** Build the canonical value from the per-path pieces. */
function finalize(
	results: DeleteResultValue[],
	failures: FileFailureMeta[],
	warnings: string[],
): DeleteValue {
	const reclaimed = {
		bytesFreed: 0,
		rows: 0,
		paths: 0,
		undoLayers: 0,
		servedRows: 0,
		anchorMeta: 0,
	};
	for (const result of results) {
		if (result.reclaimed === undefined) continue;
		reclaimed.bytesFreed += result.reclaimed.bytesFreed;
		reclaimed.rows += result.reclaimed.anchorLines;
		reclaimed.undoLayers += result.reclaimed.undoLayers;
		reclaimed.servedRows += result.reclaimed.servedRows;
		reclaimed.anchorMeta += result.reclaimed.anchorMeta;
		if (result.reclaimed.anchorMeta > 0) reclaimed.paths += 1;
	}
	const totals = {
		deleted: results.filter((r) => r.status === "deleted").length,
		alreadyAbsent: results.filter((r) => r.status === "already-absent").length,
		failed: failures.length,
	};
	const ok = totals.deleted + totals.alreadyAbsent > 0;
	const firstFailure = failures[0];
	const error: ErrorMeta | undefined =
		!ok && firstFailure !== undefined
			? {
					code: firstFailure.code ?? "E_DELETE_FAILED",
					message: firstFailure.message,
					path: firstFailure.path,
					...(firstFailure.context !== undefined ? { context: firstFailure.context } : {}),
					...(firstFailure.hint !== undefined ? { hint: firstFailure.hint } : {}),
				}
			: undefined;
	const value: Omit<DeleteValue, "modelText"> = {
		results,
		failures,
		totals,
		reclaimed,
		vacuum: reclaimed.bytesFreed > 0 ? "pending" : "none",
		warnings,
		...(error !== undefined ? { error } : {}),
	};
	const modelText = isJsonOutput()
		? JSON.stringify({ ok, ...value })
		: renderText(value);
	return { ...value, modelText };
}

/**
 * Build the `delete` tool definition.
 * @param io - the filesystem bridge (probe + guarded unlink).
 * @param sandbox - the escalation controller (policy + approval).
 * @returns A registry-ready definition.
 */
export function buildDeleteTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "delete",
		description: DELETE_DESCRIPTION,
		parameters: {
			paths: {
				type: "array",
				required: true,
				description:
					"Explicit paths to delete (1-32, duplicates collapse). Relative paths resolve against the session cwd. Regular files only; directories, symlinks and special files are refused.",
				items: { type: "string" },
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: { type: "array" },
					failures: { type: "array" },
					totals: { type: "object", additionalProperties: true },
					reclaimed: { type: "object", additionalProperties: true },
					vacuum: { type: "string" },
					warnings: { type: "array" },
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as unknown as DeleteValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as unknown as DeleteValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
				return {
					delete: {
						results: v.results,
						failures: v.failures,
						totals: v.totals,
						reclaimed: v.reclaimed,
						vacuum: v.vacuum,
						warnings: v.warnings,
					},
				} as never;
			},
		},
		presentCall: (args) => {
			const paths = (args as { paths?: unknown }).paths;
			if (!Array.isArray(paths) || paths.length === 0) return undefined;
			return {
				card: "generic",
				title: `Delete ${paths.length} path${paths.length === 1 ? "" : "s"}`,
				kind: "delete",
				locations: paths
					.filter((path): path is string => typeof path === "string")
					.map((path) => ({ path })),
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const signal = exec.signal;
				const paths = requestPaths(args);
				const results: DeleteResultValue[] = [];
				const failures: FileFailureMeta[] = [];
				const warnings: string[] = [];

				// Preflight BEFORE approval: a symlink/directory must not prompt the
				// user for a wider mode it can never use. A probe failure is a
				// per-path failure, not a whole-call abort.
				const probes = new Map<string, FileProbe>();
				for (const path of paths) {
					try {
						const probe = await io.probeFile(path, cwd, signal);
						const rejected = typeFailure(path, probe);
						if (rejected !== undefined) {
							failures.push(rejected);
							continue;
						}
						probes.set(path, probe);
					} catch (error) {
						failures.push(failureFromError(error, path));
					}
				}

				if (probes.size === 0) return finalize(results, failures, warnings) as never;

				const sandboxPolicy = await sandbox.resolvePolicy(
					"delete",
					args as unknown as FsEscalationArgs,
					exec,
				);

				let store: HashStore | undefined;
				try {
					store = await loadHashStore(cwd);
				} catch (error) {
					warnings.push(
						`store could not be opened; files will still be deleted, but their anchor rows are left to the sweep/TTL: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}

				for (const path of paths) {
					const expected = probes.get(path);
					if (expected === undefined) continue; // already a preflight failure
					let outcome;
					try {
						outcome = await io.deleteFile(path, cwd, expected, signal, sandboxPolicy);
					} catch (error) {
						failures.push(failureFromError(sandbox.mapError(error, sandboxPolicy), path));
						continue;
					}

					// Host consistency: the file is gone, so nothing should keep a
					// present observation, a stale alignment notice, or an LSP
					// document for it. Only `fs/observed` absent — never a write intent.
					const absentRecorded = await io.emitAbsent(outcome.path, exec, signal);
					clearAlignmentNotice(outcome.path);
					notifyDocumentClosed(outcome.path);

					let reclaimed: PurgeReport | undefined;
					let warning: string | undefined;
					if (store !== undefined) {
						try {
							reclaimed = store.purgePath(outcome.path);
						} catch (error) {
							warning = `store reclaim failed; the sweep/TTL will retry: ${
								error instanceof Error ? error.message : String(error)
							}`;
						}
					}
					if (!absentRecorded) {
						warning = `${warning === undefined ? "" : `${warning} `}the absence observation was not recorded (no observation policy mounted, or the path was recreated).`;
					}
					results.push({
						path,
						canonicalPath: outcome.path,
						status: outcome.kind === "deleted" ? "deleted" : "already-absent",
						...(reclaimed !== undefined ? { reclaimed } : {}),
						...(warning !== undefined ? { warning } : {}),
					});
				}

				return finalize(results, failures, warnings) as never;
			}).catch((error: unknown) =>
				thrownErrorResult(error, { path: pathFromArgs(args) }) as never,
			);
		},
	});
}

/**
 * Register the `delete` tool on the calling agent's scope (own layer).
 * @param _rootCtx - host context (unused; signature symmetry).
 * @param agentCtx - the agent's scoped context.
 * @param io - the filesystem bridge.
 * @param sandbox - the escalation controller.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerDeleteTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildDeleteTool(io, sandbox));
}
