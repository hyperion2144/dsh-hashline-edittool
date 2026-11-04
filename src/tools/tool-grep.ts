/**
 * The dsh `grep` tool: hash-anchored substring / regex search that shadows
 * the built-in `grep` on the agent's own scope layer. Output mirrors the
 * `read` tool: every match row is `<line>#<hash>│content` under a
 * `ANCHOR:FILELINE` header, one section per file. Matches are
 * recorded as served, so a follow-up `edit` against a hit does not require a
 * separate `read` — EXCEPT for a lossy file (#273): its text carries U+FFFD
 * stand-ins for undecodable bytes, so its rows stay unserved (`[line N]
 * content`) — an anchor served against stand-in text could never verify the
 * edit's write-back. A lossless refusal (valid UTF-8 the backend declined
 * for its NUL heuristic) serves normally.
 *
 * ADR-0013: the scan runs to completion — nothing is refused by size. The
 * response carries whole sections up to the per-response char budget; rows
 * beyond it spill to a session file and the response carries a resume token
 * (`grep {resume}`). Resumed rows allocate/reuse anchors at serve time
 * (ADR-0009), against the live file when its version stamp still matches,
 * otherwise as caution-flagged snapshot text.
 *
 * ripgrep is the ENGINE here (#384), not a pre-filter: one `rg --json` search
 * produces the matches (file, line number), and only the files that actually
 * match are read for the served text. The pattern reaches ripgrep as ONE
 * `--regexp=` argument — a literal pattern as `--fixed-strings` — so it can
 * never be mangled on the way in: the old pre-filter glued `-F` onto the
 * pattern text, so every literal search looked for "-F<pattern>" and answered
 * "No matches" for hits and misses alike. The plugin's own line matcher
 * survives only as the DEGRADED path — for the one case ripgrep cannot run
 * at all: a missing binary, or a run that failed. A pattern ripgrep's own
 * engine REJECTS is a bad pattern (E_BAD_SHAPE, like the official grep
 * tool's SEARCH_INVALID_PATTERN) — never another engine's opinion.
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
import { basename, join, relative, resolve } from "node:path";
import type { Context as CordisContext } from "@deepseek-ai/cordis";

import type { FileIO } from "../infra/fs-bridge.js";
import { execSessionKey, recordServed, openWorkspaceStore } from "../domain/session/session-view.js";
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
	takeRowsStrictlyWithinBudget,
} from "../infra/response-stream.js";
import { errorFieldSchema, pathFromArgs, thrownErrorResult, type ErrorMeta } from "../infra/error-result.js";
import { anchorForInWorkspace, anchorForRowsInWorkspace } from "../domain/session/session-view.js";
import { withLiveWorkspace } from "../domain/session/live-cwd.js";
import { splitLines, visLines, abortIf } from "../infra/utils.js";
import { gatherFiles, matchInclude } from "../infra/file-scan.js";
import { runGrep } from "./grep-rg.js";
import { readFileIdentity } from "../infra/file-identity.js";
import {
	DEFAULT_LIMIT,
	sectionsFromRows,
	type GrepSectionRow,
	type GrepToolOptions,
} from "./grep-search.js";
import { toLF } from "../render/edit-diff.js";
import {
	combineTruncations,
	formatGrepStats,
	hitCountText,
	limitCutFor,
	GREP_TRUNCATIONS,
	type GrepFileHits,
	type GrepTruncation,
} from "../domain/grep/stats.js";
import { rowTitle } from "../render/wire-text.js";
import { grepDescription } from "../domain/edit/prompts.js";
import {
	capGrepMeta,
	grepPresentationFromMeta,
	type GrepFileRows,
} from "../render/grep-card.js";
import { fmtMarker, hashlineHeader, contextLinesCfg, hashSep, canon, contentChecksum, fmtHashlineRow, anchorWidth } from "../hashline/hash-assign.js";


/**
 * The per-row allowance the scan charges for a row's marker — the rendered
 * marker, its separator and the space after it. It is the SAME allowance the
 * continuation charges for a resumed row (`content + 24`), so a row costs the
 * same on either side of the cut, and the same one the #205 pointer-ization
 * measures a single row against.
 */
const ROW_MARKER_ALLOWANCE = 24;


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





interface GrepCanonicalValue {
	files: GrepFileRows[];
	truncated: boolean;
	/**
	 * The number of hits the search found — the TRUE total when it is known
	 * (#386).
	 */
	total: number;
	/**
	 * Whether `total` IS the true hit count (#386). Absent means it is: a
	 * value without the flag carries the count the search found, which is
	 * exact whenever nothing was cut.
	 */
	totalExact?: boolean;
	/**
	 * Which cut happened, when one did (#386): the per-file cap, the response
	 * budget, or both.
	 */
	truncatedBy?: GrepTruncation;
	/**
	 * The number of hit rows this response served (#386).
	 */
	served?: number;
	continuation?: { resume: string; remaining: number };
}

/**
 * The TRUE hit count of the files the search capped (#386).
 *
 * The engine stops at the per-file cap, so a file that reached the cap may
 * carry more hits than the search collected — and the search cannot say more.
 * Those files get a second, uncapped counting pass; every other file's count
 * is already exact, so the common case costs nothing.
 *
 * @param plan - the search's plan: which files reached the cap.
 * @param pattern - the pattern to count with.
 * @param regex - whether the pattern is a regular expression.
 * @param signal - the abort signal.
 * @returns the count of each capped file, keyed by the file's own path.
 */

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
				description: "Pattern to match; treated as a ripgrep regular expression by default. Pass `regex: false` for literal substring matching.",
			},
			regex: {
				type: "boolean",
				description: "Treat `pattern` as a regular expression (ripgrep syntax, default true). Pass `regex: false` for literal substring matching.",
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
					// #386: whether `total` IS the true hit count.
					totalExact: { type: "boolean" },
					// #386: which cut happened — the per-file cap, the response budget,
					// or both.
					truncatedBy: { type: "string", enum: [...GREP_TRUNCATIONS] },
					// #386: the number of hit rows this response served.
					served: { type: "integer" },
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
				return {
					...capGrepMeta({
						files: v.files,
						truncated: v.truncated,
						total: v.total,
					}),
					// issue 375: the folded row's title travels as a key + params — a
					// search names no file of its own, so the title carries no path.
					// #386: the title carries the COUNTS the call produced — how many
					// hits it found, how many it served, and which cut took the rest.
					rowTitle: rowTitle("grep", {
						hits: v.totalExact === false ? hitCountText(undefined, v.total) : v.total,
						served: v.served ?? 0,
						...(v.truncatedBy !== undefined ? { truncatedBy: v.truncatedBy } : {}),
					}),
				} as never;
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
			return withLiveWorkspace(exec, async (cwd) => {
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
					// #386: the spill carries the search's TRUE hit count and the cut that
					// happened, so the continuation answers with the same total the first
					// segment gave — the search does not restart at the segment.
					const spillMeta = sidecar.meta;
					const searchTotal = typeof spillMeta.hitTotal === "number" ? spillMeta.hitTotal : undefined;
					const searchTotalExact = spillMeta.hitTotalExact !== false;
					const searchTruncation: GrepTruncation | undefined =
						spillMeta.truncatedBy === "limit" ||
							spillMeta.truncatedBy === "budget" ||
							spillMeta.truncatedBy === "limit+budget"
							? spillMeta.truncatedBy
							: undefined;
					const searchLimit = typeof spillMeta.limit === "number" ? spillMeta.limit : DEFAULT_LIMIT;
					// The per-file hits travel with the spill, so a continuation ends
					// every one of its sections with the SAME count line the first
					// segment did (#386).
					const spillFileHits = (spillMeta.fileHits ?? {}) as Record<
						string,
						GrepFileHits
					>;
					const remaining = await readSpillRows(sidecar, sidecar.total - sidecar.cursor);
					const take = takeRowsWithinBudget(remaining, budget, (row) => codeUnits(row.content) + ROW_MARKER_ALLOWANCE);
					const overflow = take.overflow;
					const servedParts: string[] = [];
					const cardFiles: GrepFileRows[] = [];
					const cautions: string[] = [];
					let servedCount = 0;
					// The HIT rows this segment served (context rows are chrome).
					let servedHits = 0;
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
						let lossy = false;
						if (!changed) {
							try {
								const tolerant = await io.readTextTolerant(group.path, signal);
								content = tolerant.text;
								lossy = tolerant.fidelity === "lossy";
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
							!changed && !lossy && normalized !== undefined
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
						// #273: the same rule on the resume path — rows this segment SHOWS must
						// be observed whether they carried anchors (live, unchanged file) or were
						// lossy/unserved. Without it a resumed hit could be edited but not
						// written, and a lossy file could be written by no path at all.
						if (!changed && (servedRows.length > 0 || lossy) && exec !== undefined) {
							await io.emitObserved(group.path, exec, signal).catch(() => undefined);
						}
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
						// #386: the section ends with its own count line, exactly as the
						// first segment's did — the file's true count, what THIS segment
						// served of it, and which cut took the rest.
						const groupHits = spillFileHits[group.path];
						const groupServed = group.rows.filter((row) => row.kind !== "ctx").length;
						if (groupHits !== undefined) {
							servedParts.push(
								formatGrepStats({
									...(groupHits.total !== undefined ? { total: groupHits.total } : {}),
									reported: groupHits.reported,
									served: groupServed,
									limitCut: limitCutFor(groupHits, searchLimit),
									budgetCut: overflow.length > 0,
									limit: searchLimit,
								}),
							);
						}
						cardFiles.push({ path: group.path, rows: rowsOut });
						servedCount += group.rows.length;
						servedHits += group.rows.filter((row) => row.kind !== "ctx").length;
					}
					let continuation: { resume: string; remaining: number } | undefined;
					const parts = [...cautions, ...servedParts];
					// #386: the continuation ends with the search's own counts.
					const resumedTruncation = combineTruncations(
						searchTruncation,
						overflow.length > 0 ? "budget" : undefined,
					);
					if (overflow.length > 0) {
						const next = await createResume({
							sessionKey,
							producer: "grep",
							consumer: "grep",
							kind: "scan-continuation",
							rows: overflow,
							stamps: sidecar.stamps,
							// #386: the search's totals travel with the spill, so the
							// continuation reports the same numbers.
							meta: {
								hitTotal: searchTotal,
								hitTotalExact: searchTotalExact,
								truncatedBy: resumedTruncation,
								limit: searchLimit,
								fileHits: spillFileHits,
							},
						});
						continuation = { resume: next.token, remaining: overflow.length };
						parts.push(
							formatOmittedNotice({
								omittedLines: overflow.length,
								omittedChars: overflow.reduce((a, r) => a + codeUnits(r.content), 0),
								consumer: "grep",
								// #386: the notice carries the search's true total.
								...(searchTotal !== undefined ? { totalMatches: searchTotal } : {}),
								token: next.token,
							}),
						);
					}
					const modelText = parts.join("\n");
					return {
						files: cardFiles,
						truncated: overflow.length > 0 || resumedTruncation !== undefined,
						// #386: the search's TRUE total — the continuation is part of the
						// same search, so the total does not restart at the segment.
						total: searchTotal ?? servedCount,
						...(searchTotal !== undefined ? { totalExact: searchTotalExact } : {}),
						served: servedHits,
						...(resumedTruncation !== undefined ? { truncatedBy: resumedTruncation } : {}),
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
				// The per-file match cap. It rides to ripgrep as `--max-count`, so the
				// engine stops exactly where the plugin's own matcher would.
				const limit = opts.limit ?? DEFAULT_LIMIT;

				const root = await io.resolve(params.path ?? ".", cwd, signal2);
				abortIf(signal2);
				const rootStat = await lstat(root);
				// #414: ONE ripgrep invocation walks the path itself, with ripgrep's
				// own ignore semantics — a build directory a parent `.gitignore`
				// excludes is never walked at all. No file list, no chunking, no
				// second engine.
				const searchOpts = {
					pattern: params.pattern,
					literal: opts.regex === false,
					path: root,
					...(includeGlob !== undefined ? { include: includeGlob } : {}),
					context: opts.context ?? 0,
					...(getEffectiveConfig().grepRespectGitignore ? {} : { ignoreIgnore: true }),
					signal: signal2,
				};
				let outcome = await runGrep(searchOpts);
				// A named path under an ignored ancestor is a real use: ONE wide
				// retry, only when the first search found nothing (#414 Q3).
				if (outcome.kind === "ok" && !outcome.rows.some((row) => row.match)) {
					const wide = await runGrep({ ...searchOpts, ignoreAncestors: true });
					if (wide.kind === "ok" && wide.rows.some((row) => row.match)) outcome = wide;
				}
				if (outcome.kind === "unavailable") {
					throw new Error(
						"[E_SEARCH_UNAVAILABLE] ripgrep is not available; install it or put `rg` on PATH. The search has no second engine.",
					);
				}
				if (outcome.kind === "invalid-pattern") {
					throw new Error(`[E_BAD_SHAPE] Grep pattern "${params.pattern}" was rejected by ripgrep: ${outcome.message}`);
				}
				if (outcome.kind === "overflow") throw new Error(`[E_SEARCH_OVERFLOW] ${outcome.message}`);
				if (outcome.kind === "failed") throw new Error(`[E_SEARCH_FAILED] ${outcome.message}`);
				const sections = sectionsFromRows(outcome.rows, root, limit, params.pattern, opts.regex !== false, opts.context ?? 0);

				const fileSections: string[] = [];

				const cardFiles: GrepFileRows[] = [];

				const jsonOutput = isJsonOutput();

				const jsonFiles: Array<{ path: string; matches: Record<string, string> }> = [];

				const spillRows: SegmentRow[] = [];

				const spillStamps: ResumeSidecar["stamps"] = [];

				const spillStampPaths = new Set<string>();
				let hitTotal = 0;
				let servedMatches = 0;
				let hitTotalExact = true;
				let limitCut = false;
				let budgetCut = false;
				let truncated = false;
				let usedChars = 0;
				let spilling = false;
				let headerEmitted = false;
				const fileHitsByFile = new Map<string, GrepFileHits>();
				// #414: the search no longer re-reads files, so nothing can go stale
				// between the search and the serve; kept for the caution text below.
				const staleFiles: string[] = [];

				for (const section of sections) {
					abortIf(signal2);
					const file = section.path;
					// #414: the file's identity comes from a STREAMING read — the
					// file is never held in memory. Rows whose preview was cut are
					// shown but not anchored (their text is not the line's text).
					let identity: { checksum: string; lineCount: number };
					try {
						identity = await readFileIdentity(file, signal2);
					} catch {
						abortIf(signal2);
						continue; // unreadable file — skipped, never a refusal
					}
					section.lineCount = identity.lineCount;
					// #205 Q5: a single row over the budget is pointer-ized and the
					// segment keeps assembling — one pathological line never destroys
					// a section.
					for (const row of section.contextRows) {
						if (codeUnits(row.content) + ROW_MARKER_ALLOWANCE > budget) {
							row.content = `[Line ${row.position + 1} is ~${codeUnits(row.content)} chars, exceeds the ${budget}-char per-response budget; content not shown. Use bash: sed -n '${row.position + 1}p' ${file} | head -c ${budget}]`;
							row.pointer = true;
						}
					}
					const anchorableRows = section.contextRows.filter((row) => row.anchorable && !row.pointer);
					let allocated: readonly string[] = [];
					if (anchorableRows.length > 0) {
						try {
							allocated = await anchorForRowsInWorkspace({
								cwd,
								absolutePath: file,
								rows: anchorableRows.map((row) => ({ line: row.position + 1, text: row.content })),
								identity,
								sessionKey,
							});
						} catch (error) {
							// The anchored state was written for different content: read the
							// file and realign through the content adapter (rare).
							if (!(error instanceof Error) || !error.message.includes("E_ANCHOR_REALIGN")) throw error;
							const tolerant = await io.readTextTolerant(file, signal2);
							allocated = await anchorForInWorkspace({
								cwd,
								absolutePath: file,
								content: tolerant.text,
								lines: anchorableRows.map((row) => row.position + 1),
								sessionKey,
							});
						}
					}
					const anchorsByPosition = new Map<number, string>();
					anchorableRows.forEach((row, index) => {
						const anchor = allocated[index] ?? "";
						if (anchor !== "") anchorsByPosition.set(row.position, anchor);
					});
					const displayPath = relative(root, file) || basename(file);
					const reported = section.matches.length;
					const fileTotal = section.limitCut ? undefined : reported;
					const fileHits: GrepFileHits = { reported, ...(fileTotal !== undefined ? { total: fileTotal } : {}) };
					const fileLimitCut = section.limitCut;
					hitTotal += fileTotal ?? reported;
					if (fileTotal === undefined) hitTotalExact = false;
					limitCut = limitCut || fileLimitCut;
					truncated = truncated || fileLimitCut;
					fileHitsByFile.set(file, fileHits);
					const sectionChars =
						codeUnits(section.contextRows.map((row) => row.content).join("\n")) +
						ROW_MARKER_ALLOWANCE * (section.contextRows.length + 1);
					const admitRows = async (rows: GrepSectionRow[], budgetCutForFile: boolean): Promise<void> => {
						const servedRows: Array<{ position: number; anchor: string }> = [];
						for (const row of rows) {
							if (row.pointer) continue;
							const anchor = anchorsByPosition.get(row.position) ?? "";
							if (anchor !== "") servedRows.push({ position: row.position, anchor });
						}
						if (servedRows.length > 0 && exec !== undefined) {
							await io.emitObserved(file, exec, signal2).catch(() => undefined);
						}
						const servedHits = rows.filter((row) => row.isMatch).length;
						fileSections.push(
							[
								renderSection(displayPath, rows, anchorsByPosition, lineNumbersEnabled(), !headerEmitted),
								formatGrepStats({
									...(fileTotal !== undefined ? { total: fileTotal } : {}),
									reported,
									served: servedHits,
									limitCut: fileLimitCut,
									budgetCut: budgetCutForFile,
									limit,
								}),
							].join("\n"),
						);
						servedMatches += servedHits;
						budgetCut = budgetCut || budgetCutForFile;
						headerEmitted = true;
						cardFiles.push({
							path: displayPath,
							rows: rows.map((row) => ({
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
							const keyOf = (position: number): string => {
								const anchor = anchorsByPosition.get(position) ?? "";
								return anchor === "" ? `${position + 1}` : fmtMarker(anchor, position + 1);
							};
							const servedPositions = new Set(rows.map((row) => row.position));
							for (const match of section.matches) {
								if (!servedPositions.has(match.position)) continue;
								matches[keyOf(match.position)] = match.content;
								for (let k = Math.max(0, match.position - context); k <= Math.min(section.lineCount - 1, match.position + context); k++) {
									if (k === match.position) continue;
									if (!servedPositions.has(k)) continue;
									const row = section.contextRows.find((candidate) => candidate.position === k);
									if (row !== undefined) matches[keyOf(k)] = row.content;
								}
							}
							jsonFiles.push({ path: displayPath, matches });
						}
					};
					if (!spilling && usedChars + sectionChars <= budget) {
						await admitRows(section.contextRows, false);
						usedChars += sectionChars;
					} else {
						const remaining = Math.max(0, budget - usedChars);
						const rowCost = (row: GrepSectionRow): number => codeUnits(row.content) + ROW_MARKER_ALLOWANCE;
						let split = spilling
							? { included: [] as GrepSectionRow[], overflow: section.contextRows, used: 0 }
							: takeRowsStrictlyWithinBudget(section.contextRows, remaining, rowCost);
						if (split.included.length > 0 && !split.included.some((row) => row.isMatch)) {
							const firstHit = section.contextRows.findIndex((row) => row.isMatch);
							if (firstHit > 0) {
								const fromHit = takeRowsStrictlyWithinBudget(section.contextRows.slice(firstHit), remaining, rowCost);
								if (fromHit.included.length > 0) {
									split = {
										included: fromHit.included,
										overflow: [...section.contextRows.slice(0, firstHit), ...fromHit.overflow],
										used: fromHit.used,
									};
								}
							}
						}
						spilling = true;
						budgetCut = budgetCut || split.overflow.length > 0;
						if (!spillStampPaths.has(file)) {
							spillStampPaths.add(file);
							const version = await io.statVersion(file, signal2).catch(() => undefined);
							spillStamps.push({ path: file, version });
						}
						if (split.included.length > 0) {
							await admitRows(split.included, split.overflow.length > 0);
							usedChars += split.used;
						}
						for (const row of split.overflow) {
							spillRows.push({ content: row.content, path: file, line: row.position + 1, kind: row.isMatch ? "row" : "ctx" });
						}
					}
				}
				// #386: WHICH cut happened — the per-file cap, the response budget, or
				// both. The model and the card both need to say it.
				const truncatedBy: GrepTruncation | undefined =
					limitCut && budgetCut ? "limit+budget" : limitCut ? "limit" : budgetCut ? "budget" : undefined;
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
						// #386: the search's totals travel with the spill, so the
						// continuation reports the same numbers.
						meta: {
							hitTotal,
							hitTotalExact,
							truncatedBy,
							limit,
							// The per-file counts travel too, so a continuation ends every
							// one of its sections with the same count line (#386).
							fileHits: Object.fromEntries(fileHitsByFile),
						},
					});
					const omittedChars = spillRows.reduce((acc, row) => acc + codeUnits(row.content), 0);
					continuation = { resume: token, remaining: spillRows.length };
					noticeText = formatOmittedNotice({
						omittedLines: spillRows.length,
						omittedChars,
						consumer: "grep",
						totalMatches: hitTotal,
						token,
					});
				}


				// The cautions name the files that changed after the search ran: their
				// rows are the search's snapshot, not the file's current text.
				const cautionText = staleFiles
					.map(
						(file) =>
							`[Caution: ${relative(root, file) || basename(file)} changed after the search ran; the rows below are the earlier snapshot and are not editable.]`,
					)
					.join("\n");
				if (fileSections.length === 0 && spillRows.length === 0) {
					const noMatchModelText = jsonOutput
						? JSON.stringify({ total: 0, truncated: false, files: [] }) +
						(cautionText === "" ? "" : `\n${cautionText}`)
						: cautionText === ""
							? `No matches for "${params.pattern}" in ${root}.`
							: cautionText;
					return {
						files: [],
						truncated: false,
						total: 0,
						modelText: noMatchModelText,
					} satisfies GrepCanonicalValue & { modelText: string };
				}
				if (fileSections.length === 0) {
					// Unreachable since the per-row admission (#307): the first section
					// always contributes at least its first row (a row bigger than the
					// whole budget is pointer-ized above). Kept as a guard: if it ever
					// fires, the notice alone is still the honest answer.
					// everything spilled: the response is the continuation notice alone
					return {
						files: [],
						truncated: true,
						total: hitTotal,
						...(continuation !== undefined ? { continuation } : {}),
						served: servedMatches,
						modelText: jsonOutput
							? JSON.stringify({ total: hitTotal, truncated: true, totalExact: hitTotalExact, truncatedBy: "budget", files: [], ...(continuation !== undefined ? { continuation } : {}) }) + (noticeText === "" ? "" : `\n${noticeText}`)
							: `Matches exist but exceed the per-response budget.\n${noticeText}`,
					} satisfies GrepCanonicalValue & { modelText: string };
				}

				const value: GrepCanonicalValue & { modelText: string } = {
					files: cardFiles,
					truncated: truncated || spillRows.length > 0,
					// #386: the TRUE hit count, and which cut took the rest away.
					total: hitTotal,
					totalExact: hitTotalExact,
					...(truncatedBy !== undefined ? { truncatedBy } : {}),
					served: servedMatches,
					...(continuation !== undefined ? { continuation } : {}),
					modelText: jsonOutput
						? JSON.stringify({ total: hitTotal, truncated: truncated || spillRows.length > 0, totalExact: hitTotalExact, ...(truncatedBy !== undefined ? { truncatedBy } : {}), files: jsonFiles, ...(continuation !== undefined ? { continuation } : {}) }) + (noticeText === "" ? "" : `\n${noticeText}`) + (cautionText === "" ? "" : `\n${cautionText}`)
						: `${cautionText === "" ? "" : `${cautionText}\n\n`}${fileSections.join("\n\n")}${noticeText === "" ? "" : `\n${noticeText}`}`,
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
