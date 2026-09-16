/**
 * The fs/observed snapshot identity: what a `fileSnap` call returns.
 *
 * This lived in `file-view` and was reached by `fs-bridge` through
 * `file-reader` — a module that only re-exported `file-view`. That made
 * `fs-bridge → file-reader → file-view → fs-bridge` a real two-way
 * dependency: the adapter took an identity helper from the read seam, and the
 * read seam took its `FileIO` interface back from the adapter.
 *
 * The snapshot is a fact about a file on disk and nothing else — `ino`,
 * `mtime`, `ctime`, `size` and the canonical path composed into an id — so it
 * belongs at the bottom with the other filesystem primitives, where both the
 * adapter and the read seam may take it.
 *
 * @module dsh-hashline-edittool/infra/file-snap
 */
import { stat as fsStat } from "node:fs/promises";
import { resolveTarget } from "./paths.js";

/** A file's identity and timestamps, plus the id derived from them. */
export type SnapInfo = {
	snapshotId: string;
	ino: number;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
};

/** Compose the canonical snapshot id. `v2` marks the current field set. */
function fmtSnapId(
	canonicalPath: string,
	info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
): string {
	return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

/**
 * Read the snapshot identity of one path, resolving symlinks first so two
 * spellings of the same file produce the same id.
 *
 * @param absolutePath - the path to stat.
 * @returns the identity, its timestamps, and the composed `snapshotId`.
 */
export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
	const canonicalPath = await resolveTarget(absolutePath);
	const stats = await fsStat(canonicalPath);
	return {
		snapshotId: fmtSnapId(canonicalPath, stats),
		ino: stats.ino,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
		size: stats.size,
	};
}
