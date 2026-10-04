/**
 * `observeServedRows` — the scope-aware serve primitive.
 *
 * Field-reported shape of the bug it exists to prevent: `lsp` and `ast_grep`
 * wrote their served rows with a bare `recordServed`, and neither tool wraps
 * its body in `withWorkspace`. Every store read and write resolves its
 * database from the cwd (`loadHashStore` → `hashStorePath` → `configDir`), so
 * with no cwd those rows landed in the SHARED
 * `$DSH_HOME/plugins/dsh-hashline-edittool/hash-store.sqlite` instead of the
 * per-project `…/--<projectKey>--/…` one that `read` and `edit` use. The card
 * showed anchors the next edit could not find.
 *
 * The first test is the regression: it calls the primitive the way `lsp` and
 * `ast_grep` now do — with an explicit cwd, from outside any workspace scope —
 * and asserts the rows are readable INSIDE that workspace. Delete the
 * `withWorkspace` call inside the primitive and this test fails, because the
 * write goes to the shared store instead.
 *
 * @module dsh-hashline-edittool/serve-in-workspace.test
 */

import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
	anchorForInWorkspace,
	loadServed,
	recordServed,
	observeServedRows,
	workspaceCwd,
	withWorkspace,
	type ServedEntry,
} from "../../src/domain/session/session-view.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { getWritableTempRoot } from "../support/fixtures.js";

/** A no-op observation emitter: this test is about where rows are WRITTEN. */
const noopIO = {
	async emitObserved(): Promise<void> {},
};

/** A minimal `ToolExecution` stand-in; only `agent.session` is ever read. */
function fakeExec() {
	return {
		agent: { session: { id: "serve-scope-session", header: { cwd: "" } } },
		signal: undefined,
	} as never;
}

/** The two lines every case serves, and a helper for building their rows. */
const CONTENT = "alpha\nbravo";
const rowsFor = (anchors: readonly string[]): ServedEntry[] => [
	{ position: 0, anchor: anchors[0]! },
	{ position: 1, anchor: anchors[1]! },
];

describe("observeServedRows", () => {
	beforeAll(async () => {
		await getWritableTempRoot();
	});

	it("writes the rows into the CWD's store even though the caller is outside every workspace scope", async () => {
		const cwd = mkdtempSync(join(await getWritableTempRoot(), "dsh-serve-scope-"));
		const path = join(cwd, "f.txt");
		try {
			// The caller is NOT inside a workspace — this is the `lsp` / `ast_grep`
			// situation that produced the bug.
			expect(workspaceCwd()).toBeUndefined();

			// MINT through the scope-aware half: this is what `lsp` / `ast_grep` now
			// do, from outside every workspace scope.
			const anchors = await anchorForInWorkspace({
				cwd,
				absolutePath: path,
				content: CONTENT,
				lines: [1, 2],
				sessionKey: "serve-scope-session",
			});
			expect(anchors).toHaveLength(2);
			expect(anchors[0]).not.toBe("");
			// The observing half, unchanged in shape.
			await observeServedRows({
				sessionKey: "serve-scope-session",
				cwd,
				absolutePath: path,
				rows: rowsFor(anchors),
				lineCount: 2,
				exec: fakeExec(),
				io: noopIO,
			});

			// Read back THROUGH the workspace the caller named: this is exactly what
			// a later `edit` does, and it is what failed before.
			const served = await withWorkspace(cwd, () => loadServed("serve-scope-session", path));
			// A Set: compare as one, not element-wise (order is not part of the claim).
			expect(served).toEqual(new Set(anchors));
		} finally {
			shutdownHashStore();
		}
	});

	it("does not leak the rows into the shared store outside the workspace", async () => {
		const cwd = mkdtempSync(join(await getWritableTempRoot(), "dsh-serve-leak-"));
		const path = join(cwd, "g.txt");
		try {
			// Mint through the workspace-scoped half, then observe: neither may land
			// in the shared store.
			const anchors = await anchorForInWorkspace({
				cwd,
				absolutePath: path,
				content: CONTENT,
				lines: [1, 2],
				sessionKey: "serve-scope-session",
			});
			await observeServedRows({
				sessionKey: "serve-scope-session",
				cwd,
				absolutePath: path,
				rows: rowsFor(anchors),
				lineCount: 2,
				exec: fakeExec(),
				io: noopIO,
			});

			// Outside every scope the store resolves to the shared-home fallback.
			// `recordServed` is the bare call the two tools used to make; if the
			// primitive had written there, this read would find the rows.
			const outside = await loadServed("serve-scope-session", path);
			expect(outside).toEqual(new Set());
		} finally {
			shutdownHashStore();
		}
	});

	it("the bare recordServed call IS the bug — it writes where the workspace read cannot see", async () => {
		const cwd = mkdtempSync(join(await getWritableTempRoot(), "dsh-serve-bare-"));
		const path = join(cwd, "h.txt");
		try {
			// Negative control for the two tests above: the unwrapped call lands in
			// the shared store, so the same workspace-scoped read comes back empty.
			// This is the failing behaviour the primitive replaced.
			await recordServed("serve-scope-session", path, rowsFor(["aa", "bb"]), 2);

			const served = await withWorkspace(cwd, () => loadServed("serve-scope-session", path));
			expect(served).toEqual(new Set());
		} finally {
			shutdownHashStore();
		}
	});
});
