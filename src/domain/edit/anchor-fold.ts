/**
 * Anchor fold — the ONE domain step that turns a raw model-supplied ref into
 * a prepared edit item. Salvage of pasted-row forms, the weak line hint, the
 * declared line, and the ref warnings all happen HERE, once (#261
 * normalize-once), so `edit`, `ast_edit` and `apply_patch`'s preflight can
 * never disagree about one token. The drift this seam prevents used to show
 * up as edits that landed on the wrong lines — for one of the tools only.
 *
 * Lives in domain because folding is a RULE, not a tool affordance: the
 * layering forbids domain/patch from importing tools/, which is exactly why
 * preflight once re-derived a 7-field subset and the two folds diverged.
 *
 * @module dsh-hashline-edittool/edit/anchor-fold
 */

import { declaredLineOf, type EditOp } from "../../contract/contract.js";
import type { AnchorRef } from "../../hashline/declaration.js";
import { encodeText, salvageAnchorRef } from "../../hashline/anchor-pipeline.js";
import type { PreparedItem } from "./edit-engine.js";

/** The raw reference string of an anchor field (declaration form → its anchor). */
function rawAnchor(field: AnchorRef): string {
	return typeof field === "string" ? field : String((field as { anchor?: unknown }).anchor ?? "");
}

/**
 * Fold one `edits[i]` — or one patch hunk, shaped the same — into a
 * {@link PreparedItem}. Resolves the per-item `path` against the top-level
 * fallback, defaults `anchor_end` to `anchor_start` when omitted, and maps
 * `op: "del"` to `replacement_text: ""`. The `op: "ins"` case is left to
 * `applyOne`/`resolveIns` — the `replacement_text` is still the raw
 * `lines.join("\n")` here because the anchor's own content needs to be read
 * first.
 *
 * Anchor REFS are salvaged HERE (#261 normalize-once): pasted rows reduce to
 * reference forms once, so `resolveIns` and `resEdit` can no longer disagree
 * about one token. Ins's folded end reuses the start's salvage, so one pasted
 * anchor warns exactly once.
 *
 * @param index - the item's position in the batch.
 * @param topLevelPath - the call-level `path`, the per-item fallback.
 * @param item - the raw request item (contract shape).
 * @param absolutePath - the resolved path of the file this item edits.
 */
export function buildPreparedItem(
	index: number,
	topLevelPath: string,
	item: {
		op?: EditOp;
		// Both optional here: which one is REQUIRED depends on `op`, and the
		// contract has already enforced that. `ins` arrives with `anchor_after`
		// and no `anchor_start`; the other two, the reverse.
		anchor_start?: AnchorRef;
		anchor_after?: AnchorRef;
		anchor_end?: AnchorRef;
		lines?: string[];
		pattern?: string;
		replacement?: string;
		flags?: string;
		path?: string;
	},
	absolutePath: string,
): PreparedItem {
	const itemPath = item.path ?? topLevelPath;
	// v2.0.3: anchor_end optional — omitted defaults to the anchor_start line
	// (single-line replace/delete). A multi-line replace without anchor_end was
	// already rejected by assertEditItem (the host runner may pass frozen args,
	// so the fold happens here by CONSTRUCTING the PreparedItem, not mutating).
	// require_line_content: the `{ anchor, line }` declaration form folds to
	// the anchor string here, with the declared text carried as expected*
	// fields for the pipeline gate (declaration.ts). An OMITTED anchor_end
	// declares nothing for the end boundary (contract #76: only start).
	const startAnchor = item.op === "ins" ? item.anchor_after : item.anchor_start;
	if (startAnchor === undefined) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}] has no anchor: op:"ins" takes "anchor_after", the other ops take "anchor_start".`,
		);
	}
	// #261 normalize-once: salvage pasted-row refs (`<anchor>:<content>`, diff
	// markers, multi-line blocks) HERE, once — the same salvage `resEdit`
	// applies — so `resolveIns`'s strict parse and the pipeline's forgiving
	// strip can no longer disagree about one token (that disagreement let an
	// un-expanded ins REPLACE its anchor line). Ins's folded end reuses the
	// start's salvage, so one pasted anchor warns exactly once.
	const refWarnings: string[] = [];
	const startLabel = item.op === "ins" ? "anchor_after" : "anchor_start";
	const startRef = salvageAnchorRef(rawAnchor(startAnchor), refWarnings, startLabel);
	const endRef =
		item.anchor_end !== undefined
			? salvageAnchorRef(rawAnchor(item.anchor_end), refWarnings, "anchor_end")
			: startRef;
	const replacementText =
		item.op === "del"
			? ""
			: encodeText(item.lines ?? []);
	return {
		index,
		path: itemPath,
		absolutePath,
		remove_from: startRef,
		remove_to: endRef,
		replacement_text: replacementText,
		op: item.op ?? "replace",
		// `op: "sed"` carries its substitution through untouched: the regex runs
		// in the engine, over the resolved range's own lines.
		...(item.pattern !== undefined ? { pattern: item.pattern } : {}),
		...(item.replacement !== undefined ? { replacement: item.replacement } : {}),
		...(item.flags !== undefined ? { flags: item.flags } : {}),
		expectedStart: declaredLineOf(startAnchor),
		...(item.anchor_end !== undefined
			? { expectedEnd: declaredLineOf(item.anchor_end) }
			: {}),
		...(refWarnings.length > 0 ? { refWarnings } : {}),
	};
}
