/**
 * Hash persistence — deep persistence wrapper for HashAssign.
 * Private to HashAssign seam; use `from "./hash-assign.js"` for pure APIs
 * and `from "./hash.js"` only for persistence-aware lineHashes.
 *
 * Hashes are deterministic content signatures, so after an edit the new
 * hashes are a plain recomputation — no stable-mapping pass, no previous
 * snapshot to carry over. The hash store only caches per-path snapshots to
 * skip repeated O(n) recomputation across tool calls.
 *
 * @module dsh-hashline-edittool/hashline/hash
 */
import { splitLines } from "../utils.js";
import { loadHashStore, type HashStore } from "../hash-store.js";
import { contentChecksum, lineHashesPure } from "./hash-assign.js";

export async function lineHashes(
	content: string,
	path?: string,
	store?: HashStore,
	persist?: boolean,
): Promise<string[]> {
	if (!path) return lineHashesPure(content);
	const hashStore = store ?? (await loadHashStore());
	let cached: string[] | undefined;
	try {
		cached = hashStore.getSnapshot(path, content, persist !== false);
	} catch (e) {
		console.error("Failed to read hash store snapshot:", e);
	}
	if (cached) return cached;
	const newHashes = lineHashesPure(content);
	if (persist !== false) {
		try {
			hashStore.upsertSnapshot(
				path,
				contentChecksum(content),
				splitLines(content).length,
				newHashes,
			);
		} catch (e) {
			console.error("Failed to persist hash snapshot:", e);
		}
	}
	return newHashes;
}