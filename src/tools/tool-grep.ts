/**
 * The dsh `grep` tool: hash-anchored substring / regex search that shadows
 * the built-in `grep` on the agent's own scope layer. Output mirrors the
 * `read` tool: every match row is `<line>#<hash>│content` under a
 * `ANCHOR:FILELINE` header, one section per file. Matches are
 * recorded as served, so a follow-up `edit` against a hit does not require a
 * separate `read` — EXCEPT for a file the backend refused as text (#268):
 * `readTextTolerant` still searches it, but its rows are unserved
 * (`[line N] content`), because `edit` reads through `readText` and would
 * refuse the very same file.
 *
 * ADR-0013: the scan runs to completion — nothing is refused by size. The
 * response carries whole sections up to the per-response char budget; rows
 * beyond it spill to a session file and the response carries a resume token
 * (`grep {resume}`). Resumed rows allocate/reuse anchors at serve time
 * (ADR-0009), against the live file when its version stamp still matches,
 * otherwise as caution-flagged snapshot text.
 *
 * Structured presentation: the canonical value carries `files` / `truncated` /
 * `total`. `output.render` projects the model text from those fields.
 * `output.presentationMeta` derives the search-card projection.
 * @module dsh-hashline-edittool/tool-grep
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readdir, lstat } from "node:fs/promises";
import { assertNoRetiredLineNumbers } from "../contract/contract.js";
import { MAX_READ_LINE_BYTES } from "../infra/constants.js";
import { formatSize } from "../domain/session/file-view.js";
import { minimatch } from "minimatch";
import { basename, join, relative } from "node:path";
import type { Context as CordisContext } from "@deepseek-ai/cordis";

import type { FileIO } from "../infra/fs-bridge.js";
import { execCwd, execSessionKey, recordServed, openWorkspaceStore } from "../domain/session/session-view.js";
import { isJsonOutput, getEffectiveConfig, lineNumbersEnabled } from "../config.js";
import {
	codeUnits,
	createResume,
	formatOmittedNotice,
	loadResume,
	readSpillRows,
	advanceResume,
	responseBudgetChars,
	stampChanged,
	type SegmentRow,
	type ResumeSidecar,
	takeRowsWithinBudget,
} from "../infra/response-stream.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { withWorkspace, anchorForInWorkspace } from "../domain/session/session-view.js";
import { splitLines, visLines, abortIf } from "../infra/utils.js";
import { gatherFiles, matchInclude } from "../infra/file-scan.js";
import { rgFiles, rgFilesWithMatches } from "./grep-rg.js";
import { toLF } from "../render/edit-diff.js";
import { grepDescription } from "../domain/edit/prompts.js";
import {
	capGrepMeta,
	grepPresentationFromMeta,
	matchSpans,
	type GrepFileRows,
	type MatchSpan,
} from "../render/grep-card.js";
import { fmtMarker, hashlineHeader, contextLinesCfg, hashSep, canon, contentChecksum, fmtHashlineRow, anchorWidth } from "../hashline/hash-assign.js";

/**
 * One row in a grep section's context set (hash + content, used to render the
 * model text) plus the card facts: whether the capped match list contains it,
 * and the highlight spans of every pattern occurrence in the line.
 */
export interface GrepSectionRow {
	position: number;
	content: string;
	isMatch: boolean;
	/** Highlight spans for this line (empty when nothing is markable). */
	spans: MatchSpan[];
	/** Pointer rows: content replaced by a bash pointer (over budget per #205). */
	pointer?: true;
}

export interface GrepFileSection {
	path: string;
	/** Absolute path of the section's file (for anchor allocation). */
	absolutePath: string;
	/** Total lines of the section's file (for recordServed). */
	lineCount: number;
	matches: GrepSectionRow[];
	contextRows: GrepSectionRow[];
}

export interface GrepToolOptions {
	/** Cap on matches per file. Default 100. */
	limit?: number;
	/** Number of context rows above and below each match. Default 0. */
	context?: number;
	/** If true, `pattern` is treated as a JavaScript regex. Default TRUE (v2.0.2). */
	regex?: boolean;
}

const DEFAULT_LIMIT = 100;

/**
 * Pure helper: extract rows from one file's content given a matcher.
 * `content` must already be in the read line space (toLF — issue #147).
 * ADR-0013: allocation is the CALLER's job — only rows actually returned to
 * the model get anchors (persisted == served == visible).
 */
export async function grepFileContent(
	path: string,
	content: string,
	pattern: string,
	opts: GrepToolOptions = {},
): Promise<GrepFileSection | undefined> {
	const matcher = buildMatcher(pattern, opts.regex !== false);
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
	const matchSet = new Set(matchPositions);
	const rows: GrepSectionRow[] = [...contextSet]
		.sort((a, b) => a - b)
		.map((position) => ({
			position,
			content: lines[position]!,
			isMatch: matchSet.has(position),
			spans: matchSpans(lines[position]!, pattern, opts.regex !== false),
		}));
	return {
		path,
		absolutePath: path,
		lineCount: lines.length,
		matches: rows.filter((row) => matchSet.has(row.position)),
		contextRows: rows,
	};
}

/** Render one section: rows with anchors where available, pointer for oversize. */
function renderSection(
	path: string,
	rows: GrepSectionRow[],
	anchorsByPosition: Map<number, string>,
	lineNumbers: boolean,
	includeFormatHeader: boolean,
): string {
	const headerLines: string[] = [`--- ${path} ---`];
	if (includeFormatHeader) headerLines.push(hashlineHeader(lineNumbers));
	const markers = rows.map((row) => {
		const anchor = anchorsByPosition.get(row.position) ?? "";
		return anchor !== "" ? fmtMarker(anchor, row.position + 1, lineNumbers) : `[line ${row.position + 1}] `;
	});
	const width = anchorWidth(markers);
	for (const [i, row] of rows.entries()) {
		const marker = markers[i]!;
		const rendered = anchorsByPosition.has(row.position)
			? fmtHashlineRow(marker, row.content, width)
			: `[line ${row.position + 1}] ${row.content}`;
		const rowBytes = Buffer.byteLength(rendered, "utf-8");
		if (rowBytes > MAX_READ_LINE_BYTES) {
			headerLines.push(
				`[Line ${row.position + 1} is ${formatSize(rowBytes)}, exceeds ${formatSize(MAX_READ_LINE_BYTES)}; content not shown. Use bash: sed -n '${row.position + 1}p' ${path} | head -c ${MAX_READ_LINE_BYTES}]`,
			);
			continue;
		}
		headerLines.push(rendered);
	}
	return headerLines.join("\n");
}

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

interface GrepCanonicalValue {
	files: GrepFileRows[];
	truncated: boolean;
	total: number;
	continuation?: { resume: string; remaining: number };
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
					"File or directory to search. Optional — defaults to the session workspace (cwd). Directories recurse using ripgrep's file list, so `.gitignore`d trees are skipped as well as hidden entries and node_modules (see the `grep_respect_gitignore` setting).",
			},
			include: {
				type: "string",
				description:
					"Optional single positive glob filter — e.g. \"*.ts\" (basenames at any depth) or \"src/**/*.test.js\". Negated (!) patterns are rejected.",
			},
			pattern: {
				type: "string",
				description: "Pattern to match; treated as a JavaScript-flavre regex by default. Pass `regex: false` for literal substring matching.",
			},
			regex: {
				type: "boolean",
				description: "Treat `pattern` as a JavaScript-flavre regex (default true). Pass `regex: false` for literal substring matching.",
			},
			context: {
				type: "number",
				description: "Number of context rows above and below each match (default 0).",
			},
			limit: {
				type: "number",
				description: "Cap on matches per file (default 100).",
			},
			resume: {
				type: "string",
				description: "Continuation token from a previous truncated scan; returns the next segment of matches.",
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
											spans: {
												type: "array",
												items: {
													type: "array",
													items: { type: "integer" },
												},
											},
										},
									},
								},
							},
						},
					},
					truncated: { type: "boolean", required: true },
					total: { type: "integer", required: true },
					continuation: {
						type: "object",
						additionalProperties: false,
						properties: {
							resume: { type: "string", required: true },
							remaining: { type: "integer", required: true },
						},
					},
					modelText: { type: "string" },
					error: errorFieldSchema,
				},
			},
			render: (_args, value) => [
				{ type: "text", text: (value as GrepCanonicalValue & { modelText: string }).modelText },
			],
			presentationMeta: (_args, value) => {
				const v = value as GrepCanonicalValue & { error?: ErrorMeta };
				if (v.error !== undefined) return { error: v.error } as never;
				// The card projection is byte-budgeted independently of the model text:
				// dropping trailing file groups never changes what the model was told.
				return capGrepMeta({
					files: v.files,
					truncated: v.truncated,
					total: v.total,
				}) as never;
			},
		},
		// grep has no presentCall — per the dsh-tools spec, a search has no
		// `card: 'search'` call-time analogue because the pending state has no
		// matches or paths to show.
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
		async execute(args, exec) {
			return withWorkspace(execCwd(exec), async () => {
				const cwd = execCwd(exec);
				const sessionKey = execSessionKey(exec);
				const signal = exec.signal;
				const budget = responseBudgetChars();

				// ADR-0013: a scan continuation serves the next budget of spilled
				// rows. Unchanged files re-read live and allocate/serve anchors at
				// this point (ADR-0009); changed files serve the snapshot as caution-
				// flagged plain rows (never allocate against drifted content).
				if (typeof (args as Record<string, unknown>).resume === "string") {
					const token = (args as Record<string, unknown>).resume as string;
					const sidecar = await loadResume(sessionKey, token, "grep");
					const remaining = await readSpillRows(sidecar, sidecar.total - sidecar.cursor);
					const take = takeRowsWithinBudget(remaining, budget, (row) => row.content.length + 24);
					const servedParts: string[] = [];
					const cardFiles: GrepFileRows[] = [];
					const cautions: string[] = [];
					let servedCount = 0;
					// group by path, preserving order
					const groups: Array<{ path: string; rows: SegmentRow[] }> = [];
					for (const row of take.included) {
						const last = groups[groups.length - 1];
						if (last !== undefined && last.path === row.path) last.rows.push(row);
						else groups.push({ path: row.path ?? "", rows: [row] });
					}
					for (const group of groups) {
						const stamp = sidecar.stamps.find((s) => s.path === group.path);
						const current = await io.statVersion(group.path, signal).catch(() => undefined);
						let changed = stampChanged(
							stamp,
							current !== undefined ? { version: current } : undefined,
						);
						let content: string | undefined;
						let binary = false;
						if (!changed) {
							try {
								const tolerant = await io.readTextTolerant(group.path, signal);
								content = tolerant.text;
								binary = tolerant.binary;
							} catch {
								changed = true;
							}
						}
						if (changed) {
							cautions.push(
								`[Caution: ${group.path} changed since this excerpt was captured. Lines below are from the earlier snapshot; anchors may not match the current file — re-read before editing.]`,
							);
						}
						const rowsOut: GrepFileRows["rows"] = [];
						const normalized = content === undefined ? undefined : toLF(content);
						const lineCount = normalized === undefined ? 0 : splitLines(normalized).length;
						const positions = group.rows.map((row) => row.line ?? 0);
						// #223: one call mints the anchors AND records them as served, in one
						// transaction. This used to be `allocateForLines` here plus a
						// `recordServed` further down, so a failure between them served rows
						// that no session had "seen".
						const allocated =
							!changed && !binary && normalized !== undefined
								? await anchorForInWorkspace({
										cwd,
										absolutePath: group.path,
										content: normalized,
										lines: positions,
										sessionKey,
									})
								: [];
						const servedRows: Array<{ position: number; anchor: string; key: string | null }> = [];
						group.rows.forEach((row, index) => {
							const anchor = allocated[index] ?? "";
							const line = row.line ?? 0;
							if (anchor !== "") {
								rowsOut.push({ number: line, hash: anchor, text: row.content, ...(row.kind !== "ctx" ? { match: true as const } : {}) });
								servedRows.push({ position: line - 1, anchor, key: contentChecksum(canon(row.content)) });
							} else {
								rowsOut.push({ number: line, hash: "", text: row.content });
							}
						});
						// Already served: `anchorForInWorkspace` recorded these anchors in
						// the same transaction that minted them. A second `recordServed` here
						// would be re-writing the same fact (and swallowing its own errors).
						servedParts.push(`--- ${group.path} ---`);
						for (const row of rowsOut) {
							servedParts.push(
								row.hash !== ""
									? `${fmtMarker(row.hash, row.number)}${hashSep()}${row.text}`
									: `[line ${row.number}] ${row.text}`,
							);
						}
						cardFiles.push({ path: group.path, rows: rowsOut });
						servedCount += group.rows.length;
					}
					const overflow = take.overflow;
					let continuation: { resume: string; remaining: number } | undefined;
					const parts = [...cautions, ...servedParts];
					if (overflow.length > 0) {
						const next = await createResume({
							sessionKey,
							producer: "grep",
							consumer: "grep",
							kind: "scan-continuation",
							rows: overflow,
							stamps: sidecar.stamps,
						});
						continuation = { resume: next.token, remaining: overflow.length };
						parts.push(
							formatOmittedNotice({
								omittedLines: overflow.length,
								omittedChars: overflow.reduce((a, r) => a + codeUnits(r.content), 0),
								consumer: "grep",
								token: next.token,
							}),
						);
					}
					const modelText = parts.join("\n");
					return {
						files: cardFiles,
						truncated: overflow.length > 0,
						total: servedCount,
						...(continuation !== undefined ? { continuation } : {}),
						modelText,
					} satisfies GrepCanonicalValue & { modelText: string };
				}

				await openWorkspaceStore(cwd);
				const signal2 = signal;

				const params = args as Record<string, unknown>;
				assertNoRetiredLineNumbers(params, "Grep request");
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
				const opts = {
					limit: typeof params.limit === "number" ? params.limit : undefined,
					context: typeof params.context === "number" ? params.context : contextLinesCfg(),
					regex: params.regex !== false,
				};
				// Pre-build matcher so a bad regex fails before any IO.
				buildMatcher(params.pattern, opts.regex);

				const root = await io.resolve(params.path ?? ".", cwd, signal2);
				abortIf(signal2);
				const rootStat = await lstat(root);
				let files: string[];
				if (rootStat.isFile()) {
					files = [root];
				} else if (rootStat.isDirectory()) {
					const listed = getEffectiveConfig().grepRespectGitignore
						? await rgFiles(root, signal2)
						: undefined;
					files = listed ?? (await gatherFiles(root, opts, signal2));
				} else {
					throw new Error(`[E_NOT_TEXT] Path is neither file nor directory: ${params.path}`);
				}
				if (includeGlob !== undefined) {
					const relOf = (p: string) => relative(root, p);
					files = files.filter((p) => matchInclude(includeGlob!, relOf(p)));
				}
				// ripgrep pre-filter (#183): only files WITH a match go on to the read
				// and anchor stage. Any rg failure returns undefined and the full list
				// is kept (JS engine, as always).
				if (files.length > 1) {
					const narrow = await rgFilesWithMatches(
						opts.regex === false ? `-F${params.pattern}` : params.pattern,
						files,
					);
					if (narrow !== undefined) {
						files = narrow;
					}
				}

				const fileSections: string[] = [];
				const cardFiles: GrepFileRows[] = [];
				const jsonOutput = isJsonOutput();
				const jsonFiles: Array<{ path: string; matches: Record<string, string> }> = [];
				const spillRows: SegmentRow[] = [];
				const spillStamps: ResumeSidecar["stamps"] = [];
				const spillStampPaths = new Set<string>();
				let totalMatches = 0;
				let truncated = false;
				let usedChars = 0;
				let spilling = false;
				let headerEmitted = false;

				// ADR-0013: the scan runs to COMPLETION — nothing is refused by size.
				// Sections fitting the per-response budget are returned (allocated +
				// served here); everything past the budget spills as unallocated rows
				// and is served at resume time.
				for (const file of files) {
					abortIf(signal2);
					let raw: string;
					let binary = false;
					try {
						// #268: `readTextTolerant` is `readText` first — every text file is read
						// exactly as before — and falls back to the backend's raw bytes only when
						// it was refused as text. A NUL byte in a log no longer answers "No
						// matches" for content `rg -a` finds.
						const tolerant = await io.readTextTolerant(file, signal2);
						raw = tolerant.text;
						binary = tolerant.binary;
					} catch {
						// An abort is never "this file is unreadable": ask the signal itself.
						abortIf(signal2);
						continue; // unreadable file — skipped, never a refusal
					}
					const text = toLF(raw);
					const section = await grepFileContent(file, text, params.pattern, opts);
					if (section === undefined) continue;
				// #205 Q5: a single row over the budget is pointer-ized and the segment
				// keeps assembling — one pathological line never destroys a section.
				for (const row of section.contextRows) {
					if (codeUnits(row.content) + 24 > budget) {
						row.content = `[Line ${row.position + 1} is ~${codeUnits(row.content)} chars, exceeds the ${budget}-char per-response budget; content not shown. Use bash: sed -n '${row.position + 1}p' ${file} | head -c ${budget}]`;
						row.pointer = true;
					}
				}
					const displayPath = relative(root, file) || basename(file);
					totalMatches += section.matches.length;
					truncated = truncated || section.matches.length >= (opts.limit ?? DEFAULT_LIMIT);
					const sectionChars =
						codeUnits(section.contextRows.map((row) => row.content).join("\n")) + 24 * (section.contextRows.length + 1);
					if (!spilling && usedChars + sectionChars <= budget) {
						const positions = section.contextRows.map((row) => row.position + 1);
						// #223: same single entry point as the section branch above.
						// A file the backend refused as text is not editable either (#268):
						// `edit` reads through `readText`, so an anchor minted here could never be
						// used. Its rows stay unserved — `[line N] content` — which is the honest
						// shape for "found, but not editable".
						const allocated = binary
							? []
							: await anchorForInWorkspace({
									cwd,
									absolutePath: file,
									content: text,
									lines: positions,
									sessionKey,
								});
						const anchorsByPosition = new Map<number, string>();
						const servedRows: Array<{ position: number; anchor: string; key: string | null }> = [];
						section.contextRows.forEach((row, index) => {
						if (row.pointer) return;
							const anchor = allocated[index] ?? "";
							anchorsByPosition.set(row.position, anchor);
							if (anchor !== "") {
								servedRows.push({
									position: row.position,
									anchor,
									key: contentChecksum(canon(row.content)),
								});
							}
						});
						// Served by the mint above; only the OBSERVATION is left.
						if (servedRows.length > 0 && exec !== undefined) {
							await io.emitObserved(file, exec, signal2).catch(() => undefined);
						}
						fileSections.push(
							renderSection(displayPath, section.contextRows, anchorsByPosition, lineNumbersEnabled(), !headerEmitted),
						);
						headerEmitted = true;
						cardFiles.push({
							path: displayPath,
							rows: section.contextRows.map((row) => ({
								number: row.position + 1,
								hash: anchorsByPosition.get(row.position) ?? "",
								text: row.content,
								...(row.isMatch ? { match: true as const } : {}),
								...(row.spans.length > 0 ? { spans: row.spans } : {}),
							})),
						});
						if (jsonOutput) {
							const context = opts.context ?? contextLinesCfg();
							const matches: Record<string, string> = {};
							const anchorsByPos = anchorsByPosition;
							// #259: the KEY is the marker, so it is spelled by the ONE formula —
							// hand-built here, this site leaked a line number with the switch OFF.
							// A row that could not be anchored keeps its bare line number: then
							// that number is the only handle there is.
							const keyOf = (position: number): string => {
								const anchor = anchorsByPos.get(position) ?? "";
								return anchor === "" ? `${position + 1}` : fmtMarker(anchor, position + 1);
							};
							for (const match of section.matches) {
								matches[keyOf(match.position)] = rowContent(section, match.position);
								for (let k = Math.max(0, match.position - context); k <= Math.min(section.lineCount - 1, match.position + context); k++) {
									if (k === match.position) continue;
									matches[keyOf(k)] = rowContent(section, k);
								}
							}
							jsonFiles.push({ path: displayPath, matches });
						}
						usedChars += sectionChars;
					} else {
						spilling = true;
						if (!spillStampPaths.has(file)) {
							spillStampPaths.add(file);
							const version = await io.statVersion(file, signal2).catch(() => undefined);
							spillStamps.push({ path: file, version });
						}
						for (const row of section.contextRows) {
							spillRows.push({ content: row.content, path: file, line: row.position + 1, kind: row.isMatch ? "row" : "ctx" });
						}
					}
				}
				function rowContent(section: { contextRows: Array<{ position: number; content: string }> }, position: number): string {
					return section.contextRows.find((row) => row.position === position)?.content ?? "";
				}

				let continuation: { resume: string; remaining: number } | undefined;
				let noticeText = "";
				if (spillRows.length > 0) {
					const { token } = await createResume({
						sessionKey,
						producer: "grep",
						consumer: "grep",
						kind: "scan-continuation",
						rows: spillRows,
						stamps: spillStamps,
					});
					const omittedChars = spillRows.reduce((acc, row) => acc + codeUnits(row.content), 0);
					continuation = { resume: token, remaining: spillRows.length };
					noticeText = formatOmittedNotice({
						omittedLines: spillRows.length,
						omittedChars,
						consumer: "grep",
						token,
					});
				}

				if (fileSections.length === 0 && spillRows.length === 0) {
					const noMatchModelText = jsonOutput
						? JSON.stringify({ total: 0, truncated: false, files: [] })
						: `No matches for "${params.pattern}" in ${root}.`;
					return {
						files: [],
						truncated: false,
						total: 0,
						modelText: noMatchModelText,
					} satisfies GrepCanonicalValue & { modelText: string };
				}
				if (fileSections.length === 0) {
					// everything spilled: the response is the continuation notice alone
					return {
						files: [],
						truncated: true,
						total: totalMatches,
						...(continuation !== undefined ? { continuation } : {}),
						modelText: jsonOutput
							? JSON.stringify({ total: totalMatches, truncated: true, files: [], ...(continuation !== undefined ? { continuation } : {}) }) + (noticeText === "" ? "" : `\n${noticeText}`)
							: `Matches exist but exceed the per-response budget.\n${noticeText}`,
					} satisfies GrepCanonicalValue & { modelText: string };
				}

				const value: GrepCanonicalValue & { modelText: string } = {
					files: cardFiles,
 				truncated: truncated || spillRows.length > 0,
					total: totalMatches,
					...(continuation !== undefined ? { continuation } : {}),
					modelText: jsonOutput
						? JSON.stringify({ total: totalMatches, truncated: truncated || spillRows.length > 0, files: jsonFiles, ...(continuation !== undefined ? { continuation } : {}) }) + (noticeText === "" ? "" : `\n${noticeText}`)
						: `${fileSections.join("\n\n")}${noticeText === "" ? "" : `\n${noticeText}`}`,
				};
				return value;
		}).catch((error: unknown) => ({
			files: [],
			truncated: false,
			total: 0,
			...(thrownErrorResult(error, { path: pathFromArgs(args) }) as unknown as Record<string, unknown>),
		}) as never);
		},
	});
}

export function registerGrepTool(
	_rootCtx: CordisContext,
	agentCtx: CordisContext,
	io: FileIO,
): () => void {
	return agentCtx.tools.register(buildGrepTool(io));
}
