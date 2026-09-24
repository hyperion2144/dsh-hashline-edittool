/**
 * Anchor acquisition seam — v2.0 dynamic hashline.
 *
 * Compatibility shim: allocates for ALL lines of the content. New serve
 * points should use `allocateForLines` with specific line numbers for lazy
 * allocation (#169).
 *
 * @module dsh-hashline-edittool/hashline/hash
 */
import { anchorsPure, allocateForLines } from "./session-anchors.js";
import { splitLines } from "../infra/utils.js";

export async function lineHashes(
	content: string,
	path?: string,
	_store?: unknown,
	_persist?: boolean,
): Promise<string[]> {
	if (!path) return anchorsPure(content);
	// Compatibility: allocate for ALL lines. The lazy model's true serve-point
	// entry is `allocateForLines` with specific line numbers.
	return allocateForLines(
		path,
		content,
		Array.from({ length: splitLines(content).length }, (_, i) => i + 1),
	);
}
