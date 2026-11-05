/**
 * Anchors for exactly the rows a diff renders (#188) — ONE method, two callers.
 *
 * The `write` tool's diff preview and `apply_patch`'s `new` section both render a
 * diff and both need every RENDERED row to carry a live anchor (ADR-0009: the
 * model may only edit rows it was served). This module owns that one method; the
 * callers pass their own before/after and get a per-line view back.
 *
 * @module dsh-hashline-edittool/write/rendered-rows
 */

import { genDiff } from "../../render/edit-diff.js";
import { contextLinesCfg } from "../../hashline/hash-assign.js";
import { anchorsFor } from "../session/anchor-state.js";
import { anchorForInWorkspace } from "../session/session-view.js";

/**
 * Anchors for exactly the rows a write's diff renders (#188).
 *
 * Pass 1 runs the text diff against the SPARSE session view (cheap: 43 MB /
 * 112 ms at 800k lines) to learn which new-side lines the diff actually
 * renders; pass 2 allocates anchors for those lines only. The sparse view is
 * also the CORRECT starting point: it pairs surviving content to its new
 * position by contentKey and leaves genuinely new lines unallocated, which is
 * exactly the set pass 2 has to fill. Allocation still goes through the same
 * persisting entry point as before — it just allocates fewer lines.
 *
 * Pass 1's `servedRows` are discarded on purpose: they carry the placeholder
 * markers of an unallocated view, and the caller records pass 2's rows.
 *
 * @param absolutePath - canonical path the write targets.
 * @param before - pre-write content (`""` when the file did not exist).
 * @param after - post-write content, already on disk.
 * @param beforeHashes - the `-` side, when the caller captured it.
 * @param ctx - the session context the mint belongs to. Required because the
 *   anchors are now SERVED here, not merely allocated (#223): serving is
 *   per-session, so this cannot be a bare path-keyed call.
 * @returns a per-line view whose RENDERED rows carry real anchors.
 */
export async function allocateForRenderedRows(
	absolutePath: string,
	before: string,
	after: string,
	beforeHashes: string[] | undefined,
	ctx: { cwd: string; sessionKey: string },
): Promise<string[]> {
	const sparse = anchorsFor(absolutePath, after);
	const firstPass = genDiff(before, after, contextLinesCfg(), sparse, beforeHashes);
	// `servedRows` is the signal, not the rendered rows: it lists exactly the
	// lines genDiff serves, and an EMPTY anchor there is precisely "this line
	// will be shown but has no anchor yet". The rendered `anchor` field cannot
	// be used for this — it is a formatted marker (four spaces when the hash is
	// missing), so it is never the empty string.
	//
	// EVERY row the diff renders, not just the ones missing an anchor: the mint
	// REUSES an anchor whose content still matches, so naming them all costs one
	// lookup each and mints only the ones that need it — while naming only the
	// empty ones leaves the reused rows UNSERVED, which forced the caller to
	// record them in a second write of the same fact (the split §3 removes: an
	// anchor that is live but unserved is an anchor the model cannot write with).
	const rendered = new Set<number>();
	for (const row of firstPass.servedRows) rendered.add(row.position + 1);
	if (rendered.size === 0) return sparse;
	const lines = [...rendered].sort((a, b) => a - b);
	// #223: the one entry point mints (what is missing) AND serves (all of it),
	// in one transaction — so a rendered row is never left in the state where
	// the model can see its anchor and the edit gate refuses it.
	const allocated = await anchorForInWorkspace({
		cwd: ctx.cwd,
		absolutePath,
		content: after,
		lines,
		sessionKey: ctx.sessionKey,
	});
	const filled = [...sparse];
	for (let i = 0; i < lines.length; i++) {
		filled[lines[i]! - 1] = allocated[i] ?? "";
	}
	return filled;
}
