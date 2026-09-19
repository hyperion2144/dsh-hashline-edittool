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
import { languageForPath } from "../ast/language.js";
import { isAstEnabled, isAstLanguageEnabled, isJsonOutput } from "../config.js";
import { errorFieldSchema, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { E_AST_DISABLED } from "../ast/codes.js";
import { AstError, getAstClient } from "../ast/client.js";
import { runFileEdits, type PreparedItem } from "../domain/edit/edit-engine.js";
import { execCwd, execSessionKey, withWorkspace } from "../domain/session/session-view.js";
import { anchorsFor } from "../hashline/session-anchors.js";
import { buildCanonicalFromFileResult, buildEditJson, buildPreparedItem, commitFileResult } from "./tool-edit.js";
import { computeHunkDiffs, diffsFromMeta, type FileDiff } from "../render/edit-card.js";
import { lineHashesPure } from "../hashline/hash-assign.js";
import { recordEchoServes } from "../domain/session/session-view.js";
import { canon, contentChecksum } from "../hashline/hash-assign.js";
import type { FileIO } from "../infra/fs-bridge.js";
import type { FsSandboxController } from "../infra/sandbox.js";
import { splitLines } from "../infra/utils.js";
import {
	deliverDiagnosticsAfterWrite,
	diagnosticsMeta,
	diagnosticsJson,
	formatDiagnosticsSection,
	prepareWriteDiagnostics,
	type DiagMetaEntry,
} from "../lsp/auto-diag.js";


type AstEditValue = {
	readonly path: string;
	readonly before?: string;
	readonly after?: string;
	readonly diffRows?: readonly unknown[];
	readonly diagnostics?: DiagMetaEntry[];
	readonly [key: string]: unknown;
};
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
					// The value IS `edit`'s single-file shape, so its schema is too: the
					// model reads a diff, the card draws one, and the two tools cannot
					// answer with different forms for the same kind of change.
					path: { type: "string", required: true },
					before: { type: "string" },
					after: { type: "string" },
					added: { type: "integer" },
					removed: { type: "integer" },
					firstChangedLine: { type: "integer" },
					lastChangedLine: { type: "integer" },
					warnings: { type: "array", items: { type: "string" } },
					diffRows: { type: "array" },
					driftNotice: { type: "string" },
					noop: { type: "boolean" },
					// #131: inline LSP diagnostics, when a push arrived in the window.
					diagnostics: { type: "array" },
					// Structural-search extras: this tool's own three fields.
					pat: { type: "string", required: true },
					count: { type: "integer", required: true },
					ok: { type: "boolean", required: true },
					message: { type: "string" },
					modelText: { type: "string", required: true },
					error: errorFieldSchema,
				},
			},
			// The model reads modelText, built in `execute` so it is the right mode
			// (text prose or the JSON envelope) — the old render always spoke prose,
			// which would have shown text while JSON mode was selected.
			render: (_args: unknown, value: { readonly modelText: string }) => [
				{ type: "text", text: value.modelText },
			],
			// THE CARD'S DATA, computed the way `edit` computes it: the hunks come
			// from before/after HERE, because the canonical value carries the content
			// and not a `diffs` field. Deriving them instead of carrying them is not
			// a style choice — an empty `diffs` array reads to the client as "nothing
			// was applied", so the card silently fell back to raw input/output.
			presentationMeta: (_args: unknown, value: { readonly path: string; readonly before?: string; readonly after?: string; readonly diffRows?: readonly unknown[]; readonly error?: ErrorMeta }) => {
				if (value.error !== undefined) return { error: value.error } as never;
				return ({
					diffs:
						value.before !== undefined && value.after !== undefined
							? computeHunkDiffs(value.path, value.before, value.after)
							: [],
					...(Array.isArray(value.diffRows) && value.diffRows.length > 0
						? { diffRows: value.diffRows }
						: {}),
					...(Array.isArray((value as AstEditValue).diagnostics)
						? { diagnostics: (value as AstEditValue).diagnostics }
						: {}),
				}) as never;
			},
		},
		// The tool-level hooks, siblings of `output` (which is where `edit` keeps
		// them too): `presentResult` is what makes the web draw the diff card, and
		// without it the meta alone drew nothing and the call stayed raw I/O.
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const diffs: FileDiff[] | undefined = diffsFromMeta(result.meta);
			if (diffs === undefined || diffs.length === 0) return undefined;
			return { card: "diff", title: `Ast edit ${diffs[0]!.path}`, diffs };
		},
		// EVERY tool that touches a file runs inside the workspace, and this one has
		// to as well: the undo entry (and the session-scoped stores beside it) is
		// resolved against the ambient workspace, so a body that skipped this wrote
		// its undo history under a DIFFERENT workspace — and `undo_last_edit`, which
		// does wrap, answered "No undo history" for an edit that had happened.
		async execute(args: { readonly pat: string; readonly out: string; readonly path: string }, exec: ToolRunContext) {
			return withWorkspace(execCwd(exec), () => runAstEdit(args, exec, io, sandbox)).catch((error: unknown) => ({
				path: args.path,
				pat: args.pat,
				count: 0,
				ok: false,
				...(thrownErrorResult(error, { path: args.path }) as unknown as Record<string, unknown>),
			}) as never);
		},
	});
}

/**
 * The body of `ast_edit`'s execute, run inside the calling session's workspace
 * (see the note at the call site — the undo entry lives under it).
 *
 * @param args - the pattern, its replacement, and the file to rewrite.
 * @param exec - execution identity, cancellation and cwd.
 * @param io - the session's file access.
 * @param sandbox - the sandbox controller for the write.
 * @returns the canonical value `edit` returns for the same kind of change.
 */
async function runAstEdit(
	args: { readonly pat: string; readonly out: string; readonly path: string },
	exec: ToolRunContext,
	io: FileIO,
	sandbox: FsSandboxController,
) {
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
	const anchors = anchorsFor(absolutePath, text);
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
	// #131: captured BEFORE the write, so the wait measures pushes against a
	// pre-write baseline. undefined = disabled / no manager / no ready server.
	const diagCtx = prepareWriteDiagnostics(absolutePath, execCwd(exec));
	await commitFileResult(result, {
		io,
		exec: exec as never,
		sandbox,
		sandboxPolicy,
		signal: (exec as { signal?: AbortSignal }).signal,
	});
	// #131: same delivery `edit` runs — inline inside the 300ms window, else
	// the bounded async wait. The syntax gate above already ran, so a report
	// here is the SERVER's opinion, complementing the parse we just did.
	const diagnostics =
		diagCtx !== undefined && result.appliedCount > 0
			? await deliverDiagnosticsAfterWrite({
					...diagCtx,
					toolName: "ast_edit",
					text: result.result,
					absolutePath,
					displayPath: args.path,
					io,
					exec: exec as never,
				})
			: undefined;
	const diagMeta = diagnostics === undefined ? undefined : diagnosticsMeta([diagnostics]);
	const diagSection = diagnostics === undefined ? "" : formatDiagnosticsSection([diagnostics]);
	// The JSON envelope carries the marker-keyed projection (diff-aligned);
	// the value field keeps the meta shape for the web card.
	const diagJson = diagnostics === undefined ? undefined : diagnosticsJson([diagnostics]);
	// The model channel IS `edit`'s, from `edit`'s own two builders: the text
	// mode is the diff block (legend, `-`/`+` rows with fresh anchors, the
	// success line) and the JSON mode is the pure edit envelope. Returning
	// the rewritten body instead told the model nothing about the change and
	// made it re-read what it had just written.
	const canonical = buildCanonicalFromFileResult(result, args.path, true);
	const modelText = isJsonOutput()
		? JSON.stringify({
				...buildEditJson(result, args.path),
				pattern: args.pat,
				count: matches.length,
				...(diagJson !== undefined ? { diagnostics: diagJson } : {}),
			})
		: diagSection === ""
			? canonical.modelText
			: `${canonical.modelText}\n\n${diagSection}`;
	return {
		...canonical,
		pat: args.pat,
		count: matches.length,
		ok: true,
		...(diagMeta !== undefined ? { diagnostics: diagMeta } : {}),
		modelText,
	};
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
