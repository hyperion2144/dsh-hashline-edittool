/**
 * The search layer under `grep`: ripgrep's rows, grouped into per-file sections (#414).
 *
 * The engine reports `match` and `context` records as flat rows; this module is
 * the one place that turns them into the sections the model text and the card
 * are rendered from (ADR-0005). No file is read here: a row's text IS the line,
 * and the only per-file fact the caller adds afterwards is the file's identity
 * (checksum + line count) used to allocate anchors.
 *
 * A row whose text was cut (`truncated`) or undecodable is shown but marked
 * NOT anchorable: its text is no longer the line's text, so an anchor minted
 * from it could never verify a later edit.
 *
 * @module dsh-hashline-edittool/tools/grep-search
 */

import { resolve } from "node:path";
import type { RgRow } from "./grep-rg.js";
import { matchSpans, type MatchSpan } from "../render/grep-card.js";

/** The per-file cap on matches, and the context window around them. */
export interface GrepToolOptions {
	/** Cap on matches per file. Default 100. */
	limit?: number;
	/** Number of context rows above and below each match. Default 0. */
	context?: number;
	/** If true, `pattern` is treated as a regular expression (ripgrep syntax). Default TRUE. */
	regex?: boolean;
}

/** The default per-file cap on matches. */
export const DEFAULT_LIMIT = 100;

/**
 * One row in a grep section (its text, used to render the model text) plus the
 * card facts: whether the capped match list contains it, and the highlight
 * spans of every pattern occurrence.
 */
export interface GrepSectionRow {
	position: number;
	content: string;
	isMatch: boolean;
	/** Highlight spans for this line (empty when nothing is markable). */
	spans: MatchSpan[];
	/** False when the row's text is a preview, not the line — no anchor. */
	anchorable: boolean;
	/** Pointer rows: content replaced by a bash pointer (over budget per #205). */
	pointer?: true;
}

/** One file's rows, already merged and ordered. */
export interface GrepFileSection {
	/** Absolute path (resolved from what ripgrep reported). */
	path: string;
	/** The file's line count — filled from its identity by the caller. */
	lineCount: number;
	contextRows: GrepSectionRow[];
	matches: GrepSectionRow[];
	/** True when the per-file cap cut hits away. */
	limitCut: boolean;
}

/**
 * Group ripgrep's rows into one section per file.
 *
 * Rows are merged by line: the same line can arrive as context for one hit and
 * as a match for another, and a match wins. A file with more than `limit` hits
 * keeps the first `limit` and truncates there, context rows included.
 *
 * @param rows - the engine's rows, in file order.
 * @param root - the search root, for resolving what ripgrep reported.
 * @param limit - the per-file cap on matches.
 * @param pattern - the pattern, for the card's highlight spans.
 * @param regex - whether the pattern is a regular expression.
 * @returns one section per file with at least one hit.
 */
export function sectionsFromRows(
	rows: readonly RgRow[],
	root: string,
	limit: number,
	pattern: string,
	regex: boolean,
	/** Context rows around each hit (the window the engine reported). */
	context: number,
): GrepFileSection[] {
	const byFile = new Map<string, Map<number, RgRow>>();
	for (const row of rows) {
		const absolute = resolve(root, row.path);
		let lines = byFile.get(absolute);
		if (lines === undefined) {
			lines = new Map<number, RgRow>();
			byFile.set(absolute, lines);
		}
		const existing = lines.get(row.line);
		// A match beats a context record for the same line; within one kind the
		// first record wins (ripgrep reports a line once per role).
		if (existing === undefined || (!existing.match && row.match)) lines.set(row.line, row);
	}

	const sections: GrepFileSection[] = [];
	for (const [absolute, lines] of byFile) {
		const all = [...lines.values()].sort((a, b) => a.line - b.line);
		const hits = all.filter((row) => row.match);
		if (hits.length === 0) continue; // context-only files cannot exist; be safe
		const limitCut = hits.length > limit;
		const keptHits = limitCut ? hits.slice(0, limit) : hits;
		const lastKept = keptHits[keptHits.length - 1]!.line;
		const rowsToShow = limitCut ? all.filter((row) => row.line <= lastKept + context) : all;

		const sectionRows: GrepSectionRow[] = rowsToShow.map((row) => ({
			position: row.line - 1,
			content: row.text,
			// #414: the per-file cap is a SERVE-time cut now (the engine no longer
			// takes `--max-count`), so a hit past the cap is shown as context.
			isMatch: row.match && row.line <= lastKept,
			spans: row.undecodable ? [] : matchSpans(row.text, pattern, regex),
			anchorable: !row.truncated && !row.undecodable,
		}));
		sections.push({
			path: absolute,
			lineCount: 0,
			contextRows: sectionRows,
			matches: sectionRows.filter((row) => row.isMatch),
			limitCut,
		});
	}
	return sections;
}
