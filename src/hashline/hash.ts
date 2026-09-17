/**
 * Anchor acquisition seam — v2.0 dynamic hashline.
 *
 * The v1.0-style pure content hash (fixed 3-char, deterministic per line) is
 * replaced by allocated variable-length anchors. Session state lives in
 * replaced by allocated variable-length anchors. Session state lives in
 * session-anchors.ts: per-path snapshots keyed by content checksum, cached in
 * memory and PERSISTED per cwd + path in the sqlite hash-store (issue #136 —
 * spec §4.4's "no disk persistence" clause is superseded; a cache miss
 * recovers from the store instead of recomputing). Cold starts and true first
 * external changes — inherits by line alignment through the lifecycle gate
 * (anchorsFor), so unchanged lines keep their anchors.
 *
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