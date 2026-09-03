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
import {
	normalizeRequest as normReq,
	assertReadRequest,
	readFilePathSchema,
	readPathAliasSchema,
	lineNumbersSchema,
} from "./contract.js";

import { readAndServe, UTF8_REWRITE_NOTE } from "./read-and-serve.js";
import { readDescription } from "./prompts.js";
import { DEFAULT_MAX_LINES } from "./file-view.js";
import { splitLines } from "./utils.js";
import { isJsonOutput, getEffectiveConfig } from "./config.js";
import {
	buildReadPresentation,
	envelopeReadText,
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
		description: readDescription(getEffectiveConfig()),
		parameters: {
			file_path: readFilePathSchema,
			path: readPathAliasSchema,
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
		limit: {
			type: "number",
			description: "Maximum number of lines to read",
		},
		line_numbers: {
			...lineNumbersSchema,
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
			const path =
				(args as { path?: unknown; file_path?: unknown }).path ??
				(args as { file_path?: unknown }).file_path;
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

				// A read of a file deleted mid-session must clear the stale
				// "present" observation: the policy would otherwise keep
				// demanding a re-read that can never succeed (read → not-found
				// → read loop). An absent observation makes a later write a
				// create-if-absent.
				let result;
				try {
					result = await readAndServe(
						io,
						rawPath,
						cwd,
						{
							sessionKey,
							signal,
							offset: canonical.offset,
							limit: canonical.limit,
							lineNumbers: canonical.line_numbers === true,
						},
					);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : String(err);
					const code = (err as { code?: unknown })?.code;
					if (
						code === "FS_NOT_FOUND" ||
						message.includes("[E_NOT_FOUND]") ||
						/not found/i.test(message)
					) {
						await io.emitAbsent(canonical.path, exec, signal);
					}
					throw err;
				}
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
						modelText: envelopeReadText(rawPath, result.text),
					} as ReadValue & { modelText: string };
				}

				const presentation = isJsonOutput()
					? (() => {
						// v2.0 (#66/B1): rebuild the pure-JSON view on the bare-anchor
						// contract. The legacy branch split dict keys on '#' (v1.0
						// <number>#<hash> form); with v2.0 bare anchors there is no '#',
						// number parsing produced NaN, and NaN is not lossless JSON —
						// every read in json mode failed output validation.
						const allLines = splitLines(result.normalized);
						const start = Math.max(1, canonical.offset ?? 1);
						const startIdx = start - 1;
						const endIdx = Math.min(
							startIdx + (canonical.limit ?? DEFAULT_MAX_LINES),
							allLines.length,
						);
						const lines: Array<{ number: number; text: string }> = [];
						const hashlines: Array<{ number: number; hash: string; text: string }> = [];
						const lineDict: Record<string, string> = {};
						for (let i = startIdx; i < endIdx; i++) {
							const number = i + 1;
							const text = allLines[i] ?? "";
							const hash = result.hashes[i] ?? "";
							lines.push({ number, text });
							hashlines.push({ number, hash, text });
							// anchor-keyed dict (grep/edit symmetry); with line_numbers on
							// the key renders as <line>:<anchor> like the text rows.
							lineDict[canonical.line_numbers === true ? `${number}:${hash}` : hash] = text;
						}
						const modelView = {
							path: rawPath,
							offset: start,
							totalLines: allLines.length,
							lines: lineDict,
						};
						return {
							path: rawPath,
							offset: start,
							totalLines: allLines.length,
							lines,
							hashlines,
							modelText: JSON.stringify(modelView),
						} as ReadValue & { modelText: string };
					})()
: buildReadPresentation(
							result.normalized,
							result.hashes,
							canonical.offset ?? 1,
							canonical.limit ?? DEFAULT_MAX_LINES,
							rawPath,
							{ lineNumbers: canonical.line_numbers === true },
						);
				// If the file had non-UTF-8 bytes, the readAndServe text already
				// carries the rewrite note — append it to the model text so the
				// structured value's modelText is faithful to the original contract.
				const body = result.hadUtf8DecodeErrors
					? `${presentation.modelText}\n\n${UTF8_REWRITE_NOTE}`
					: presentation.modelText;
				// dsh 0.1.2 web parity: the web client derives the read card only
				// from a result text matching the read envelope; the card renders
				// from presentationMeta, and the model still sees the usual rows
				// inside the envelope.
				const modelText = envelopeReadText(rawPath, body);
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
