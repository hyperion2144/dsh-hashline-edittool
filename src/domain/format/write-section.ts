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
	preCallServed: ReadonlySet<string>;
	/** Create vs update — a create's rows cannot be "also in the main diff". */
	created: boolean;
	/** The auto-read preview's per-line anchors (`""` where none was allocated). */
	servedHashes?: string[];
}

/**
 * Build the write tool's format section for a successful pass. Must run AFTER
 * the preview: the eligible rows quote the preview's fresh anchors.
 */
export function buildWriteFormatSection(input: WriteSectionInput): FormatSection {
	const modelLines = splitLines(input.modelContent);
	const finalLines = splitLines(input.outcome.content);
	const provenance = input.outcome.finalToModel ?? new Map<number, ReadonlySet<number>>();
	// G3: authorship does NOT qualify on write — only a pre-call served line
	const eligibility = computeRowEligibility({
		finalLineCount: finalLines.length,
		provenance,
		modelTouched: new Set<number>(),
		preCallHashes: lineHashesPure(input.modelContent),
		served: input.preCallServed,
	});
	const changed = formatterChangedLines(modelLines, finalLines, provenance);
	// An update's before→after hunks already show every formatter-touched row
	// (they differ from the pre-disk text); a create renders no diff rows.
	const alsoInMain = input.created ? new Set<number>() : changed;
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
	});
}
