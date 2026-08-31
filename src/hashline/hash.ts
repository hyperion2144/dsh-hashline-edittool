/**
 * Anchor acquisition seam — v2.0 dynamic hashline.
 *
 * The v1.0-style pure content hash (fixed 3-char, deterministic per line) is
 * replaced by allocated variable-length anchors. Session state lives in
 * session-anchors.ts: per-path snapshots keyed by content checksum, held in
 * memory only (spec §4.4 — no disk persistence; cross-session consistency
 * comes from deterministic recomputation, not from a stored mapping).
 *
 * The legacy `store` / `persist` parameters are accepted for call-site
 * compatibility and ignored: the old on-disk hash-store snapshots (fixed
 * 3-char hashes under the same checksum key) are deliberately NOT consulted —
 * the allocation format changed and stale rows would be wrong.
 *
 * @module dsh-hashline-edittool/hashline/hash
 */
import { anchorsFor, anchorsPure } from "./session-anchors.js";

export async function lineHashes(
	content: string,
	path?: string,
	_store?: unknown,
	_persist?: boolean,
): Promise<string[]> {
	if (!path) return anchorsPure(content);
	return anchorsFor(path, content);
}