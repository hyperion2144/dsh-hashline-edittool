/**
 * `undo` is a SNAPSHOT ROLLBACK, not a remap (contract §2 "undo", #224).
 *
 * The contract asks for three things to go back TOGETHER: the content, the
 * line → anchor binding, and the checksum. Restoring only the content is the
 * tempting half-measure — the file looks right — but it leaves the model
 * holding the anchors the UNDON edit minted, so a model that undoes a mistaken
 * edit and re-submits its previous one is rejected for using anchors that are
 * (from its point of view) the ones it was just shown.
 *
 * The binding is already saved with every undo entry (`UndoRecord.hashes` is
 * the dense pre-edit binding), so this is about restoring it, not about
 * capturing it.
 *
 * @module dsh-hashline-edittool/test/core/undo-restores-anchors
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { probeLines } from "../../src/domain/session/anchor-entry.js";
import { openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { withTempDir, setupIntegrationTest, servedRows } from "../support/fixtures.js";

const CONTENT = ["alpha", "bravo", "charlie", "delta"].join("\n");

describe("undo restores the anchor binding it saved (#224)", () => {
	it("gives back the anchors the model held BEFORE the edit", async () => {
		await withTempDir("undo-anchors-1-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			// The handles the model holds before it edits anything.
			const before = (await servedRows(setupIntegrationTest(dir), "f.ts")).map((r) => r.hash);
			expect(before).toHaveLength(4);

			const harness = setupIntegrationTest(dir);
			const edited = await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: before[1]!, anchor_end: before[1]!, lines: ["BRAVO REPLACED"] },
				],
			});
			expect((edited as { content: Array<{ text?: string }> }).content[0]?.text).toContain(
				"Successfully edited",
			);

			await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.ts" });

			// The content is back (the easy half), and so is the binding.
			const after = (await servedRows(setupIntegrationTest(dir), "f.ts")).map((r) => r.hash);
			expect(after).toEqual(before);
		});
	});

	it("makes the restored anchors USABLE again, not merely displayed", async () => {
		await withTempDir("undo-anchors-2-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const before = (await servedRows(setupIntegrationTest(dir), "f.ts")).map((r) => r.hash);
			const harness = setupIntegrationTest(dir);
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: before[1]!, anchor_end: before[1]!, lines: ["BRAVO REPLACED"] },
				],
			});
			await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.ts" });

			// The point of the whole exercise: the pre-edit handle still verifies,
			// so the model can immediately re-submit the edit it meant to make.
			const probe = await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);
				return probeLines({
					path,
					content: CONTENT,
					refs: [{ anchor: before[1]!, line: 2 }],
					sessionKey: "test-session",
				});
			});
			expect(probe.ok).toBe(true);
			if (probe.ok) expect(probe.resolved[0]!.line).toBe(2);
		});
	});

	it("stops after the third level, so the stack is bounded at 3", async () => {
		await withTempDir("undo-anchors-3-", async (dir) => {
			// Payload shape only: the depth bound itself is pinned in
			// `undo-store.test.ts` against UNDO_STACK_DEPTH. What matters here is
			// that the constant really is three, which is a contract number and
			// not a tunable.
			const { UNDO_STACK_DEPTH } = await import("../../src/infra/constants.js");
			expect(UNDO_STACK_DEPTH).toBe(3);
		});
	});
});

	it("refuses and CLEARS the entry when the file changed after the edit", async () => {
		await withTempDir("undo-anchors-4-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const before = (await servedRows(setupIntegrationTest(dir), "f.ts")).map((r) => r.hash);
			const harness = setupIntegrationTest(dir);
			await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: before[1]!, anchor_end: before[1]!, lines: ["BRAVO REPLACED"] },
				],
			});

			// Someone else writes the file. Undoing now would silently discard that
			// change, so the entry must be refused — and REMOVED, or every later
			// undo on this path re-answers the same stale question (§2 undo).
			await writeFile(path, "completely different\ncontent\n", "utf8");

			const res = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.ts" });
			const text = (res as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
			expect(text).toContain("E_UNDO_STALE");
			// The file is untouched by the refused revert.
			expect(await readFile(path, "utf8")).toBe("completely different\ncontent\n");
			// And the entry is gone: asking again is a different refusal ("nothing
			// to undo"), not the same stale one forever.
			const again = await harness.getTool("undo_last_edit").execute("undo_last_edit", { path: "f.ts" });
			const againText = (again as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
			expect(againText).not.toContain("E_UNDO_STALE");
		});
	});
