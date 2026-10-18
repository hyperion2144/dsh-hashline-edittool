/**
 * Building the format section the card renders beside a main diff.
 *
 * Decision B's display contract, as a builder:
 *
 * - A row exists for every final line the FORMATTER changed that the main
 *   diff does not already show; a formatter-changed line the main diff ALSO
 *   shows appears with `alsoInMainDiff: true` so the card can mark the
 *   duplicate instead of double-rendering it.
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
import type { FormatRow, FormatSection, FormatStatus } from "./types.js";

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
	let unserved = 0;
	for (let line = 1; line <= params.finalLines.length; line++) {
		if (!params.changed.has(line)) continue;
		const alsoInMainDiff = params.alsoInMain.has(line);
		const eligible = params.eligibility.get(line) === true;
		if (!alsoInMainDiff && !eligible) {
			unserved += 1;
			continue;
		}
		rows.push({
			kind: "+",
			lineNumber: line,
			hash: eligible ? (params.finalHashes[line - 1] ?? "") : "",
			text: params.finalLines[line - 1] ?? "",
			alsoInMainDiff,
		});
	}
	return {
		status: params.status,
		...(params.server !== undefined ? { server: params.server } : {}),
		...(params.mode !== undefined ? { mode: params.mode } : {}),
		...(params.requested !== undefined ? { requested: params.requested } : {}),
		...(params.applied !== undefined ? { applied: params.applied } : {}),
		changedLines: params.changed.size,
		unservedRows: unserved,
		rows,
	};
}
