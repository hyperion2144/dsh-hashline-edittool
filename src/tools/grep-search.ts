/**
 * The search layer under `grep`: which files carry a hit, and on which line.
 *
 * ripgrep is the engine (#384, ADR-0028): one `rg --json` search produces the
 * matches, and only the files that matched are read. This module owns that
 * decision — the engine call, the grouping of its hits per file, the plugin's
 * own matcher as the degraded path, and the one file shape ripgrep's line
 * numbers cannot reproduce (#147).
 *
 * The rows a section is built from live here too: they carry the match flag and
 * the highlight spans, so the model text and the search card derive from ONE
 * list (ADR-0005).
 *
 * @module dsh-hashline-edittool/tools/grep-search
 */

import { resolve } from "node:path";
import { rgSearchMatches, type RgMatch } from "./grep-rg.js";
import { matchSpans, type MatchSpan } from "../render/grep-card.js";
import { type GrepFileHits } from "../domain/grep/stats.js";

/** The per-file cap on matches, and the context window around them. */
export interface GrepToolOptions {
	/** Cap on matches per file. Default 100. */
	limit?: number;
	/** Number of context rows above and below each match. Default 0. */
	context?: number;
	/** If true, `pattern` is treated as a regular expression (ripgrep syntax). Default TRUE (v2.0.2). */
	regex?: boolean;
}

/** The default per-file cap on matches. */
export const DEFAULT_LIMIT = 100;

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

/**
 * Build one file's section from the match positions the search engine reported.
 *
 * `lines` must already be in the read line space (toLF — issue #147).
 * ADR-0013: allocation is the CALLER's job — only rows actually returned to
 * the model get anchors (persisted == served == visible).
 *
 * The positions are 0-based line indexes and are capped at the per-file limit:
 * the engine already caps them (`--max-count`), and the cap is repeated here so
 * every position source answers alike.
 */
export function buildGrepSection(
	path: string,
	lines: readonly string[],
	positions: readonly number[],
	pattern: string,
	opts: GrepToolOptions = {},
): GrepFileSection | undefined {
	if (lines.length === 0) return undefined;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const context = Math.max(0, opts.context ?? 0);
	// A position the file no longer has is DROPPED, not served: the engine
	// counted the lines of the file as it was when it searched it, and the file
	// may have shrunk since (a concurrent write).
	const matchPositions = positions
		.filter((position) => position >= 0 && position < lines.length)
		.slice(0, limit);
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

/**
 * The plugin's own line matcher — the DEGRADED path's engine, and the repair for
 * a file whose line space ripgrep cannot reproduce (#147).
 *
 * A pattern ripgrep's engine rejects (a JavaScript-only look-around, say) has no
 * matcher here; that is reported where the matcher is only a repair, and raised
 * where the matcher IS the engine (a bad pattern, as before ripgrep became the
 * engine).
 */
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

/** The match positions of one file, found by the plugin's own matcher. */
function matchPositions(
	lines: readonly string[],
	matcher: (line: string) => boolean,
	limit: number,
): { positions: number[]; total?: number } {
	const positions: number[] = [];
	for (let i = 0; i < lines.length && positions.length < limit; i++) {
		if (matcher(lines[i]!)) positions.push(i);
	}
	// The scan reached the END of the file, so the count IS the hit count. It
	// stopped at the cap, so there may be more hits the scan never looked
	// for: the count is then a LOWER BOUND, and it stays unknown (#386).
	return { positions, total: positions.length < limit ? positions.length : undefined };
}

/**
 * Whether the file's line space is one ripgrep can reproduce (#147).
 *
 * The read line space folds CRLF and bare CR to LF — a bare CR ends a line —
 * while ripgrep counts LF only. The two agree on every file without a bare CR;
 * on a file that has one, ripgrep's line numbers drift, and a pattern could even
 * match ACROSS the CR. Such a file is therefore matched by the plugin's own
 * matcher, in the read line space.
 */
function hasBareCr(raw: string): boolean {
	return /\r(?!\n)/.test(raw);
}

/**
 * Group the engine's matches per candidate file.
 *
 * ripgrep reports the path it was given, so a match belongs to the candidate
 * file with that path. The paths are compared RESOLVED, so a match is still
 * attributed to its file when the two spellings differ (a relative path, a
 * separator difference). A match whose file is not in the candidate list cannot
 * happen — the search was given that list — and is dropped rather than served, so
 * a section is never built for a file the scan did not ask for.
 */
function groupMatchesByFile(
	matches: readonly RgMatch[],
	files: readonly string[],
): Map<string, RgMatch[]> {
	const byKey = new Map<string, string>();
	for (const file of files) byKey.set(resolve(file), file);
	const grouped = new Map<string, RgMatch[]>();
	for (const match of matches) {
		const file = byKey.get(resolve(match.path));
		if (file === undefined) continue;
		const hits = grouped.get(file);
		if (hits === undefined) grouped.set(file, [match]);
		else hits.push(match);
	}
	for (const hits of grouped.values()) hits.sort((a, b) => a.line - b.line);
	return grouped;
}

/** One file's text, in both spaces the search reads it in. */
export interface GrepFileContent {
	/** The file's raw text, before the line space folds its line endings. */
	raw: string;
	/** The text's lines in the read line space (ADR-0008). */
	lines: readonly string[];
	/** Whether the text carries undecodable bytes (U+FFFD stand-ins, #273). */
	lossy: boolean;
}


/** One file's search result: the rows its section is built from. */
export interface GrepFileSearch {
	/** The section's rows: the matches and their context rows, in line order. */
	contextRows: GrepSectionRow[];
	/** The rows that are hits. */
	matches: GrepSectionRow[];
	/** The file's line count — the bound of the context window around a match. */
	lineCount: number;
	/**
	 * Whether the file changed after the search ran.
	 *
	 * The search's snapshot of a line and the line as it is now can disagree:
	 * the file changed between ripgrep's read and the plugin's. Then the rows
	 * are the SNAPSHOT — served unserved (no anchor: the file no longer holds
	 * them), with a caution naming the file.
	 */
	stale: boolean;
	/**
	 * What the search knows about this file's hits (#386).
	 */
	hits: GrepFileHits;
}

/**
 * The plan of one search: which files to read, and what their hits are.
 *
 * The plan is what the tool executes against; the search itself already happened
 * by the time it exists (ripgrep ran over the candidate list), so a plan is
 * cheap to keep and cheap to ask questions of.
 */
export interface GrepSearchPlan {
	/** The files to read: the ones the engine matched (the degraded path: all of them). */
	readonly candidates: string[];
	/**
	 * The files whose hits reached the per-file cap: their true total is not in
	 * the plan, and another pass has to count it (#386).
	 */
	readonly cappedFiles: readonly string[];
	/**
	 * The rows of one file's section, given the file's text.
	 *
	 * `undefined` when the file carries no hit.
	 */
	sectionFor(file: string, content: GrepFileContent): GrepFileSearch | undefined;
}

/** What one search is asked for. */
export interface GrepSearchRequest {
	/** The pattern to search for. */
	pattern: string;
	/** Whether the pattern is a regular expression (ripgrep syntax) or a literal. */
	regex: boolean;
	/** The per-file cap on matches. */
	limit: number;
	/** The number of context rows around each match. */
	context: number;
	/** The candidate files to search. */
	files: readonly string[];
	/** An optional abort signal. */
	signal?: AbortSignal;
}

/**
 * Run the search and plan what the tool will do with it.
 *
 * ripgrep is the engine: one `rg --json` search produces the matches, and only
 * the files that matched become candidates — a file without a hit is never read.
 *
 * A pattern ripgrep's engine rejects is a bad pattern: the plugin answers with
 * its own `E_BAD_SHAPE`, the way the official grep tool answers with
 * `SEARCH_INVALID_PATTERN`. The plugin's own matcher takes over only when
 * ripgrep could not run at all (its binary is missing, or the run failed) —
 * then every candidate is searched, in the read line space.
 *
 * @param request - the pattern, the cap and the candidate files.
 * @returns the plan: the files to read and what their hits are.
 * @throws the plugin's own `E_BAD_SHAPE` for a pattern ripgrep rejected.
 */
export async function planGrepSearch(request: GrepSearchRequest): Promise<GrepSearchPlan> {
	const search = await rgSearchMatches({
		pattern: request.pattern,
		literal: !request.regex,
		limit: request.limit,
		files: request.files,
		...(request.signal !== undefined ? { signal: request.signal } : {}),
	});
	if (search.kind === "invalid-pattern") {
		// ripgrep's engine is the engine: a pattern it rejects is a bad pattern.
		throw new Error(
			`[E_BAD_SHAPE] Grep pattern "${request.pattern}" was rejected by ripgrep: ${search.message}`,
		);
	}
	const engineHits =
		search.kind === "ok" ? groupMatchesByFile(search.matches, request.files) : undefined;
	if (engineHits !== undefined) {
		// #386: the engine stops at the per-file cap, so a file that reached the
		// cap may carry MORE hits than the search collected — and the search
		// cannot tell. Those files are the ones a second, uncapped counting pass
		// has to answer for; every other file's count is already exact.
		const cappedFiles: string[] = [];
		for (const [file, fileHits] of engineHits) {
			// The engine stops at the cap, so a file that reached it may carry more
			// hits than it reported: its true total needs another pass (#386).
			if (fileHits.length >= request.limit) cappedFiles.push(file);
		}
		return {
			candidates: [...engineHits.keys()],
			cappedFiles,
			sectionFor: (file, content) =>
				engineSection(file, content, engineHits.get(file) ?? [], request),
		};
	}
	// The DEGRADED path: ripgrep could not answer at all. The plugin's own
	// matcher takes over, in the read line space, and every candidate is read.
	const matcher = buildMatcher(request.pattern, request.regex);
	return {
		candidates: [...request.files],
		cappedFiles: [],
		sectionFor: (file, content) => {
			const { positions, total } = matchPositions(content.lines, matcher, request.limit);
			const section = buildGrepSection(file, content.lines, positions, request.pattern, request);
			if (section === undefined) return undefined;
			return {
				contextRows: section.contextRows,
				matches: section.matches,
				lineCount: content.lines.length,
				stale: false,
				hits: { reported: positions.length, total },
			};
		},
	};
}

/**
 * One file's section, from the engine's hits.
 *
 * Two things happen here that the raw hits do not carry:
 *
 * - the hits are PLACED in the read line space (ADR-0008): on a file whose line
 *   space ripgrep cannot reproduce, the hit's offset inside its line says which
 *   read-space line it is on;
 * - the file is checked for DRIFT: the search's snapshot of a line and the line
 *   as it is now can disagree, and a file that changed is served as the snapshot
 *   it was.
 */
function engineSection(
	file: string,
	content: GrepFileContent,
	hits: readonly RgMatch[],
	request: GrepSearchRequest,
): GrepFileSearch | undefined {
	if (hits.length === 0) return undefined;
	// #386: the engine's count for this file, and whether it is the whole
	// truth. A file that reached the cap may carry more hits than the
	// engine reported, so its total is unknown until another pass counts it.
	const reported = hits.length;
	const total = hits.length < request.limit ? hits.length : undefined;
	const diverged = hasBareCr(content.raw);
	const spaces = diverged ? indexLineSpaces(content.raw) : undefined;
	const placed: Array<{ position: number; text: string }> = [];
	let stale = false;
	for (const hit of hits) {
		const position = spaces === undefined ? hit.line - 1 : readSpacePosition(hit, spaces);
		if (position === undefined) continue;
		if (position < 0 || position >= content.lines.length) continue;
		// The DRIFT check: the search's snapshot of the line against the line as
		// it is now. On a file ripgrep can count, the line as it is now is the
		// read-space line; on a file it cannot, the two spaces count the file
		// differently and the raw line is the comparable one.
		const current =
			spaces === undefined ? content.lines[position]! : rawRgLine(content.raw, spaces, hit.line);
		if (!content.lossy && stripTrailingCr(hit.text) !== stripTrailingCr(current)) stale = true;
		placed.push({ position, text: hit.text });
	}
	if (placed.length === 0) return undefined;
	if (stale) {
		// The file changed: the section is the search's SNAPSHOT — the matched
		// lines as ripgrep saw them. No context rows (the search did not report
		// those) and no anchors (the file no longer holds them).
		const rows: GrepSectionRow[] = placed.map((row) => ({
			position: row.position,
			content: row.text,
			isMatch: true,
			spans: matchSpans(row.text, request.pattern, request.regex),
		}));
		return {
			contextRows: rows,
			matches: rows,
			lineCount: content.lines.length,
			stale: true,
			hits: { reported, total },
		};
	}
	const section = buildGrepSection(
		file,
		content.lines,
		placed.map((row) => row.position),
		request.pattern,
		request,
	);
	if (section === undefined) return undefined;
	return {
		contextRows: section.contextRows,
		matches: section.matches,
		lineCount: content.lines.length,
		stale: false,
		hits: { reported, total },
	};
}

/** The two line spaces of one file, indexed once. */
interface FileLineSpaces {
	/** The character offset of each ripgrep line's start (ripgrep splits on LF). */
	rgLineStarts: number[];
	/** The character offset of every line break in the read line space. */
	breaks: number[];
}

/**
 * Index the two line spaces of one raw text.
 *
 * ripgrep splits on LF alone; the read line space folds CRLF and bare CR to LF
 * as well (ADR-0008). The index says where each ripgrep line starts and where
 * every read-space line break is, so a hit can be placed in the read space.
 */
function indexLineSpaces(raw: string): FileLineSpaces {
	const rgLineStarts: number[] = [];
	const breaks: number[] = [];
	let rgLineStart = 0;
	for (let index = 0; index < raw.length; index++) {
		const ch = raw[index];
		if (ch === "\r") {
			breaks.push(index);
			if (raw[index + 1] === "\n") {
				// CRLF: ONE break in the read space; ripgrep's line ends after it.
				index++;
				rgLineStarts.push(rgLineStart);
				rgLineStart = index + 1;
			}
			continue;
		}
		if (ch === "\n") {
			breaks.push(index);
			rgLineStarts.push(rgLineStart);
			rgLineStart = index + 1;
		}
	}
	rgLineStarts.push(rgLineStart);
	return { rgLineStarts, breaks };
}

/**
 * The read line space's line index of one hit, on a file ripgrep cannot count.
 *
 * The hit's offset inside its line says where in the line it sits; the file's
 * own line breaks say which read-space line that is.
 */
function readSpacePosition(hit: RgMatch, spaces: FileLineSpaces): number | undefined {
	if (hit.offset === undefined) return undefined;
	const lineStart = spaces.rgLineStarts[hit.line - 1];
	if (lineStart === undefined) return undefined;
	const absolute = lineStart + hit.offset;
	// The number of read-space line breaks before the hit IS its line index.
	let low = 0;
	let high = spaces.breaks.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (spaces.breaks[mid]! < absolute) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** The raw text's ripgrep line at the given 1-based line number. */
function rawRgLine(raw: string, spaces: FileLineSpaces, line: number): string {
	const start = spaces.rgLineStarts[line - 1];
	if (start === undefined) return "";
	const next = spaces.rgLineStarts[line];
	const end = next === undefined ? raw.length : next - 1;
	return raw.slice(start, Math.max(start, end));
}

/** A line's trailing CR, dropped: the two sides of the drift check spell it differently. */
function stripTrailingCr(text: string): string {
	return text.endsWith("\r") ? text.slice(0, -1) : text;
}
