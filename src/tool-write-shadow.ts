/**
 * The hashline `write` shadow — full ownership of the built-in write tool.
 *
 * Why a shadow: after a write the model must be able to keep editing with
 * fresh anchors, and the web must show a write card whose left gutter carries
 * `行号:锚点` (the same gutter the edit card draws). A post-execute hook can
 * only append model text; a scoped shadow owns the result value, so it can
 * publish the structured `diffRows` the card renders AND inline the auto-read
 * preview in one place (the old `write-hook` listener is removed).
 *
 * The execute body:
 *   1. resolves the target and reads the pre-write content (`before`),
 *   2. writes through the fs bridge (policy + observation preserved),
 *   3. re-reads via `readAndServe` so the written lines are served — the model
 *      sees the `行号:锚点` preview and can edit immediately,
 *   4. computes structured diff rows (`-`/`+`/context, each with its anchor)
 *      for the web card's gutter.
 *
 * Contract parity: the JSON parameter vocabulary
 * (`{file_path, content, sandbox_permissions?, justification?}`) and the
 * `{path, operation: create|update, before, after}` value match the built-in
 * tool; `diffRows` and `modelText` are additive.
 *
 * @module dsh-hashline-edittool/tool-write-shadow
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { FileIO } from "./fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { execCwd, execSessionKey } from "./session-view.js";
import { withWorkspace } from "./session-view.js";
import { readAndServe } from "./read-and-serve.js";
import {
	buildReadJson,
	computeHunkDiffs,
	diffRowsFromGenDiff,
	type EditDiffRow,
} from "./presentation-helpers.js";
import { genDiff } from "./edit-diff.js";
import { lineHashes } from "./hashline/index.js";
import { contextLinesCfg } from "./hashline/hash-assign.js";
import { abortIf } from "./utils.js";
import { isJsonOutput } from "./config.js";

/** Model-facing heading that precedes the auto-read preview (hook parity). */
const AUTO_READ_HEADING = "--- Auto-read (hashline anchors) ---";

/** Canonical write value: built-in contract plus the card/model extensions. */
export interface WriteValue {
	path: string;
	operation: "create" | "update";
	before: string | null;
	after: string;
	/** Structured rows for the web card's `行号:锚点` gutter. */
	diffRows?: EditDiffRow[];
	modelText: string;
}

/**
 * Build the `write` shadow definition.
 * @param io - the filesystem bridge.
 * @param sandbox - the escalation controller.
 * @returns A registry-ready definition that shadows the built-in `write`.
 */
export function buildWriteShadowTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "write",
		description: "Create or fully replace a UTF-8 text file.",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Path to write, resolved by the filesystem backend.",
			},
			content: {
				type: "string",
				required: true,
				description: "Full UTF-8 text content to write.",
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					operation: {
						type: "string",
						required: true,
						enum: ["create", "update"],
					},
					before: {
						required: true,
						oneOf: [{ type: "string" }, { type: "null" }],
					},
					after: { type: "string", required: true },
					// Rendering channel: structured rows carrying the per-line
					// `行号:锚点` gutter facts — never parsed from model text.
					diffRows: { type: "array" },
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as WriteValue).modelText },
			],
			presentationMeta: (args, value) => {
				const v = value as WriteValue;
				const filePath =
					(args as { file_path?: string } | undefined)?.file_path ?? v.path;
				return {
					path: filePath,
					// Built-in parity: overwrites carry hunks, creates carry none.
					diffs:
						v.before === null
							? []
							: computeHunkDiffs(filePath, v.before, v.after),
					...(v.diffRows !== undefined && v.diffRows.length > 0
						? { diffRows: v.diffRows }
						: {}),
				} as never;
			},
		},
		presentCall(args) {
			const filePath = (args as { file_path?: string }).file_path;
			if (typeof filePath !== "string") return undefined;
			return {
				card: "diff",
				title: `Write ${filePath}`,
				diffs: [
					{
						path: filePath,
						oldText: null,
						newText: (args as { content?: string }).content ?? "",
					},
				],
				locations: [{ path: filePath }],
			};
		},
		presentResult(_args, result) {
			if (result.isError) return undefined;
			const meta = result.meta as
				| { path?: string; diffs?: unknown[]; diffRows?: unknown[] }
				| undefined;
			const diffs = Array.isArray(meta?.diffs) ? meta.diffs : [];
			const diffRows = Array.isArray(meta?.diffRows) ? meta.diffRows : [];
			if (diffs.length === 0 && diffRows.length === 0) return undefined;
			return {
				card: "diff",
				title: `Write ${meta?.path ?? ""}`,
				diffs: diffs as never,
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;
				const rawPath = (args as { file_path?: unknown }).file_path;
				const content = (args as { content?: unknown }).content;
				if (typeof rawPath !== "string" || rawPath.length === 0) {
					throw new Error(
						'[E_BAD_SHAPE] Write request requires a "file_path" string.',
					);
				}
				if (typeof content !== "string") {
					throw new Error(
						'[E_BAD_SHAPE] Write request requires a "content" string.',
					);
				}

				const sandboxPolicy = await sandbox.resolvePolicy(
					"write",
					args as unknown as FsEscalationArgs,
					exec,
				);
				abortIf(signal);

				// ---- pre-write state: create vs update ----
				const absolute = await io.resolve(rawPath, cwd, signal);
				let before: string | null = null;
				let operation: "create" | "update" = "create";
				try {
					before = await io.readText(absolute, signal);
					operation = "update";
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!/not found/i.test(message) && !/ENOENT/.test(message)) {
						throw error;
					}
					before = null;
				}

				abortIf(signal);
				await io.writeText(absolute, content, signal, exec, sandboxPolicy);
				const after = content;

				// ---- model channel: serve the written lines (fresh anchors) ----
				const served = await readAndServe(io, rawPath, cwd, {
					sessionKey,
					signal,
				}).catch(() => undefined);

				const modelText =
					served === undefined
						? `Wrote ${rawPath} (${operation}).`
						: isJsonOutput() &&
							  served.normalized !== undefined &&
							  served.hashes !== undefined
							? JSON.stringify(
									buildReadJson(
										served.normalized,
										served.hashes,
										1,
										served.hashes.length,
										rawPath,
									),
								)
							: `${AUTO_READ_HEADING}\n${served.text}`;

				// ---- web card channel: structured rows with `行号:锚点` ----
				const diffRows = await buildDiffRows(absolute, before, after).catch(
					() => undefined,
				);

				return {
					path: rawPath,
					operation,
					before,
					after,
					...(diffRows !== undefined ? { diffRows } : {}),
					modelText,
				} as WriteValue;
			});
		},
	});
}

/**
 * Structured diff rows for the card gutter: `-` removed (pre-write anchors),
 * `+` added and context (post-write anchors). Anchors come from the same
 * session allocator the read/grep rows use, so the card shows exactly the
 * markers the model was served. A create diffs against "" and yields all-`+`
 * rows.
 */
async function buildDiffRows(
	absolutePath: string,
	before: string | null,
	after: string,
): Promise<EditDiffRow[]> {
	const afterHashes = await lineHashes(after, absolutePath);
	const beforeHashes =
		before === null ? undefined : await lineHashes(before, absolutePath);
	const { rows } = genDiff(
		before ?? "",
		after,
		contextLinesCfg(),
		afterHashes,
		beforeHashes,
	);
	return diffRowsFromGenDiff(rows);
}

/**
 * Register the hashline write shadow on the calling agent's scope.
 * @param _rootCtx - host context (unused; kept for signature symmetry).
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @param sandbox - the escalation controller.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerWriteShadow(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildWriteShadowTool(io, sandbox));
}
