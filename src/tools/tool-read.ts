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
 *
 * ADR-0013: the returned window is bounded by the per-response char budget;
 * a truncated read carries a `continuation` token consumable via `resume`
 * (or the classic `offset`). Report/text continuations from other tools are
 * consumed here too — read is the only continuation exit.
 * @module dsh-tool-hashline/tool-read
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	normalizeRequest as normReq,
	assertReadRequest,
	readFilePathSchema,
	lineNumbersSchema,
	type ReadParams,
} from "../contract/contract.js";

import { readAndServe, UTF8_REWRITE_NOTE } from "../read-and-serve.js";
import { readDescription } from "../domain/edit/prompts.js";
import { splitLines } from "../infra/utils.js";
import { isJsonOutput, getEffectiveConfig } from "../config.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { readView } from "../domain/session/file-view.js";
import { recordServed } from "../domain/session/session-view.js";
import { createResume, loadResume, takeTextContinuation, responseBudgetChars } from "../infra/response-stream.js";
import {
	buildReadPresentation,
	buildReadJson,
	extractReadBody,
	langFromPath,
	readMetaFromMeta,
	type ReadPresentation,
	type ReadValue,
} from "../render/read-card.js";

import type { FileIO } from "../infra/fs-bridge.js";
import { execCwd, execSessionKey } from "../domain/session/session-view.js";
import { withWorkspace } from "../domain/session/session-view.js";
import { takeRebuildWarning } from "../domain/session/hash-store.js";

const RESUME_WINDOW_LINES = 4000;

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
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
			limit: {
				type: "number",
				description: "Maximum number of lines to read",
			},
			resume: {
				type: "string",
				description:
					'Continuation token from a previous truncated result. Takes precedence over offset/limit. Report continuations (from write/edit/undo) are consumed here too.',
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
					continuation: {
						type: "object",
						additionalProperties: false,
						properties: {
							resume: { type: "string", required: true },
							remaining: { type: "integer", required: true },
						},
					},
					error: errorFieldSchema,
					// Present only on a symbol/anchor read; JSON mode's extra projection.
					symbol: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string", required: true },
							kind: { type: "string", required: true },
							start: { type: "integer", required: true },
							end: { type: "integer", required: true },
						},
					},
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as ReadValue & { modelText: string }).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as ReadValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
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

				const canonical = normReq(args) as ReadParams;
				assertReadRequest(canonical);
				const budget = responseBudgetChars();

				// ADR-0013: a resume token takes precedence over offset/limit. Two
				// kinds land here — read's own file windows (fall through to the
				// normal read flow at the token's offset) and report/text segments
				// produced by the mutating tools (consumed as plain text: their
				// anchors, where they exist, were minted and served by the producer).
				if (typeof canonical.resume === "string" && canonical.resume.length > 0) {
					const sidecar = await loadResume(sessionKey, canonical.resume, "read");
					if (sidecar.kind === "file-window") {
						const windowPath =
							typeof sidecar.meta.path === "string" ? sidecar.meta.path : pathFromArgs(args) ?? "";
						const windowOffset =
							typeof sidecar.meta.nextOffset === "number" ? sidecar.meta.nextOffset : 1;
						const continued = await readAndServe(io, windowPath, cwd, {
							sessionKey,
							signal,
							offset: windowOffset,
							lineNumbers: canonical.line_numbers !== false,
							maxChars: budget,
							exec,
						});
						const continuedTotal = splitLines(continued.normalized ?? "").length;
						const continuedBody = continued.hadUtf8DecodeErrors
							? `${continued.text}\n\n${UTF8_REWRITE_NOTE}`
							: continued.text;
						const allLines = splitLines(continued.normalized ?? "");
						const shownEnd = continued.nextOffset !== undefined ? continued.nextOffset - 1 : continuedTotal;
						const lines: Array<{ number: number; text: string }> = [];
						const hashlines: Array<{ number: number; hash: string; text: string }> = [];
						for (let i = windowOffset - 1; i < Math.min(shownEnd, allLines.length); i++) {
							lines.push({ number: i + 1, text: allLines[i] ?? "" });
							hashlines.push({ number: i + 1, hash: continued.hashes?.[i] ?? "", text: allLines[i] ?? "" });
						}
						return {
							path: windowPath,
							offset: windowOffset,
							totalLines: continuedTotal,
							lines,
							hashlines,
							modelText: continuedBody,
						} as ReadValue & { modelText: string };
					}
					const take = await takeTextContinuation(sessionKey, canonical.resume, "read", RESUME_WINDOW_LINES);
					const footer = take.done
						? "[End of continued report.]"
						: `(Omitted ${take.remaining} more lines. Use read {resume: "${canonical.resume}"} to continue.)`;
					const modelText = `[Continued report]\n${take.lines.join("\n")}\n${footer}`;
					return {
						path: typeof sidecar.meta.path === "string" ? sidecar.meta.path : pathFromArgs(args) ?? "",
						offset: 1,
						totalLines: 0,
						lines: [],
						hashlines: [],
						modelText,
					} as ReadValue & { modelText: string };
				}

				// `read` READS LINES. It used to answer structural questions too — a
				// symbol's block, an outline, cross-file references — until those
				// selectors were the reason a line reader needed a grammar and a global
				// switch. They now live where they belong: `ast_grep` for shape (with no
				// pattern it returns the outline), `lsp` for anything semantic.
				//
				// A call still carrying one of the old selectors must FAIL rather than
				// silently read lines instead: `assertReadRequest` rejects unknown
				// fields, so the model is told what changed rather than handed a
				// different answer to the question it asked.

				// A read of a file deleted mid-session must clear the stale
				// "present" observation: the policy would otherwise keep
				// demanding a re-read that can never succeed (read → not-found
				// → read loop). An absent observation makes a later write a
				// create-if-absent.
				let result;
				try {
					result = await readAndServe(
						io,
						canonical.path,
						cwd,
						{
							sessionKey,
							signal,
							offset: canonical.offset,
							limit: canonical.limit,
							lineNumbers: canonical.line_numbers !== false,
							maxChars: budget,
							exec,
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
				// The present observation is emitted by `readAndServe` itself: serving
				// rows IS observing the file, and one choke point beats a call per
				// caller (the duplicate here made every read observe twice).

				if (result.hashes === undefined || result.normalized === undefined) {
					// Defensive fallback: if the file didn't normalize cleanly, fall
					// back to a generic string-shaped value so the model still gets
					// the read.
					return {
						path: canonical.path,
						offset: 1,
						totalLines: 0,
						lines: [],
						hashlines: [],
						modelText: result.text,
					} as ReadValue & { modelText: string };
				}

				// Window seam (#212): the render bound is `shownEnd` — the renderer's
				// LAST SERVED row. `nextOffset` is NOT the render bound: it exists
				// only when the char BUDGET cut the window (it mints the resume
				// token), so deriving the window from it made every limit-cut fall
				// back to EOF and rebuild rows that were never served — bare-number
				// rows for unallocated lines, "not in served set" for persisted ones.
				const totalLines = splitLines(result.normalized).length;
				const start = Math.max(1, canonical.offset ?? 1);
				const shownEnd =
					result.shownEnd ??
					(result.nextOffset !== undefined ? result.nextOffset - 1 : totalLines);
				const shownCount = Math.max(0, shownEnd - start + 1);
				// Served rows are normally the contiguous window [start..shownEnd].
				// The oversized-line branch serves a SPARSE set (oversized rows are
				// shown as notices, not content) — rebuild those from the served
				// rows alone so presentation == served, never more.
				const servedRows = result.served;
				const contiguous =
					servedRows.length > 0 &&
					servedRows[0]!.position === start - 1 &&
					servedRows[servedRows.length - 1]!.position - servedRows[0]!.position + 1 ===
						servedRows.length;
				const servedAllLines = splitLines(result.normalized);
				const buildFromServed = (): ReadValue & { modelText: string } => {
					const lines: Array<{ number: number; text: string }> = [];
					const hashlines: Array<{ number: number; hash: string; text: string }> = [];
					const lineDict: Record<string, string> = {};
					for (const row of servedRows) {
						const number = row.position + 1;
						const text = servedAllLines[row.position] ?? "";
						lines.push({ number, text });
						hashlines.push({ number, hash: row.anchor, text });
						lineDict[canonical.line_numbers !== false ? `${row.anchor}:${number}` : row.anchor] =
							text;
					}
					if (isJsonOutput()) {
						const modelView = {
							path: canonical.path,
							offset: start,
							totalLines: servedAllLines.length,
							lines: lineDict,
						};
						return {
							path: canonical.path,
							offset: start,
							totalLines: servedAllLines.length,
							lines,
							hashlines,
							modelText: JSON.stringify(modelView),
						} as ReadValue & { modelText: string };
					}
					// Text mode: the renderer's preview IS the model text here — it
					// carries the header, the served rows and the oversized-row
					// notices that a range rebuild could not reproduce.
					return {
						path: canonical.path,
						offset: start,
						totalLines: servedAllLines.length,
						lines,
						hashlines,
						modelText: result.text,
					} as ReadValue & { modelText: string };
				};
				// JSON mode: one builder for both windows — the served rows ARE the
				// rendered rows in every branch (contiguous window or sparse
				// oversized-line set), so the dict/arrays come from one place.
				const presentation =
					!contiguous || isJsonOutput()
						? buildFromServed()
						: buildReadPresentation(
							result.normalized!,
							result.hashes!,
							start,
							shownCount,
							canonical.path,
							{ lineNumbers: canonical.line_numbers !== false },
						);
				// If the file had non-UTF-8 bytes, the readAndServe text already
				// carries the rewrite note — append it to the model text so the
				// structured value's modelText is faithful to the original contract.
				let body = result.hadUtf8DecodeErrors
					? `${presentation.modelText}\n\n${UTF8_REWRITE_NOTE}`
					: presentation.modelText;
				// A REBUILD invalidated every anchor this workspace had (a version upgrade
				// or a capacity sweep). The model has to hear it from the first result that
				// runs afterwards, or it keeps presenting markers that are now dead and
				// reads every refusal as its own mistake. `takeRebuildWarning` clears it, so
				// exactly ONE result carries the notice — whichever tool ran first — and the
				// rest of the session sees clean output.
				//
				// Prepended rather than appended: it is the frame the rows below are read
				// in, not a footnote to them.
				const rebuildNotice = takeRebuildWarning();
				if (rebuildNotice !== undefined) body = `${rebuildNotice}\n\n${body}`;
				// companion client plugin) renders the web read card from the
				// persisted presentationMeta alone, so the model no longer pays the
				// four <path>/<type>/<content> wrapper lines per read — and json
				// mode emits pure JSON again. extractReadBody still strips the
				// envelope from PRE-0.4.2 session history.

				// ADR-0013: when the window was budget-cut, mint the continuation.
				let continuation: { resume: string; remaining: number } | undefined;
				if (result.nextOffset !== undefined && result.nextOffset <= totalLines) {
					const { token } = await createResume({
						sessionKey,
						producer: "read",
						consumer: "read",
						kind: "file-window",
						rows: [],
						meta: { path: result.absolutePath, nextOffset: result.nextOffset },
					});
					const omitted = totalLines - shownEnd;
					continuation = { resume: token, remaining: omitted };
					// ADR-0013: the classic pagination hint is superseded by the resume footer.
					body = body.replace(/\n*\[Showing lines [^\]]*\]\s*$/, "\n");
					body = `${body}(Omitted ${omitted} lines. Use read {resume: "${token}"} to continue.)`;
				}
				return {
					...presentation,
					modelText: body,
					...(continuation !== undefined ? { continuation } : {}),
				};
		}).catch((error: unknown) => ({
			path: pathFromArgs(args) ?? "",
			offset: 1,
			totalLines: 0,
			lines: [],
			hashlines: [],
			...(thrownErrorResult(error, { path: pathFromArgs(args) }) as unknown as Record<string, unknown>),
		}) as never);
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
