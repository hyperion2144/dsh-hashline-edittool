/**
 * The write tool's format section — the one place the automatic pass meets a
 * WHOLE-FILE authorship.
 *
 * The rule that makes this different from the edit engine (G3): a write's
 * model-authored rows never qualify for format-section anchors by authorship
 * alone — eligibility reduces to "the pre-format line was already SERVED
 * before the call". The served set must be captured BEFORE the auto-read
 * preview (whose own mint would otherwise make everything look served);
 * anchors are canonical (whitespace-insensitive), so a pure re-indent
 * legitimately inherits a served line's anchor. Eligible rows quote the
 * preview's fresh anchors (`served.hashes`), so the section is still built
 * only after `readAndServe`.
 *
 * A mode that returns no preview at all (`write.preview: confirmation`, map
 * #354) passes `rowless`: the section keeps the header and the counters and
 * returns NO rows — a row would have to quote an anchor the model cannot
 * address, and content-hash stand-ins are exactly the rows the model cannot
 * write with.
 *
 * @module dsh-hashline-edittool/domain/format/write-section
 */
import { lineHashesPure } from "../../hashline/hash-assign.js";
import { splitLines } from "../../infra/utils.js";
import type { AutoFormatOutcome } from "./auto-format.js";
import { computeRowEligibility } from "./eligibility.js";
import { buildFormatSection, formatterChangedLines } from "./format-section.js";
import type { FormatSection } from "./types.js";

export interface WriteSectionInput {
	/** The pass outcome (`status: "formatted"` only). */
	outcome: AutoFormatOutcome;
	/** The pre-format model text, normalized (LF, BOM-less). */
	modelContent: string;
	sessionKey: string;
	/** The pre-call served anchors, captured BEFORE the preview's mint. */
	preCallServed: ReadonlyMap<string, string>;
	/** Create vs update — a create's rows cannot be "also in the main diff". */
	created: boolean;
	/**
	 * The mode served no preview at all (`write.preview: confirmation`, map #354):
	 * the section keeps its header and counters and returns NO rows. Eligibility
	 * is empty by construction — never content-hash-derived, because that would
	 * render rows whose anchors the model cannot use.
	 */
	rowless?: boolean;
	/** The auto-read preview's per-line anchors (`""` where none was allocated). */
	servedHashes?: string[];
	/**
	 * The pre-disk text, when a faithful per-line view of it exists (absent
	 * on create and for a lossy pre-write read). #312: update withholding
	 * compares against it — a changed row is "in main" only when the model
	 * rewrote the pre-disk line it came from, i.e. the preview renders it.
	 */
	beforeContent?: string;
}

/**
 * The gate's pre-call anchors (#442 P1b): the preview's served anchors where
 * they cover the model content — the family the model actually received. A
 * TRUNCATED preview (a resume window, not the whole file) pads the uncovered
 * lines with `""` (never eligible — the model was never shown an anchor for
 * them), and only a caller with NO preview at all falls back to the pure
 * whole-file assignment (direct/standalone use).
 */
function previewPreCallHashes(
	servedHashes: readonly string[] | undefined,
	lineCount: number,
	modelContent: string,
): readonly string[] {
	if (servedHashes === undefined) return lineHashesPure(modelContent);
	if (servedHashes.length === lineCount) return servedHashes;
	const padded = servedHashes.slice(0, lineCount);
	while (padded.length < lineCount) padded.push("");
	return padded;
}

/**
 * Build the write tool's format section for a successful pass. Must run AFTER
 * the preview: the eligible rows quote the preview's fresh anchors.
 */
export function buildWriteFormatSection(input: WriteSectionInput): FormatSection {
	const modelLines = splitLines(input.modelContent);
	const finalLines = splitLines(input.outcome.content);
	const provenance = input.outcome.finalToModel ?? new Map<number, ReadonlySet<number>>();
	const changed = formatterChangedLines(modelLines, finalLines, provenance);
	if (input.rowless === true) {
		// No echo ⟹ no anchors to quote: header + counters only (#354). The
		// early return also skips building the eligibility gate's input —
		// computing it here would run the very whole-file assignment this
		// module just abolished (#442 review).
		return buildFormatSection({
			status: "formatted",
			...(input.outcome.server !== undefined ? { server: input.outcome.server } : {}),
			...(input.outcome.mode !== undefined ? { mode: input.outcome.mode } : {}),
			...(input.outcome.requested !== undefined ? { requested: input.outcome.requested } : {}),
			...(input.outcome.applied !== undefined ? { applied: input.outcome.applied } : {}),
			finalLines,
			finalHashes: [],
			changed,
			eligibility: new Map<number, boolean>(),
			alsoInMain: new Set<number>(),
		});
	}
	// G3: authorship does NOT qualify on write — only a pre-call served line
	const eligibility = computeRowEligibility({
		finalLineCount: finalLines.length,
		provenance,
		modelTouched: new Set<number>(),
		preCallHashes: previewPreCallHashes(input.servedHashes, modelLines.length, input.modelContent),
		served: input.preCallServed,
	});
	// #312 (spec review): an update withholds a changed row ONLY when the
	// preview provably shows it — the model rewrote the (single) pre-disk
	// line the row came from, so the before→model hunks render that line. A
	// row the model left alone (the formatter fixing stale formatting away
	// from the edit), a merged row, and a lossy pre-write read (no honest
	// before text) all stay section rows — uncertain visibility shows, it
	// never silently drops.
	const alsoInMain = new Set<number>();
	if (!input.created && input.beforeContent !== undefined) {
		const beforeLines = splitLines(input.beforeContent);
		for (const line of changed) {
			const sources = provenance.get(line);
			if (sources === undefined || sources.size !== 1) continue;
			const [source] = sources;
			if (source !== undefined && beforeLines[source - 1] !== modelLines[source - 1]) {
				alsoInMain.add(line);
			}
		}
	}
	return buildFormatSection({
		status: "formatted",
		...(input.outcome.server !== undefined ? { server: input.outcome.server } : {}),
		...(input.outcome.mode !== undefined ? { mode: input.outcome.mode } : {}),
		...(input.outcome.requested !== undefined ? { requested: input.outcome.requested } : {}),
		...(input.outcome.applied !== undefined ? { applied: input.outcome.applied } : {}),
		finalLines,
		finalHashes: input.servedHashes ?? lineHashesPure(input.outcome.content),
		changed,
		eligibility,
		alsoInMain,
		// #315 PR review: stable runs get locators + a restored summary instead
		// of content rows; drift rows (same-text occurrence shifted) stay rows.
		// Create and lossy pre-writes have no honest pre-edit lines — skip.
		...(input.created || input.beforeContent === undefined
			? {}
			: { preEditLines: splitLines(input.beforeContent), finalText: input.outcome.content }),
	});
}
