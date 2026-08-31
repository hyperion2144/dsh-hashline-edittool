/**
 * v2 test helpers — adapt legacy tests to the dynamic-hashline contract:
 *   - real anchors come from the allocator (no hardcoded "aB3")
 *   - error-code constants track the renamed vocabulary
 *   - ServedRow / ServedEntry use {position, anchor}
 *
 * @module test/support/v2
 */
import { assignAnchors, allocateAnchor } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/utils.js";
import { canon, contentChecksum } from "../../src/hashline/hash-assign.js";
import { applyHashlineShape, hashlineHeader } from "../../src/hashline/hash-assign.js";

// Pin shape so header strings and hashes stay stable across runs.
applyHashlineShape({ separator: ":", contextLines: 3 });

/** Deterministic per-line anchors for the given content. */
export function anchorsOf(content: string): string[] {
	const lines = splitLines(content);
	if (lines.length === 0) return [];
	const used = new Set<string>();
	const out = new Array<string>(lines.length);
	for (let i = 0; i < lines.length; i++) {
		out[i] = allocateAnchor(used, lines[i]!).anchor;
		used.add(out[i]);
	}
	return out;
}

/** Anchor for `content` line `line` (1-indexed). */
export function anchorAt(content: string, line: number): string {
	const a = anchorsOf(content);
	if (line < 1 || line > a.length) {
		throw new Error(`anchorAt: line ${line} out of range (1..${a.length})`);
	}
	return a[line - 1];
}

/** contentKey for a served row (matches `ServedRow.contentKey`). */
export function contentKeyOf(line: string): string {
	return contentChecksum(canon(line));
}

/** Re-exported runtime header (tests can assert against it). */
export const HEADER = hashlineHeader();

/** Error-code vocabulary (matches `src/hashline/anchor-pipeline.ts`). */
export const ErrCode = {
	E_BAD_REF: "E_BAD_REF",
	E_STALE: "E_STALE",
	E_RANGE_UNSERVED: "E_RANGE_UNSERVED",
	E_RANGE_UNVERIFIED: "E_RANGE_UNVERIFIED",
	E_RANGE_STALE: "E_RANGE_STALE",
	E_BATCH_CONFLICT: "E_BATCH_CONFLICT",
} as const;

/** A short `toContain` snippet of the legacy-bad-ref marker. */
export const LEGACY_BAD_REF_MARKER = "legacy line#hash form is no longer supported";
