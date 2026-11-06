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

/**
 * What `sessionKey` has been shown for `path`, WITH the binding each sighting
 * recorded (#420): anchor → truncated fingerprint of the line's content at
 * serve time. The fingerprint is what lets the verdict tell "the session saw
 * THIS binding" from "the anchor is merely known to it" — a released-and-
 * re-minted anchor carries a different fingerprint, and the session's claim
 * on it expires.
 *
 * Scoped to ONE session by construction: another session's sightings are
 * invisible here, which is what makes "served" mean "the model saw it" rather
 * than "someone did".
 *
 * @param sessionKey - the session whose served mirror to read.
 * @param path - the absolute path the anchors belong to.
 * @returns the served mirror, empty when the session has seen nothing.
 */
export async function loadServed(sessionKey: string, path: string): Promise<Map<string, string>> {
  const store = await loadHashStore();
  return store.getServed(sessionKey, path);
}
