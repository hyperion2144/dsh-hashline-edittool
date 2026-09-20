/**
 * `lsp` — the semantic tool, and the first place the plugin prefers the protocol.
 *
 * The rule this implements is alignment with omp, stated there as a MUST:
 * symbol-aware work goes to the language server WHENEVER ONE IS AVAILABLE,
 * because a server follows shadowing, re-exports and cross-file usage that a
 * syntax tree cannot. AST answers "what shape is this"; this answers "what does
 * it mean, and who else touches it".
 *
 * The two fail differently on purpose. When no server can be had, this REFUSES
 * with the reason the manager already computed — it does not quietly return an
 * empty list, because "no server" and "no symbols" are different facts and the
 * model has to be able to tell them apart.
 *
 * @module dsh-hashline-edittool/tool-lsp
 */
import { pathToFileURL } from "node:url";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { languageForPath } from "../ast/language.js";
import { getLspManager } from "../lsp/manager.js";
import type { FileIO } from "../infra/fs-bridge.js";
import { splitLines } from "../infra/utils.js";
import { toLF } from "../render/edit-diff.js";
// The SAME anchor assigner `read` uses, so a row the card shows carries the
// marker an `edit` accepts — otherwise the card would be decorative.
import { anchorWidth, fmtHashlineRow, fmtMarker, lineHashesPure } from "../hashline/hash-assign.js";
import { serveRowsInWorkspace, execCwd, execSessionKey } from "../domain/session/session-view.js";
import { readMetaFromMeta } from "../render/read-card.js";
import { isJsonOutput } from "../config.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { anchorsFor } from "../hashline/session-anchors.js";
import { diagRowsToJson, verifiedReport } from "../lsp/auto-diag.js";

/** One symbol as the server reports it, flattened for display. */
interface FlatSymbol {
	readonly name: string;
	readonly kind: string;
	readonly line: number;
	readonly depth: number;
}

/**
 * LSP `SymbolKind`, 0-indexed HERE and 1-based in the protocol.
 *
 * The spec starts at `1 File`; this array starts at index 0, so every read of
 * it subtracts one. The mismatch is silent and total — it mislabels every
 * symbol in every answer — which is why the subtraction is spelled out rather
 * than left as `SYMBOL_KIND[kind]` for someone to "fix" back.
 */
const SYMBOL_KIND: readonly string[] = [
	"file", "module", "namespace", "package", "class", "method", "property", "field",
	"constructor", "enum", "interface", "function", "variable", "constant", "string",
	"number", "boolean", "array", "object", "key", "null", "enum-member", "struct",
	"event", "operator", "type-parameter",
];

/** Flatten `DocumentSymbol[]`, which nests children. */
function flattenSymbols(nodes: unknown, depth = 0): FlatSymbol[] {
	if (!Array.isArray(nodes)) return [];
	const out: FlatSymbol[] = [];
	for (const raw of nodes) {
		if (typeof raw !== "object" || raw === null) continue;
		const node = raw as {
			name?: unknown;
			kind?: unknown;
			range?: { start?: { line?: unknown } };
			location?: { range?: { start?: { line?: unknown } } };
			children?: unknown;
		};
		const name = typeof node.name === "string" ? node.name : undefined;
		if (name !== undefined) {
			// `DocumentSymbol` carries `range`; `SymbolInformation` carries
			// `location.range`. Servers send either depending on what the client
			// advertised, so both are read rather than one being assumed.
			const line = node.range?.start?.line ?? node.location?.range?.start?.line;
			out.push({
				name,
				// LSP's SymbolKind is 1-BASED: 1 File, 5 Class, 6 Method. Indexing a
				// 0-based array with it reported every class as a method — wrong for
				// every symbol, silently, in every call.
				kind:
					typeof node.kind === "number"
						? (SYMBOL_KIND[node.kind - 1] ?? `kind-${node.kind}`)
						: "unknown",
				line: typeof line === "number" ? line + 1 : 0,
				depth,
			});
		}
		out.push(...flattenSymbols(node.children, depth + 1));
	}
	return out;
}

/** The description the model reads. */
function lspDescription(): string {
	return [
		"Semantic code intelligence from a language server.",
		"",
		"Prefer this over `ast_grep` and text search for work that is about MEANING: definitions, references, symbols, renames, diagnostics. A server follows shadowing, re-exports and cross-file usage that a syntax tree cannot see; the AST tools answer questions about SHAPE.",
		"",
		"Operations:",
		"- `symbols` — the symbols of one file, as the server reports them.",
		"- `code_actions` — what the server offers at a position (`line`, and `symbol` for the token). Listed, not applied.",
		"- `diagnostics` — what the server has REPORTED for the file. Waits briefly for its first push; \"no answer yet\" and \"no problems\" are reported as the different things they are.",
		"- `request` — any LSP method, for anything not yet wrapped (see `query` and `payload`).",
		"",
		"This REFUSES rather than returning nothing when no server can be started, and says why: \"no server\" and \"no symbols\" are different facts.",
	].join("\n");
}

/**
 * Build the tool.
 *
 * @param io - the session's file access, for resolve + read.
 * @returns the tool definition.
 */
export function buildLspTool(io: FileIO) {
	// ONE wrapper adds the model channel to EVERY return path below — the tool's
	// branches each build their own structured value, and the text/JSON pair is
	// projected from it in a single place, so no branch can forget its mode.
	const tool = defineTool({
		name: "lsp",
		description: lspDescription(),
		parameters: {
			operation: {
				type: "string",
				required: true,
				description:
					"`symbols` for one file's symbols, `code_actions` for what a server offers at a position (see `line` / `symbol`), or `request` to send an LSP method directly.",
			},
			path: {
				type: "string",
				required: true,
				description: "The file to work on. Its extension decides which language server is asked for.",
			},
			query: {
				type: "string",
				description: "For `request`: the LSP method, e.g. `textDocument/definition`.",
			},
			payload: {
				type: "string",
				description: "For `request`: JSON params. Omitted means `{ textDocument: { uri } }`.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					operation: { type: "string", required: true },
					server: { type: "string", required: true },
					symbols: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								kind: { type: "string", required: true },
								line: { type: "integer", required: true },
								depth: { type: "integer", required: true },
							},
						},
					},
					raw: { type: "string" },
					// THE CARD'S ROWS. `lsp`'s answers are all line-anchored — every symbol
					// has a line, every diagnostic has a line — so the honest card is the
					// read card's gutter, and this is its shape (`{number, hash, text}`).
					//
					// `messages` is a DIAGNOSTIC row's second half: the row stays the verbatim
					// source line (what `edit` addresses, and what the served-state check must
					// vouch for), and the diagnostics sit beside it as data, so each channel
					// can present them as what they are.
					//
					// Emitted rather than derived on the client because the ANCHORS live
					// here: they are the same variable-length markers `read` hands out, so
					// a symbol row is directly editable without a second read.
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
								messages: { type: "array", items: { type: "string" } },
								severities: { type: "array", items: { type: "integer" } },
							},
						},
					},
					totalLines: { type: "integer", required: true },
					// THE MODEL CHANNEL, declared because the DSL validates the returned
					// value against this schema (`value.modelText is not declared` is the
					// error a returned-but-undeclared field produces).
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
			// The model reads modelText, built by the wrapper below for EVERY branch
			// (text listing or JSON envelope) — this render used to re-derive prose
			// from `symbols`/`raw`, which would have ignored JSON mode entirely.
			render: (_args: unknown, value: { readonly modelText: string }) => [
				{ type: "text", text: value.modelText },
			],
		// The card's projection. The component that draws a `read` draws this too,
		// because the DATA is the same shape — a line, its anchor, its content.
		//
		// `lines` must be an ARRAY ({number, text}), not an object: the read meta's
		// soft-validator rejects an object outright, which silently dropped the
		// whole projection and left the call as raw input/output.
		presentationMeta: (_args: unknown, value: { readonly path: string; readonly hashlines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number; readonly error?: ErrorMeta }) => {
			if (value.error !== undefined) return { error: value.error } as never;
			return ({
				path: value.path,
				offset: 1,
				lines: value.hashlines.map(({ number, text }) => ({ number, text })),
				totalLines: value.totalLines,
				hashlines: value.hashlines,
			}) as never;
		},
		},
		// THE CARD ITSELF: `presentResult` is what makes the web draw one. The meta
		// alone drew nothing — without this the call stayed raw input/output, which
		// is exactly what was reported.
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const meta = readMetaFromMeta(result.meta);
			if (meta === undefined) return undefined;
			const only = result.content.length === 1 ? result.content[0] : undefined;
			const text = only?.type === "text" ? only.text : undefined;
			if (text === undefined) return undefined;
			return {
				card: "read",
				path: meta.path,
				offset: meta.offset,
				lines: meta.lines,
				totalLines: meta.totalLines,
				hashlines: meta.hashlines,
				content: [{ type: "text", text }],
			};
		},
		// The return type is left open ON PURPOSE: the branches build the structured
		// value and the wrapper below adds the model channel, so the inline body is
		// one field short of the declared schema. The HOST validates the wrapped
		// value at runtime, which is where the schema must hold.
		async execute(
			args: {
				readonly operation: string;
				readonly path: string;
				readonly query?: string;
				readonly payload?: string;
				/** For position-based operations: the 1-indexed line. */
				readonly line?: number;
				/** The text on that line the range should cover; absent means the line. */
				readonly symbol?: string;
			},
			exec: ToolRunContext,
			// The wrapper below supplies the one field the schema adds — `modelText` —
			// so this body is typed loosely ON PURPOSE: demanding the schema here
			// would require building a field the wrapper owns.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		): Promise<any> {
			const cwd = execCwd(exec);
			const absolutePath = await io.resolve(args.path, cwd);
			const language = languageForPath(absolutePath);
			if (language === undefined) {
				throw new Error(`${E_LSP_NO_SERVER} no language is registered for ${args.path}, so no server can be asked.`);
			}
			const manager = getLspManager();
			if (manager === undefined) {
				throw new Error(`${E_LSP_NO_SERVER} the language-server client is not enabled in this deployment.`);
			}
			// WAIT for the cold server, bounded. `sessionFor` returns instantly while a
			// server boots, which made every first call a refusal the caller had to
			// retry blind. This tool IS the protocol path: holding here for the boot
			// is what the caller asked for, and the timeout turns a hang into an
			// honest "did not start in time".
			const session = await manager.waitForSession(language.id, process.cwd());
			if (session === undefined) {
				const why = manager.unavailability(language.id);
				throw new Error(
					`${E_LSP_NO_SERVER} no server is usable for ${language.id}: ${why?.message ?? "it did not start in time"}. ` +
						`Install one, or name it under hashline.lsp.servers. The AST tools (\`ast_grep\`, \`read\`) still work without a server.`,
				);
			}
			const uri = pathToFileURL(absolutePath).href;
			const sync = manager.openDocumentFor(language.id, uri);
			if (sync === undefined) {
				throw new Error(`${E_LSP_NO_SERVER} the server for ${language.id} is not ready to open a document.`);
			}
			// Read once: the sync below needs the text, and a position-based operation
			// needs the same text to turn a line number into a range.
			// Issue #147 (ADR-0008): the READ LINE SPACE — the server sync and every row below live in the space read serves.
			const text = toLF(await io.readText(absolutePath));
			sync(text);
			if (args.operation === "diagnostics") {
				// THE FRESHNESS GUARANTEE (verifiedReport): pull-first for capable
				// servers; otherwise the sentinel probe — a guaranteed-error canary
				// proves the pipeline, the revert settles the true content's report.
				// "no answer yet" is returned only when the guarantee could not be
				// established inside the budget — never a stale pre-change report,
				// which is what the old arrivedAlready short-circuit served.
				const verified = await verifiedReport(session, uri, text, {
					open: (next) => sync(next),
					budgetMs: DIAGNOSTIC_WAIT_MS,
					signal: exec.signal,
				});
				const pushed = verified?.items;
				if (pushed === undefined) {
					return {
						path: args.path,
						operation: args.operation,
						server: language.displayName,
						symbols: [],
						// No rows: nothing was reported, so there is nothing to point at. An
						// empty gutter beside the sentence is the honest card for "no answer".
						hashlines: [],
						totalLines: 0,
						raw: `${language.displayName} has not reported diagnostics for this file within ${DIAGNOSTIC_WAIT_MS}ms. That is "no answer yet", not "no problems".`
					};
				}
				const diagLines = splitLines(text);
				const diagAnchors = anchorsFor(absolutePath, text);
				// ONE ROW PER LINE: the row IS the source line, its diagnostics are a
				// SEPARATE field.
				//
				// Three shapes have now been wrong, and each one taught the same lesson
				// from a different side: dedup-only parked the messages in `raw` (body and
				// messages disagreed); one-row-per-diagnostic printed the source line once
				// per error (the same text three times, in a channel the model pays for);
				// and joining the messages INTO the row text made one string serve two
				// readings — the card cannot style a diagnostic differently from the line
				// it sits under if both are the same string.
				//
				// So the row keeps the verbatim line (which is also what `served` must
				// vouch for, since anchors are content-derived) and `messages` carries the
				// diagnostics as data. Both channels then read the same two fields: the
				// model prints the messages indented under their line, and the card gives
				// them a style of their own.
				const byLine = new Map<number, string[]>();
				const bySeverity = new Map<number, number[]>();
				// Collected in the SAME pass as the rows: deriving `raw` from the rendered
				// row text afterwards would mean parsing a string this function just built.
				const diagMessages: string[] = [];
				for (const entry of pushed) {
					const d = entry as { message?: unknown; severity?: unknown; range?: { start?: { line?: unknown } } };
					const at = d.range?.start?.line;
					if (typeof at !== "number" || at < 0) continue;
					// The severity the protocol sent, as a word: a warning that reads like an
					// error is worse than no label at all.
					const code = typeof d.severity === "number" ? d.severity : 0;
					const severity = DIAGNOSTIC_SEVERITY[code] ?? "diagnostic";
					const message = typeof d.message === "string" ? d.message : JSON.stringify(entry);
					const labelled = `${severity}: ${message}`;
					diagMessages.push(`L${at + 1} ${labelled}`);
					const line = at + 1;
					byLine.set(line, [...(byLine.get(line) ?? []), labelled]);
					// The CODES ride beside the labels: the card counts errors and warnings
					// for its title suffix, and counting them out of an "error: …" prefix
					// would be the card parsing a string this same function just built.
					bySeverity.set(line, [...(bySeverity.get(line) ?? []), code]);
				}
				const diagRows = [...byLine.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([line, messages]) => ({
						number: line,
						hash: diagAnchors[line - 1] ?? "",
						text: diagLines[line - 1] ?? "",
						messages,
						severities: bySeverity.get(line) ?? [],
					}));
				// Served and observed like a read's rows, with the VERBATIM line as the
				// content: the anchors are content-derived, so serving the row TEXT (which
				// now carries a message) would vouch for a line that does not exist.
				//
				// Through the scope-aware primitive: `lsp` has no `withWorkspace` body, so
				// a bare `recordServed` here resolved the SHARED `$DSH_HOME` store instead
				// of this project's — the rows landed where no later edit looks.
				await serveRowsInWorkspace({
					sessionKey: execSessionKey(exec),
					cwd,
					absolutePath,
					rows: diagRows
						.filter((row) => row.hash !== "")
						.map((row) => ({ position: row.number - 1, anchor: row.hash })),
					lineCount: diagLines.length,
					exec,
					io,
				});
				return {
					path: args.path,
					operation: args.operation,
					server: language.displayName,
					symbols: [],
					hashlines: diagRows,
					totalLines: diagLines.length,
					// JSON 模式：诊断与 `edit` 内联的投影同形 ——
					// `[{ path, rows: { "<anchor>:<line>": { text, messages, severities } } }]`，
					// severities 为文字。raw 的纯文本句子只留在 text 模式。
					...(isJsonOutput()
						? {
								diagnostics: [
									{ path: absolutePath, rows: diagRowsToJson(diagRows) },
								],
							}
						: {
								raw:
									diagMessages.length === 0
										? `${language.displayName} reported NO diagnostics for this file.`
										: diagMessages.join("\n"),
							}
				),
			};
			}

			// Position-based operations need a range, and a range needs a column —
			// which the model gives by naming the text it means. Without `symbol` the
			// range covers the whole line, which is what a server expects for a
			// line-scoped action and is wrong for a token-scoped one. Naming the text
			// is the difference, and it is the caller's to make.
			const lineIndex = args.line === undefined ? 0 : Math.max(0, args.line - 1);
			const sourceLine = lineIndex === 0 ? (splitLines(text)[0] ?? "") : (splitLines(text)[lineIndex] ?? "");
			const at = args.symbol === undefined ? 0 : Math.max(0, sourceLine.indexOf(args.symbol));
			const range = {
				start: { line: lineIndex, character: at },
				end: { line: lineIndex, character: args.symbol === undefined ? sourceLine.length : at + args.symbol.length },
			};
			const method =
				args.operation === "symbols"
					? "textDocument/documentSymbol"
					: args.operation === "code_actions"
						? "textDocument/codeAction"
						: args.query;
			if (method === undefined || method === "") {
				throw new Error("[E_LSP_BAD_OPERATION] `request` needs `query` to name the LSP method.");
			}
			const params =
				args.operation === "code_actions"
					? // `context.diagnostics` is what a server keys its quick-fixes off. We do
						// not collect the pushed diagnostics yet, so it is empty on purpose: a
						// server then offers what it can without them, which is the honest
						// subset rather than a guess at what they were.
						{ textDocument: { uri }, range, context: { diagnostics: [] } }
					: args.payload === undefined
						? { textDocument: { uri } }
						: (JSON.parse(args.payload) as unknown);
			const answer = await session.request(method, params);

			if (args.operation === "symbols") {
				const flat = flattenSymbols(answer);
				// The card's rows: every symbol's line, with its anchor and its source
				// text. `line` is 1-based from the protocol; a server that answers 0 has
				// no usable position, and such a symbol is left out of the CARD rather
				// than drawn at line 0 — the model text still lists it.
				const sourceLines = splitLines(text);
				const anchors = anchorsFor(absolutePath, text);
				const seenLines = new Set<number>();
				const hashlines: { number: number; hash: string; text: string }[] = [];
				for (const symbol of flat) {
					if (symbol.line <= 0 || seenLines.has(symbol.line)) continue;
					seenLines.add(symbol.line);
					hashlines.push({
						number: symbol.line,
						hash: anchors[symbol.line - 1] ?? "",
						text: sourceLines[symbol.line - 1] ?? "",
					});
				}
				hashlines.sort((a, b) => a.number - b.number);
				// The symbol rows are SERVED and OBSERVED exactly like a read's: an
				// anchor the card shows is an anchor the next edit may use.
				// Same scope-aware primitive as the diagnostics branch above.
				await serveRowsInWorkspace({
					sessionKey: execSessionKey(exec),
					cwd,
					absolutePath,
					// Only rows that actually carry an anchor: a symbol whose line had no
					// hash allocated is shown in the card but is not a served row, and the
					// served store rejects an empty anchor.
					rows: hashlines
						.filter((row) => row.hash !== "")
						.map((row) => ({ position: row.number - 1, anchor: row.hash })),
					lineCount: sourceLines.length,
					exec,
					io,
				});
				return {
					path: args.path,
					operation: args.operation,
					server: language.displayName,
					symbols: flat,
					hashlines,
					totalLines: sourceLines.length,
				};
			}
			if (args.operation === "code_actions") {
				// LISTED, never applied — and the reason is structural rather than
				// cautious. An action's edit is a `WorkspaceEdit`: text ranges across
				// any number of files, arriving from the server. Applying it here would
				// be this tool writing files directly, which is the one thing it must
				// not do. The same job goes through the hashline engine the way
				// `ast_edit` does it — locate, take anchors, hand to `runFileEdits` —
				// and that is its own step.
				const actions = Array.isArray(answer) ? answer : [];
				const titles = actions.map((raw) => {
					const action = raw as { title?: unknown; kind?: unknown };
					return typeof action.title === "string"
						? `${action.title}${typeof action.kind === "string" ? `  [${action.kind}]` : ""}`
						: undefined;
				}).filter((title): title is string => title !== undefined);
				// An action list is not line-anchored: a server offers what it can for a
				// range, and the range is the caller's, not the answer's. So there are no
				// rows to draw and the sentence is the card.
				return { path: args.path, operation: args.operation, server: language.displayName, symbols: [], hashlines: [], totalLines: 0, raw: titles.length === 0 ? "No action is offered here." : titles.join("\n") };
			}
			// A raw `request` answer is whatever the method returns — not necessarily
			// line-anchored at all — so it gets no rows, and the JSON is both the model
			// text and the card.
			return {
				path: args.path,
				operation: args.operation,
				server: language.displayName,
				symbols: [],
				hashlines: [],
				totalLines: 0,
				raw: JSON.stringify(answer, null, 2),
			};
		},
	});
	// The branches build the structured value; the wrapper adds the model channel.
	// It is the WRAPPER's return that must satisfy the schema — one place, so no
	// branch can forget its mode, and the inner signature above is left open
	// because the wrapped field is what the host validates.
	return {
		...tool,
		async execute(args: never, exec: never) {
			let value: Record<string, unknown>;
			try {
				value = (await tool.execute(args, exec)) as unknown as Record<string, unknown>;
			} catch (error) {
				return thrownErrorResult(error, { path: pathFromArgs(args) }) as never;
			}
			return { ...value, modelText: lspModelText(value) };
		},
	} as typeof tool;
}
/**
 * The `lsp` tool's model channel, in BOTH modes, from the value the branch built.
 *
 * Text mode lists the anchors and their lines (`<anchor>:<line>` markers, the
 * same naming every other tool uses, so a symbol line can be edited straight
 * from the answer); JSON mode is the pure envelope, with the anchored rows keyed
 * by that same marker and the server's raw answer untouched beside them.
 *
 * @param value - the structured value an operation branch returned.
 * @returns the model-facing text for the active output mode.
 */
function lspModelText(value: Record<string, unknown>): string {
	const hashlines = Array.isArray(value.hashlines)
		? (value.hashlines as Array<{ number?: unknown; hash?: unknown; text?: unknown; messages?: unknown }>)
		: [];
	// ONE row renderer, the same one `read`/`grep`/`ast_grep` use: the divider is
	// the CONFIGURED separator (a hardcoded `:` here emitted `anchor:line: text`
	// in a deployment configured with `|`) and the markers align into a column
	// exactly as they do everywhere else.
	const rows: Array<{ marker: string; text: string; messages: string[] }> = [];
	const anchors: Record<string, string> = {};
	for (const row of hashlines) {
		if (typeof row.number !== "number" || typeof row.hash !== "string" || row.hash === "") continue;
		const marker = fmtMarker(row.hash, row.number);
		const text = typeof row.text === "string" ? row.text : "";
		const messages = Array.isArray(row.messages)
			? row.messages.filter((message): message is string => typeof message === "string")
			: [];
		rows.push({ marker, text, messages });
		anchors[marker] = text;
	}
	if (isJsonOutput()) {
		return JSON.stringify({ ...value, hashlines: anchors });
	}
	// Whether there is anything to LIST is a question about the rows, not about
	// `symbols`: diagnostics carry rows and no symbols, and keying off `symbols`
	// meant their rows were never shown to the model at all — the whole point of
	// building them.
	const head = `${value.server ?? "lsp"} — ${value.operation ?? "?"} for ${value.path ?? "?"}`;
	if (rows.length === 0) {
		const raw = typeof value.raw === "string" && value.raw !== "" ? value.raw : "nothing to report";
		return `${head}\n${raw}`;
	}
	const width = anchorWidth(rows.map((row) => row.marker));
	// Two parts per row, and they must not be confusable: the hashline row IS the
	// source line (what an `edit` addresses), and every diagnostic for it follows
	// indented under a `↳` — one per line, never merged into the row text. The
	// indent is the point: a reader (and a model) can tell at a glance which text
	// is the FILE and which text is a machine's opinion OF the file.
	const indent = " ".repeat(2 + width + 2);
	const body = rows.flatMap((row) => {
		const line = `  ${fmtHashlineRow(row.marker, row.text, width)}`;
		return [line, ...row.messages.map((message) => `${indent}↳ ${message}`)];
	});
	const symbols = Array.isArray(value.symbols) ? value.symbols.length : 0;
	return [`${head}${symbols > 0 ? ` (${symbols} symbol(s))` : ""}`, ...body].join("\n");
}
/** No server could be had — a refusal, distinct from an empty answer. */
export const E_LSP_NO_SERVER = "[E_LSP_NO_SERVER]";

/**
 * How long to wait for a server's first diagnostics push after opening a file.
 *
 * Bounded on purpose: the push is on the SERVER's schedule, and waiting forever
 * would turn a slow server into a hung tool. Past the budget the answer is "no
 * answer yet", which is a different sentence from "no problems".
 *
 * 5s, not 2s: a cold `typescript-language-server` needs to load the compiler and
 * `lib.d.ts` before its first push, and measured arrival is 2.6-3.1s on a real
 * Windows workspace — under a 2s budget the answer was ALWAYS "no answer yet".
 * The wait loop returns the moment a push arrives, so the ceiling costs a fast
 * server nothing.
 */
const DIAGNOSTIC_WAIT_MS = 5_000;

/**
 * LSP `DiagnosticSeverity` as a word, so a message says what it is.
 *
 * A warning labelled like an error is worse than no label at all: the reader has
 * to be able to tell "this will not compile" from "you could write this
 * better".
 */
const DIAGNOSTIC_SEVERITY: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

/**
 * Register the tool on an agent's context.
 *
 * @param _rootCtx - unused; kept for symmetry with the other registrars.
 * @param agentCtx - the agent whose tool surface this joins.
 * @param io - the session's file access.
 * @returns a disposer.
 */
export function registerLspTool(_rootCtx: Context, agentCtx: Context, io: FileIO): () => void {
	return agentCtx.tools.register(buildLspTool(io));
}
