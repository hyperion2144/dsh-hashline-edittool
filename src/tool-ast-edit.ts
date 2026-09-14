/**
 * `ast_edit` — change code at places found by SHAPE.
 *
 * It finds the places and nothing else. The anchors come from the hashline
 * allocator, the items are folded by the edit tool's own preparation, and the
 * write goes through the same engine as `edit` — so the served-state check, the
 * syntax gate, the diff, the undo entry and the store all apply exactly as they
 * do to a hand-written edit. This module owns no file I/O and no anchor logic,
 * and that is the point: a second implementation of either would drift, and the
 * drift would surface as edits landing on the wrong lines for one tool only.
 *
 * @module dsh-hashline-edittool/tool-ast-edit
 */
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import { languageForPath } from "./ast/language.js";
import { isAstEnabled, isAstLanguageEnabled, isJsonOutput } from "./config.js";
import { E_AST_DISABLED } from "./ast/codes.js";
import { AstError, getAstClient } from "./ast/client.js";
import { runFileEdits, type PreparedItem } from "./edit-engine.js";
import { diffDictFrom } from "./presentation-helpers.js";
import { buildPreparedItem, commitFileResult } from "./tool-edit.js";
import { lineHashesPure } from "./hashline/hash-assign.js";
import { execCwd, execSessionKey } from "./session-view.js";
import { recordEchoServes } from "./hashline/anchor-pipeline.js";
import { canon, contentChecksum } from "./hashline/hash-assign.js";
import type { FileIO } from "./fs-bridge.js";
import type { FsSandboxController } from "./sandbox.js";
import { splitLines } from "./utils.js";

/** One match, as the worker reports it. */
interface GrepMatchLike {
	readonly startLine: number;
	readonly endLine: number;
	readonly captures: Record<string, readonly string[]>;
}

/**
 * Fill a replacement template from a match's captures.
 *
 * `$$$NAME` first: the one-node rule would otherwise consume `$` and leave `$$`,
 * and it would substitute the wrong thing rather than fail.
 *
 * @param template - the `out` text, with metavariables.
 * @param captures - what the pattern bound.
 * @returns the replacement for this match.
 */
function fillTemplate(template: string, captures: Record<string, readonly string[]>): string {
	return template
		.replace(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)?/g, (_m, name: string | undefined) =>
			name === undefined ? "" : (captures[name] ?? []).join(", "))
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => captures[name]?.[0] ?? "");
}

/** The description the model reads. */
function astEditDescription(): string {
	return [
		"Change code at places found by SYNTAX SHAPE — the write half of `ast_grep`.",
		"",
		"`pat` selects what to change; `out` is what it becomes, and may reference the pattern's metavariables (`out: \"logger.info($$$ARGS)\"`). An empty `out` deletes the match.",
		"",
		"Every match is applied as ONE atomic batch through the same engine `edit` uses: the anchors come from the hashline allocator, syntax is re-checked after the change, the diff comes back, and `undo_last_edit` can put it back. Nothing here writes a file directly.",
		"",
		"Pattern rules are `ast_grep`'s, and the same ones bite: a pattern must parse as ONE node, and some positions demand a specific token — a module specifier is a string, so write `from \"$MODULE\"`.",
		"",
		"If a change would break syntax the whole batch is refused and nothing is written; re-read the file, because anchors are scoped to the state they were served in.",
	].join("\n");
}

/**
 * Build the tool.
 *
 * @param io - the session's file access.
 * @returns the tool definition.
 */
export function buildAstEditTool(io: FileIO, sandbox: FsSandboxController) {
	return defineTool({
		name: "ast_edit",
		description: astEditDescription(),
		parameters: {
			pat: {
				type: "string",
				required: true,
				description: "One AST pattern, with `$NAME` / `$$$NAME` / `$_` metavariables. Must parse as a single node.",
			},
			out: {
				type: "string",
				required: true,
				description: "The replacement. May reference the pattern's metavariables. Empty string deletes every match.",
			},
			path: {
				type: "string",
				required: true,
				description: "The file to change. Required — a structural pattern is language-specific.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					pat: { type: "string", required: true },
					count: { type: "integer", required: true },
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					// THE MODEL CHANNEL, declared because the DSL validates the returned
					// value: a field the schema does not name is rejected outright
					// (`value.modelText is not declared`).
					modelText: { type: "string", required: true },
				},
			},
			// The model reads modelText, built in `execute` so it is the right mode
			// (text prose or the JSON envelope) — the old render always spoke prose,
			// which would have shown text while JSON mode was selected.
			render: (_args: unknown, value: { readonly modelText: string }) => [
				{ type: "text", text: value.modelText },
			],
		},
		async execute(args: { readonly pat: string; readonly out: string; readonly path: string }, exec: ToolRunContext) {
			const cwd = execCwd(exec);
			const absolutePath = await io.resolve(args.path, cwd);
			const language = languageForPath(absolutePath);
			if (language === undefined) {
				throw new Error(
					`[E_AST_PATTERN] no grammar is registered for ${args.path}. Structural search needs a language whose descriptor exists; use \`grep\` for a text search.`
				);
			}
			// THE SWITCH, now that these ARE the AST tools — the same gate `ast_grep`
			// runs, for the same reason: a switch that does not gate the thing it names
			// is worse than no switch, and reporting "switched off" as "nothing matched"
			// would be a claim about the code.
			if (!isAstEnabled()) {
				throw new Error(
					`${E_AST_DISABLED} the AST capability is off, so \`ast_edit\` will not run. Turn it on in the hashline settings (\`ast.enabled\`), or use \`edit\` with anchors for a line-level change.`
				);
			}
			if (!isAstLanguageEnabled(language.id)) {
				throw new Error(
					`${E_AST_DISABLED} AST is on, but turned off for ${language.displayName} — the per-language switches sit under the master switch in the hashline settings.`
				);
			}
			const text = await io.readText(absolutePath);
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
			if (matches.length === 0) {
				const message =
					"No match, so nothing was written. A pattern the grammar could not parse would have been an error instead.";
				return {
					path: args.path,
					pat: args.pat,
					count: 0,
					ok: true,
					message,
					// The model channel is required by the output schema, in every mode.
					modelText: isJsonOutput()
						? JSON.stringify({ ok: true, path: args.path, pattern: args.pat, count: 0, diff: {}, hints: [], warnings: [], errors: [] })
						: `No match for \`${args.pat}\` in ${args.path}. ${message}`,
				};
			}
			// The anchors come from the hashline allocator — the SAME primitive
			// `read` uses — so what is edited is what a read would have shown.
			const anchors = lineHashesPure(text);
			const sourceLines = splitLines(text);
			const sessionKey = execSessionKey(exec);
			// SERVE what this tool is about to edit, exactly as `read` serves what it
			// returns. Without this the engine's served-state check rejects every edit:
			// the anchors exist, but nothing ever published them, so the mirror has no
			// entry for the line and the range comes back unverifiable — `ast_edit`
			// could not touch a file the model had not read first.
			//
			// The check is NOT bypassed; it is satisfied the way it is meant to be.
			// Publishing these rows makes the same statement `read` makes: "these are
			// the lines I found, and this is their content". A later edit against a
			// stale view still fails, which is the guarantee, kept intact.
			//
			// Only the MATCHED lines are served, not the whole file: the model was
			// shown the matches and nothing else, and serving more would be this tool
			// vouching for lines nobody looked at.
			const served = matches.flatMap((match) => {
				const rows = [];
				for (let line = match.startLine; line <= match.endLine; line++) {
					rows.push({
						position: line - 1,
						anchor: anchors[line - 1] ?? "",
						contentKey: contentChecksum(canon(sourceLines[line - 1] ?? "")),
					});
				}
				return rows;
			});
			await recordEchoServes(sessionKey, absolutePath, served, "live", anchors.length);
			// An echo is a read: the session has seen these lines, so the dsh
			// observation policy must know it too, or the fresh anchors in the echo
			// cannot be written with.
			await io.emitObserved(absolutePath, exec, exec.signal);
			const items: PreparedItem[] = matches.map((match, index) => {
				const start = anchors[match.startLine - 1];
				const end = anchors[match.endLine - 1];
				if (start === undefined || end === undefined) {
					throw new Error(`[E_AST_PATTERN] match ${index} spans lines the file does not have; re-read and retry.`);
				}
				const replacement = fillTemplate(args.out, match.captures);
				// PUT THE INDENTATION BACK.
				//
				// A match covers the NODE, and a node does not include the whitespace its
				// line begins with — the pattern `return `hello ${name}`;` starts at
				// `return`, while the line is `\treturn …`. The hunk replaces whole LINES,
				// so replacing with the bare replacement dropped that tab: every structural
				// edit silently de-indented the code it touched.
				//
				// The fix re-applies the start line's own leading whitespace, and applies
				// the SAME indent delta to the replacement's later lines so a multi-line
				// `out` stays structurally clear instead of losing its interior shape.
				const originalStart = sourceLines[match.startLine - 1] ?? "";
				// The leading whitespace the NODE does not own.
				const indent = /^[ \t]*/.exec(originalStart)?.[0] ?? "";
				return buildPreparedItem(
					index,
					args.path,
					{
						op: replacement === "" ? "del" : "replace",
						anchor_start: start,
						anchor_end: end,
						...(replacement === ""
							? {}
							: {
									lines: splitLines(replacement).map((line, index_) =>
										// Only the FIRST line gets the recovered indent: the rest of a
										// multi-line `out` carries the indentation its author wrote, and
										// adding more would double it.
										index_ === 0 ? indent + line : line,
									),
								}),
					},
					absolutePath,
				);
			});
			// `runFileEdits` PREPARES; it does not write. The commit below is the same
			// one `edit` performs — without it this tool computed a result, reported
			// `ok: true`, and left the file untouched, which is the worst shape a
			// failure can take: the caller is told it worked.
			const sandboxPolicy = await sandbox.resolvePolicy("ast_edit", {} as never, exec as never);
			const result = await runFileEdits(io, items, { sessionKey, exec });
			// THE SYNTAX GATE, which this tool must run ITSELF.
			//
			// The engine has one — `assertSyntaxAfterBlockEdit` — but it fires only for
			// BLOCK ops. This tool sends anchored line ops, so that path never runs, and
			// a pattern whose replacement drops a brace used to reach the disk while the
			// description promised otherwise.
			//
			// A structural tool leaving unparsable code behind is exactly its failure
			// mode, so the check belongs here rather than in the description.
			if (result.appliedCount > 0) {
				// An over-limit file or an unparsable SERVICE must not block the write:
				// that is the engine's own rule for the same check, and it is right —
				// "we could not ask" is not "it is broken".
				const clean = await getAstClient()
					.parsesCleanly({ path: absolutePath, text: result.result, languageId: language.id })
					.catch((error: unknown) => {
						if (error instanceof AstError) return true;
						throw error;
					});
				if (!clean) {
					throw new Error(
						`[E_SYNTAX_AFTER_EDIT] \`${args.pat}\` would leave ${args.path} unparsable, so NOTHING was written. ` +
							"The usual cause is a pattern whose replacement drops or duplicates a brace.",
					);
				}
			}
			await commitFileResult(result, {
				io,
				exec: exec as never,
				sandbox,
				sandboxPolicy,
				signal: (exec as { signal?: AbortSignal }).signal,
			});
			// The model channel, in BOTH modes, projected from the same facts the
			// write produced (never re-parsed text): the text mode keeps the body the
			// engine returned, the JSON mode is the edit envelope with its diff keyed
			// `<anchor>:<line>` exactly as every other tool's diff is.
			const file = result as unknown as {
				result?: string;
				originalNormalized?: string;
				resultHashes?: string[];
				originalHashes?: string[];
				warnings?: string[];
			};
			const body = file.result ?? "";
			let modelText = body === "" ? "Applied." : body;
			if (isJsonOutput()) {
				modelText = JSON.stringify({
					ok: true,
					path: args.path,
					pattern: args.pat,
					count: matches.length,
					diff: file.originalNormalized !== undefined && file.result !== undefined
						? diffDictFrom(file.originalNormalized, file.result, file.resultHashes, file.originalHashes)
						: {},
					hints: [],
					warnings: file.warnings ?? [],
					errors: [],
				});
			}
			return {
				path: args.path,
				pat: args.pat,
				count: matches.length,
				ok: true,
				message: body === "" ? "Applied." : body,
				modelText,
			};
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
export function registerAstEditTool(_rootCtx: Context, agentCtx: Context, io: FileIO, sandbox: FsSandboxController): () => void {
	return agentCtx.tools.register(buildAstEditTool(io, sandbox));
}
