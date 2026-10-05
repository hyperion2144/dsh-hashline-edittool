/**
 * Releasing an anchor is THREE things, and the edit path has to do all of them
 * (#223 / contract §4, invariant 4).
 *
 * `updateAnchorsAfterEdit` dropped the rows of lines whose content a hunk
 * replaced — and stopped there. The anchor left `anchor_lines`, but it stayed in
 * the editing session's served set and never entered the call's release pool, so
 * it could be minted again for a different line while the model still held the
 * old meaning. Every check then passes (the anchor is live, its content key
 * matches its line, it is in `served`) and the write lands on the wrong line —
 * the defect #217 §1 reproduced constructively.
 *
 * These tests pin the missing two thirds at the seam that has to do them: the
 * file × session edit path, not the primitive (that one is covered by
 * `anchor-entry-invariants.test.ts`).
 *
 * @module dsh-hashline-edittool/test/core/anchor-release-after-edit
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { probeLines, releasePoolFor, clearReleasePool } from "../../src/domain/session/anchor-entry.js";
import { loadServed, openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { withTempDir, setupIntegrationTest, servedRows } from "../support/fixtures.js";

/** Four distinct lines, no trailing newline surprises. */
const CONTENT = ["alpha", "bravo", "charlie", "delta"].join("\n");

/**
 * The anchor each of the four lines carries, via the repo's own row parser.
 *
 * NOT hand-rolled here: the rendered marker is `<anchor>:<line>:<content>`
 * (anchor FIRST — the number is only a hint), and a hand-written regex that
 * assumes the legacy order silently yields nothing, which then shows up as a
 * confusing tool-args error rather than a failed assertion.
 */
async function readAnchors(cwd: string): Promise<string[]> {
	const rows = await servedRows(setupIntegrationTest(cwd), "f.ts");
	return rows.map((row) => row.hash);
}

describe("the edit path completes a release (#223 contract §4)", () => {
	it("drops a replaced line's anchor out of the session's served set", async () => {
		await withTempDir("release-edit-1-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const anchors = await readAnchors(dir);
			expect(anchors).toHaveLength(4);
			const doomed = anchors[1]!; // line 2, "bravo"

			// The anchor starts served and usable — the precondition.
			const before = await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				return loadServed("test-session", path);
			});
			expect(before.has(doomed)).toBe(true);

			const harness = setupIntegrationTest(dir);
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{
						op: "replace",
						anchor_start: doomed,
						anchor_end: doomed,
						lines: ["BRAVO REPLACED"],
					},
				],
			});

			// The write itself must have landed, or this test proves nothing.
			expect(await readFile(path, "utf8")).toBe(
				["alpha", "BRAVO REPLACED", "charlie", "delta"].join("\n"),
			);

			// (2) gone from the EDITING session's served set. Without this the
			// mirror stays one entry larger than `anchor_lines` after every edit,
			// and the released anchor keeps answering "served" forever.
			const served = await withWorkspace(dir, async () => loadServed("test-session", path));
			expect(served.has(doomed)).toBe(false);
		});
	});

	it("puts a replaced line's anchor in the call's release pool", async () => {
		await withTempDir("release-edit-2-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			const anchors = await readAnchors(dir);
			const doomed = anchors[1]!;

			// The pool is per-call in-memory state. A fresh call must start empty —
			// asserted so the check below cannot pass on a leftover.
			clearReleasePool(path);
			expect(releasePoolFor(path).size).toBe(0);

			const harness = setupIntegrationTest(dir);
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: doomed, anchor_end: doomed, lines: ["BRAVO REPLACED"] },
				],
			});

			// (3) pooled, so no later line of THIS call could have been handed it.
			expect([...releasePoolFor(path)]).toContain(doomed);
			clearReleasePool(path);
		});
	});

	it("stops an anchor it released from verifying afterwards", async () => {
		await withTempDir("release-edit-3-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			const anchors = await readAnchors(dir);
			const doomed = anchors[1]!;

			const harness = setupIntegrationTest(dir);
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: doomed, anchor_end: doomed, lines: ["BRAVO REPLACED"] },
				],
			});

			// The observable consequence the model feels: a handle it still holds
			// for that line is now refused. (1) is what makes this true — the row
			// is gone from `anchor_lines`, so nothing can resolve it any more.
			shutdownHashStore();
			const probe = await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				return probeLines({
					path,
					content: ["alpha", "BRAVO REPLACED", "charlie", "delta"].join("\n"),
					refs: [{ anchor: doomed, line: 2 }],
					sessionKey: "test-session",
				});
			});
			expect(probe.ok).toBe(false);
			if (!probe.ok) expect(probe.reason).toBe("not-live");
		});
	});
});
