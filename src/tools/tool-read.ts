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
	type ReadParams,
} from "../contract/contract.js";

import { readAndServe, UTF8_REWRITE_NOTE } from "../read-and-serve.js";
import { readDescription } from "../domain/edit/prompts.js";
import { splitLines } from "../infra/utils.js";
import { isJsonOutput, getEffectiveConfig, lineNumbersEnabled } from "../config.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { readNormFile, readView } from "../domain/session/file-view.js";
import { recordServed } from "../domain/session/session-view.js";
import {
	createResume,
	formatOmittedNotice,
	loadResume,
	responseBudgetChars,
	takeTextContinuation,
} from "../infra/response-stream.js";
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
import { probeLines } from "../domain/session/anchor-entry.js";
import {
	EMPTY_FILE_NOTE,
	cursorRejection,
	digitLineOf,
	formatWindowSummary,
	invertedWindowError,
	parseReadCursor,
	readWindowOf,
	resumeConflictError,
	type ReadCursorName,
	type ReadWindow,
} from "../domain/session/read-window.js";

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
				// #245: a line number OR an anchor, and the anchor's line is the
				// window's FIRST line (inclusive). Declared as a union because the
				// harness validates this schema itself, before `execute` runs —
				// the same pattern `tool-write-shadow` uses for its nullable field.
				oneOf: [{ type: "number" }, { type: "string" }],
				description:
					'Line number to start reading from (1-indexed), or the anchor of the line to start at — an anchor\'s line is included in the window.',
			},
			limit: {
				oneOf: [{ type: "number" }, { type: "string" }],
				description:
					'Maximum number of lines to read, or the anchor of the LAST line to read: a number counts rows, an anchor names the end point.',
			},
			resume: {
				type: "string",
				description:
					'Continuation token from a previous truncated result. Mutually exclusive with offset/limit — the token already names the window. Report continuations (from write/edit/undo) are consumed here too.',
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
					// #245: the lines this call actually served (absent when none were).
					window: {
						type: "object",
						additionalProperties: false,
						properties: {
							start: { type: "integer", required: true },
							end: { type: "integer", required: true },
							totalLines: { type: "integer", required: true },
						},
					},
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
				const v = value as ReadValue & { error?: ErrorMeta; window?: ReadWindow };
				if (v.error !== undefined) return { error: v.error } as never;
				const lang = langFromPath(v.path);
				return {
					path: v.path,
					offset: v.offset,
					lines: v.lines,
					totalLines: v.totalLines,
					hashlines: v.hashlines,
					...(v.window === undefined ? {} : { window: v.window }),
					...(lang === undefined ? {} : { lang }),
				} as never;
			},
		},
		presentCall: (args) => {
			// #256: a bare digit string is a line number serialized as text —
			// normalize it so the card shows the numeric window it names, not a
			// phantom anchor.
			const asNumber = (value: unknown): number | undefined =>
				typeof value === "number"
					? value
					: typeof value === "string"
						? digitLineOf(value)
						: undefined;
			const offset =
				asNumber((args as { offset?: unknown }).offset) ??
				(args as { offset?: number | string }).offset;
			const limit =
				asNumber((args as { limit?: unknown }).limit) ??
				(args as { limit?: number | string }).limit;
			const path =
				(args as { path?: unknown; file_path?: unknown }).path ??
				(args as { file_path?: unknown }).file_path;
			if (typeof path !== "string") return undefined;
			// #245: a cursor may be an anchor, and its line number is only known
			// after the read resolves it — so the call card names what was passed.
			const window =
				typeof limit === "number" && limit > 0
					? ` (${typeof offset === "number" ? offset : 1} - ${(typeof offset === "number" ? offset : 1) + limit - 1})`
					: typeof offset === "number"
						? ` (from line ${offset})`
						: typeof offset === "string" || typeof limit === "string"
							? ` (from anchor ${typeof offset === "string" ? offset : String(limit)})`
							: "";
			return {
				card: "generic",
				title: `Read ${path}${window}`,
				kind: "read",
				locations: [{ path, line: typeof offset === "number" ? offset : 1 }],
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


				// #245: a resume token and a cursor name the same window — carrying
				// both is refused instead of silently preferring one (ADR-0014).
				const resumeToken =
					typeof canonical.resume === "string" ? canonical.resume.trim() : "";
				if (resumeToken.length > 0 && (canonical.offset !== undefined || canonical.limit !== undefined)) {
					throw resumeConflictError();
				}
				// Anchors resolve to line numbers BEFORE the read, against the served
				// ledger, through the same read-only probe `edit` uses: no served
				// record, no echo, and `edit`'s refusal codes (ADR-0014).
				const cursors = await resolveReadCursors({
					cwd,
					sessionKey,
					signal,
					path: canonical.path,
					offset: canonical.offset,
					limit: canonical.limit,
				});
				const offset = cursors.offset;
				const limit = cursors.limit;
				// ADR-0013: a resume token names a window of its own, and (#245) carrying
				// a cursor ALONGSIDE it is refused above — never silently resolved. Two
				// kinds land here — read's own file windows (fall through to the normal
				// read flow at the token's offset) and report/text segments produced by
				// the mutating tools (consumed as plain text: their anchors, where they
				// exist, were minted and served by the producer).
				if (resumeToken.length > 0) {
					const sidecar = await loadResume(sessionKey, resumeToken, "read");
					if (sidecar.kind === "file-window") {
						const windowPath =
							typeof sidecar.meta.path === "string" ? sidecar.meta.path : pathFromArgs(args) ?? "";
						const windowOffset =
							typeof sidecar.meta.nextOffset === "number" ? sidecar.meta.nextOffset : 1;
						const continued = await readAndServe(io, windowPath, cwd, {
							sessionKey,
							signal,
							offset: windowOffset,
							maxChars: budget,
							exec,
						});
						// #245: the resumed window reports the same rows, the same window
						// sentence and the same resume token as a direct read — one
						// assembly, so the two paths cannot drift apart.
						return await assembleServedRead({
							sessionKey,
							displayPath: windowPath,
							start: windowOffset,
							text: continued.text,
							normalized: continued.normalized ?? "",
							served: continued.served,
							shownEnd: continued.shownEnd,
							nextOffset: continued.nextOffset,
							absolutePath: continued.absolutePath,
							hadUtf8DecodeErrors: continued.hadUtf8DecodeErrors,
						});
					}
					const take = await takeTextContinuation(sessionKey, resumeToken, "read", RESUME_WINDOW_LINES);
					const footer = take.done
						? "[End of continued report.]"
						: formatOmittedNotice({ omittedLines: take.remaining, consumer: "read", token: resumeToken });
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
							offset,
							limit,
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

				// The model's rows come from the structured builder when the served set is
				// the contiguous window, and from the renderer when it is SPARSE (an
				// oversized-line notice cannot be rebuilt from a range). Row text is the
				// one thing read-card still owns — the closing sentence is not (#245).
				const servedRows = result.served;
				const totalLines = splitLines(result.normalized).length;
				const start = Math.max(1, offset ?? 1);
				const shownEnd =
					result.shownEnd ??
					(result.nextOffset !== undefined ? result.nextOffset - 1 : totalLines);
				const contiguous =
					servedRows.length > 0 &&
					servedRows[0]!.position === start - 1 &&
					servedRows[servedRows.length - 1]!.position - servedRows[0]!.position + 1 === servedRows.length;
				const text =
					!contiguous || isJsonOutput()
						? result.text
						: buildReadPresentation(
								result.normalized,
								result.hashes,
								start,
								Math.max(0, shownEnd - start + 1),
								canonical.path,
								{ lineNumbers: lineNumbersEnabled() },
							).modelText;
				// #245: rows, window, ONE closing sentence and the resume token are
				// assembled in one place — this path and the resumed window share it.
				return await assembleServedRead({
					sessionKey,
					displayPath: canonical.path,
					start,
					text,
					normalized: result.normalized,
					served: result.served,
					shownEnd: result.shownEnd,
					nextOffset: result.nextOffset,
					absolutePath: result.absolutePath,
					hadUtf8DecodeErrors: result.hadUtf8DecodeErrors,
				});
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

/**
 * Resolve `read`'s `offset` / `limit` cursors to line numbers (#245, ADR-0014).
 *
 * A number is already a line number. An anchor is looked up against the served
 * ledger with the very same READ-ONLY probe `edit` uses: it writes no served
 * record, allocates no anchor, and echoes nothing — read's refusal names the
 * anchor and sends the caller back to `read`, in `edit`'s codes.
 *
 * @param input - the raw fields plus the session they resolve against.
 * @returns the numeric window, with absent fields absent.
 */
async function resolveReadCursors(input: {
	readonly path: string;
	readonly cwd: string;
	readonly sessionKey: string;
	readonly signal?: AbortSignal | undefined;
	readonly offset: unknown;
	readonly limit: unknown;
}): Promise<{ offset?: number; limit?: number }> {
	const offsetCursor = parseReadCursor(input.offset, "offset");
	const limitCursor = parseReadCursor(input.limit, "limit");
	const offsetLine = offsetCursor.kind === "line" ? offsetCursor.line : undefined;
	let limitCount = limitCursor.kind === "line" ? limitCursor.line : undefined;
	if (offsetCursor.kind !== "anchor" && limitCursor.kind !== "anchor") {
		return {
			...(offsetLine === undefined ? {} : { offset: offsetLine }),
			...(limitCount === undefined ? {} : { limit: limitCount }),
		};
	}
	const norm = await readNormFile(input.path, input.cwd, { signal: input.signal });
	const refs = [offsetCursor, limitCursor]
		.filter((cursor): cursor is { kind: "anchor"; anchor: string } => cursor.kind === "anchor")
		.map((cursor) => ({ anchor: cursor.anchor }));
	const probe = await probeLines({
		path: norm.absolutePath,
		content: norm.normalized,
		refs,
		sessionKey: input.sessionKey,
	});
	if (!probe.ok) {
		const failed = probe.rows[0]?.given ?? refs[0]!.anchor;
		const name: ReadCursorName =
			offsetCursor.kind === "anchor" && offsetCursor.anchor === failed ? "offset" : "limit";
		throw cursorRejection(probe.reason, failed, norm.absolutePath, name);
	}
	const lineOf = (anchor: string): number => probe.resolved.find((row) => row.anchor === anchor)!.line;
	const start = offsetCursor.kind === "anchor" ? lineOf(offsetCursor.anchor) : offsetLine ?? 1;
	if (limitCursor.kind === "anchor") {
		const endLine = lineOf(limitCursor.anchor);
		if (endLine < start) throw invertedWindowError(start, endLine);
		limitCount = endLine - start + 1;
	}
	return { offset: start, ...(limitCount === undefined ? {} : { limit: limitCount }) };
}

/**
 * Assemble one read result: rows, window, the ONE closing sentence and the
 * resume token (#245). The direct read and a resumed file window both come
 * through here, so the two channels cannot report different windows.
 *
 * Text mode ends with exactly one sentence ({@link formatWindowSummary}) — and
 * never for an empty file, whose single served row already says what to do.
 * JSON mode stays PURE JSON: the window, the token and the warnings ride INSIDE
 * the object instead of being appended as prose (they used to break JSON.parse).
 *
 * @param input - what the renderer served, plus the session for the token.
 * @returns the canonical value, model text included.
 */
async function assembleServedRead(input: {
	readonly sessionKey: string;
	readonly displayPath: string;
	readonly start: number;
	readonly text: string;
	readonly normalized: string;
	readonly served: readonly { readonly position: number; readonly anchor: string }[];
	readonly shownEnd?: number | undefined;
	readonly nextOffset?: number | undefined;
	readonly absolutePath?: string | undefined;
	readonly hadUtf8DecodeErrors?: boolean | undefined;
}): Promise<ReadValue & { modelText: string }> {
	const allLines = splitLines(input.normalized);
	const totalLines = allLines.length;
	const shownEnd = input.shownEnd ?? (input.nextOffset !== undefined ? input.nextOffset - 1 : totalLines);
	const window = readWindowOf(input.served, totalLines);
	// ADR-0013: a BUDGET cut mints the token before the text is assembled — the
	// token is part of the sentence the model reads, and in JSON mode it is a field.
	let continuation: { resume: string; remaining: number } | undefined;
	if (input.nextOffset !== undefined && input.nextOffset <= totalLines) {
		const { token } = await createResume({
			sessionKey: input.sessionKey,
			producer: "read",
			consumer: "read",
			kind: "file-window",
			rows: [],
			meta: { path: input.absolutePath ?? input.displayPath, nextOffset: input.nextOffset },
		});
		continuation = { resume: token, remaining: Math.max(0, totalLines - shownEnd) };
	}
	const lines: Array<{ number: number; text: string }> = [];
	const hashlines: Array<{ number: number; hash: string; text: string }> = [];
	const lineDict: Record<string, string> = {};
	for (const row of input.served) {
		const number = row.position + 1;
		const text = allLines[row.position] ?? "";
		lines.push({ number, text });
		hashlines.push({ number, hash: row.anchor, text });
		lineDict[lineNumbersEnabled() && row.anchor !== "" ? `${row.anchor}:${number}` : row.anchor] = text;
	}
	const lastAnchor = input.served.length === 0 ? "" : input.served[input.served.length - 1]!.anchor;
	// An empty file is a REAL serve whose single row has no text (#245): its
	// sentence is the tail, and the JSON channel spells it structurally instead.
	const summary =
		input.normalized === ""
			? EMPTY_FILE_NOTE
			: window === undefined
				? undefined
				: formatWindowSummary(
						window,
						continuation === undefined ? { nextAnchor: lastAnchor } : { resumeToken: continuation.resume },
					);
	const rebuildNotice = takeRebuildWarning();
	const utf8Note = input.hadUtf8DecodeErrors === true ? UTF8_REWRITE_NOTE : undefined;
	const warnings = [rebuildNotice, utf8Note].filter((warning): warning is string => warning !== undefined);
	let modelText: string;
	if (isJsonOutput()) {
		modelText = JSON.stringify({
			path: input.displayPath,
			offset: input.start,
			totalLines,
			lines: lineDict,
			...(window === undefined ? {} : { window }),
			...(continuation === undefined ? {} : { continuation }),
			...(warnings.length === 0 ? {} : { warnings }),
		});
	} else {
		modelText = input.text;
		if (summary !== undefined) modelText = `${modelText}\n\n${summary}`;
		if (utf8Note !== undefined) modelText = `${modelText}\n\n${utf8Note}`;
		if (rebuildNotice !== undefined) modelText = `${rebuildNotice}\n\n${modelText}`;
	}
	return {
		path: input.displayPath,
		offset: input.start,
		totalLines,
		lines,
		hashlines,
		...(window === undefined ? {} : { window }),
		...(continuation === undefined ? {} : { continuation }),
		modelText,
	};
}
