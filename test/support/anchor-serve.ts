/**
 * Test-side anchor serving, through the ONE allocate entry point.
 *
 * `allocateForLines` and `lineHashes` were deleted (contract §2: `anchorFor` is
 * the single allocate path; a second one existed only as a compatibility shim
 * and had no production caller). Tests still need to say "the model has seen
 * these lines now", so these two helpers say exactly that — by calling
 * `anchorFor`, the same way a tool result does.
 *
 * The two keep the DELETED shims' argument orders on purpose
 * (`serveLines(path, content, lines)` and `servedAnchors(content, path)`, which
 * were opposite), so a call site only changes its import. They are `async`
 * because `anchorFor` is: an allocation is a write, and a write is awaited.
 *
 * @module test/support/anchor-serve
 */
import { anchorFor } from "../../src/domain/session/anchor-entry.js";
import { anchorsFor, registerAnchorPersistence } from "../../src/domain/session/anchor-state.js";
import type { PersistedAnchorLine, PersistedAnchorState } from "../../src/domain/session/anchor-state.js";
import { splitLines } from "../../src/infra/utils.js";

/** Every 1-based line number of `content`. */
function allLines(content: string): number[] {
	return Array.from({ length: splitLines(content).length }, (_, i) => i + 1);
}

/**
 * Serve `lines` of `path` and return their anchors (in `lines` order).
 *
 * Replaces `allocateForLines(path, content, lines)`.
 *
 * @param path - absolute path being served.
 * @param content - the file's current text.
 * @param lines - 1-based lines to serve; all of them when omitted.
 * @param sessionKey - whose served set records it.
 * @returns one anchor per requested line.
 */
export async function serveLines(
	path: string,
	content: string,
	lines?: readonly number[],
	sessionKey = "test-session",
): Promise<string[]> {
	const { anchors } = await anchorFor({
		path,
		content,
		lines: lines === undefined ? allLines(content) : [...lines],
		sessionKey,
	});
	return [...anchors];
}

/**
 * Serve every line of `content` and return the dense anchor view.
 *
 * Replaces `lineHashes(content, path)`. Note the argument order: CONTENT first,
 * which is the deleted shim's order, not `serveLines`'.
 *
 * @param content - the file's current text.
 * @param path - absolute path being served.
 * @param sessionKey - whose served set records it.
 * @returns one anchor per line, `""` where none could be allocated.
 */
export async function servedAnchors(
	content: string,
	path: string,
	sessionKey = "test-session",
): Promise<string[]> {
	await anchorFor({ path, content, lines: allLines(content), sessionKey });
	return anchorsFor(path, content);
}

/**
 * An in-memory anchor-state PORT — the store's contract without sqlite.
 *
 * `domain/session/anchor-state` holds the rows and no state of its own beyond
 * the record, reached through `registerAnchorPersistence`. Unit tests of the
 * pure allocation / remap logic have no database, so they register this — the
 * same five methods, backed by a Map — and the code under test cannot tell the
 * difference. Before, those tests passed by accident: the module kept a private
 * cache and `anchorsFor` read it, so "the store" was optional.
 *
 * @returns the handle for resetting/disposing the registration.
 */
export function useMemoryAnchorStore(): { reset: () => void; dispose: () => void } {
	// Meta and rows are separate maps on purpose: the real store writes the row
	// family and the meta row in either order (`persistAnchorState` upserts rows
	// first, then the meta row), and `get` answers undefined until the META row
	// exists — that is the gate the real `anchorMetaGet` provides.
	const meta = new Map<string, { checksum: string; lineCount: number }>();
	const rows = new Map<string, Map<number, PersistedAnchorLine>>();
	const rowsOf = (path: string): Map<number, PersistedAnchorLine> => {
		const existing = rows.get(path);
		if (existing !== undefined) return existing;
		const created = new Map<number, PersistedAnchorLine>();
		rows.set(path, created);
		return created;
	};
	registerAnchorPersistence({
		probe: (path) => meta.get(path)?.checksum,
		get: (path) => {
			const m = meta.get(path);
			if (m === undefined) return undefined;
			const lines = [...rowsOf(path).values()].sort((a, b) => a.line - b.line);
			return { checksum: m.checksum, lineCount: m.lineCount, lines: lines.map((l) => ({ ...l })) };
		},
		put: (path, state) => {
			meta.set(path, { checksum: state.checksum, lineCount: state.lineCount });
			const target = new Map<number, PersistedAnchorLine>();
			for (const line of state.lines) target.set(line.line, { ...line });
			rows.set(path, target);
		},
		putLines: (path, lines) => {
			const target = rowsOf(path);
			for (const line of lines) target.set(line.line, { ...line });
		},
		putMeta: (path, checksum, lineCount, dropLine) => {
			meta.set(path, { checksum, lineCount });
			if (dropLine !== undefined) rowsOf(path).delete(dropLine);
		},
	});
	return {
		reset: () => {
			meta.clear();
			rows.clear();
		},
		dispose: () => {
			meta.clear();
			rows.clear();
			registerAnchorPersistence(undefined);
		},
	};
}
