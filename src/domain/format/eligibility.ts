/**
 * The eligibility gate: which final lines may carry an anchor.
 *
 * G2's rule, spelled mechanically. A final line is eligible when EITHER:
 *
 * 1. the MODEL created it — a line inside (or descended from) one of the
 *    model's own hunks is always eligible: the main diff shows it, so the
 *    normal mint path serves it, and refusing it an anchor would break the
 *    echo contract the main diff already made; OR
 * 2. a pre-call line it descended from was SERVED this session — the anchor
 *    derivation is content-keyed, so the pre-call line's anchor equals the
 *    final line's anchor whenever the text is unchanged; "served" therefore
 *    transfers through the provenance map by CONTENT, not by position.
 *
 * Everything else — formatter re-indentation of a line the model never saw,
 * formatter-invented text — is INELIGIBLE: it renders anchor-less (the card's
 * four-space placeholder), is not minted, and its served set stays untouched.
 *
 * @module dsh-hashline-edittool/domain/format/eligibility
 */

/**
 * Per-final-line eligibility.
 *
 * @param params.finalLineCount - the final (post-format) line count.
 * @param params.provenance - final line → pre-call source lines
 *   (`composeProvenance`); an absent entry means formatter-invented.
 * @param params.modelTouched - final lines the MODEL's hunks produced
 *   (the engine's own hunks walked through the same provenance walk — H2
 *   supplies the set).
 * @param params.preCallHashes - the content-derived anchors of the PRE-CALL
 *   lines (`lineHashesPure(preCallContent)`, index = line − 1).
 * @param params.served - the session's served anchors for this path
 *   (`loadServed(sessionKey, path)`).
 * @returns final line (1-based) → eligible.
 */
export function computeRowEligibility(params: {
	finalLineCount: number;
	provenance: ReadonlyMap<number, ReadonlySet<number>>;
	modelTouched: ReadonlySet<number>;
	preCallHashes: readonly string[];
	served: ReadonlySet<string>;
}): Map<number, boolean> {
	const { finalLineCount, provenance, modelTouched, preCallHashes, served } = params;
	const eligibility = new Map<number, boolean>();
	for (let line = 1; line <= finalLineCount; line++) {
		if (modelTouched.has(line)) {
			eligibility.set(line, true);
			continue;
		}
		const sources = provenance.get(line);
		if (sources === undefined) {
			eligibility.set(line, false);
			continue;
		}
		let eligible = false;
		for (const source of sources) {
			const hash = preCallHashes[source - 1];
			if (hash !== undefined && served.has(hash)) {
				eligible = true;
				break;
			}
		}
		eligibility.set(line, eligible);
	}
	return eligibility;
}
