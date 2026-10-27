/**
 * #351 — a release has to be recorded WHEN IT HAPPENS, not when the batch ends.
 *
 * The batch engine applies one item at a time (descending original line order).
 * `updateAnchorsAfterEdit` drops the replaced lines' rows on the FIRST item, but
 * the "three parts of a release" were only completed once, at the end of the
 * batch (pool + served). Between the two, the anchor is gone from `anchor_lines`
 * and not yet in the pool, so the second item's allocation sees neither source
 * and may hand the released string to a brand-new line.
 *
 * Reported from a live session: a `del` of `import { confirmProfileDelete }`
 * (line 1689, anchor `no`) plus an `ins` of the SAME text at the top produced
 * `+32:no` — the same string, in the same call.
 *
 * @module dsh-hashline-edittool/test/core/issue-351-same-call-release
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clearReleasePool, releasePoolFor } from "../../src/domain/session/anchor-entry.js";
import { loadServed, openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { setupIntegrationTest, servedRows, withTempDir } from "../support/fixtures.js";

/** Six distinct lines; the last one is what the call moves to the top. */
const MOVED = "import { moved } from './moved.ts'";
const CONTENT = ["alpha", "bravo", "charlie", "delta", "echo", MOVED].join("\n");

const FINAL = ["alpha", MOVED, "bravo", "charlie", "delta", "echo"].join("\n");

/**
 * One `edit` call, two items, same file: delete the line carrying `MOVED`,
 * insert the very same text right under the first line.
 */
async function moveFirstToLastInOneCall(dir: string) {
	const path = join(dir, "f.ts");
	await writeFile(path, CONTENT, "utf8");
	const harness = setupIntegrationTest(dir);
	const before = await servedRows(harness, "f.ts");
	expect(before).toHaveLength(6);
	const first = before[0]!.hash;
	const doomed = before[5]!.hash;

	clearReleasePool(path);
	await harness.editTool.execute("edit", {
		path: "f.ts",
		edits: [
			{ op: "del", anchor_start: doomed, anchor_end: doomed },
			{ op: "ins", anchor_after: first, lines: [MOVED] },
		],
	});
	return { path, harness, doomed };
}

describe("a release is sealed for the rest of the edit call that made it (#351)", () => {
	it("does not hand the deleted line's anchor to the inserted copy", async () => {
		await withTempDir("issue-351-1-", async (dir) => {
			const { path, harness, doomed } = await moveFirstToLastInOneCall(dir);
			expect(await readFile(path, "utf8")).toBe(FINAL);

			// What the model holds after the call: the inserted line's anchor must
			// not be the released string (contract §9 invariant 5 — 本轮不重发).
			const after = await servedRows(harness, "f.ts");
			expect(after[1]!.content).toBe(MOVED);
			expect(after[1]!.hash).not.toBe(doomed);
		});
	});

	it("completes all three parts of the release inside a multi-item batch", async () => {
		await withTempDir("issue-351-2-", async (dir) => {
			const { path, doomed } = await moveFirstToLastInOneCall(dir);

			// (3) the anchor is sealed for the rest of the call …
			expect([...releasePoolFor(path)]).toContain(doomed);
			// (2) … and it left the EDITING session's served set.
			const served = await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				return loadServed("test-session", path);
			});
			expect(served.has(doomed)).toBe(false);
			clearReleasePool(path);
		});
	});
});
