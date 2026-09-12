/**
 * The `read` tool's **structural-summary** form: a whole-file outline that
 * folds bodies, import runs and block comments while keeping every delimiter
 * line verbatim.
 *
 * Three properties the renderer is built around:
 *
 * 1. **Nothing is reconstructed.** A kept line is the source line, byte for
 *    byte — including a multi-line signature, which is why the opener and the
 *    closer of every fold stay visible.
 * 2. **A merged row is visibly not a normal row.** Its prefix is a *range*
 *    (`20-34:cd`), which is the only reason a model can tell "this line
 *    represents lines 20–34" from "this is line 20's content". Without it the
 *    outline would be copied back as source.
 * 3. **Served is endpoints, not interiors.** A merged row marks its first and
 *    last line as seen — which is exactly the proof the edit contract's
 *    "block's last line must be served" rule needs — while folded interiors
 *    stay unseen, so no line can be edited without having been shown.
 *
 * @module dsh-hashline-edittool/read-summary
 */
import {
	AST_ADMIT_LIMIT_SOURCE_BYTES,
	AST_SUMMARY_MAX_BYTES,
	AST_SUMMARY_MAX_LINES,
	AST_SUMMARY_MIN_BODY_LINES,
	AST_SUMMARY_MIN_COMMENT_LINES,
	AST_SUMMARY_MIN_SHRINK_RATIO,
	AST_SUMMARY_MIN_TOTAL_LINES,
} from "./constants.js";
import type { ElisionSpan } from "./ast/elide.js";
import { canon, contentChecksum } from "./hashline/hash-assign.js";
import type { ServedRow } from "./hashline/served.js";

/** The elision marker. U+2026, never `...` — that is a legal token in JS/Python. */
export const ELISION_MARKER = "…";

/** Whether a payload string carries an outline row back into an edit. */
export function containsElisionMarker(text: string): boolean {
	return text.includes(ELISION_MARKER);
}

/** One rendered row. */
export interface SummaryRow {
	/** 1-indexed line for a kept row; the fold's opener for a merged row. */
	readonly number: number;
	/** Last line for a merged row; equal to `number` for a kept row. */
	readonly endNumber: number;
	/** The anchor to show. */
	readonly anchor: string;
	readonly text: string;
	readonly merged: boolean;
}

/** A rendered outline. */
export interface SummaryRender {
	readonly rows: readonly SummaryRow[];
	/** Lines the model has seen: kept lines plus both endpoints of every fold. */
	readonly servedLines: number[];
	readonly elidedLines: number;
	readonly foldedUnits: number;
}

/** Why a file was not summarised, for the caller's fallback decision. */
export type SummaryRefusal =
	| "too-few-lines"
	| "too-many-lines"
	| "too-many-bytes"
	| "no-elisions"
	| "not-worth-it";

/** Gate decision for the summary form. */
export function summaryGate(input: {
	readonly totalLines: number;
	readonly byteLength: number;
}): SummaryRefusal | undefined {
	if (input.totalLines < AST_SUMMARY_MIN_TOTAL_LINES) return "too-few-lines";
	if (input.totalLines > AST_SUMMARY_MAX_LINES) return "too-many-lines";
	// The spec's two byte ceilings nest; the smaller one wins (spec §10).
	const cap = Math.min(AST_SUMMARY_MAX_BYTES, AST_ADMIT_LIMIT_SOURCE_BYTES);
	if (input.byteLength > cap) return "too-many-bytes";
	return undefined;
}

/** Render rows for a set of disjoint folds. */
export function renderSummary(input: {
	readonly lines: readonly string[];
	readonly hashes: readonly string[];
	readonly spans: readonly ElisionSpan[];
}): SummaryRender {
	const { lines, hashes, spans } = input;
	const total = lines.length;
	const rows: SummaryRow[] = [];
	const served = new Set<number>();
	let elidedLines = 0;
	let i = 1; // 1-indexed cursor

	const keep = (line: number): void => {
		rows.push({
			number: line,
			endNumber: line,
			anchor: hashes[line - 1] ?? "",
			text: lines[line - 1] ?? "",
			merged: false,
		});
		served.add(line);
	};

	for (const span of spans) {
		for (; i < span.openerLine; i++) keep(i);
		const openText = (lines[span.openerLine - 1] ?? "").trimEnd();
		const closeText = (lines[span.closerLine - 1] ?? "").trimStart();
		rows.push({
			number: span.openerLine,
			endNumber: span.closerLine,
			// The anchor is the OPENER's: it is the line an edit would name to
			// replace the whole construct.
			anchor: hashes[span.openerLine - 1] ?? "",
			text: `${openText} ${ELISION_MARKER} ${closeText}`,
			merged: true,
		});
		// Both endpoints count as seen — the fold's own claim is "these two
		// lines, and nothing between them".
		served.add(span.openerLine);
		served.add(span.closerLine);
		elidedLines += span.endLine - span.startLine + 1;
		i = span.closerLine + 1;
	}
	for (; i <= total; i++) keep(i);

	return {
		rows,
		servedLines: [...served].sort((a, b) => a - b),
		elidedLines,
		foldedUnits: spans.length,
	};
}

/**
 * Whether the outline is worth replacing the source.
 *
 * An outline as long as the file, having *replaced* the content, is worse than
 * the source: the model pays the same tokens and loses the code. Refusing here
 * sends the caller back to line mode.
 */
export function summaryIsWorthIt(rendered: SummaryRender, totalLines: number): boolean {
	if (renderTotal(rendered) === 0) return false;
	return renderTotal(rendered) / totalLines < AST_SUMMARY_MIN_SHRINK_RATIO;
}

function renderTotal(rendered: SummaryRender): number {
	return rendered.rows.length;
}

/** The footer naming what was folded and how to get it back. */
export function summaryFooter(input: {
	readonly path: string;
	readonly rendered: SummaryRender;
	readonly fallbackReason?: string;
}): string {
	const { rendered } = input;
	const ranges = rendered.rows
		.filter((row) => row.merged)
		.map((row) => `${row.number}-${row.endNumber + 1}`);
	const list = ranges.length > 2 ? `${ranges.slice(0, 2).join(",")}, …` : ranges.join(",");
	return (
		`[${rendered.elidedLines}ln elided; re-read needed ranges with ${input.path}:${list}]` +
		(input.fallbackReason === undefined ? "" : ` (${input.fallbackReason})`)
	);
}

/**
 * The outline's served rows, in the session store's own shape.
 *
 * The `contentKey` is built exactly as `file-view` builds it — a drift check
 * compares it against a re-hash of the line at edit time, so a row whose key
 * came from anywhere else would look permanently stale.
 */
export function servedRowsFor(
	rendered: SummaryRender,
	lines: readonly string[],
	hashes: readonly string[],
): ServedRow[] {
	return rendered.servedLines.map((line) => ({
		position: line - 1,
		anchor: hashes[line - 1] ?? "",
		contentKey: contentChecksum(canon(lines[line - 1] ?? "")),
	}));
}
