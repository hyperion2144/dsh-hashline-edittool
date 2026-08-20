/**
 * The dsh `grep` tool: hash-anchored substring / regex search that shadows
 * the built-in `grep` on the agent's own scope layer. Output mirrors the
 * `read` tool: every match row is `<line>#<hash>│content` under a
 * `HASH IDENTIFIER │ FILE LINES` header, one section per file. Matches are
 * recorded as served so a follow-up `edit` against a hit does not require a
 * separate `read`.
 * @module dsh-hashline-edittool/tool-grep
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey, recordServed } from "./session-view.js";
import { withWorkspace } from "./session-view.js";
import { lineHashes, HASH_SEP, HASHLINE_HEADER, LINE_HASH_SEP } from "./hashline/index.js";
import { HASH_SPACE } from "./hashline/hash-assign.js";
import { visLines, abortIf, clipLine } from "./utils.js";
import { GREP_DESCRIPTION } from "./prompts.js";

export interface GrepMatch {
	position: number;
	hash: string;
	content: string;
}

export interface GrepFileSection {
	path: string;
	matches: GrepMatch[];
	/** Context rows around each match (always includes the match position too). */
	contextRows: GrepMatch[];
}

export interface GrepToolOptions {
	/** Cap on matches per file. Default 100. */
	limit?: number;
	/** Number of context rows above and below each match. Default 0. */
	context?: number;
	/** If true, `pattern` is treated as a JavaScript regex. Default false. */
	regex?: boolean;
}

const DEFAULT_LIMIT = 100;

function buildMatcher(pattern: string, regex: boolean): (line: string) => boolean {
	if (!regex) {
		const needle = pattern;
		return (line) => line.includes(needle);
	}
	let compiled: RegExp;
	try {
		compiled = new RegExp(pattern);
	} catch (error) {
		throw new Error(
			`[E_BAD_SHAPE] Grep regex "${pattern}" is invalid: ${error instanceof Error ? error.message : String(error)}.`,
		);
	}
	return (line) => compiled.test(line);
}

/** Pure helper: extract sections from one file's content given a matcher. */
export async function grepFileContent(
	path: string,
	content: string,
	hashes: string[],
	pattern: string,
	opts: GrepToolOptions = {},
): Promise<GrepFileSection | undefined> {
	const matcher = buildMatcher(pattern, opts.regex === true);
	const lines = visLines(content);
	if (lines.length === 0) return undefined;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const context = Math.max(0, opts.context ?? 0);
	const matchPositions: number[] = [];
	for (let i = 0; i < lines.length && matchPositions.length < limit; i++) {
		if (matcher(lines[i]!)) matchPositions.push(i);
	}
	if (matchPositions.length === 0) return undefined;

	const contextSet = new Set<number>();
	for (const p of matchPositions) {
		for (let k = Math.max(0, p - context); k <= Math.min(lines.length - 1, p + context); k++) {
			contextSet.add(k);
		}
	}
	const contextRows: GrepMatch[] = [...contextSet]
		.sort((a, b) => a - b)
		.map((position) => ({
			position,
			hash: hashes[position]!,
			content: lines[position]!,
		}));
	return {
		path,
		matches: matchPositions.map((position) => ({
			position,
			hash: hashes[position]!,
			content: lines[position]!,
		})),
		contextRows,
	};
}

function renderSection(path: string, section: GrepFileSection): string {
	const headerLines: string[] = [`--- ${path} ---`, HASHLINE_HEADER];
	for (const row of section.contextRows) {
		headerLines.push(`${row.position + 1}${LINE_HASH_SEP}${row.hash}${HASH_SEP}${clipLine(row.content)}`);
	}
	return headerLines.join("\n");
}

/**
 * Register the hashline `grep` tool on the calling agent's scope.
 * @param _rootCtx - host context (logger, lifecycle).
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildGrepTool(io: FileIO) {
	return defineTool({
		name: "grep",
		description: GREP_DESCRIPTION,
		parameters: {
			path: {
				type: "string",
				description:
					"File or directory to search. Directories recurse one level deep.",
			},
			pattern: {
				type: "string",
				description:
					"Substring to match by default; pass `regex: true` to use a JavaScript-flavre regex.",
			},
			regex: {
				type: "boolean",
				description: "Treat `pattern` as a regex (default false: literal).",
			},
			context: {
				type: "number",
				description:
					"Number of context rows above and below each match (default 0).",
			},
			limit: {
				type: "number",
				description: "Cap on matches per file (default 100).",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;

				const params = args as Record<string, unknown>;
				if (typeof params.path !== "string" || params.path.length === 0) {
					throw new Error('[E_BAD_SHAPE] Grep request requires a non-empty "path".');
				}
				if (typeof params.pattern !== "string") {
					throw new Error('[E_BAD_SHAPE] Grep request requires a "pattern" string.');
				}
				const opts: GrepToolOptions = {
					limit: typeof params.limit === "number" ? params.limit : undefined,
					context: typeof params.context === "number" ? params.context : undefined,
					regex: params.regex === true,
				};
				// Pre-build matcher so a bad regex fails before any IO.
				buildMatcher(params.pattern, opts.regex === true);

				const root = await io.resolve(params.path, cwd, signal);
				abortIf(signal);
				const pathStat = await stat(root);
				let files: string[];
				if (pathStat.isDirectory()) {
					const entries = await readdir(root);
					files = entries
						.filter((name) => !name.startsWith(".") && name !== "node_modules")
						.map((name) => join(root, name));
				} else if (pathStat.isFile()) {
					files = [root];
				} else {
					throw new Error(
						`[E_NOT_TEXT] Path is neither file nor directory: ${params.path}`,
					);
				}

				const sections: string[] = [];
				const allServed: Array<{ path: string; rows: { position: number; hash: string }[] }> = [];
				const allSeen: Array<{ path: string }> = [];
				for (const file of files) {
					abortIf(signal);
					let raw: string;
					try {
						raw = await io.readText(file, signal);
					} catch {
						continue;
					}
					const hashes = await lineHashes(raw, file);
					const section = await grepFileContent(file, raw, hashes, params.pattern, opts);
					if (!section) continue;
					sections.push(renderSection(file, section));
					allServed.push({ path: file, rows: section.contextRows });
					allSeen.push({ path: file });
				}

				for (const seen of allSeen) {
					await io.emitObserved(seen.path, exec as ToolExecution, signal);
				}
				for (const served of allServed) {
					if (served.rows.length === 0) continue;
					await recordServed(
						sessionKey,
						served.path,
						served.rows,
						HASH_SPACE,
					);
				}

				if (sections.length === 0) {
					return `No matches for "${params.pattern}" in ${params.path}.`;
				}
				return sections.join("\n\n");
			});
		},
	});
}

export function registerGrepTool(
	_rootCtx: Context,
	agentCtx: Context,
	io: FileIO,
): () => void {
	return agentCtx.tools.register(buildGrepTool(io));
}