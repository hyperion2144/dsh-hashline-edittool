/**
 * The dsh `format` tool (map #275 / G1): format a file through its language
 * server — the whole document, or a range between two served anchors — as
 * ONE undo-able write. The thin tool layer around
 * `domain/format/manual-format.ts`: it resolves the path, delegates the
 * read/verify/format/write/undo transaction, and shapes the reply
 * (`[format: …]` section in text mode, `{ ok, path, format }` in JSON mode).
 *
 * Not gated on `format.auto`: the manual tool is always registered, and its
 * refusals are errors, never the auto pass's silence.
 *
 * @module dsh-hashline-edittool/tool-format
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isJsonOutput, lineNumbersEnabled } from "../config.js";
import { responseBudgetChars, spillModelTextOverflow } from "../infra/response-stream.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import type { FileIO } from "../infra/fs-bridge.js";
import type { FsSandboxController, FsEscalationArgs } from "../infra/sandbox.js";
import { execCwd, execSessionKey, openWorkspaceStore, withWorkspace } from "../domain/session/session-view.js";
import { renderFormatSection } from "../domain/edit/edit-response.js";
import { runManualFormat } from "../domain/format/manual-format.js";
import { FORMAT_DESCRIPTION } from "../domain/format/prompts.js";
import type { FormatRow } from "../domain/format/types.js";

/** The format tool's canonical value (returned from `execute`). */
type FormatCanonicalValue = {
	path: string;
	operation: "format";
	status: "formatted" | "noop";
	server: string;
	mode: string;
	requested: number;
	applied: number;
	changedLines: number;
	inMainDiffRows: number;
	unservedRows: number;
	rows: FormatRow[];
	modelText: string;
} & { [key: string]: unknown };

/**
 * Register the `format` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @param sandbox - the sandbox controller (the write needs its policy).
 * @returns the exact disposer that unregisters the tool.
 */
export function buildFormatTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "format",
		description: FORMAT_DESCRIPTION,
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Path to the file to format",
			},
			range: {
				type: "object",
				additionalProperties: false,
				description:
					"Format only the lines between two served anchors. `start` and `end` are anchors from a read/grep/diff row (`<line>:<anchor>` accepted); both must be served in this session, middle lines may not be.",
				properties: {
					start: { type: "string", required: true },
					end: { type: "string", required: true },
				},
			},
			...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					// NOTHING but `modelText` is required: the error path answers with
					// {modelText, error} (the edit tool's convention), and a strict
					// value shape turned every clean refusal (e.g. [E_LSP_NO_SERVER]
					// for a language with no server) into a schema-validation error.
					path: { type: "string" },
					operation: { type: "string" },
					status: { type: "string" },
					server: { type: "string" },
					mode: { type: "string" },
					requested: { type: "integer" },
					applied: { type: "integer" },
					changedLines: { type: "integer" },
					unservedRows: { type: "integer" },
					inMainDiffRows: { type: "integer" },
					// The formatter-changed rows, with the anchors they earned.
					rows: { type: "array" },
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as FormatCanonicalValue).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as FormatCanonicalValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
				// One file, one section: the client renders it beside/below the
				// text reply (C1).
				return {
					formats: [
						{
							path: v.path,
							status: v.status,
							server: v.server,
							mode: v.mode,
							requested: v.requested,
							applied: v.applied,
							changedLines: v.changedLines,
							inMainDiffRows: v.inMainDiffRows ?? 0,
							unservedRows: v.unservedRows,
							rows: v.rows,
						},
					],
				} as never;
			},
		},
		presentCall: (args) => {
			const a = args as { path?: string };
			if (typeof a.path !== "string") return undefined;
			return {
				card: "generic",
				title: `Format ${a.path}`,
				kind: "edit",
				locations: [{ path: a.path }],
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;
				const raw = args as {
					path?: unknown;
					range?: { start?: unknown; end?: unknown } | undefined;
				};
				const path = typeof raw.path === "string" ? raw.path : "";
				const sandboxPolicy = await sandbox.resolvePolicy(
					"format",
					args as unknown as FsEscalationArgs,
					exec,
				);
				const absolutePath = await io.resolve(path, cwd, signal);
				const range =
					raw.range !== undefined && typeof raw.range === "object"
						? {
								startRef: String(raw.range.start ?? ""),
								endRef: String(raw.range.end ?? ""),
							}
						: undefined;
				// The reply mints and serves rows — the anchor port writes only
				// to an OPEN store (#171 probe).
				await openWorkspaceStore(cwd);

				const outcome = await runManualFormat({
					io,
					absolutePath,
					displayPath: path,
					cwd,
					sessionKey,
					signal,
					exec,
					sandboxPolicy,
					range,
				});

				const modelText = isJsonOutput()
					? JSON.stringify({ ok: true, path, format: outcome.section })
					: `[format result] ${path}\n` +
						renderFormatSection(outcome.section, lineNumbersEnabled(), "format");
				const streamed = await spillModelTextOverflow({
					sessionKey,
					producer: "format",
					consumer: "read",
					kind: "report-segment",
					modelText,
					budgetChars: responseBudgetChars(),
				});
				const section = outcome.section;
				return {
					path,
					operation: "format",
					status: outcome.status,
					server: outcome.server,
					mode: outcome.mode,
					requested: outcome.requested,
					applied: outcome.applied,
					changedLines: outcome.changedLines,
					inMainDiffRows: section.inMainDiffRows ?? 0,
					unservedRows: section.unservedRows ?? 0,
					rows: section.rows ?? [],
					modelText: streamed.modelText,
				} satisfies FormatCanonicalValue;
			}).catch((error: unknown) => thrownErrorResult(error, { path: pathFromArgs(args) }) as never);
		},
	});
}

/**
 * Register the hashline `format` tool on the calling agent's scope (own
 * layer).
 */
export function registerFormatTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
	sandbox: FsSandboxController,
): () => void {
	return agentCtx.tools.register(buildFormatTool(io, sandbox));
}
