/**
 * Line provenance across a format pass — which pre-call line ended up where.
 *
 * The anchor contract (ADR-0019, decision B) splits the attribution question
 * in two. The MAIN diff renders the model's edit and mints anchors from the
 * post-EDIT content. Formatting then reshuffles that content before it is
 * written, and a formatter-changed line may only carry an anchor when the
 * line it came from was already served THIS session — otherwise the plugin
 * would mint anchors for text the model has never seen (G2's eligibility
 * rule). Both rules need the same map: final line → pre-call source line(s).
 *
 * That map is composed from two exact, testable walks:
 *
 * 1. **Model hunks → model lines** (`lineMapFromHunks`): the engine knows its
 *    own hunks exactly — no re-diff ambiguity over identical lines. A
 *    replacement line inherits the SET of original lines its range replaced
 *    (the all-inheritance policy: a served line split into three gives all
 *    three the same eligibility; a merge gives the survivor the union).
 * 2. **Applied TextEdits → final lines** (`lineMapFromTextEdits`): the
 *    formatter's own edits, applied offsets — again exact, again no re-diff.
 *    A final line an edit produced inherits the model line-range that edit
 *    touched; a final line no edit touched keeps its identity.
 *
 * The composition (`composeProvenance`) unions the two hops per final line.
 * A final line with NO path back to a pre-call line (formatter-brand-new
 * text) has no entry — and "no entry" is exactly what the eligibility layer
 * reads as unserved.
 *
 * All line numbers are 1-based; ranges are inclusive on both ends.
 *
 * @module dsh-hashline-edittool/domain/format/provenance
 */

/** One applied hunk, in the engine's own bookkeeping (1-based, inclusive). */
export interface ProvenanceHunk {
	/** First original line the hunk replaced (1-based). */
	readonly originalStartLine: number;
	/** Last original line the hunk replaced (1-based; == start for an insert). */
	readonly originalEndLine: number;
	/** First line of the replacement, in the POST-hunk content (1-based). */
	readonly newStartLine: number;
	/** How many lines the replacement has (0 for a pure delete). */
	readonly newLineCount: number;
}

/**
 * Map post-hunk lines to the original lines they replaced.
 *
 * Hunks must be ordered by original position (the engine's order).
 * Context lines between hunks map 1:1 with the running shift; lines inside a
 * replacement inherit the WHOLE replaced range — the split/merge "all"
 * policy, so every descendant of one served line shares its fate.
 *
 * @param originalLineCount - line count of the pre-hunk content.
 * @param hunks - the model's hunks, ascending.
 * @returns post-hunk line (1-based) → replaced original lines.
 */
export function lineMapFromHunks(
	originalLineCount: number,
	hunks: readonly ProvenanceHunk[],
): Map<number, ReadonlySet<number>> {
	const map = new Map<number, ReadonlySet<number>>();
	let original = 1;
	let shifted = 0;
	for (const hunk of hunks) {
		// Context before the hunk: one-to-one with the shift so far.
		for (let line = original; line < hunk.originalStartLine; line++) {
			map.set(line + shifted, new Set([line]));
		}
		original = hunk.originalEndLine + 1;
		// Replacement lines inherit the replaced range as a SET. A pure delete
		// contributes nothing (the original lines have no final line).
		for (let i = 0; i < hunk.newLineCount; i++) {
			const sources = new Set<number>();
			for (let line = hunk.originalStartLine; line <= hunk.originalEndLine; line++) {
				sources.add(line);
			}
			map.set(hunk.newStartLine + i, sources);
		}
		shifted += hunk.newLineCount - (hunk.originalEndLine - hunk.originalStartLine + 1);
	}
	// Trailing context.
	for (let line = original; line <= originalLineCount; line++) {
		map.set(line + shifted, new Set([line]));
	}
	return map;
}

/**
 * Map final lines to the model lines the formatter's edits touched.
 *
 * The walk replays the applied TextEdits over the MODEL content (the text the
 * edits were computed against), tracking the line shift each edit causes:
 * untouched spans map 1:1; the lines an edit REPLACED are inherited by every
 * line its `newText` produced — including lines inside a multi-line
 * replacement, which all inherit the touched range together.
 *
 * @param modelLineCount - line count of the pre-format (post-model) text.
 * @param edits - the applied edits, in ANY order (sorted here); ranges must
 *   be non-overlapping and document-bounded (the applier already refused
 *   anything else).
 * @returns final line (1-based) → model lines it came from. A final line
 *   absent from the map has NO model source (formatter-invented).
 */
export function lineMapFromTextEdits(
	modelLineCount: number,
	edits: readonly {
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
		newText: string;
	}[],
): Map<number, ReadonlySet<number>> {
	const ordered = [...edits].sort(
		(a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character,
	);
	const map = new Map<number, ReadonlySet<number>>();
	let modelLine = 1; // next untouched model line (1-based)
	let finalLine = 1; // where the next mapped line lands
	for (const edit of ordered) {
		const startLine = edit.range.start.line + 1; // 1-based, inclusive
		const endLine = edit.range.end.line + 1; // 1-based, inclusive
		// Untouched model lines before the edit.
		for (let line = modelLine; line < startLine; line++) {
			map.set(finalLine, new Set([line]));
			finalLine += 1;
		}
		// The lines the edit's newText produces inherit the touched range.
		// Trailing-newline convention: "a\n" is ONE line, matching the read
		// line space — the split's empty tail is not a real line.
		const produced =
			edit.newText.length === 0
				? []
				: (edit.newText.endsWith("\n") ? edit.newText.slice(0, -1) : edit.newText).split("\n");
		for (let i = 0; i < produced.length; i++) {
			const sources = new Set<number>();
			for (let line = startLine; line <= endLine; line++) sources.add(line);
			map.set(finalLine, sources);
			finalLine += 1;
		}
		// An edit ending AT a line start (character 0) does not consume that
		// line's text — only the newline before it — so the line survives
		// with its identity. Any other end position consumes the line whole.
		modelLine = edit.range.end.character > 0 ? endLine + 1 : endLine;
	}
	// Trailing untouched lines.
	for (let line = modelLine; line <= modelLineCount; line++) {
		map.set(finalLine, new Set([line]));
		finalLine += 1;
	}
	return map;
}

/**
 * Compose the two hops: final line → model lines → pre-call lines.
 *
 * @param finalToModel - {@linkcode lineMapFromTextEdits}' result.
 * @param modelToPreCall - {@linkcode lineMapFromHunks}' result over the
 *   model's own hunks (post-hunk line = model line).
 * @returns final line → the pre-call lines it came from; a final line with no
 *   pre-call ancestor (formatter-invented) has no entry.
 */
export function composeProvenance(
	finalToModel: ReadonlyMap<number, ReadonlySet<number>>,
	modelToPreCall: ReadonlyMap<number, ReadonlySet<number>>,
): Map<number, ReadonlySet<number>> {
	const composed = new Map<number, ReadonlySet<number>>();
	for (const [finalLine, modelLines] of finalToModel) {
		const preCall = new Set<number>();
		for (const modelLine of modelLines) {
			const sources = modelToPreCall.get(modelLine);
			if (sources === undefined) continue;
			for (const source of sources) preCall.add(source);
		}
		if (preCall.size > 0) composed.set(finalLine, preCall);
	}
	return composed;
}
