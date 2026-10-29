/**
 * The dsh `rename` tool: move regular files and carry their hashline state to
 * the destination path, per the rename-tool spec
 * (`docs/specs/rename-tool-spec.md`).
 *
 * Why a tool rather than `bash mv`: the move is ordinary, but the state it
 * leaves behind is not. Every successful rename must also migrate
 * `anchor_meta` / `anchor_lines` / `served` (every session) / `undo` (every
 * depth) to the new path, record an ABSENT observation for the old path and a
 * PRESENT one for the new, and tell a running language server the old document
 * is gone. A shell move creates a second anchor batch for the same file; this
 * tool is the one call that keeps one batch.
 *
 * Transport: `ctx.fs` has no rename seam in dsh 0.2.x (research:
 * `docs/research/dsh-rename-seam.md`). The bridge therefore performs a guarded
 * `node:fs.rename` after rebuilding the sandbox fence from
 * `writableRoots()` / `fs.contains()`, checking BOTH sides, and refuses
 * anything that cannot be proven local.
 *
 * @module dsh-hashline-edittool/tool-rename
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isJsonOutput } from "../config.js";
import {
	errorFieldSchema,
	thrownErrorResult,
	type ErrorMeta,
	type FileFailureMeta,
} from "../infra/error-result.js";
import type { FileIO, FileProbe } from "../infra/fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { execCwd, withWorkspace } from "../domain/session/session-view.js";
import {
	loadHashStore,
	type HashStore,
	type MigrateReport,
} from "../domain/session/hash-store.js";
import { clearAlignmentNotice } from "../domain/session/anchor-state.js";
import { notifyDocumentClosed } from "../lsp/sync.js";
import { RENAME_DESCRIPTION } from "../domain/edit/prompts.js";

/**
 * The rename tool's domain vocabulary, kept as one literal list so the README
 * error-code contract test sees every code this tool can emit.
 */
export const RENAME_ERROR_CODES = [
	"[E_RENAME_UNSUPPORTED]",
	"[E_RENAME_STALE]",
	"[E_CROSS_DEVICE]",
	"[E_EXISTS]",
	"[E_NOT_FOUND]",
	"[E_SYMLINK]",
	"[E_NOT_FILE]",
	"[E_ACCESS]",
] as const;

/** A rename batch names PAIRS, not ops — this ceiling is its own (#380). */
const RENAME_MAX_PAIRS = 32;

/** One requested pair, after shape validation. */
interface RenamePair {
	from: string;
	to: string;
}

/** One pair that was actually moved (or is a same-path no-op). */
export interface RenamePairResult {
	/** The source as the model wrote it. */
	from: { path: string; canonicalPath: string };
	/** The destination as the model wrote it, plus its post-rename version. */
	to: { path: string; canonicalPath: string; version?: string };
	status: "renamed";
	/** What the store moved (and purged at the destination), when it opened. */
	migrated?: MigrateReport;
	/** A non-fatal problem (usually the store migration). */
	warning?: string;
}

/** Summed store work over the call. */
export interface RenameMigrationTotals {
	anchorMeta: number;
	anchorLines: number;
	servedRows: number;
	undoLayers: number;
	purgedAnchorMeta: number;
	purgedAnchorLines: number;
	purgedServedRows: number;
	purgedUndoLayers: number;
	purgedBytes: number;
}

/** The canonical value returned from `execute`. */
export interface RenameValue {
	results: RenamePairResult[];
	failures: FileFailureMeta[];
	totals: { renamed: number; failed: number };
	migrated: RenameMigrationTotals;
	warnings: string[];
	modelText: string;
	error?: ErrorMeta;
}

/** Turn any thrown failure into the per-pair error shape the card reads. */
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

/** Small, local byte formatter for the model-facing summary. */
function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
	return `${(n / 1024 / 1024).toFixed(1)}MiB`;
}

/**
 * Validate the request shape: 1-32 `{from, to}` pairs, exact duplicates
 * collapse, and a repeated `from` or `to` after collapsing is a shape error
 * (the batch would otherwise be ambiguous).
 */
function requestPairs(args: unknown): RenamePair[] {
	const raw = (args as { renames?: unknown } | undefined)?.renames;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(
			"[E_BAD_SHAPE] rename requires `renames`: a non-empty array of 1-32 `{from, to}` objects.",
		);
	}
	if (raw.length > RENAME_MAX_PAIRS) {
		throw new Error(
			`[E_BAD_SHAPE] rename accepts at most ${RENAME_MAX_PAIRS} pairs per call (received ${raw.length}). Split the request.`,
		);
	}
	const seen = new Set<string>();
	const pairs: RenamePair[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(
				"[E_BAD_SHAPE] every `renames` entry must be an object with non-empty `from` and `to` strings.",
			);
		}
		const from = (entry as { from?: unknown }).from;
		const to = (entry as { to?: unknown }).to;
		if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
			throw new Error(
				"[E_BAD_SHAPE] every `renames` entry must have non-empty `from` and `to` strings.",
			);
		}
		const key = `${from}\u0000${to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push({ from, to });
	}
	const froms = new Set<string>();
	const tos = new Set<string>();
	for (const pair of pairs) {
		if (froms.has(pair.from)) {
			throw new Error(
				`[E_BAD_SHAPE] the same \`from\` appears twice in one call: ${pair.from}. Split or deduplicate the request.`,
			);
		}
		if (tos.has(pair.to)) {
			throw new Error(
				`[E_BAD_SHAPE] the same \`to\` appears twice in one call: ${pair.to}. Split or deduplicate the request.`,
			);
		}
		froms.add(pair.from);
		tos.add(pair.to);
	}
	return pairs;
}

/** A pre-approval rejection that is already a per-pair failure. */
function typeFailure(path: string, probe: FileProbe): FileFailureMeta | undefined {
	if (probe.kind === "symlink") {
		return {
			path,
			code: "E_SYMLINK",
			message: `Refusing to rename a symbolic link: ${path}. The rename tool handles regular files only; use bash if you mean to move the link itself.`,
		};
	}
	if (probe.kind === "directory" || probe.kind === "other") {
		return {
			path,
			code: "E_NOT_FILE",
			message: `Path is not a regular file: ${path}. Directories and special files are not renamable here; use bash for directories.`,
		};
	}
	return undefined;
}

/** The model-facing text mode. */
function renderText(value: Omit<RenameValue, "modelText">): string {
	const lines = [
		`[rename result] ${value.totals.renamed} renamed, ${value.totals.failed} failed.`,
	];
	for (const result of value.results) {
		const migrated =
			result.migrated === undefined
				? ""
				: `; anchors ${result.migrated.anchorLines}, undo ${result.migrated.undoLayers}, served ${result.migrated.servedRows}, meta ${result.migrated.anchorMeta}` +
					(result.migrated.purged.bytesFreed > 0
						? `; purged destination residue ${formatBytes(result.migrated.purged.bytesFreed)} (logical)`
						: "");
		const warning = result.warning === undefined ? "" : ` [warning: ${result.warning}]`;
		lines.push(`- ${result.from.path} -> ${result.to.path} — renamed${migrated}${warning}`);
	}
	for (const failure of value.failures) {
		const code = failure.code === undefined ? "" : `[${failure.code}] `;
		lines.push(`- ${failure.path} — failed ${code}${failure.message}`);
	}
	if (value.migrated.purgedBytes > 0) {
		lines.push(
			`Reclaimed ${formatBytes(value.migrated.purgedBytes)} of logical store space at the destinations.`,
		);
	}
	if (value.warnings.length > 0) {
		lines.push(`Warnings: ${value.warnings.join(" ")}`);
	}
	return lines.join("\n");
}

/** Build the canonical value from the per-pair pieces. */
function finalize(
	results: RenamePairResult[],
	failures: FileFailureMeta[],
	warnings: string[],
): RenameValue {
	const migrated: RenameMigrationTotals = {
		anchorMeta: 0,
		anchorLines: 0,
		servedRows: 0,
		undoLayers: 0,
		purgedAnchorMeta: 0,
		purgedAnchorLines: 0,
		purgedServedRows: 0,
		purgedUndoLayers: 0,
		purgedBytes: 0,
	};
	for (const result of results) {
		if (result.migrated === undefined) continue;
		migrated.anchorMeta += result.migrated.anchorMeta;
		migrated.anchorLines += result.migrated.anchorLines;
		migrated.servedRows += result.migrated.servedRows;
		migrated.undoLayers += result.migrated.undoLayers;
		migrated.purgedAnchorMeta += result.migrated.purged.anchorMeta;
		migrated.purgedAnchorLines += result.migrated.purged.anchorLines;
		migrated.purgedServedRows += result.migrated.purged.servedRows;
		migrated.purgedUndoLayers += result.migrated.purged.undoLayers;
		migrated.purgedBytes += result.migrated.purged.bytesFreed;
	}
	const totals = { renamed: results.length, failed: failures.length };
	const ok = results.length > 0;
	const firstFailure = failures[0];
	const error: ErrorMeta | undefined =
		!ok && firstFailure !== undefined
			? {
					code: firstFailure.code ?? "E_RENAME_FAILED",
					message: firstFailure.message,
					path: firstFailure.path,
					...(firstFailure.context !== undefined ? { context: firstFailure.context } : {}),
					...(firstFailure.hint !== undefined ? { hint: firstFailure.hint } : {}),
				}
			: undefined;
	const value: Omit<RenameValue, "modelText"> = {
		results,
		failures,
		totals,
		migrated,
		warnings,
		...(error !== undefined ? { error } : {}),
	};
	const modelText = isJsonOutput() ? JSON.stringify({ ok, ...value }) : renderText(value);
	return { ...value, modelText };
}

/**
 * Build the `rename` tool definition.
 * @param io - the filesystem bridge (two-sided probe + guarded host rename).
 * @param sandbox - the escalation controller (policy + approval).
 * @returns A registry-ready definition.
 */
export function buildRenameTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "rename",
		description: RENAME_DESCRIPTION,
		parameters: {
			renames: {
				type: "array",
				required: true,
				description:
					"Pairs to move (1-32, exact duplicates collapse). Relative paths resolve against the session cwd. Regular files only; an existing destination is refused unless it is the same file under another spelling.",
				items: {
					type: "object",
						additionalProperties: false,
					properties: {
						from: {
							type: "string",
							required: true,
							description: "Existing regular file to move.",
						},
						to: {
							type: "string",
							required: true,
							description: "Destination path; its parent directory must already exist.",
						},
					},
				},
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
					migrated: { type: "object", additionalProperties: true },
					warnings: { type: "array" },
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as unknown as RenameValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as unknown as RenameValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
				return {
					rename: {
						results: v.results,
						failures: v.failures,
						totals: v.totals,
						migrated: v.migrated,
						warnings: v.warnings,
					},
				} as never;
			},
		},
		presentCall: (args) => {
			const renames = (args as { renames?: unknown }).renames;
			if (!Array.isArray(renames) || renames.length === 0) return undefined;
			return {
				card: "generic",
				title: `Rename ${renames.length} path${renames.length === 1 ? "" : "s"}`,
				locations: renames
					.filter((pair): pair is { from: string; to: string } => {
						if (typeof pair !== "object" || pair === null) return false;
						return (
							typeof (pair as { from?: unknown }).from === "string" &&
							typeof (pair as { to?: unknown }).to === "string"
						);
					})
					.flatMap((pair) => [{ path: pair.from }, { path: pair.to }]),
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const signal = exec.signal;
				const pairs = requestPairs(args);
				const results: RenamePairResult[] = [];
				const failures: FileFailureMeta[] = [];
				const warnings: string[] = [];

				// Preflight BEFORE approval: a symlink/directory or an existing
				// destination must not prompt the user for a wider mode it can never
				// use. A same-file destination (case-only rename) is left to the
				// bridge, which compares inodes.
				const prepared: Array<{ pair: RenamePair; expected?: FileProbe }> = [];
				for (const pair of pairs) {
					try {
						const fromProbe = await io.probeFile(pair.from, cwd, signal);
						const rejected = typeFailure(pair.from, fromProbe);
						if (rejected !== undefined) {
							failures.push(rejected);
							continue;
						}
						const toProbe = await io.probeFile(pair.to, cwd, signal);
						if (toProbe.kind === "symlink" || toProbe.kind === "directory" || toProbe.kind === "other") {
							failures.push({
								path: pair.to,
								code: "E_EXISTS",
								message: `Destination already exists: ${pair.to}. Remove it first or pick another name.`,
							});
							continue;
						}
						// A source that is absent now may be created by an earlier pair in
						// this batch (request order is the chain order); defer it.
						prepared.push({
							pair,
							expected: fromProbe.kind === "file" ? fromProbe : undefined,
						});
					} catch (error) {
						failures.push(failureFromError(error, pair.from));
					}
				}

				if (prepared.length === 0) return finalize(results, failures, warnings) as never;

				const sandboxPolicy = await sandbox.resolvePolicy(
					"rename",
					args as unknown as FsEscalationArgs,
					exec,
				);

				let store: HashStore | undefined;
				try {
					store = await loadHashStore(cwd);
				} catch (error) {
					warnings.push(
						`store could not be opened; files will still be renamed, but their anchor rows stay at the old path and the sweep/TTL will reclaim them: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}

				for (const { pair, expected } of prepared) {
					try {
						// A chained pair's source was absent before approval; probe it now so
						// the bridge still gets a version to compare against.
						const expectedProbe =
							expected ?? (await io.probeFile(pair.from, cwd, signal));
						const outcome = await io.renameFile(
							pair.from,
							pair.to,
							cwd,
							expectedProbe,
							signal,
							sandboxPolicy,
						);
						// Host consistency: the old path is gone, the new one exists.
						// Only observed events — never a write intent (nothing derives
						// a write guard from a rename).
						const absentRecorded = await io.emitAbsent(outcome.from, exec, signal);
						clearAlignmentNotice(outcome.from);
						notifyDocumentClosed(outcome.from);
						await io.emitObserved(outcome.to, exec, signal);
						const version = await io.statVersion(outcome.to, signal);

						let migrated: MigrateReport | undefined;
						let warning: string | undefined;
						if (store !== undefined) {
							try {
								migrated = store.renamePath(outcome.from, outcome.to);
							} catch (error) {
								warning = `store migration failed; the sweep/TTL will reclaim the old path's rows: ${
									error instanceof Error ? error.message : String(error)
								}`;
							}
						}
						if (!absentRecorded) {
							warning = `${warning === undefined ? "" : `${warning} `}the old path's absence observation was not recorded (no observation policy mounted, or the path was recreated).`;
						}
						results.push({
							from: { path: pair.from, canonicalPath: outcome.from },
							to: {
								path: pair.to,
								canonicalPath: outcome.to,
								...(version !== undefined ? { version } : {}),
							},
							status: "renamed",
							...(migrated !== undefined ? { migrated } : {}),
							...(warning !== undefined ? { warning } : {}),
						});
					} catch (error) {
						failures.push(
							failureFromError(sandbox.mapError(error, sandboxPolicy), pair.from),
						);
					}
				}

				return finalize(results, failures, warnings) as never;
			}).catch((error: unknown) =>
				thrownErrorResult(error, {
					path: (args as { renames?: Array<{ from?: unknown }> }).renames?.[0]?.from as
						string | undefined,
				}) as never,
			);
		},
	});
}

/**
 * Register the `rename` tool on the calling agent's scope (own layer).
 * @param _rootCtx - host context (unused; signature symmetry).
 * @param agentCtx - the agent's scoped context.
 * @param io - the filesystem bridge.
 * @param sandbox - the escalation controller.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerRenameTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildRenameTool(io, sandbox));
}
