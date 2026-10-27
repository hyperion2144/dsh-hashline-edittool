/**
 * The `write` tool's MODEL CHANNEL — the one place its model-facing text is
 * assembled.
 *
 * Why a module: the echo's parts are decided in different places (the preview
 * or its absence, the diagnostics push, a lossy pre-write read, the format
 * pass), but the ORDER they take in the text — and the rule that a JSON
 * envelope stays parseable instead of growing prose — is one contract. Every
 * preview mode (`write.preview`) supplies a base and hands it here; a second
 * place that appends sections is a second spelling of the same contract.
 *
 * The base is either prose (`text`) or a JSON payload (`json`). The payload
 * form is what `output_format: json` promises: the section fields ride INSIDE
 * the envelope, so `JSON.parse` keeps working; text mode appends them as
 * markdown-ish sections separated by a blank line.
 *
 * @module dsh-hashline-edittool/domain/write/model-text
 */
import { renderFormatSection } from "../edit/edit-response.js";
import type { FormatSection } from "../format/types.js";

/** Model-facing heading that precedes the auto-read preview (hook parity). */
export const AUTO_READ_HEADING = "--- Auto-read (hashline anchors) ---";

/**
 * #273 (review M2): said when the overwritten file's previous bytes were not
 * valid UTF-8 — no honest per-line diff exists against a U+FFFD stand-in.
 */
export const WRITE_LOSSY_BEFORE_NOTE =
	"[Previous content had undecodable bytes (shown as U+FFFD); its per-line diff is omitted, and the file was fully overwritten as UTF-8.]";

/**
 * The opening line of a confirmation echo — the same sentence the tool has
 * always used when the auto-read preview failed, promoted to a mode's normal
 * output (`write.preview: confirmation`).
 *
 * @param path - the display path the caller wrote.
 * @param operation - create or update.
 * @returns `Wrote <path> (<operation>).`
 */
export function writeConfirmationText(path: string, operation: "create" | "update"): string {
	return `Wrote ${path} (${operation}).`;
}

/** What a preview mode hands the composer: prose, or a JSON envelope to extend. */
export type WriteModelBase =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "json"; readonly payload: Readonly<Record<string, unknown>> };

/**
 * The sections that ride beside the base. Each is optional; an absent section
 * contributes nothing, which is also how "the pass did not run" is spelled.
 */
export interface WriteModelSections {
	/** #131: the diagnostics section (text) and its JSON projection. */
	readonly diagnostics?: { readonly section: string; readonly json?: unknown };
	/** #273: the pre-write bytes were not valid UTF-8. */
	readonly beforeLossy?: boolean;
	/** map #275: the automatic format pass's report. */
	readonly formatSection?: FormatSection;
}

/**
 * Assemble the model text: base, then diagnostics, then the lossy note, then
 * the format section — the order the tool has always used, so a caller that
 * changes only the base (a new preview mode) cannot reorder them by accident.
 *
 * @param base - the prose or JSON the mode decided to open with.
 * @param sections - the optional facts that ride beside it.
 * @returns the final `modelText`.
 */
export function buildWriteModelText(
	base: WriteModelBase,
	sections: WriteModelSections = {},
): string {
	const jsonMode = base.kind === "json";
	let text = base.kind === "json" ? JSON.stringify(base.payload) : base.text;

	if (sections.diagnostics !== undefined && sections.diagnostics.section !== "") {
		text =
			jsonMode && sections.diagnostics.json !== undefined
				? mergeJson(text, { diagnostics: sections.diagnostics.json })
				: `${text}\n\n${sections.diagnostics.section}`;
	}

	if (sections.beforeLossy === true) {
		text = jsonMode
			? mergeJson(text, { beforeLossy: true, warnings: [WRITE_LOSSY_BEFORE_NOTE] })
			: `${text}\n\n${WRITE_LOSSY_BEFORE_NOTE}`;
	}

	if (sections.formatSection !== undefined) {
		text = jsonMode
			? mergeJson(text, { formats: [sections.formatSection] })
			: `${text}\n\n${renderFormatSection(sections.formatSection)}`;
	}

	return text;
}

/**
 * Add fields to an already-serialized JSON envelope. The envelope's own field
 * order is preserved (a later field of the same name would be overwritten),
 * and the result is re-serialized so the caller always gets one valid JSON
 * document.
 */
function mergeJson(text: string, patch: Readonly<Record<string, unknown>>): string {
	return JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), ...patch });
}
