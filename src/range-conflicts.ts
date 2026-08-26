/**
 * RangeConflicts — batch edit conflict detection.
 *
 * Batch edits resolve against one file snapshot (concurrent semantics): every
 * hunk's `line#hash` anchor refers to the original file, so two hunks may be
 * applied together iff their ranges cannot interfere. This module owns the
 * interference rule set so it can be unit-tested in isolation:
 *
 *   - two replace/del ranges conflict when their line intervals intersect
 *     (inclusive endpoints — deleting line 6 while replacing 4-6 is a clash);
 *   - two `ins` hunks conflict when both insert after the same anchor line;
 *   - an `ins` conflicts with a replace/del when its anchor line lies inside
 *     the other hunk's range (the insertion point disappears); inserting right
 *     BEFORE the range (anchor line < range start) is unambiguous and allowed.
 *
 * @module dsh-hashline-edittool/range-conflicts
 */

import { formatLineRange } from "./utils.js";

export interface RangeEdge {
	/** 0-based position of the hunk in the batch (for error messages). */
	index: number;
	/** 1-indexed first line of the range in the ORIGINAL snapshot. */
	startLine: number;
	/** 1-indexed last line of the range in the ORIGINAL snapshot. */
	endLine: number;
	/** `op:"ins"` — the start/end line is the anchor line, insert goes after it. */
	isIns: boolean;
}

/** An unordered conflicting pair (edge order preserved from the input). */
export type ConflictPair = [RangeEdge, RangeEdge];

function rangesOverlap(
	a: RangeEdge,
	b: RangeEdge,
): boolean {
	return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function insConflictsWithRange(
	ins: RangeEdge,
	range: RangeEdge,
): boolean {
	// Half-open rule: the ins anchor may sit on the range's END line (a
	// batch applies back-to-front, so the gap insert lands after the range
	// and neither replace nor del touches it), but never on its start or
	// interior — inserting into a range being rewritten/deleted is
	// ambiguous and rejects.
	return (
		ins.startLine >= range.startLine &&
		ins.startLine < range.endLine
	);
}

/**
 * Return every conflicting pair of edges. Edges never conflict with
 * themselves; pairs are reported once in input order (i < j).
 */
export function detectRangeConflicts(edges: RangeEdge[]): ConflictPair[] {
	const conflicts: ConflictPair[] = [];
	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 1; j < edges.length; j++) {
			const a = edges[i]!;
			const b = edges[j]!;
			let clash: boolean;
			if (a.isIns && b.isIns) {
				clash = a.startLine === b.startLine;
			} else if (a.isIns) {
				clash = insConflictsWithRange(a, b);
			} else if (b.isIns) {
				clash = insConflictsWithRange(b, a);
			} else {
				clash = rangesOverlap(a, b);
			}
			if (clash) conflicts.push([a, b]);
		}
	}
	return conflicts;
}

/** Human summary of one edge, e.g. `edits[0] lines 4..6` / `edits[1] insert after line 3`. */
export function describeEdge(edge: RangeEdge): string {
	if (edge.isIns) {
		return `edits[${edge.index}] insert after line ${edge.startLine}`;
	}
	return `edits[${edge.index}] ${formatLineRange(edge.startLine, edge.endLine)}`;
}
