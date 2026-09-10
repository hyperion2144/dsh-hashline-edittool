/**
 * The hashline `write` shadow — full ownership of the built-in write tool
 * (spec #85, decisions Q4-b + Q10 in #52).
 *
 * Why a shadow: the JSON channel contract must be preserved exactly, and the
 * text channel needs a string payload parsed before the body runs —
 * `defineTool` validates arguments and rejects a string, so this tool is a
 * raw scoped registration (the same scope-layer pattern read/edit/grep use)
 * with a dual-channel execute:
 *
 *   - object args (JSON channel): `{ file_path, content, sandbox_permissions?,
 *     justification? }` — the native dsh write vocabulary.
 *   - string args (text channel): the write DSL `file_path` on the first
 *     line, optional option rows, then a `<<<END` heredoc body; parsed to the
 *     exact object above.
 *
 * Both channels then run the SAME body, which:
 *   1. resolves the target, reads the pre-write content (`before`),
 *   2. writes through the fs bridge (policy + observation preserved),
 *   3. returns `{ path, operation: create|update, before, after }` plus
 *      `modelText` = the auto-read hashline preview (`行号:锚点` rows) so the
 *      model gets fresh anchors without an extra read call,
 *   4. web card data via `presentationMeta` diffs on update (native parity:
 *      overwrites render a diff, creates carry none).
 *
 * The old post-execute `write-hook` listener is REMOVED (its job is now
 * inline in execute).
 *
 * @module dsh-hashline-edittool/tool-write-shadow
 */

import type { Context } from "@deepseek-ai/cordis";
import { buildChannelTool } from "./text-input/channel-tool.js";
import type { FileIO } from "./fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "./sandbox.js";
import { execCwd, execSessionKey } from "./session-view.js";
import { withWorkspace } from "./session-view.js";
import { readAndServe } from "./read-and-serve.js";
import { computeHunkDiffs, type FileDiff } from "./presentation-helpers.js";
import { abortIf } from "./utils.js";
import { parseWriteText } from "./text-input/parse.js";
import { writeDescription } from "./prompts.js";
import { getEffectiveConfig } from "./config.js";

/** Model-facing heading that precedes the auto-read preview. */
const AUTO_READ_HEADING = "--- Auto-read (hashline anchors) ---";

/** Canonical write value: native contract plus the auto-read preview. */
export interface WriteValue {
	path: string;
	operation: "create" | "update";
	before: string | null;
	after: string;
	modelText: string;
}

export function buildWriteShadowTool(io: FileIO, sandbox: FsSandboxController) {
	return buildChannelTool({
		name: "write",
		description: writeDescription(getEffectiveConfig()),
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
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as WriteValue).modelText },
			],
			presentationMeta: (args, value) => {
				const v = value as WriteValue;
				if (v.before === null) return { diffs: [] } as never;
				const filePath = (args as { file_path?: string })?.file_path ?? v.path;
				return {
					diffs: computeHunkDiffs(filePath, v.before, v.after),
				} as never;
			},
		},
		presentCall(args) {
			const filePath = (args as { file_path?: string }).file_path;
			if (typeof filePath !== "string") return undefined;
			return {
				card: "diff",
				title: `Write ${filePath}`,
				// A pending write is shown against the (unknown) old content —
				// native parity: no oldText, newText = the requested content.
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
			const meta = result.meta as { diffs?: FileDiff[] } | undefined;
			const diffs = Array.isArray(meta?.diffs) ? meta.diffs : [];
			if (diffs.length === 0) return undefined;
			const first = diffs[0] as { path?: string } | undefined;
			return {
				card: "diff",
				title: `Write ${first?.path ?? ""}`,
				diffs,
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
					throw new Error('[E_BAD_SHAPE] Write request requires a "file_path" string.');
				}
				if (typeof content !== "string") {
					throw new Error('[E_BAD_SHAPE] Write request requires a "content" string.');
				}

				const sandboxPolicy = await sandbox.resolvePolicy(
					"write",
					args as unknown as FsEscalationArgs,
					exec,
				);
				abortIf(signal);

				// ---- read the pre-write state (create vs update) ----
				const absolute = await io.resolve(rawPath, cwd, signal);
				let before: string | null = null;
				let operation: "create" | "update" = "create";
				try {
					before = await io.readText(absolute, signal);
					operation = "update";
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!/not found/i.test(message) && !/ENOENT/.test(message)) throw error;
					before = null;
				}

				abortIf(signal);
				await io.writeText(absolute, content, signal, exec, sandboxPolicy);
				const after = content;

				// ---- model channel: auto-read hashline preview (fresh anchors) ----
				const served = await readAndServe(io, rawPath, cwd, {
					sessionKey,
					signal,
				}).catch(() => undefined);

				const modelText =
					served === undefined
						? `Wrote ${rawPath} (${operation}).`
						: `${AUTO_READ_HEADING}\n${served.text}`;

				return {
					path: rawPath,
					operation,
					before,
					after,
					modelText,
				} as WriteValue;
			});
		},
		parseText: (text) => parseWriteText(text),
		textParameterDescription:
			"Plain-text write payload: the file path on the first line, optional `sandbox_permissions:` / `justification:` rows, then the full content inside a `<<<END` … `<<<END` heredoc.",
	});
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
