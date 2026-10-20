import type { ServedRow } from "../../hashline/anchor-pipeline.js";
import { genDiff, formatRowMarker, renderDiffLines, type DiffBlock } from "../../render/edit-diff.js";
import { visLines, clipLine } from "../../infra/utils.js";
import { lineNumbersEnabled } from "../../infra/settings.js";
import { contextLinesCfg } from "../../hashline/index.js";

/**
 * Compact legend opening every edit diff block. Replaces the long
 * `ANCHOR:FILELINE` header (issue #69 / A): the generic web card shows this
 * text raw, so it must read like a diff at a glance, while still telling the
 * model what the diff IS — a unified diff, whose block header carries the line
 * range and the enclosing function(s), whose `-` rows name pre-edit lines whose
 * anchors are stale, and whose `+` and unchanged rows carry fresh anchors.
 */
export const EDIT_DIFF_LEGEND =
	"Diff rows: <+|-><anchor>:<content> — a unified diff: `@@ -old,count +new,count @@ scope()` gives the line range and the enclosing function(s); `-` rows are the pre-edit lines (their `~` anchors are stale), `+` rows and unchanged rows are the post-edit code.";

/**
 * The legend for the CURRENT line-number switch: with the switch on, a row
 * carries its line number between the anchor and the content.
 *
 * @param lineNumbers - whether the line-number switch is on.
 * @returns the legend text.
 */
export function editDiffLegend(lineNumbers = lineNumbersEnabled()): string {
	return lineNumbers
		? EDIT_DIFF_LEGEND.replace("<+|-><anchor>:<content>", "<+|-><anchor>:<line>:<content>")
		: EDIT_DIFF_LEGEND;
}

/**
 * One file's group of the unified diff: the file header, then the file's
 * blocks — a block header line, then the block's rows.
 *
 * @param path - the file's display path.
 * @param blocks - the file's blocks, in order.
 * @param lineNumbers - whether the line-number switch is on.
 * @returns the group's lines, joined by newlines.
 */
export function renderFileDiffGroup(
	path: string,
	blocks: readonly DiffBlock[],
	lineNumbers = lineNumbersEnabled(),
): string {
	return [`--- ${path}`, `+++ ${path}`, ...renderDiffLines(blocks, lineNumbers)].join("\n");
}

/**
 * The model-visible unified diff: the legend, then one group per file.
 *
 * ONE renderer for the four edit tools (`edit`, `write`, `undo_last_edit`,
 * `ast_edit`): they all describe the same edit to the model, and a second copy
 * of this projection is a second shape to keep in sync.
 *
 * @param files - the files, in order, with their blocks.
 * @param lineNumbers - whether the line-number switch is on.
 * @returns the legend and the groups — one blank line between groups.
 */
export function renderUnifiedDiff(
	files: ReadonlyArray<{ path: string; blocks: readonly DiffBlock[] }>,
	lineNumbers = lineNumbersEnabled(),
): string {
	const legend = editDiffLegend(lineNumbers);
	// A file with no blocks has no diff to show, so it gets no file header: an
	// empty diff answers with the legend alone (spec §7).
	const groups = files
		.filter((file) => file.blocks.length > 0)
		.map((file) => renderFileDiffGroup(file.path, file.blocks, lineNumbers));
	return groups.length === 0 ? legend : `${legend}\n${groups.join("\n\n")}`;
}
import type { HunkShift } from "./edit-engine.js";

/**
 * The model-facing text of a format section (P1's shape): a bracketed
 * header that names the server, the mode and the counters, then one `+` row
 * per formatter-changed line the model may address. Rows the eligibility gate
 * refuses are not IN the section at all (the #275 follow-up ruling: an edit
 * response never surfaces content the model has no standing view of) — only
 * `unservedRows` counts them, and a formatted pass whose rows are all
 * unserved renders the bare header so the counts stay honest. The same
 * withholding covers rows the main diff already shows (#312): `inMainDiffRows`
 * counts them and neither content nor anchor is repeated here.
 */
export function renderFormatSection(
	section: FormatSection,
	lineNumbers = lineNumbersEnabled(),
	// The auto pass labels itself `auto-format`; the manual `format` tool
	// passes its own label so the two are distinguishable in the model text.
	label = "auto-format",
): string {
	const server = section.server ?? "language server";
	if (section.status === "skipped") {
		return `[${label}: ${server} · skipped · ${section.reason ?? "unspecified"}]`;
	}
	// One header template for both the counts-only and the rows path — the
	// two spellings only ever disagreed in the changed-line fallback (#312
	// review).
	const countsHeader = (changed: number): string =>
		`[${label}: ${server} · ${section.mode ?? "full-file"} · requested ${section.requested ?? 1} → applied ${section.applied ?? 0} · ${changed} lines changed · ${section.inMainDiffRows ?? 0} in main diff · ${section.unservedRows ?? 0} unserved]`;
	if (section.status !== "formatted" || section.rows === undefined || section.rows.length === 0) {
		// A formatted outcome whose rows are all withheld is NOT "no changes":
		// the header carries the honest counts (changedLines + inMainDiffRows +
		// unservedRows) — #275's follow-up rows return neither content nor
		// anchors, and #312's in-main rows are already fully visible in the diff.
		// Only a genuinely change-free pass says "no changes".
		if (section.status === "formatted" && (section.unservedRows ?? 0) + (section.inMainDiffRows ?? 0) > 0) {
			return countsHeader(section.changedLines ?? 0);
		}
		return `[${label}: ${server} · no changes]`;
	}
	const header = countsHeader(section.changedLines ?? section.rows.length);
	const rows = section.rows.map((row) => {
		const marker = row.hash !== "" ? formatRowMarker(row.hash, row.lineNumber, lineNumbers) : "    ";
		return `+${marker} ${row.text}`;
	});
	return [header, ...rows].join("\n");
}
import { replacedOriginalRanges } from "./edit-engine.js";
import type { FormatSection } from "../format/types.js";


export type EditDetails = {
	diff: string;
	firstChangedLine?: number;
	snapshotId?: string;
	classification?: "noop";
	metrics?: RMetrics;
	servedRows?: ServedRow[];
	servedByPath?: Array<{ path: string; servedRows: ServedRow[] }>;
	warnings?: string[];
	driftNotice?: string;
};
type TResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: EditDetails;
};

export type RMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export type RMeta = {
	editsAttempted: number;
	noopEditsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines: number;
	removedLines: number;
};

type NEditEntry = {
	loc: string;
	currentContent: string;
};

export interface NoopInput {
	path: string;
	noopEdit: NEditEntry | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	warnings: string[] | undefined;
	driftNotice?: string;
}

export interface SuccessInput {
	path: string;
	originalNormalized: string;
	originalHashes: string[];
	result: string;
	resultHashes: string[];
	warnings: string[] | undefined;
	snapshotId?: string;
	editMeta: RMeta;
	driftNotice?: string;
	/** The user's line-number switch (#244): diff rows carry `<anchor>:<line>` when on (informational only). */
	lineNumbers?: boolean;
	/** The batch's hunks, when the caller has them — removal-row attribution (#198). */
	hunkShifts?: HunkShift[];
	/** The automatic format pass's report, when it produced one (map #275). */
	format?: FormatSection;
}

export function buildMetrics(args: {
	classification: "applied" | "noop";
	editsAttempted: number;
	noopEditsCount: number;
	warningsCount: number;
	firstChangedLine?: number;
	lastChangedLine?: number;
	addedLines?: number;
	removedLines?: number;
}): RMetrics {
	const metrics: RMetrics = {
		edits_attempted: args.editsAttempted,
		edits_noop: args.noopEditsCount,
		warnings: args.warningsCount,
		classification: args.classification,
	};
	if (
		args.classification === "applied" &&
		args.firstChangedLine !== undefined &&
		args.lastChangedLine !== undefined
	) {
		metrics.changed_lines = {
			first: args.firstChangedLine,
			last: args.lastChangedLine,
		};
	}
	if (args.addedLines !== undefined) metrics.added_lines = args.addedLines;
	if (args.removedLines !== undefined)
		metrics.removed_lines = args.removedLines;
	return metrics;
}

export interface FinalizeInput {
	diff: string;
	warnings?: string[];
	driftNotice?: string;
}

export function finalizeResult(input: FinalizeInput): string {
	const base = input.diff + warnBlock(input.warnings);
	return base + driftBlock(input.driftNotice);
}

export function finalizeToolResult(details: EditDetails): {
	content: Array<{ type: "text"; text: string }>;
	servedRows: ServedRow[] | undefined;
} {
	const text = finalizeResult({
		diff: details.diff,
		warnings: details.warnings,
		driftNotice: details.driftNotice,
	});
	return { content: [{ type: "text", text }], servedRows: details.servedRows };
}

function warnBlock(warnings: string[] | undefined): string {
	return warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
}

function driftBlock(driftNotice: string | undefined): string {
	return driftNotice ? `\n\n${driftNotice}` : "";
}

/**
 * Render the "Shift: lines > N shift by +K" block that tells the model how the
 * edit shifted absolute line numbers below the changed range. The block is
 * omitted when there is no shift (delta = 0) or when the hunk reached the end
 * of the file (no rows below to shift). `startLine` is the absolute line number
 * of the FIRST replacement row (in the new file); `firstStableLineNew` is the
 * line number of the first unchanged row after the hunk; `delta` is the
 * cumulative shift through this hunk; `originalLineCount` is the total file
 * length at edit-time.
 */

export function buildNoop(input: NoopInput): TResult {
	const { path, noopEdit, snapshotId, editMeta, warnings, driftNotice } = input;

	const noopDetailsText = noopEdit
		? `Edit for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
		: "The edit produced identical content.";
	const noticeBlock = driftBlock(driftNotice);
	const text = `No changes made to ${path}\nClassification: noop\n${noopDetailsText}${warnBlock(warnings)}${noticeBlock}`;

	const metrics = buildMetrics({
		classification: "noop",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: "",
			firstChangedLine: undefined,
			snapshotId,
			classification: "noop" as const,
			metrics,
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			...(driftNotice !== undefined ? { driftNotice } : {}),
		},
	};
}

export function buildChanged(input: SuccessInput): TResult {
	const {
		path,
		result,
		warnings,
		snapshotId,
		originalNormalized,
		originalHashes,
		editMeta,
		resultHashes,
		driftNotice,
	} = input;
	const resultLines = visLines(result);
	const diffResult = genDiff(
		originalNormalized,
		result,
		contextLinesCfg(),
		resultHashes,
		originalHashes,
		input.lineNumbers ?? lineNumbersEnabled(),
		{
			path,
			changedRanges: replacedOriginalRanges(input.hunkShifts ?? []),
		},
	);
	const addedLines = editMeta.addedLines;
	const removedLines = editMeta.removedLines;
	const warningsBlock = warnBlock(warnings);
	const successPrefix = `Successfully edited in ${path}.`;
	const lineSummary =
		addedLines > 0 || removedLines > 0
			? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
			: "";
	const noticeBlock = driftBlock(driftNotice);
	const diffBody = renderUnifiedDiff(
		[{ path, blocks: diffResult.blocks }],
		input.lineNumbers ?? lineNumbersEnabled(),
	);
	const formatBlock =
		input.format !== undefined ? `\n\n${renderFormatSection(input.format, input.lineNumbers ?? lineNumbersEnabled())}` : "";
	const text =
		resultLines.length === 0
			? "File is empty. Use edit to insert content." + noticeBlock
			: `${diffBody}${formatBlock}\n\n${successPrefix}${lineSummary}${warningsBlock}${noticeBlock}`;
	const metrics = buildMetrics({
		classification: "applied",
		editsAttempted: editMeta.editsAttempted,
		noopEditsCount: editMeta.noopEditsCount,
		warningsCount: warnings?.length ?? 0,
		firstChangedLine: editMeta.firstChangedLine,
		lastChangedLine: editMeta.lastChangedLine,
		addedLines,
		removedLines,
	});

	return {
		content: [{ type: "text", text }],
		details: {
			diff: diffResult.diff,
			firstChangedLine:
				editMeta.firstChangedLine ?? diffResult.firstChangedLine,
			snapshotId,
			metrics,
			...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
			servedRows: diffResult.servedRows,
			...(driftNotice !== undefined ? { driftNotice } : {}),
			...(input.format !== undefined ? { formats: [input.format] } : {}),
		},
	};
}

export type BatchSection = {
	path: string;
	originalNormalized: string;
	result: string;
	originalHashes: string[];
	resultHashes: string[];
	warnings: string[] | undefined;
	driftNotice: string | undefined;
	appliedCount: number;
	noopCount: number;
	totalAddedLines: number;
	totalRemovedLines: number;
	hunkShifts: HunkShift[];
};

export type BatchDetails = EditDetails;

export function buildBatchResult(sections: BatchSection[]): TResult {
	const totalEdits = sections.reduce(
		(n, s) => n + s.appliedCount + s.noopCount,
		0,
	);
	const appliedFiles = sections.filter((s) => s.appliedCount > 0);
	const appliedTotal = appliedFiles.reduce((n, s) => n + s.appliedCount, 0);
	const noopTotal = sections.reduce((n, s) => n + s.noopCount, 0);
	const addedLines = sections.reduce((n, s) => n + s.totalAddedLines, 0);
	const removedLines = sections.reduce((n, s) => n + s.totalRemovedLines, 0);
	const allNoop = appliedTotal === 0;
	const warnings = sections.flatMap((s) => s.warnings ?? []);
	const driftNotice = sections
		.map((s) => s.driftNotice)
		.filter((d): d is string => d !== undefined)
		.join("\n\n");

	if (allNoop) {
		const text = `No changes made. All ${totalEdits} edit(s) in the batch produced identical content.\nClassification: noop${warnBlock(warnings)}${driftBlock(driftNotice)}`;
		return {
			content: [{ type: "text", text }],
			details: {
				diff: "",
				classification: "noop" as const,
				metrics: buildMetrics({
					classification: "noop",
					editsAttempted: totalEdits,
					noopEditsCount: noopTotal,
					warningsCount: warnings.length,
				}),
				...(warnings.length > 0 ? { warnings } : {}),
				...(driftNotice !== undefined ? { driftNotice } : {}),
			},
		};
	}

	const servedByPath: Array<{ path: string; servedRows: ServedRow[] }> = [];
	const diffFiles: Array<{ path: string; blocks: readonly DiffBlock[] }> = [];
	for (const s of appliedFiles) {
		const diffResult = genDiff(
			s.originalNormalized,
			s.result,
			contextLinesCfg(),
			s.resultHashes,
			s.originalHashes,
			undefined,
			{
				path: s.path,
				changedRanges: replacedOriginalRanges(s.hunkShifts),
			},
		);
		diffFiles.push({ path: s.path, blocks: diffResult.blocks });
		if (diffResult.servedRows.length > 0) {
			servedByPath.push({ path: s.path, servedRows: diffResult.servedRows });
		}
	}
	const diff = renderUnifiedDiff(diffFiles);

	const lineSummary =
		addedLines > 0 || removedLines > 0
			? ` Added ${addedLines} line(s), removed ${removedLines} line(s).`
			: "";
	const summary = `Successfully edited ${appliedFiles.length} file(s) — ${appliedTotal} of ${totalEdits} edit(s) applied${noopTotal > 0 ? ` (${noopTotal} noop)` : ""}.${lineSummary}`;
	const text = `${diff}\n\n${summary}${warnBlock(warnings)}${driftBlock(driftNotice)}`;

	return {
		content: [{ type: "text", text }],
		details: {
			diff,
			metrics: buildMetrics({
				classification: "applied",
				editsAttempted: totalEdits,
				noopEditsCount: noopTotal,
				warningsCount: warnings.length,
				addedLines,
				removedLines,
			}),
			...(warnings.length > 0 ? { warnings } : {}),
			servedRows: servedByPath.flatMap((e) => e.servedRows),
			servedByPath,
			...(driftNotice !== undefined ? { driftNotice } : {}),
		},
	};
}
