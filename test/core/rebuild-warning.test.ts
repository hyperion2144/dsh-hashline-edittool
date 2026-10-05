/**
 * The rebuild notice: it has to REACH the model, exactly once.
 *
 * A rebuild (a version upgrade, or a capacity sweep) invalidates every anchor
 * the workspace had. The store has always queued a message for that — and
 * nothing ever drained it, so the model kept resubmitting markers that were
 * already dead and read every refusal as its own mistake. Found by driving the
 * real tools after a version upgrade: the store moved 6 → 7 and invalidated
 * 36,789 anchor rows, and the session was told nothing.
 *
 * These cases pin the delivery contract, which is "first result wins, and only
 * one result carries it" — `takeRebuildWarning` clears as it reads, so a
 * session that never re-reads is not nagged forever.
 *
 * @module dsh-hashline-edittool/rebuild-warning.test
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setRebuildWarning } from "../../src/domain/session/hash-store.js";
import { setupIntegrationTest, getText, withTempDir } from "../support/fixtures.js";

const NOTICE = "[hash-store] rebuild: every anchor for this workspace is invalidated — re-read files before editing.";

describe("the rebuild notice reaches the model", () => {
	it("rides the FIRST read result, and only that one", async () => {
		await withTempDir("rebuild-notice-read-", async (dir) => {
			await writeFile(join(dir, "a.ts"), "alpha\nbravo\ncharlie\n", "utf8");
			const harness = setupIntegrationTest(dir);

			setRebuildWarning(NOTICE);
			const first = getText(await harness.readTool.execute("read", { path: "a.ts" }));
			expect(first).toContain(NOTICE);
			// Prepended, not appended: it is the frame the rows are read in.
			expect(first.indexOf(NOTICE)).toBeLessThan(first.indexOf("alpha"));

			// The second read is clean — the notice is take-and-clear, so a session
			// that keeps working does not see it on every result forever.
			const second = getText(await harness.readTool.execute("read", { path: "a.ts" }));
			expect(second).not.toContain(NOTICE);
			expect(second).toContain("alpha");
		});
	});

	it("rides the first EDIT result when an edit runs first", async () => {
		await withTempDir("rebuild-notice-edit-", async (dir) => {
			await writeFile(join(dir, "b.ts"), "alpha\nbravo\ncharlie\n", "utf8");
			const harness = setupIntegrationTest(dir);
			// Serve the rows, so the edit below is accepted on its merits.
			const readText = getText(await harness.readTool.execute("read", { path: "b.ts" }));
			const anchor = /^([A-Za-z0-9]{2,8}):2:/m.exec(readText)?.[1];
			expect(anchor).toBeDefined();

			setRebuildWarning(NOTICE);
			const first = getText(
				await harness.editTool.execute("edit", {
					path: "b.ts",
					edits: [{ op: "replace", anchor_start: anchor!, anchor_end: anchor!, lines: ["BRAVO"] }],
				}),
			);
			expect(first).toContain(NOTICE);
			expect(getText(await harness.readTool.execute("read", { path: "b.ts" }))).not.toContain(NOTICE);
		});
	});
});
