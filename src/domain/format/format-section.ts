/**
 * Building the format section the card renders beside a main diff.
 *
 * Decision B's display contract, as a builder:
 *
 * - A row exists for every final line the FORMATTER changed that the main
 *   diff does not already show. A formatter-changed line the main diff ALSO
 *   shows is not returned in any form — the diff already carries its anchor
 *   and content — `inMainDiffRows` counts it instead (#312: repeating it in
 *   the section was pure token waste under ADR-0020's unified diff).
 * - A row's hash is the FINAL content's anchor when the line is eligible
 * - A row the eligibility gate refuses is NOT returned at all — no content,
 *   no anchor, not even a placeholder. The inline section is part of an edit
 *   response, and the edit contract never surfaces content the model has no
 *   standing view of (#275 follow-up user ruling); `unservedRows` counts
 *   those rows instead, so the model still learns how many there were.
 * - `changedLines` counts ALL formatter-changed final lines (eligible or
 *   not, in the main diff or not) — the honest size of the format's effect.
 * - `unservedRows` counts the rows a reader cannot address: changed, not in
 *   the main diff, and ineligible. This is the number that tells the model
 *   "the formatter touched lines you have no anchors for".
 *
 * @module dsh-hashline-edittool/domain/format/format-section
 */
import { currentScopeLabelAt } from "../../render/scope-registry.js";
import type { FormatCluster, FormatRow, FormatSection, FormatStatus } from "./types.js";

/**
 * Which final lines the formatter changed, and how they read.
 *
 * A final line changed when its provenance entry is missing (inserted), maps
 * from more than one model line (a merge — the text cannot be one line's
 * continuation), or its text differs from the single model line it maps to.
 *
 * @param modelLines - the pre-format (post-model) lines.
 * @param finalLines - the post-format lines.
 * @param finalToModel - `lineMapFromTextEdits`'s result.
 * @returns the set of changed final lines (1-based).
 */
export function formatterChangedLines(
	modelLines: readonly string[],
	finalLines: readonly string[],
	finalToModel: ReadonlyMap<number, ReadonlySet<number>>,
): Set<number> {
	const changed = new Set<number>();
	for (let line = 1; line <= finalLines.length; line++) {
		const sources = finalToModel.get(line);
		if (sources === undefined || sources.size !== 1) {
			changed.add(line);
			continue;
		}
		const [modelLine] = sources;
		const text = modelLine === undefined ? undefined : modelLines[modelLine - 1];
		if (text !== finalLines[line - 1]) changed.add(line);
	}
	return changed;
}

/**
 * Assemble one file's format section.
 *
 * @param params.status - the outcome; anything but `formatted` renders no rows.
 * @param params.server - the server name for the header.
 * @param params.mode - how the request was served.
 * @param params.requested - ranges requested (hunks; 1 for a whole file).
 * @param params.applied - TextEdits actually applied.
 * @param params.finalLines - the post-format lines (the rows' text).
 * @param params.finalHashes - the final content's content-derived anchors,
 *   index = line − 1 (only the eligible rows' values are used).
 * @param params.changed - `formatterChangedLines`'s result.
 * @param params.eligibility - `computeRowEligibility`'s result.
 * @param params.alsoInMain - final lines the main diff already shows.
 */
export function buildFormatSection(params: {
	status: FormatStatus;
	server?: string;
	mode?: FormatSection["mode"];
	requested?: number;
	applied?: number;
	reason?: string;
	finalLines: readonly string[];
	finalHashes: readonly string[];
	changed: ReadonlySet<number>;
	eligibility: ReadonlyMap<number, boolean>;
	alsoInMain: ReadonlySet<number>;
	/** The PRE-EDIT lines. Presence turns on restore summaries (#315 review): a
	 * changed line outside the main diff whose exact text occurred at least as
	 * many times before the edit carries the same content-derived anchor it had,
	 * so its content is old news — it is counted in `restoredRows` and
	 * summarized per cluster instead of returned as a row. Absent (manual
	 * format) every eligible out-of-diff line stays a full row. */
	preEditLines?: readonly string[];
	/** The full post-format content, for cluster scope lookups; defaults to joining `finalLines`. */
	finalText?: string;
	/** The file's path, for the scope detector's language pick. */
	path?: string;
}): FormatSection {
	if (params.status !== "formatted") {
		const base: FormatSection = { status: params.status };
		if (params.server !== undefined) {
			(base as { server?: string }).server = params.server;
		}
		if (params.status === "skipped" && params.reason !== undefined) {
			(base as { reason?: string }).reason = params.reason;
		}
		return base;
	}
	const rows: FormatRow[] = [];
	const restoredLines: number[] = [];
	let unserved = 0;
	let inMain = 0;
	// Occurrence bookkeeping for the stability rule: anchors are content-
	// derived (hash + same-text occurrence), so "this exact text occurred at
	// least k times pre-edit, and this line is the k-th occurrence now" means
	// the model already holds its content and anchor (#315 review). One pass
	// over ALL final lines — an occurrence index is a whole-file property, not
	// a section-row property.
	const preCount = new Map<string, number>();
	const finalOcc = new Map<number, number>();
	if (params.preEditLines !== undefined) {
		for (const text of params.preEditLines) {
			preCount.set(text, (preCount.get(text) ?? 0) + 1);
		}
		const seen = new Map<string, number>();
		for (let line = 1; line <= params.finalLines.length; line++) {
			const text = params.finalLines[line - 1] ?? "";
			const k = (seen.get(text) ?? 0) + 1;
			seen.set(text, k);
			finalOcc.set(line, k);
		}
	}
	for (let line = 1; line <= params.finalLines.length; line++) {
		if (!params.changed.has(line)) continue;
		// #312: the main diff already carries this line's anchor and content —
		// repeating them in the section is pure token waste. Count, never re-show.
		if (params.alsoInMain.has(line)) {
			inMain += 1;
			continue;
		}
		const eligible = params.eligibility.get(line) === true;
		if (!eligible) {
			unserved += 1;
			continue;
		}
		const k = finalOcc.get(line);
		if (k !== undefined && k <= (preCount.get(params.finalLines[line - 1] ?? "") ?? 0)) {
			// Anchor unchanged vs pre-edit: the row would repeat content the
			// model read before editing. Count it; the cluster summary speaks.
			restoredLines.push(line);
			continue;
		}
		// Drift (rare): the anchor genuinely changed vs pre-edit — republish
		// content + anchor so the next edit still addresses this line.
		rows.push({
			kind: "+",
			lineNumber: line,
			hash: params.finalHashes[line - 1] ?? "",
			text: params.finalLines[line - 1] ?? "",
		});
	}
	// Contiguous runs over the section's body lines (restored + drift) become
	// the locator clusters — the model's "where are these lines" answer.
	const list: FormatCluster[] = [];
	if (params.preEditLines !== undefined && restoredLines.length + rows.length > 0) {
		const scopeLabelAt = currentScopeLabelAt();
		const text = params.finalText ?? params.finalLines.join("\n");
		const driftAt = new Set(rows.map((row) => row.lineNumber));
		const body = [...restoredLines, ...rows.map((row) => row.lineNumber)].sort((a, b) => a - b);
		let start = 0;
		let prev = 0;
		let stable = 0;
		const flush = (endLine: number): void => {
			const scope = scopeLabelAt(text, start, params.path);
			list.push({
				startLine: start,
				lines: endLine - start + 1,
				restored: stable,
				...(scope !== undefined && scope !== "" ? { scope } : {}),
			});
		};
		for (const line of body) {
			if (start === 0) {
				start = line;
				prev = line;
				stable = driftAt.has(line) ? 0 : 1;
				continue;
			}
			if (line === prev + 1) {
				prev = line;
				if (!driftAt.has(line)) stable += 1;
				continue;
			}
			flush(prev);
			start = line;
			prev = line;
			stable = driftAt.has(line) ? 0 : 1;
		}
		if (start !== 0) flush(prev);
	}
	return {
		status: params.status,
		...(params.server !== undefined ? { server: params.server } : {}),
		...(params.mode !== undefined ? { mode: params.mode } : {}),
		...(params.requested !== undefined ? { requested: params.requested } : {}),
		...(params.applied !== undefined ? { applied: params.applied } : {}),
		changedLines: params.changed.size,
		inMainDiffRows: inMain,
		unservedRows: unserved,
		...(params.preEditLines !== undefined
			? { restoredRows: restoredLines.length, ...(list.length > 0 ? { clusters: list } : {}) }
			: {}),
		rows,
	};
}
