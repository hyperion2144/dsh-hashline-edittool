/**
 * The dsh `read` tool: hash-anchored reads (`<line>#<hash>:content` rows) that
 * shadow the built-in `read` on the agent's own scope layer. Every shown row
 * is recorded as served, so a later `edit` can verify the model was actually
 * shown the lines it targets.
 *
 * Structured presentation: the canonical value carries the model-facing
 * fields plus the `lines` / `hashlines` arrays the web's read card needs.
 * `output.render` projects the model text (as a `code` content block so the
 * `:` separator in the row format does not trigger markdown table parsing).
 * `output.presentationMeta` derives the read-card projection; `presentResult`
 * reads the persisted meta + content and emits a `ReadResultView`.
 * `presentCall` is generic (no IO, pure on `args`) — the read result isn't
 * available until `execute` returns.
 * @module dsh-hashline-edittool/tool-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertReadRequest, pathSchema } from "./contract.js";

import { readAndServe } from "./read-and-serve.js";
import { READ_DESCRIPTION } from "./prompts.js";
import { DEFAULT_MAX_LINES } from "./file-view.js";
import { isJsonOutput } from "./config.js";
import {
	buildReadPresentation,
	buildReadJson,
	extractReadBody,
	langFromPath,
	readMetaFromMeta,
	type ReadPresentation,
	type ReadValue,
} from "./presentation-helpers.js";

import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey } from "./session-view.js";
import { withWorkspace } from "./session-view.js";

/**
 * Register the hash-anchored `read` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildReadTool(io: FileIO) {
	return defineTool({
		name: "read",
		description: READ_DESCRIPTION,
		parameters: {
			path: pathSchema,
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
			limit: {
				type: "number",
				description: "Maximum number of lines to read",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					offset: { type: "integer", required: true },
					totalLines: { type: "integer", required: true },
					lines: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								number: { type: "integer", required: true },
								text: { type: "string", required: true },
							},
						},
					},
					hashlines: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								number: { type: "integer", required: true },
								hash: { type: "string", required: true },
								text: { type: "string", required: true },
							},
						},
					},
					truncatedByBytes: { type: "boolean" },
					modelText: { type: "string", required: true },
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as ReadValue & { modelText: string }).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as ReadValue;
				const lang = langFromPath(v.path);
				return {
					path: v.path,
					offset: v.offset,
					lines: v.lines,
					totalLines: v.totalLines,
					hashlines: v.hashlines,
					...(lang === undefined ? {} : { lang }),
				} as never;
			},
		},
		presentCall: (args) => {
			const offset = (args as { offset?: number }).offset;
			const limit = (args as { limit?: number }).limit;
			const path = (args as { path?: string }).path;
			if (typeof path !== "string") return undefined;
			const window =
				limit !== undefined && limit > 0
					? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
					: offset !== undefined
						? ` (from line ${offset})`
						: "";
			return {
				card: "generic",
				title: `Read ${path}${window}`,
				kind: "read",
				locations: [{ path, line: offset ?? 1 }],
			};
		},
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const meta = readMetaFromMeta(result.meta);
			if (meta === undefined) return undefined;
			const only = result.content.length === 1 ? result.content[0] : undefined;
			const text = only?.type === "text" ? only.text : undefined;
			if (text === undefined) return undefined;
			const body = extractReadBody(text);
			return {
				card: "read",
				path: meta.path,
				offset: meta.offset,
				lines: meta.lines,
				totalLines: meta.totalLines,
				hashlines: meta.hashlines,
				...(meta.lang === undefined ? {} : { lang: meta.lang }),
				content: body === undefined ? [{ type: "text", text }] : [{ type: "text", text: body }],
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;

				const canonical = normReq(args);
				assertReadRequest(canonical);
				const rawPath = canonical.path;

				const result = await readAndServe(
					io,
					rawPath,
					cwd,
					{
						sessionKey,
						signal,
						offset: canonical.offset,
						limit: canonical.limit,
					},
				);
				// Record the present observation with the fs policy gate so later
				// built-in write/edit calls see this file as observed at the
				// version the model just read (a no-op when no policy listens).
				await io.emitObserved(result.absolutePath, exec, signal);

				if (result.hashes === undefined || result.normalized === undefined) {
					// Defensive fallback: if the file didn't normalize cleanly, fall
					// back to a generic string-shaped value so the model still gets
					// the read.
					return {
						path: rawPath,
						offset: 1,
						totalLines: 0,
						lines: [],
						hashlines: [],
						modelText: result.text,
					} as ReadValue & { modelText: string };
				}

				const presentation = isJsonOutput()
					? ({
							modelText: JSON.stringify(
								buildReadJson(
									result.normalized,
									result.hashes,
									canonical.offset ?? 1,
									canonical.limit ?? DEFAULT_MAX_LINES,
									rawPath,
								),
							),
						} as ReadValue & { modelText: string })
					: buildReadPresentation(
							result.normalized,
							result.hashes,
							canonical.offset ?? 1,
							canonical.limit ?? DEFAULT_MAX_LINES,
							rawPath,
						);
				// If the file had non-UTF-8 bytes, the readAndServe text already
				// carries the rewrite note — append it to the model text so the
				// structured value's modelText is faithful to the original contract.
				const modelText = result.hadUtf8DecodeErrors
					? `${presentation.modelText}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
					: presentation.modelText;
				return { ...presentation, modelText };
			});
		},
	});
}

/**
 * Register the hashline tool on the calling agent's scope (own layer).
 */
export function registerReadTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
): () => void {
	return agentCtx.tools.register(buildReadTool(io));
}
