/**
 * `loadServed` — the ONE served read the anchor primitives need.
 *
 * It sits in its own leaf module for a layering reason, not a cosmetic one:
 * `session-view` already imports the primitives from `anchor-entry` (the
 * scope-aware mint, and `markReleased` for the release pool), so if
 * `anchor-entry` read served back out of `session-view` the two modules would
 * form a cycle. A shared read belongs BELOW both:
 *
 * ```text
 *   anchor-entry ─┐
 *                 ├─→ served  ─→ hash-store
 *   session-view ─┘
 * ```
 *
 * `session-view` re-exports this name, because it is part of that module's
 * public vocabulary (the served view) — callers that already import it from
 * there do not have to care which file it physically lives in.
 *
 * @module dsh-hashline-edittool/domain/session/served
 */
import { loadHashStore } from "./hash-store.js";

/**
 * The anchors `sessionKey` has been shown for `path`.
 *
 * Scoped to ONE session by construction: another session's sightings are
 * invisible here, which is what makes "served" mean "the model saw it" rather
 * than "someone did".
 *
 * @param sessionKey - the session whose served mirror to read.
 * @param path - the absolute path the anchors belong to.
 * @returns the served anchor set, empty when the session has seen nothing.
 */
export async function loadServed(sessionKey: string, path: string): Promise<Set<string>> {
	const store = await loadHashStore();
	return store.getServed(sessionKey, path);
}
