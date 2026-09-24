/**
 * `ast_grep` — a structural search, as its own tool.
 *
 * Split out of `read` rather than folded into it, because the two answer
 * different questions: `read` returns lines and anchors, this returns PLACES the
 * syntax matches. Folding it in meant a capability that had to be switched on
 * globally (`ast.enabled`) and parameters that only existed when it was, and it
 * tied a structural question to a line-reading tool's schema.
 *
 * The result is deliberately expressed as THE SAME ROW FORMAT `read` uses, so a
 * match can be handed straight to `edit`: this tool decides WHERE, and the
 * hashline primitives decide how it lands. It parses nothing itself and writes
 * nothing at all — the worker owns the grammar, and `edit` owns the change.
 *
 * @module dsh-hashline-edittool/tool-ast-grep
 */
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { languageForPath } from "../ast/language.js";
import { isAstEnabled, isAstLanguageEnabled } from "../config.js";
import { E_AST_DISABLED } from "../ast/codes.js";
import { AstError, getAstClient } from "../ast/client.js";
import type { FileIO } from "../infra/fs-bridge.js";
import { anchorsFor, allocateForLines } from "../hashline/session-anchors.js";
import { anchorWidth, fmtHashlineRow, fmtMarker, hashlineHeader, lineHashesPure } from "../hashline/hash-assign.js";
// tools emit the SAME `files` shape precisely so one cap governs both.
import { capGrepMeta, grepPresentationFromMeta } from "../render/grep-card.js";
import { getEffectiveConfig, isJsonOutput } from "../config.js";
import { errorFieldSchema, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { serveRowsInWorkspace, execCwd, execSessionKey } from "../domain/session/session-view.js";
import { renderSummary, servedRowsFor, summaryFooter, summaryGate, summaryIsWorthIt } from "../render/read-summary.js";
import { AST_SUMMARY_MIN_BODY_LINES, AST_SUMMARY_MIN_COMMENT_LINES } from "../infra/constants.js";
import { splitLines } from "../infra/utils.js";
import { toLF } from "../render/edit-diff.js";

/** The description the model reads — it has to teach the pattern syntax. */
function astGrepDescription(): string {
	return [
		"Structural code search: find places by SYNTAX SHAPE rather than by text.",
		"",
		"Use it when the shape matters (calls, declarations, imports, language constructs) and plain `grep` would match inside strings or comments.",
		"",
		"The pattern is ordinary source for the file's language, in which identifiers are metavariables:",
		"- `$NAME` — one node, captured under NAME",
		"- `$$$NAME` — zero or more nodes, captured as a list",
		"- `$_` — one node, matched without capturing",
		"",
		"Rules that bite:",
		"- A pattern must parse as ONE node. A fragment the grammar rejects is an error, not an empty result — wrap it (`class $_ { … }`).",
		"- Some positions demand a specific token, so a metavariable cannot stand there as written: a module specifier is a string, so write `import $$$BODY from \"$MODULE\"`.",
		"- Metavariable names are UPPERCASE and stand for a whole node: `pre$FIX` does not work.",
		"- The same name twice must match the SAME code (`$A == $A` matches `x == x`, not `x == y`).",
		"",
		"The rows come back in the same `line:anchor:content` form `read` produces, so a match can be passed straight to `edit`.",
	].join("\n");
}

/** One matched span, as the worker reports it. */
interface GrepMatchLike {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly captures: Record<string, readonly string[]>;
	/** Capture positions: `[startLine, startColumn, endLine, endColumn]` each. */
	readonly captureSpans: Record<string, readonly (readonly number[])[]>;
}

/**
 * Build the tool.
 *
 * @param io - the session's file access, for resolve + read.
 * @returns the tool definition.
 */
export function buildAstGrepTool(io: FileIO) {
	return defineTool({
		name: "ast_grep",
		description: astGrepDescription(),
		parameters: {
			pat: {
			// Optional on purpose, and this is where the outline lives now.
			//
			// It used to be `read {summary: true}` — an AST capability folded into
			// the line reader, which is the thing the split exists to undo.
			// Structural questions belong to the structural tools, and "show me the
			// shape of this file" is one.
				type: "string",
				description:
					"One AST pattern in the file's language, with `$NAME` / `$$$NAME` / `$_` metavariables. Must parse as a single node. " +
					"OMIT IT to get the file's OUTLINE instead: every symbol with the bodies of the large ones folded away.",
			},
			path: {
				type: "string",
				description: "The file to search. Required — a structural pattern is language-specific, so the language has to be known.",
			},
		},
		// The result type comes FROM this schema, so it is not decoration: without
		// it the tool's return type is `never` and nothing can be returned at all.
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					// Absent for an outline, which has no pattern.
					pat: { type: "string" },
					outline: { type: "string" },
					matches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								startLine: { type: "integer", required: true },
								endLine: { type: "integer", required: true },
								// The same `line:anchor:content` rows `read` produces, so a match
								// can be handed straight to `edit`.
								// `required` is NOT allowed on an `items` value spec — the DSL rejects
								// it at registration time, which is later than it sounds: the tool
								// compiles and only fails when a real session mounts it.
								rows: { type: "array", required: true, items: { type: "string" } },
								captures: { type: "array", required: true, items: { type: "string" } },
							},
						},
					},
					// THE CARD'S DATA, and it is STRUCTURED for the same reason `grep`'s is
					// (ADR-0005): the card is a projection of facts, never a re-parse of the
					// model text. Re-parsing `rows` would put two renderers on one string,
					// and the day they disagree the model and the reader see different files.
					//
					// The shape is `grep`'s on purpose, so `ast_grep` wears the grep card
					// rather than a copy of it.
					cardFiles: {
						type: "array",
						required: true,
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
											match: { type: "boolean" },
											// The matched NODE's span within the line, so the card can
											// highlight what the pattern actually selected rather than the
											// whole line — which is the one thing a structural search
											// knows that a text search does not.
											spans: {
												type: "array",
												items: { type: "array", items: { type: "integer" } },
											},
										},
									},
								},
							},
						},
					},
					truncated: { type: "boolean", required: true },
					total: { type: "integer", required: true },
					// Outline mode only: marks the meta so the card's footer says
					// OUTLINE instead of counting matches. Declared because the DSL
					// rejects an undeclared property outright (field-reported).
					isOutline: { type: "boolean" },
					// THE MODEL CHANNEL. Declared because the DSL validates the returned
					// value against this schema: a field the tool returns but the schema
					// does not name is rejected outright (`value.modelText is not
					// declared`), which is how this was found.
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
		// The model reads modelText — built in `execute`, so BOTH output modes are
		// projections of the same facts instead of being re-derived here. The old
		// render rebuilt the text from `matches`, which put two renderers on one
		// answer and would have shown text while JSON mode was selected.
		render: (_args: unknown, value: { readonly modelText: string }) => [
			{ type: "text", text: value.modelText },
		],
		// The card's projection, and the reason `ast_grep` can wear the GREP card
		// rather than a copy of it: `cardFiles` is the same shape `grep` emits, so
		// the same component draws both and a fix to one is a fix to the other.
		//
		// An outline has no rows and no matches — its card is the explanatory
		// sentence, delivered as the model text already carries it. Emitting an
		// empty `files` there is honest: there is nothing to draw, and the grep
		// card renders the empty state rather than falling back to raw IO.
		presentationMeta: (_args: unknown, value: { readonly cardFiles: unknown; readonly truncated: boolean; readonly total: number; readonly isOutline?: boolean; readonly error?: ErrorMeta }) => {
			if (value.error !== undefined) return { error: value.error } as never;
			return capGrepMeta({
				files: value.cardFiles as never,
				truncated: value.truncated,
				total: value.total,
				// An outline renders its rows but the footer must not read them as
				// matches; the flag rides the meta to the card.
				...(value.isOutline === true ? { outline: true } : {}),
			}) as never;
		},
	},
	// THE CARD ITSELF. The meta above is data; this is what turns it into the
	// search card — file tabs, `行号:锚点` gutter, highlight — the SAME view
	// `grep` returns, because the shape is the same. `presentationMeta` alone drew
	// nothing: the web renders a card only when presentResult describes one, and
	// without it the call fell back to raw input/output.
	presentResult: (_args, result) => {
		if (result.isError) return undefined;
		const meta = grepPresentationFromMeta(result.meta);
		if (meta === undefined) return undefined;
		return {
			card: "search",
			shape: "matches",
			files: meta.files.map((file) => ({
				path: file.path,
				matches: file.rows
					.filter((row) => row.match === true)
					.map((row) => ({ lineNumber: row.number, line: row.text })),
			})),
			truncated: meta.truncated,
			total: meta.total,
		};
	},
		async execute(args: { readonly pat?: string; readonly path: string }, exec: ToolRunContext) {
			try {
			const cwd = execCwd(exec);
			const absolutePath = await io.resolve(args.path, cwd);
			const language = languageForPath(absolutePath);
			if (language === undefined) {
				throw new Error(
					`[E_AST_PATTERN] no grammar is registered for ${args.path}. Structural search needs a language whose descriptor exists; use \`grep\` for a text search.`
				);
			}
			// THE SWITCH, now that these ARE the AST tools.
			//
			// It used to gate `read`'s selectors and `edit`'s block ops, and once those
			// left it gated NOTHING on this path — so "AST off" still ran structural
			// searches, and the card's copy said something that had stopped being true.
			// A switch that does not gate the thing it names is worse than no switch.
			//
			// It comes AFTER the language check on purpose: "no grammar for this file" is
			// the more specific answer, and reporting "AST is off" for a `.txt` would send
			// the user to the wrong setting.
			//
			// A REFUSAL, not an empty result: reporting "switched off" as "no match" would
			// be a claim about the code.
			if (!isAstEnabled()) {
				throw new Error(
					`${E_AST_DISABLED} the AST capability is off, so \`ast_grep\` will not run. Turn it on in the hashline settings (\`ast.enabled\`), or use \`grep\` for a text search.`
				);
			}
			if (!isAstLanguageEnabled(language.id)) {
				throw new Error(
					`${E_AST_DISABLED} AST is on, but turned off for ${language.displayName} — the per-language switches sit under the master switch in the hashline settings.`
				);
			}
			// Issue #147 (ADR-0008): the READ LINE SPACE — the AST client and the row splitter see the space read serves.
			const text = toLF(await io.readText(absolutePath));
			// NO PATTERN means the OUTLINE. It is a different question from matching
			// and it is answered by a different primitive, but it is the same KIND of
			// question — what is the shape of this code — and that is why it lives
			// here rather than in the line reader.
			if (args.pat === undefined || args.pat === "") {
				const lines = splitLines(text);
				// LAZY (#169): the view first; the allocation happens only AFTER the
				// gate — a refused file allocates nothing at all.
				let hashes = anchorsFor(absolutePath, text);
				const tooBig = summaryGate({ totalLines: lines.length, byteLength: text.length });
				if (tooBig !== undefined) {
					// A file the outline gate refuses is not an error: say which rule it hit
					// and let the model decide. Silence here would read as "no symbols".
					return {
						path: args.path,
						matches: [],
						cardFiles: [],
						truncated: false,
						total: 0,
						outline: `${args.path}: no outline — ${tooBig}. Read it in windows instead, or use \`ast_grep\` with a pattern to find something specific.`,
						// A refusal still speaks through the model channel, in whatever mode
						// is active — the schema declares it, so it must always be present.
						modelText: isJsonOutput()
							? JSON.stringify({ path: args.path, outline: [], reason: tooBig })
							: `${args.path}: no outline — ${tooBig}. Read it in windows instead, or use \`ast_grep\` with a pattern to find something specific.`
					};
				}
				// Not refused: the outline answers a whole-file question — allocate
				// for every line the file has.
				hashes = allocateForLines(
					absolutePath, text,
					Array.from({ length: lines.length }, (_, i) => i + 1),
				);
				let spans;
				try {
					spans = await getAstClient().summarySpans({
						path: args.path,
						text,
						languageId: language.id,
						minBodyLines: AST_SUMMARY_MIN_BODY_LINES,
						minCommentLines: AST_SUMMARY_MIN_COMMENT_LINES,
					});
				} catch (error) {
					if (error instanceof AstError) {
						return {
							path: args.path,
							outline: `${args.path}: no outline — ${error.message}`,
							modelText: isJsonOutput()
								? JSON.stringify({ path: args.path, outline: [], reason: error.message })
								: `${args.path}: no outline — ${error.message}`,
							matches: [],
							cardFiles: [],
							truncated: false,
							total: 0,
						};
					}
					throw error;
				}
				const rendered = renderSummary({ lines, hashes, spans });
				if (!summaryIsWorthIt(rendered, lines.length)) {
					// Nothing to fold means the file is already short enough to read
					// whole — an "outline" identical to the file would be noise.
					return {
						path: args.path,
						matches: [],
						cardFiles: [],
						truncated: false,
						total: 0,
						outline: `${args.path}: nothing to fold — the file is short enough to \`read\` whole (${lines.length} lines).`,
						modelText: isJsonOutput()
							? JSON.stringify({ path: args.path, outline: [], reason: `nothing to fold — short enough to read whole (${lines.length} lines)` })
							: `${args.path}: nothing to fold — the file is short enough to \`read\` whole (${lines.length} lines).`,
					};
				}
				const outlineLines = rendered.rows.map((row) => {
					// A merged row's number part is a RANGE (`20-34`); a kept row's is
					// its line. The anchor comes FIRST and the number trails it inside
					// the marker; the separator only divides marker from content.
					const line = row.merged ? `${row.number}-${row.endNumber}` : `${row.number}`;
					return { marker: `${row.anchor}:${line}`, text: row.text, line };
				});
				// The CARD's rows: the outline IS a folded line view, so it wears the
				// grep card's row shape — gutter and text, no match highlight (an
				// outline is not a match). A merged row reports its START line; the
				// range lives in the model text's marker. Field-reported bug #131:
				// an empty `files` here rendered the search card's 无结果, telling
				// the reader the outline the model was actively reading was nothing.
				const outlineCardRows = outlineLines.map((r) => {
					const at = r.marker.lastIndexOf(":");
					return {
						number: Number.parseInt(r.line, 10),
						hash: at > 0 ? r.marker.slice(0, at) : "",
						text: r.text,
					};
				});
				const width = anchorWidth(outlineLines.map((r) => r.marker));
				const body = outlineLines
					.map((r) => fmtHashlineRow(r.marker, r.text, width))
					.join("\n");
				// The rows are SERVED, so the outline is editable exactly as a read is:
				// kept lines at their own positions and a merged row at BOTH endpoints.
				// A folded interior stays unseen and cannot be edited unseen.
				//
				// Through the scope-aware primitive: `ast_grep` has no `withWorkspace`
				// body, so a bare `recordServed` here resolved the SHARED `$DSH_HOME`
				// store rather than this project's — served to nobody.
				await serveRowsInWorkspace({
					sessionKey: execSessionKey(exec),
					cwd,
					absolutePath,
					rows: servedRowsFor(rendered, lines, hashes),
					lineCount: lines.length,
					exec,
					io,
				});
				return {
					path: args.path,
					matches: [],
					cardFiles: [{ path: args.path, rows: outlineCardRows }],
					truncated: false,
					total: outlineCardRows.length,
					// Marks the meta so the card's footer says OUTLINE instead of
					// "0 of N matches" — the grep counts vocabulary is wrong here.
					isOutline: true,
					// `outline` is the CARD's sentence and stays the rendered text;
					// `modelText` is what the model reads, in the active mode. Both are
					// projections of `outlineLines`, so the markers cannot drift.
					outline: `${hashlineHeader()}\n${body}\n\n${summaryFooter({ path: args.path, rendered })}`,
					modelText: isJsonOutput()
						? JSON.stringify({
								path: args.path,
								totalLines: lines.length,
								lines: Object.fromEntries(outlineLines.map((r) => [r.marker, r.text])),
							})
						: `${hashlineHeader()}\n${body}\n\n${summaryFooter({ path: args.path, rendered })}`,
				};
			}
			let matches: readonly GrepMatchLike[];
			try {
				matches = await getAstClient().grepPattern({
					path: args.path,
					text,
					languageId: language.id,
					pat: args.pat,
				});
			} catch (error) {
				if (error instanceof AstError) throw new Error(error.message);
				throw error;
			}
			// `fmtHashlineRow` owns the separator between anchor and content, which is
			// the configured one; the line-to-anchor colon is fixed syntax and is not
			// the separator (issue #69). The rows are exactly what `read` produces, so
			// a match can be handed straight to `edit`.
			const lines = splitLines(text);
			const anchors = anchorsFor(absolutePath, text);
			// LAZY (#169): allocate for exactly the rows this call serves — one row
			// per line any match touches. Everything else keeps its state (or stays
			// unallocated until something serves it).
			const servedLineNos = [...new Set(
				matches.flatMap((match) => {
					const rows: number[] = [];
					for (let line = match.startLine; line <= match.endLine; line++) rows.push(line);
					return rows;
				}),
			)].sort((a, b) => a - b);
			const allocatedAnchors = allocateForLines(absolutePath, text, servedLineNos);
			for (let k = 0; k < servedLineNos.length; k++) {
				anchors[servedLineNos[k]! - 1] = allocatedAnchors[k]!;
			}
			const width = anchors.reduce((w, a) => Math.max(w, a.length), 0);
			// THE CARD'S ROWS, built from the SAME `lines` / `anchors` the model text
			// uses. A card is a projection of facts, never a re-parse of the rendered
			// text (ADR-0005): two renderers on one string drift, and the day they do
			// the model and the reader are looking at different files.
			interface CardRow {
				number: number;
				hash: string;
				text: string;
				match?: true;
				spans?: [number, number][];
			}
			const cardRows: CardRow[] = [];
			// One row per line any match touches, in document order, deduplicated —
			// two matches on one line are one row with one highlight.
			const seen = new Set<number>();
			// What the highlight covers, in priority order:
			//
			//   1. THE CAPTURES, when the pattern has metavariables. `const $NAME =
			//      $VALUE;` is a search for the SYMBOLS the pattern names — lighting
			//      up the whole statement paints the whole line and says nothing.
			//   2. The matched NODE, when the pattern is literal (no `$` variables),
			//      which is the only thing there is to point at.
			//
			// A range that spans lines is clipped per line: its first line starts at
			// the start column, its last ends at the end column, and middle lines are
			// wholly inside it.
			const clipRange = (
				range: readonly number[],
				line: number,
				rowText: string,
			): [number, number] | undefined => {
				const [startLine, startColumn, endLine, endColumn] = range as [
					number,
					number,
					number,
					number,
				];
				if (line < startLine || line > endLine) return undefined;
				if (startLine === endLine) {
					return [startColumn, Math.min(endColumn, rowText.length)];
				}
				if (line === startLine) return [startColumn, rowText.length];
				if (line === endLine) return [0, Math.min(endColumn, rowText.length)];
				return [0, rowText.length];
			};
			const spansFor = (match: GrepMatchLike, line: number, rowText: string): [number, number][] => {
				if (rowText.length === 0) return [];
				const captureRanges = Object.values(match.captureSpans ?? {}).flat();
				const ranges =
					captureRanges.length > 0
						? captureRanges
						: [[match.startLine, match.startColumn, match.endLine, match.endColumn]];
				const spans: [number, number][] = [];
				for (const range of ranges) {
					const span = clipRange(range, line, rowText);
					if (span === undefined || span[1] <= span[0]) continue;
					spans.push(span);
				}
				// Ascending and merged: two captures on one line paint one run, never a
				// seamed pair, and the segmenter downstream never has to repair order.
				spans.sort((a, b) => a[0] - b[0]);
				const merged: [number, number][] = [];
				for (const span of spans) {
					const last = merged[merged.length - 1];
					if (last !== undefined && span[0] <= last[1]) {
						last[1] = Math.max(last[1], span[1]);
						continue;
					}
					merged.push([span[0], span[1]]);
				}
				return merged;
			};
			for (const match of matches) {
				for (let line = match.startLine; line <= match.endLine; line++) {
					if (seen.has(line)) continue;
					seen.add(line);
					const rowText = lines[line - 1] ?? "";
					cardRows.push({
						number: line,
						hash: anchors[line - 1] ?? "",
						text: rowText,
						match: true,
						...(spansFor(match, line, rowText).length === 0
							? {}
							: { spans: spansFor(match, line, rowText) }),
					});
				}
			}
			// Every row is built ONCE from the structured facts (line, anchor, text)
			// and used by BOTH channels: the rendered text rows and the JSON dict
			// keyed `<anchor>:<line>`. Rows are never re-parsed (ADR-0005).
			//
			// The dict stays a LOCAL: the tool DSL has no map type, so a dictionary
			// reaches the model inside `modelText` (a string) and never as a schema
			// field — a returned `dict` is rejected as `not declared`.
			const dicts: Array<Record<string, string>> = [];
			const rows = matches.map((match) => {
				const body: string[] = [];
				const dict: Record<string, string> = {};
				for (let line = match.startLine; line <= match.endLine; line++) {
					const anchor = anchors[line - 1] ?? "";
					const text = lines[line - 1] ?? "";
					body.push(fmtHashlineRow(fmtMarker(anchor, line), text, width));
					if (anchor !== "") dict[`${anchor}:${line}`] = text;
				}
				dicts.push(dict);
				return {
					startLine: match.startLine,
					endLine: match.endLine,
					rows: body,
					captures: Object.entries(match.captures).map(
						([name, values]) => `${name}=${values.map((v) => JSON.stringify(v)).join(", ")}`),
				};
			});
			// The card is a projection of the SAME facts, never a re-parse of `rows`.
			//
			// BOTH output modes are produced here, from those same facts: the text
			// mode renders the matched rows with their `<anchor>:<line>` markers
			// (editable exactly as a read's are), the JSON mode keys the same rows by
			// that same marker. Nothing is re-parsed and the two cannot drift.
			// `total` is the card's count — the matched LINES, which is what the card
			// lists. The MODEL text has to say both, because a pattern that matches
			// multi-line nodes reports far fewer structural matches than lines, and
			// "22 match(es)" for 2 function matches is simply false (#151/P6).
			const total = cardRows.length;
			const matchCount = matches.length;
			const counted =
				matchCount === total
					? `${matchCount} match(es)`
					: `${matchCount} match(es) covering ${total} line(s)`;
			const modelText = isJsonOutput()
				? JSON.stringify({
						path: args.path,
						pattern: args.pat,
						// Both counts, named: `total` stays the card's line count.
						matchCount,
						total,
						matches: rows.map((row, index) => ({
							startLine: row.startLine,
							endLine: row.endLine,
							captures: row.captures,
							rows: dicts[index] ?? {},
						})),
					})
				: [`${args.path} — ${counted} for \`${args.pat}\``, ...rows.flatMap((row) => [...row.rows, ...row.captures.map((c) => `  ${c}`), ""])]
						.join("\n")
						.trimEnd();
			return {
				path: args.path,
				pat: args.pat,
				matches: rows,
				cardFiles: [{ path: args.path, rows: cardRows }],
				truncated: false,
				total,
				modelText,
			};
			} catch (error) {
				return {
					path: args.path,
					matches: [],
					cardFiles: [],
					truncated: false,
					total: 0,
					...(thrownErrorResult(error, { path: args.path }) as unknown as Record<string, unknown>),
				} as never;
				}
		},
	});
}

/**
 * Register the tool on an agent's context.
 *
 * @param _rootCtx - unused; kept for symmetry with the other registrars.
 * @param agentCtx - the agent whose tool surface this joins.
 * @param io - the session's file access.
 * @returns a disposer.
 */
export function registerAstGrepTool(_rootCtx: Context, agentCtx: Context, io: FileIO): () => void {
	return agentCtx.tools.register(buildAstGrepTool(io));
}
