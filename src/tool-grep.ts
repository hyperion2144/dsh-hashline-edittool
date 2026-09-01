/**
 * The dsh `grep` tool: hash-anchored substring / regex search that shadows
 * the built-in `grep` on the agent's own scope layer. Output mirrors the
 * `read` tool: every match row is `<line>#<hash>│content` under a
 * `ANCHOR:FILELINE` header, one section per file. Matches are
 * recorded as served so a follow-up `edit` against a hit does not require a
 * separate `read`.
 *
 * Structured presentation: the canonical value carries `files` (per-file
 * grouped matches) / `truncated` / `total`. `output.render` projects the
 * model text from those fields. `output.presentationMeta` derives the
 * `SearchMatchesResultView` projection. `presentResult` reads the
 * persisted meta and emits a `card: 'search' shape: 'matches'` view.
 * `grep` has NO `presentCall` — per the dsh-tools spec, a search has no
 * `card: 'search'` call-time analogue because the pending state has no
 * matches or paths to show.
 * @module dsh-hashline-edittool/tool-grep
 */

import { readdir, lstat } from "node:fs/promises";
import { lineNumbersSchema } from "./contract.js";
import { minimatch } from "minimatch";
import { basename, join, relative } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

import type { FileIO } from "./fs-bridge.js";
import { execCwd, execSessionKey, recordServed } from "./session-view.js";
import { isJsonOutput, getEffectiveConfig } from "./config.js";
import { withWorkspace } from "./session-view.js";
import { lineHashes, LINE_HASH_SEP } from "./hashline/index.js";
import { hashlineHeader, contextLinesCfg } from "./hashline/hash-assign.js";
import { fmtHashlineRow, anchorWidth } from "./hashline/hash-assign.js";
import { visLines, abortIf, clipLine } from "./utils.js";
import { grepDescription } from "./prompts.js";
import {
	grepPresentationFromMeta,
	type GrepFileMatches,
} from "./presentation-helpers.js";

/** One row in a grep section's context set (with hash + content, used to render the model text). */
export interface GrepSectionRow {
	position: number;
anchor: string;
	content: string;
}

export interface GrepFileSection {
	path: string;
	matches: GrepSectionRow[];
	/** Context rows around each match (always includes the match position too). */
	contextRows: GrepSectionRow[];
}

export interface GrepToolOptions {
	/** Cap on matches per file. Default 100. */
	limit?: number;
	/** Number of context rows above and below each match. Default 0. */
	context?: number;
	/** If true, `pattern` is treated as a JavaScript regex. Default false. */
	regex?: boolean;
	/** v2.0: prefix every context/match row marker with `<line>:<anchor>`. */
	lineNumbers?: boolean;
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
const contextRows: GrepSectionRow[] = [...contextSet]
		.sort((a, b) => a - b)
		.map((position) => ({
			position,
			anchor: hashes[position]!,
			content: lines[position]!,
		}));
	return {
		path,
matches: matchPositions.map((position) => ({
			position,
			anchor: hashes[position]!,
			content: lines[position]!,
		})),
		contextRows,
	};
}

function renderSection(path: string, section: GrepFileSection, lineNumbers = false): string {
	const headerLines: string[] = [`--- ${path} ---`, hashlineHeader()];
	const anchors = section.contextRows.map((row) =>
		lineNumbers ? `${row.position + 1}:${row.anchor}` : row.anchor,
	);
	const width = anchorWidth(anchors);
	for (const [i, row] of section.contextRows.entries()) {
		headerLines.push(fmtHashlineRow("", anchors[i]!, clipLine(row.content), width));
	}
	return headerLines.join("\n");
}

/** Build the model-facing text for one file section (reused by `render`). */
function buildSectionModelText(
	path: string,
	section: GrepFileSection,
	lineNumbers = false,
): string {
	return renderSection(path, section, lineNumbers);
}

interface GrepCanonicalValue {
	files: GrepFileMatches[];
	truncated: boolean;
	total: number;
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
		description: grepDescription(getEffectiveConfig()),
		parameters: {
			path: {
				type: "string",
				description:
					"File or directory to search. Optional — defaults to the session workspace (cwd). Directories recurse the whole tree (hidden entries and node_modules skipped).",
			},
			include: {
				type: "string",
				description:
					"Optional single positive glob filter — e.g. \"*.ts\" (basenames at any depth) or \"src/**/*.test.js\". Negated (!) patterns are rejected.",
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
		line_numbers: {
			...lineNumbersSchema,
		},
	},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					files: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								matches: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											lineNumber: { type: "integer", required: true },
											line: { type: "string", required: true },
										},
									},
								},
							},
						},
					},
					truncated: { type: "boolean", required: true },
					total: { type: "integer", required: true },
					modelText: { type: "string" },
				},
			},
			render: (_args, value) => [
				{
					type: "text",
					text: (value as GrepCanonicalValue & { modelText: string }).modelText,
				},
			],
			presentationMeta: (_args, value) => {
				const v = value as GrepCanonicalValue;
				return {
					files: v.files,
					truncated: v.truncated,
					total: v.total,
				} as never;
			},
		},
		// grep has no presentCall — per the dsh-tools spec, a search has no
		// `card: 'search'` call-time analogue because the pending state has no
		// matches or paths to show. The pending card stays generic with
		// `kind: 'search'`.
		presentResult: (_args, result) => {
			if (result.isError) return undefined;
			const meta = grepPresentationFromMeta(result.meta);
			if (meta === undefined) return undefined;
			return {
				card: "search",
				shape: "matches",
				files: meta.files,
				truncated: meta.truncated,
				total: meta.total,
			};
		},
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;

				const params = args as Record<string, unknown>;
				// `path` is optional — it defaults to the session workspace (cwd),
				// matching the host grep. Directories recurse the whole tree.
				if (
					params.path !== undefined &&
					(typeof params.path !== "string" || params.path.length === 0)
				) {
					throw new Error('[E_BAD_SHAPE] Grep request "path" must be a non-empty string when given.');
				}
				let includeGlob: string | undefined;
				if (params.include !== undefined) {
					if (typeof params.include !== "string" || params.include.trim().length === 0) {
						throw new Error('[E_BAD_SHAPE] Grep request "include" must be a non-empty glob when given.');
					}
					if (params.include.startsWith("!")) {
						throw new Error('[E_BAD_SHAPE] Grep request "include" must be a positive glob filter; negated patterns ("!…") are not supported.');
					}
					includeGlob = params.include;
				}
				if (typeof params.pattern !== "string") {
					throw new Error('[E_BAD_SHAPE] Grep request requires a "pattern" string.');
				}
				const opts: GrepToolOptions = {
					limit: typeof params.limit === "number" ? params.limit : undefined,
					context: typeof params.context === "number" ? params.context : undefined,
					regex: params.regex === true,
					lineNumbers: params.line_numbers === true,
				};
				// Pre-build matcher so a bad regex fails before any IO.
				buildMatcher(params.pattern, opts.regex === true);

				const root = await io.resolve(params.path ?? ".", cwd, signal);
				abortIf(signal);
				const rootStat = await lstat(root);
				let files: string[];
				if (rootStat.isFile()) {
					files = [root];
				} else if (rootStat.isDirectory()) {
					files = await gatherFiles(root, opts, signal);
				} else {
					throw new Error(
						`[E_NOT_TEXT] Path is neither file nor directory: ${params.path}`,
					);
				}
				if (includeGlob !== undefined) {
					const relOf = (p: string) => relative(root, p);
					files = files.filter((p) => matchInclude(includeGlob!, relOf(p)));
				}

				const fileSections: string[] = [];
				const cardFiles: GrepFileMatches[] = [];
				const jsonOutput = isJsonOutput();
				const jsonFiles: Array<{
					path: string;
					matches: Record<string, string>;
				}> = [];
const allServed: Array<{ path: string; rows: { position: number; anchor: string }[] }> = [];
				const allSeen: Array<{ path: string }> = [];
				let totalMatches = 0;
				let truncated = false;
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
					// Truncation = the per-file cap was hit.
					truncated = truncated || section.matches.length >= (opts.limit ?? DEFAULT_LIMIT);
					totalMatches += section.matches.length;
					// The model-facing path is the relative path the user passed in,
					// derived from `file` (absolute) by stripping the directory part.
					// Show the path relative to the searched root (host-aligned):
					// src/deep.txt under a directory root; the bare basename when
					// the root IS the file.
					const displayPath = relative(root, file) || basename(file);
					fileSections.push(buildSectionModelText(displayPath, section, opts.lineNumbers));
					cardFiles.push({
						path: displayPath,
						matches: section.contextRows.map((row) => ({
							lineNumber: row.position + 1,
							// The card's `line` is the pre-rendered `<line>:<anchor>:content` row.
							line: renderSection(displayPath, section, opts.lineNumbers)
								.split("\n")
								.slice(2)
								.join("\n"),
						})),
					});
					if (jsonOutput) {
						// matches is ONE anchor-keyed dict like read's lines: match
						// rows and their context rows live together, key = line:anchor,
						// value = verbatim content (no separate before/after fields).
						const context = opts.context ?? contextLinesCfg();
						const matches: Record<string, string> = {};
						const rowsByPos = new Map<number, GrepSectionRow>(
							section.contextRows.map((r) => [r.position, r]),
						);
						const anchorAt = (pos: number) =>
							opts.lineNumbers
								? `${pos + 1}:${rowsByPos.get(pos)?.anchor ?? hashes[pos] ?? ""}`
								: (rowsByPos.get(pos)?.anchor ?? hashes[pos] ?? "");
						for (const m of section.matches) {
							matches[m.anchor ?? anchorAt(m.position)] =
								rowsByPos.get(m.position)?.content ?? linesOf(raw)[m.position] ?? "";
							for (let k = Math.max(0, m.position - context); k <= Math.min(linesOf(raw).length - 1, m.position + context); k++) {
								if (k === m.position) continue;
								matches[anchorAt(k)] = rowsByPos.get(k)?.content ?? linesOf(raw)[k] ?? "";
							}
						}
						jsonFiles.push({ path: displayPath, matches });
					}
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
served.rows.map((r) => ({ position: r.position, anchor: r.anchor })),
						62 ** 4, // anchor pool bound (v2.0; legacy HASH_SPACE removed)
					);
				}

				if (fileSections.length === 0) {
					const noMatchModelText = `No matches for "${params.pattern}" in ${params.path}.`;
					return {
						files: [],
						truncated: false,
						total: 0,
						modelText: noMatchModelText,
					} satisfies GrepCanonicalValue & { modelText: string };
				}

				const value: GrepCanonicalValue & { modelText: string } = {
					files: cardFiles,
					truncated,
					total: totalMatches,
					modelText: jsonOutput
						? JSON.stringify({ total: totalMatches, truncated, files: jsonFiles })
						: fileSections.join("\n\n"),
				};
				return value;
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


/** Split content for json context lookup (mirrors splitLines semantics). */
function linesOf(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}


/** Recursive file gather: whole tree, skipping hidden entries and node_modules. */
async function gatherFiles(
	root: string,
	_opts: unknown,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		abortIf(signal);
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue; // unreadable dir — skip silently
		}
		for (const name of entries) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const p = join(dir, name);
			let st;
			try {
				st = await lstat(p);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) continue; // no symlink recursion (loop-safe)
			if (st.isDirectory()) {
				stack.push(p);
			} else if (st.isFile()) {
				out.push(p);
			}
		}
	}
	return out;
}

/**
 * Host-style include glob: a pattern without "/" matches the basename at ANY
 * depth (like ripgrep --glob); with "/" it matches the root-relative path.
 */
function matchInclude(pattern: string, relPath: string): boolean {
	const bare = pattern.split("/").every((seg) => !seg.includes("*") && !seg.includes("?"));
	void bare;
	if (!pattern.includes("/")) {
		const name = relPath.split("/").pop() ?? relPath;
		return minimatch(name, pattern, { dot: true });
	}
	return minimatch(relPath, pattern, { dot: true });
}

