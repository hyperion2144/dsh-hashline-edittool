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
import { LANGUAGES, languageForPath } from "../ast/language.js";
import { getLspManager, type LspManager } from "../lsp/manager.js";
import { latestWriteFor } from "../lsp/write-tracker.js";
import { E_LSP_NO_SERVER } from "../lsp/provider.js";
import { responseBudgetChars, spillModelTextOverflow } from "../infra/response-stream.js";
import type { FileIO } from "../infra/fs-bridge.js";
import { splitLines } from "../infra/utils.js";
import { toLF } from "../render/edit-diff.js";
// The SAME anchor assigner `read` uses, so a row the card shows carries the
// marker an `edit` accepts — otherwise the card would be decorative.
import { anchorWidth, fmtHashlineRow, fmtMarker, lineHashesPure } from "../hashline/hash-assign.js";
import { observeServedRows, anchorForInWorkspace, execSessionKey } from "../domain/session/session-view.js";
import { liveCwd } from "../domain/session/live-cwd.js";
import { readMetaFromMeta } from "../render/read-card.js";
import { rowTitle } from "../render/wire-text.js";
import { isJsonOutput } from "../config.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { currentContentFor, diagRowsToJson, verifiedReport } from "../lsp/auto-diag.js";
import {
	isLspOperation,
	LSP_METHOD_FOR,
	supportsOperation,
	transientSyncUnsupported,
	type LspOperation,
} from "../lsp/capabilities.js";
import { capGrepMeta, grepPresentationFromMeta } from "../render/grep-card.js";
import {
	boundText,
	fileUriToPath,
	DEFAULT_MAX_LOCATIONS,
	DEFAULT_MAX_RESULT_CHARS,
	groupLocations,
	hoverContents,
	normalizeLocationList,
	resolveLocations,
	sameDocumentUri,
	type ResolvedLocation,
} from "../render/lsp-locations.js";

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
		"- `goToDefinition` / `findReferences` / `goToImplementation` — where a symbol is declared, used, or implemented. Every line it names is served as an editable row, so a hit can be handed straight to `edit`. Needs `line`, plus a column: name the text with `symbol`, or give `character`.",
		"- `hover` — the server's documentation for the symbol at the cursor. Same cursor rule.",
		"- `symbols` — the symbols of one file, as the server reports them.",
		"- `code_actions` — what the server offers at a position (`line`, and `symbol` for the token). Listed, not applied.",
		"- `diagnostics` — what the server has REPORTED for the file. Waits briefly for its first push; \"no answer yet\" and \"no problems\" are reported as the different things they are.",
		"- `request` — any LSP method, for anything not yet wrapped (see `query` and `payload`).",
		"- `status` — every language's server state (or one `language`'s) WITHOUT starting anything: ready / starting / failed, with reason and attempt count when failed.",
		"- `warm` — start (or restart) one `language`'s server NOW, skipping the retry backoff, and wait for the outcome.",
		"",
		"This REFUSES rather than returning nothing when no server can be started, and says why: \"no server\" and \"no symbols\" are different facts.",
	].join("\n");
}

/**
 * Add the document a request is about, unless the caller already named one.
 *
 * `payload` is optional PARAMS, not a replacement for the document: a
 * `textDocument/definition` payload carrying only a `position` used to reach
 * the server without its `textDocument`, and the server answered `Cannot read
 * properties of undefined (reading 'uri')` (#151/P8). An explicit
 * `textDocument` — or an explicit `uri` inside one — is left exactly as the
 * caller wrote it; a non-object payload is returned untouched, for the server
 * (or the protocol layer) to reject in its own words.
 */
function withDocument(params: unknown, uri: string): unknown {
	if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
	const record = params as Record<string, unknown>;
	const textDocument = record.textDocument;
	if (textDocument === undefined) return { ...record, textDocument: { uri } };
	if (textDocument !== null && typeof textDocument === "object" && !Array.isArray(textDocument)) {
		const doc = textDocument as Record<string, unknown>;
		if (doc.uri === undefined) return { ...record, textDocument: { ...doc, uri } };
	}
	return record;
}

/**
 * The operation an errored call asked for — the schema-required `operation`
 * field of the wrapper's error value, read out of the args the same way
 * `pathFromArgs` reads the path.
 */
function operationFromArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const a = args as { operation?: unknown };
	return typeof a.operation === "string" ? a.operation : "";
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
		// The whole queued open/query/close lifecycle is bounded, so a server
		// that stops answering cannot hang the turn. A budget, not a model-facing
		// knob: it never appears in the schema.
		timeoutMs: LSP_TOOL_TIMEOUT_MS,
		parameters: {
			operation: {
				type: "string",
				required: true,
				description:
					"`symbols` for one file's symbols, `code_actions` for what a server offers at a position (see `line` / `symbol`), `request` to send an LSP method directly, `status` to report per-language server state without starting anything, or `warm` to start (or restart) one language's server and wait for the outcome.",
			},
			path: {
				type: "string",
				description: "The file to work on. Its extension decides which language server is asked for. Every operation needs it EXCEPT `status` and `warm`, which are language-level.",
			},
			language: {
				type: "string",
				description: "For `status` and `warm`: the language id, e.g. `typescript`. `status` without it reports every language that has a slot.",
			},
			query: {
				type: "string",
				description: "For `request`: the LSP method, e.g. `textDocument/definition`.",
			},
			payload: {
				type: "string",
				description: "For `request`: JSON params. Omitted means `{ textDocument: { uri } }`.",
			},
			line: {
				type: "number",
				description: "For position-based and navigation operations: the one-based line of the cursor.",
			},
			symbol: {
				type: "string",
				description: "The text on that line the cursor means. Its position in the line IS the column, so a caller never has to count UTF-16 columns by hand. Wins over `character` when both are given.",
			},
			character: {
				type: "number",
				description: "For navigation operations: the one-based UTF-16 column of the cursor, when `symbol` is not usable.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					operation: { type: "string", required: true },
					server: { type: "string" },
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
					// THE NAVIGATION ROWS. `locations` is the exact answer — every
					// position the server returned, one-based — and `groups` is the
					// same answer arranged per file so each line can carry the
					// hashline anchor an `edit` accepts.
					locations: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								line: { type: "integer", required: true },
								character: { type: "integer", required: true },
							},
						},
					},
					groups: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								rows: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											number: { type: "integer", required: true },
											hash: { type: "string", required: true },
											text: { type: "string", required: true },
											character: { type: "integer", required: true },
										},
									},
								},
							},
						},
					},
					truncated: { type: "boolean" },
					totalLocations: { type: "integer" },
					hover: { type: "string" },
					// THE ACTION LIST (#397 review): `code_actions` answers with no rows, so
					// the card draws the list itself. Optional — no other operation sets it.
					actions: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								title: { type: "string", required: true },
								kind: { type: "string" },
							},
						},
					},
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
					// The status card's data (#318): the slots a status/warm answer
					// reports, exactly as `snapshot()` holds them.
					slots: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								languageId: { type: "string", required: true },
								state: { type: "string", required: true },
								reason: { type: "string" },
								message: { type: "string" },
								attempts: { type: "integer" },
							},
						},
					},
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
			presentationMeta: (_args: unknown, value: Parameters<typeof lspPresentationMeta>[0]) =>
				lspPresentationMeta(value) as never,
		},
		// THE CARD ITSELF: `presentResult` is what makes the web draw one. The meta
		// alone drew nothing — without this the call stayed raw input/output, which
		// is exactly what was reported.
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			// A navigation answer is a SEARCH card, not a read card: its rows
			// belong to other files. The meta is the grep projection, so the
			// same well-tested multi-file body draws it.
			const nav = grepPresentationFromMeta(result.meta);
			// Only a NON-EMPTY navigation answer is a search card. An empty one
			// falls through to the generic body, where its "No results." sentence
			// lives — an empty multi-file card would draw nothing at all.
			if (nav !== undefined && nav.files.length > 0) {
				return {
					card: "search",
					shape: "matches",
					files: nav.files.map((file) => ({
						path: file.path,
						matches: file.rows.map((row) => ({ lineNumber: row.number, line: row.text })),
					})),
					truncated: nav.truncated,
					total: nav.total,
				};
			}
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
				readonly path?: string;
				/** For `status`/`warm`: which language. `status` without it lists every slot. */
				readonly language?: string;
				readonly query?: string;
				readonly payload?: string;
				/** For position-based operations: the 1-indexed line. */
				readonly line?: number;
				/** The text on that line the range should cover; absent means the line. */
				readonly symbol?: string;
				/** For the navigation operations: the one-based UTF-16 column. */
				readonly character?: number;
			},
			exec: ToolRunContext,
			// The wrapper below supplies the one field the schema adds — `modelText` —
			// so this body is typed loosely ON PURPOSE: demanding the schema here
			// would require building a field the wrapper owns.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		): Promise<any> {
			const cwd = await liveCwd(exec);
			// `status` and `warm` are LANGUAGE-level: they answer "what is up"
			// and "make it up" without a document, so they branch before the
			// path is even resolved (#318).
			if (args.operation === "status" || args.operation === "warm") {
				const manager = getLspManager();
				if (manager === undefined) {
					throw new Error(`${E_LSP_NO_SERVER} the language-server client is not enabled in this deployment.`);
				}
				const languageId = args.language;
				const entry = languageId === undefined ? undefined : LANGUAGES.find((candidate) => candidate.id === languageId);
				if (languageId !== undefined && entry === undefined) {
					throw new Error(`[E_LSP_BAD_OPERATION] \`${languageId}\` is not a registered language id.`);
				}
				if (args.operation === "status") return statusValue(manager, languageId);
				if (languageId === undefined) {
					throw new Error(`[E_LSP_BAD_OPERATION] \`warm\` needs \`language\` — the registry id, e.g. \`typescript\`.`);
				}
				// An explicit warm-up is the caller asking for a start, so the
				// retry backoff does not apply: forceWarm restarts a failed slot
				// right now, and the outcome — either way — is reported.
				const session = await manager.forceWarm(languageId, process.cwd());
				if (session === undefined) {
					const why = manager.unavailability(languageId);
					throw new Error(`${E_LSP_NO_SERVER} ${languageId} did not start: ${why?.message ?? "it did not start in time"}.`);
				}
				const displayName = entry?.displayName ?? languageId;
				return { operation: "warm", server: displayName, symbols: [], hashlines: [], totalLines: 0, slots: [{ languageId, state: "ready" }], raw: `${displayName} is ready.` };
			}
			if (args.path === undefined) {
				throw new Error(`[E_LSP_BAD_OPERATION] \`${args.operation}\` needs \`path\` — the file to work on.`);
			}
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
					(why?.reason === "server-missing"
						? `Install one, or name it under hashline.lsp.servers. `
						: `Failed starts retry on their own once the backoff passes; \`lsp { operation: "warm", language: "${language.id}" }\` forces one now. `) +
					`The AST tools (\`ast_grep\`, \`read\`) still work without a server.`,
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
			// #388: the probe syncs the server, so what it syncs must be the CURRENT
			// content — a write that lands while the probe is in flight must not be
			// rolled back by the probe's revert.
			const generation = latestWriteFor(uri)?.generation;
			const text = toLF(await io.readText(absolutePath));
			sync(text);
			// NAVIGATION — a cursor question whose answer points at OTHER files.
			// It branches before the single-file position path because its rows
			// are not this file's lines: each hit is read, anchored and served on
			// its own file, so every row the model sees is one `edit` accepts.
			if (isLspOperation(args.operation)) {
				return await navigationValue({
					operation: args.operation,
					serverName: language.displayName,
					queriedPath: args.path,
					text,
					line: args.line,
					character: args.character,
					symbol: args.symbol,
					session,
					uri,
					cwd,
					exec,
					io,
				});
			}
			if (args.operation === "diagnostics") {
				// THE FRESHNESS GUARANTEE (verifiedReport): pull-first for capable
				// servers; otherwise the sentinel probe — a guaranteed-error canary
				// proves the pipeline, the revert settles the true content's report.
				// "no answer yet" is returned only when the guarantee could not be
				// established inside the budget — never a stale pre-change report,
				// which is what the old arrivedAlready short-circuit served.
				const verified = await verifiedReport(session, uri, () => currentContentFor(uri, generation, text), {
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
				// The rows describe the content the server ANSWERED for — the probe may
				// have verified a newer write than the snapshot this call read.
				const verifiedText = verified?.text ?? text;
				const diagLines = splitLines(verifiedText);
				// NO dense read: every entry ever READ below belongs to a line in
				// `diagLineNos`, and those are exactly the lines the mint fills in.
				// The array stays full length because the rows index it by LINE.
				const diagAnchors: string[] = new Array(diagLines.length).fill("");
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
				// LAZY (#169): allocate for exactly the diagnostic lines this report serves.
				const diagLineNos = [...byLine.keys()].sort((a, b) => a - b);
				const diagAllocated = await anchorForInWorkspace({
					cwd,
					absolutePath,
					content: verifiedText,
					lines: diagLineNos,
					sessionKey: execSessionKey(exec),
				});
				for (let k = 0; k < diagLineNos.length; k++) {
					diagAnchors[diagLineNos[k]! - 1] = diagAllocated[k]!;
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
				await observeServedRows({
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
			const at = resolveColumn(sourceLine, args);
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
						: withDocument(JSON.parse(args.payload), uri);
			const answer = await session.request(method, params);

			if (args.operation === "symbols") {
				const flat = flattenSymbols(answer);
				// The card's rows: every symbol's line, with its anchor and its source
				// text. `line` is 1-based from the protocol; a server that answers 0 has
				// no usable position, and such a symbol is left out of the CARD rather
				// than drawn at line 0 — the model text still lists it.
				const sourceLines = splitLines(text);
				// NO dense read, same reason as the diagnostics branch above: the rows
				// below are built from `seenLines`, and the mint then fills exactly
				// those lines in. A read here was paid for and then overwritten.
				const anchors: string[] = new Array(sourceLines.length).fill("");
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
				// LAZY (#169): allocate for exactly the symbol lines this call serves —
				// the serve below publishes these anchors, and an unallocated symbol
				// row would be dropped from the serve (and be uneditable).
				const symbolLineNos = [...seenLines].sort((a, b) => a - b);
				const symbolAllocated = await anchorForInWorkspace({
					cwd,
					absolutePath,
					content: text,
					lines: symbolLineNos,
					sessionKey: execSessionKey(exec),
				});
				for (let k = 0; k < symbolLineNos.length; k++) {
					const anchor = symbolAllocated[k]!;
					const row = hashlines.find((r) => r.number === symbolLineNos[k]);
					if (row) row.hash = anchor;
				}
				// The symbol rows are SERVED and OBSERVED exactly like a read's: an
				// anchor the card shows is an anchor the next edit may use.
				// Same scope-aware primitive as the diagnostics branch above.
				await observeServedRows({
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
				// The SAME list, structured: the model text keeps the joined sentences,
				// while the card draws one row per action with its LSP kind beside it
				// (#397 review: every answer is a card, and a title list is not a dump).
				const listed: Array<{ title: string; kind?: string }> = [];
				for (const raw of actions) {
					const action = raw as { title?: unknown; kind?: unknown };
					if (typeof action.title !== "string") continue;
					listed.push({ title: action.title, ...(typeof action.kind === "string" ? { kind: action.kind } : {}) });
				}
				// An action list is not line-anchored: a server offers what it can for a
				// range, and the range is the caller's, not the answer's. So there are no
				// rows to draw and the sentence is the card.
				return { path: args.path, operation: args.operation, server: language.displayName, symbols: [], hashlines: [], totalLines: 0, actions: listed, raw: titles.length === 0 ? "No action is offered here." : titles.join("\n") };
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
		async execute(args: Record<string, unknown>, exec: ToolRunContext) {
			let value: Record<string, unknown>;
			try {
				value = (await tool.execute(args as never, exec)) as unknown as Record<string, unknown>;
			} catch (error) {
				// An ABORT keeps its host semantics — interruption records, failure
				// accounting — and is never converted (ADR-0007).
				if (exec.signal.aborted) throw error;
				// THE HOST VALIDATES THE WRAPPED VALUE — errors included — so the
				// converted refusal must carry every REQUIRED field (the #317
				// witness fill). But a witness is not a lie about data: `path` is
				// OPTIONAL since #318, and `status`/`warm` pass none — the literal
				// `path: undefined` the fill used to write is not lossless JSON,
				// and the host rejected every path-less refusal outright
				// (`value is not lossless JSON`, #320). Omitted, not undefined.
				// The conversion spreads LAST so `modelText`/`error` win, and BOTH
				// conversions (the direct one and the `[E_LSP_UNEXPECTED]` wrap)
				// ride this one helper so neither shape can regress.
				const convertError = (err: unknown): Record<string, unknown> => {
					const relatedPath = pathFromArgs(args);
					return {
						operation: operationFromArgs(args),
						server: "",
						symbols: [],
						hashlines: [],
						totalLines: 0,
						...(relatedPath !== undefined ? { path: relatedPath } : {}),
						...thrownErrorResult(err, { path: relatedPath }),
					} as Record<string, unknown>;
				};
				try {
					return convertError(error) as never;
				} catch {
					// Not in the E_* vocabulary. Re-throwing it would make the host
					// persist an isError result whose Error object cannot survive
					// lossless JSON — every lsp call then dies with `value is not
					// lossless JSON` (#320). An unexpected lsp failure is still an
					// lsp refusal: wrapped into the vocabulary, it rides the error card.
					const message = error instanceof Error ? error.message : String(error);
					return convertError(new Error(`[E_LSP_UNEXPECTED] the lsp call failed unexpectedly: ${message}`)) as never;
				}
			}
			const streamedLsp = await spillModelTextOverflow({ sessionKey: execSessionKey(exec), producer: "lsp", consumer: "read", modelText: lspModelText(value), budgetChars: responseBudgetChars() });
			return { ...value, modelText: streamedLsp.modelText };
		},
	} as typeof tool;
}

/**
 * The `status` operation's value: every slot's state, READ-ONLY.
 *
 * A status question with side effects stops being one — no boot, no
 * restart, no document sync. Without a `language` every slot is listed;
 * with one, just that language, and a language with no slot yet says so
 * plainly instead of implying a failure (#318).
 */
function statusValue(manager: LspManager, languageId: string | undefined): Record<string, unknown> {
	const wanted = manager.snapshot().filter((row) => languageId === undefined || row.languageId === languageId);
	const described = wanted.map((row) => {
		if (row.state === "failed") {
			return `  ${row.languageId}: failed — ${row.reason}: ${row.message} (attempt ${row.attempts ?? 1})`;
		}
		return `  ${row.languageId}: ${row.state}`;
	});
	const raw =
		described.length === 0
			? languageId === undefined
				? "No language has a server slot yet — nothing has been started. `warm` with a `language` starts one."
				: `${languageId} has no slot yet — it has not been started. \`warm\` with this language starts one.`
			: `Language-server slots:\n${described.join("\n")}`;
	return { operation: "status", symbols: [], hashlines: [], totalLines: 0, raw, slots: wanted };
}

/**
 * The status/warm card's meta: the slots, verbatim, under an explicit card
 * name. The client's status block reads `card: "lsp-status"` + `slots` from
 * the persisted meta — a read-shaped projection would draw a file card for an
 * answer about LANGUAGES. Exported because the projection has no surface on
 * the tool object (the DSL consumes it), so the unit test asserts it here.
 *
 * @param slots - the slot rows to draw, verbatim.
 * @param note - the sentence to show when there are NO slots (`status` with
 *   nothing started); omitted otherwise.
 */
export function lspStatusMeta(slots: unknown, note?: string): Record<string, unknown> {
	const list = Array.isArray(slots) ? slots : [];
	// A note rides along only when there is no slot to draw: with slots, the
	// rows ARE the answer, and the sentence would just repeat them.
	return { card: "lsp-status", slots: list, ...(list.length === 0 && note !== undefined && note !== "" ? { note } : {}) };
}

/**
 * The WHOLE projection — error card, status card, or read card — in one place
 * the unit test can reach (the DSL consumes `presentationMeta`, leaving no
 * surface on the tool object). THE ERROR CHECK COMES FIRST: a converted
 * refusal carries a witness `operation` (#317), and a status/warm refusal's
 * witness is literally "status"/"warm" — matching on the operation first
 * turned every refusal into an EMPTY status card, and the client fell back
 * to the bare LSP row (#320).
 */
export function lspPresentationMeta(value: {
	readonly operation?: string;
	readonly path?: string;
	readonly hashlines?: readonly { readonly number: number; readonly text: string }[];
	readonly totalLines?: number;
	readonly error?: ErrorMeta;
	readonly slots?: unknown;
	readonly groups?: readonly unknown[];
	readonly truncated?: boolean;
	readonly totalLocations?: number;
	/** The answer's own sentence — the status card shows it when it has no rows. */
	readonly raw?: string;
	/** #397 review: the hover answer's own contents (empty means "no information"). */
	readonly hover?: string;
	/** #397 review: what `code_actions` offers here, structured for the card. */
	readonly actions?: readonly unknown[];
}): Record<string, unknown> {
	if (value.error !== undefined) return { error: value.error };
	if (value.operation === "status" || value.operation === "warm") {
		const slots = Array.isArray(value.slots) ? value.slots : [];
		// An EMPTY slot list is still an ANSWER, so it is still a card — one that
		// says the sentence instead of drawing rows. Falling back to generic IO
		// buried a one-line answer under an input/output dump (#397 review).
		const note = typeof value.raw === "string" ? value.raw : undefined;
		return lspStatusMeta(slots, note);
	}
	// A navigation answer projects the grep card's multi-file shape: its rows
	// live in OTHER files, so a read-shaped projection (one `path`) would have
	// to lie about which file the rows belong to.
	// An EMPTY answer keeps the read projection on purpose: a multi-file card
	// with no files draws an empty body, while the read projection's zero rows
	// make BOTH card models reject the meta and the row falls back to the
	// generic body — which is where the "No results." sentence lives.
	if (Array.isArray(value.groups) && value.groups.length > 0) {
		const capped = capGrepMeta({
			files: value.groups as never,
			truncated: value.truncated === true,
			total: typeof value.totalLocations === "number" ? value.totalLocations : 0,
		});
		// #397 review: the folded row could not say the answer spans FILES — it
		// carried only the queried path. The width rides at the row's end (the same
		// weak slot the grep counts use), while the path stays the summary.
		const locations = typeof value.totalLocations === "number" ? value.totalLocations : 0;
		return {
			...capped,
			rowTitle: rowTitle("lsp", { locations, files: value.groups.length }),
		} as unknown as Record<string, unknown>;
	}
	// An EMPTY navigation answer has a sentence and no rows: the sentence IS the
	// card. Falling back to the read projection dumped the whole call instead.
	if (
		Array.isArray(value.groups) &&
		value.groups.length === 0 &&
		typeof value.raw === "string" &&
		value.raw !== ""
	) {
		return {
			operation: typeof value.operation === "string" ? value.operation : "navigation",
			...(typeof value.path === "string" ? { path: value.path } : {}),
			note: value.raw,
		};
	}
	// #397 review: EVERY answer is a card. Three of them carry NO rows at all —
	// a hover's contents, an action list, a raw `request` JSON — so the read
	// projection below would draw an empty body and the row would fall back to a
	// raw input/output dump. Each gets its own shape instead.
	if (value.operation === "hover") {
		const text = typeof value.hover === "string" ? value.hover : "";
		const pathed = typeof value.path === "string" ? { path: value.path } : {};
		// An empty hover is the ANSWER (`No hover information.`): the sentence
		// draws in the card rather than an empty body.
		if (text !== "") return { operation: "hover", ...pathed, hover: text };
		return {
			operation: "hover",
			...pathed,
			note: typeof value.raw === "string" ? value.raw : "No hover information.",
		};
	}
	if (value.operation === "code_actions") {
		const actions = Array.isArray(value.actions) ? value.actions : [];
		return {
			operation: "code_actions",
			...(typeof value.path === "string" ? { path: value.path } : {}),
			actions,
			// An EMPTY list is still the answer: the host's sentence is what the
			// card says instead of drawing a body-less frame.
			...(actions.length === 0 && typeof value.raw === "string" ? { note: value.raw } : {}),
		};
	}
	if (value.operation === "request") {
		return {
			operation: "request",
			...(typeof value.path === "string" ? { path: value.path } : {}),
			json: typeof value.raw === "string" ? value.raw : "",
		};
	}
	return {
		path: value.path,
		offset: 1,
		lines: (value.hashlines ?? []).map(({ number, text }) => ({ number, text })),
		totalLines: value.totalLines ?? 0,
		hashlines: value.hashlines,
	};
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
	// A navigation answer has no single file to print under. It is groups (one
	// per file), and JSON mode is the whole envelope — the exact one-based
	// positions included — because those columns are what the text view folds
	// away in favour of editable lines.
	const navGroups = Array.isArray(value.groups) ? (value.groups as NavigationGroup[]) : undefined;
	if (navGroups !== undefined) {
		if (isJsonOutput()) return JSON.stringify(value);
		return navigationModelText(value, navGroups);
	}
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
	const head = `${value.server ?? "lsp"} — ${value.operation ?? "?"}${value.path === undefined ? "" : ` for ${value.path}`}`;
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

/**
 * The tool-call budget: the queued open + query + render lifecycle, not one
 * request. A server that accepts a document and then stops answering must not
 * hold the turn; past this the call is failed rather than forgotten.
 */
const LSP_TOOL_TIMEOUT_MS = 60_000;

/**
 * How long a navigation call holds for the server's project index to finish.
 *
 * Bounded well under the tool budget: a whole-repo index on a cold start is
 * usually seconds, and a bracket that never closes must not own the call.
 */
const PROJECT_LOAD_WAIT_MS = 15_000;

/**
 * How long a shape-checked cold-index retry keeps asking.
 *
 * TIME, not attempts: a real first call has to boot the server
 * (2.6–3.1 s) AND index the project, so any fixed small number of retries
 * runs out inside the index. FIFTEEN seconds covers both: a measured cold
 * restart (cold page cache, the app's startup I/O still settling) outlasted
 * five, and the whole retry only ever runs on an answer ALREADY KNOWN to be
 * shallow — so a warm or merely slow server pays nothing either way. The
 * tool's own budget is 60 s, so this stays a quarter of it.
 */
const COLD_RETRY_BUDGET_MS = 15_000;
/** Spacing between cold-index retries. */
const SHALLOW_RETRY_DELAY_MS = 500;

/**
 * How many distinct files a navigation answer will READ for anchors.
 *
 * Every anchored file costs one read plus one anchor mint, and a
 * project-wide `findReferences` can touch a hundred files. Past this ceiling
 * the remaining files still get rows — they only lose their anchors, which
 * costs the caller a `read`, never the location.
 */
const MAX_ANCHORED_FILES = 32;

/**
 * The zero-based UTF-16 column a cursor request names.
 *
 * `symbol` wins when it is on the line: its position IS the column, so the
 * caller never has to count UTF-16 code units — the one thing a model is
 * reliably bad at. `character` is the explicit fallback, and an absent or
 * missing symbol means the start of the line.
 *
 * @param sourceLine - the line the cursor points into.
 * @param args - the caller's `symbol` / `character`.
 * @returns a zero-based column within the line.
 */
function resolveColumn(sourceLine: string, args: { readonly symbol?: string; readonly character?: number }): number {
	if (args.symbol !== undefined && args.symbol !== "") {
		const at = sourceLine.indexOf(args.symbol);
		if (at >= 0) return at;
	}
	if (args.character !== undefined && Number.isFinite(args.character)) {
		return Math.max(0, Math.floor(args.character) - 1);
	}
	return 0;
}

/** One line of a navigation answer, anchored when it could be served. */
interface NavigationRow {
	readonly number: number;
	readonly hash: string;
	readonly text: string;
	readonly character: number;
}

/** One file's rows in a navigation answer. */
interface NavigationGroup {
	readonly path: string;
	readonly rows: NavigationRow[];
}

/** The slice of a live session the navigation path needs. */
interface NavigationSession {
	readonly serverCapabilities: Record<string, unknown>;
	/**
	 * Whether the server says it is still indexing. Absent on a fake session,
	 * which is why every read of it is optional.
	 */
	readonly projectLoading?: boolean;
	/** Bounded wait for the index to finish; absent on a fake session. */
	waitForProjectLoad?(budgetMs: number, signal?: AbortSignal): Promise<"idle" | "timeout">;
	request(method: string, params: unknown): Promise<unknown>;
}

/** Everything the navigation branch needs from the caller's frame. */
interface NavigationInput {
	readonly operation: LspOperation;
	readonly serverName: string;
	readonly queriedPath: string;
	readonly text: string;
	readonly line?: number;
	readonly character?: number;
	readonly symbol?: string;
	readonly session: NavigationSession;
	readonly uri: string;
	readonly cwd: string;
	readonly exec: ToolRunContext;
	readonly io: FileIO;
}

/**
 * The rendered-answer budget: the smaller of the plugin's own cap and the
 * deployment's response budget, so a navigation answer cannot outgrow the
 * channel it travels on.
 */
function maxNavigationChars(): number {
	return Math.min(DEFAULT_MAX_RESULT_CHARS, responseBudgetChars());
}

/**
 * Whether a navigation answer is the IMPORT CLAUSE rather than a definition.
 *
 * A server still building its project index resolves an imported symbol to
 * the import that names it: the target sits in the QUERIED file, on an
 * `import` / `export … from` line, and covers exactly the symbol asked about.
 * No real definition looks like that — a definition never lives on an import
 * clause — so the shape alone is reason enough to ask again in a moment.
 *
 * @param answer - the server's raw answer.
 * @param input - the caller's frame (queried file text, symbol, uri).
 * @returns true when the answer can only be a cold-index fallback.
 */
export function looksLikeImportBinding(answer: unknown, input: NavigationInput): boolean {
	if (input.operation !== "goToDefinition" && input.operation !== "goToImplementation") return false;
	const symbol = input.symbol;
	if (symbol === undefined || symbol === "") return false;
	const locations = normalizeLocationList(answer);
	if (locations.length === 0) return false;
	// (the URI identity — not a raw string compare — is what decides this; see `sameDocumentUri`)
	const lines = splitLines(input.text);
	for (const location of locations) {
		if (!sameDocumentUri(location.uri, input.uri)) return false;
		const start = (location.range as { start?: { line?: unknown; character?: unknown } } | null)?.start;
		if (typeof start?.line !== "number" || typeof start.character !== "number") return false;
		const line = lines[start.line] ?? "";
		if (!/^\s*(?:import|export)\b/u.test(line)) return false;
		if (line.slice(start.character, start.character + symbol.length) !== symbol) return false;
	}
	return true;
}

/**
 * Answer one navigation question.
 *
 * The capability is checked BEFORE the request: a method the server never
 * advertised comes back as a protocol error (or, worse, as an empty list that
 * reads like "nothing here"), and the model cannot tell those apart from a
 * real answer. "Unsupported" and "no results" are different facts.
 *
 * @param input - the operation, the cursor, the session and the session's IO.
 * @returns the canonical value the tool wrapper turns into text and a card.
 */
async function navigationValue(input: NavigationInput): Promise<Record<string, unknown>> {
	const capabilities = input.session.serverCapabilities;
	if (!supportsOperation(capabilities, input.operation)) {
		throw new Error(
			`[E_LSP_UNSUPPORTED_OPERATION] ${input.serverName} does not advertise ${input.operation}. Nothing was asked, so this is "unsupported", not "no results". ` +
			`The AST tools (\`ast_grep\`, \`read\`) still answer questions about shape.`,
		);
	}
	if (transientSyncUnsupported(capabilities)) {
		throw new Error(
			`[E_LSP_UNSUPPORTED_SYNC] ${input.serverName} refuses \`didOpen\`, so it never sees the document a cursor points into. Nothing was asked.`,
		);
	}
	// A server still indexing answers from a PARTIAL index, and that answer is
	// shaped exactly like a real one — an imported symbol resolves to its import
	// specifier until the project finishes loading. Waiting is the only honest
	// move: the caller asked for a definition, not for whatever the index had
	// ready. Bounded, because a server that never ends the bracket must not
	// turn a navigation call into a hang; servers that never open it are
	// already "not loading" and cost nothing.
	if (input.session.projectLoading === true && input.session.waitForProjectLoad !== undefined) {
		await input.session.waitForProjectLoad(PROJECT_LOAD_WAIT_MS, input.exec.signal);
	}
	const sourceLine = splitLines(input.text)[input.line === undefined ? 0 : Math.max(0, input.line - 1)] ?? "";
	const position = {
		line: input.line === undefined ? 0 : Math.max(0, input.line - 1),
		character: resolveColumn(sourceLine, input),
	};
	const params =
		input.operation === "findReferences"
			? { textDocument: { uri: input.uri }, position, context: { includeDeclaration: true } }
			: { textDocument: { uri: input.uri }, position };
	// THE COLD-INDEX RETRY. A server whose project index is still loading
	// answers `goToDefinition` on an imported symbol with the import clause
	// that names it — a target inside the QUERIED file, covering exactly the
	// symbol, on an `import` line. That is never a definition, so the shape
	// itself is the evidence: wait once or twice and ask again, and the real
	// declaration arrives as soon as the index does. Shape-checked retries
	// beat a fixed cold-start sleep: a server that was already warm pays
	// nothing, and a slow one is not cut off at an arbitrary deadline.
	let answer = await input.session.request(LSP_METHOD_FOR[input.operation], params);
	// The budget is TIME, not attempts: a real cold start has to boot the
	// server (2.6–3.1 s measured) AND index the project, so a fixed two
	// retries runs out inside the index. Ask again every 500 ms until the
	// answer stops being an import clause or the budget is gone; a warm
	// server never enters the loop at all.
	const deadline = Date.now() + COLD_RETRY_BUDGET_MS;
	while (looksLikeImportBinding(answer, input) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, SHALLOW_RETRY_DELAY_MS));
		answer = await input.session.request(LSP_METHOD_FOR[input.operation], params);
	}

	if (input.operation === "hover") {
		const contents = hoverContents(answer);
		return {
			path: input.queriedPath,
			operation: input.operation,
			server: input.serverName,
			symbols: [],
			hashlines: [],
			totalLines: 0,
			hover: contents ?? "",
			raw: contents === null ? "No hover information." : boundText(contents, maxNavigationChars(), "hover"),
		};
	}

	const resolved = resolveLocations(normalizeLocationList(answer), pathToFileURL(input.cwd).href);
	const shown = resolved.slice(0, DEFAULT_MAX_LOCATIONS);
	const omitted = resolved.length - shown.length;
	const groups = await anchorGroups(shown, input);
	const raw =
		omitted > 0
			? `… ${omitted} more location${omitted === 1 ? "" : "s"} omitted (limit ${DEFAULT_MAX_LOCATIONS}).`
			: shown.length === 0
				? "No results."
				: undefined;
	return {
		path: input.queriedPath,
		operation: input.operation,
		server: input.serverName,
		symbols: [],
		hashlines: [],
		totalLines: 0,
		locations: shown.map((location) => ({
			path: location.displayPath,
			line: location.line,
			character: location.character,
		})),
		groups,
		truncated: omitted > 0,
		totalLocations: resolved.length,
		...(raw === undefined ? {} : { raw }),
	};
}

/**
 * Arrange the locations per file and mint an anchor for every line it serves.
 *
 * The rows are served exactly like a `read`'s: an anchor the answer shows is
 * an anchor the next `edit` accepts. Anchoring is per FILE — one read, one
 * mint, one serve — and bounded by {@link MAX_ANCHORED_FILES}; a file that
 * cannot be read keeps its rows and loses only its anchors.
 *
 * @param locations - the capped, resolved locations.
 * @param input - the caller's frame (workspace, session key, IO).
 * @returns one group per file, in first-seen order.
 */
async function anchorGroups(
	locations: readonly ResolvedLocation[],
	input: NavigationInput,
): Promise<NavigationGroup[]> {
	const out: NavigationGroup[] = [];
	let anchoredFiles = 0;
	for (const group of groupLocations(locations)) {
		const absolutePath = group.absolutePath;
		if (absolutePath === undefined || anchoredFiles >= MAX_ANCHORED_FILES) {
			out.push({
				path: group.displayPath,
				rows: group.entries.map((entry) => ({ number: entry.line, hash: "", text: "", character: entry.character })),
			});
			continue;
		}
		anchoredFiles += 1;
		try {
			const content = toLF(await input.io.readText(absolutePath));
			const lines = splitLines(content);
			const wanted = [...new Set(group.entries.map((entry) => entry.line))].sort((a, b) => a - b);
			const minted = await anchorForInWorkspace({
				cwd: input.cwd,
				absolutePath,
				content,
				lines: wanted,
				sessionKey: execSessionKey(input.exec),
			});
			const byLine = new Map<number, string>();
			for (let k = 0; k < wanted.length; k++) byLine.set(wanted[k]!, minted[k]!);
			await observeServedRows({
				sessionKey: execSessionKey(input.exec),
				cwd: input.cwd,
				absolutePath,
				rows: wanted
					.filter((line) => (byLine.get(line) ?? "") !== "")
					.map((line) => ({ position: line - 1, anchor: byLine.get(line)! })),
				lineCount: lines.length,
				exec: input.exec,
				io: input.io,
			});
			const seen = new Set<number>();
			const rows: NavigationRow[] = [];
			for (const entry of group.entries) {
				// One row per LINE: the anchor addresses a line, so two references on
				// one line are one editable row. The exact columns stay in
				// `locations`, which is what JSON mode reads.
				if (seen.has(entry.line)) continue;
				seen.add(entry.line);
				rows.push({
					number: entry.line,
					hash: byLine.get(entry.line) ?? "",
					text: lines[entry.line - 1] ?? "",
					character: entry.character,
				});
			}
			out.push({ path: group.displayPath, rows });
		} catch {
			// Unreadable (gone, or outside this store's world): the ROWS survive
			// and only the anchors are lost. A location is still a location.
			out.push({
				path: group.displayPath,
				rows: group.entries.map((entry) => ({ number: entry.line, hash: "", text: "", character: entry.character })),
			});
		}
	}
	return out;
}

/**
 * The text view of a navigation answer: one section per file, one row per
 * line, the anchor in the same column every other tool puts it.
 *
 * A row whose file could not be read has no anchor, so it falls back to the
 * `line:character` the server gave — still a usable pointer, just not an
 * editable one.
 *
 * @param value - the canonical value (for the header and the omission note).
 * @param groups - the per-file rows.
 * @returns the model-facing text.
 */
function navigationModelText(value: Record<string, unknown>, groups: readonly NavigationGroup[]): string {
	const head = `${value.server ?? "lsp"} — ${value.operation ?? "?"} for ${value.path ?? "?"}`;
	const note = typeof value.raw === "string" && value.raw !== "" ? value.raw : undefined;
	if (groups.length === 0) return `${head}\n${note ?? "No results."}`;
	const anchored = groups.flatMap((group) => group.rows.filter((row) => row.hash !== ""));
	const width = anchorWidth(anchored.map((row) => fmtMarker(row.hash, row.number)));
	const body: string[] = [];
	for (const group of groups) {
		body.push(`  ${group.path}`);
		for (const row of group.rows) {
			body.push(row.hash === ""
				? `    ${row.number}:${row.character}`
				: `    ${fmtHashlineRow(fmtMarker(row.hash, row.number), row.text, width)}`);
		}
	}
	const total = typeof value.totalLocations === "number" ? value.totalLocations : anchored.length;
	const header = `${head} (${total} location${total === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"})`;
	return [header, ...body, ...(note === undefined ? [] : [note])].join("\n");
}
/** Re-exported from the lsp layer: the domain's format tool raises it too. */
export { E_LSP_NO_SERVER };

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
