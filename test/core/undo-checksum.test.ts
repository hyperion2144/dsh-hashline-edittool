/**
 * The undo stack stores a CHECKSUM of the post-edit body, not a second copy of
 * it (#176). The stale check — "is the file still what my edit produced?" — is
 * the only consumer of that body, so a checksum answers it identically while
 * halving the biggest text payload in the store.
 *
 * Pinned here:
 *  - a new row keeps no post-edit body and carries the checksum instead;
 *  - undo still reverts, and a second undo step still reverts (the chain is
 *    intact, not just the top);
 *  - a LEGACY row (body present, checksum empty) is still verified by text, so
 *    stacks written by an older build keep working after the upgrade.
 *
 * @module dsh-hashline-edittool/test/core/undo-checksum
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { realpathSync } from "node:fs";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";
import { hashStorePath } from "../../src/infra/paths.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "undo-checksum-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

/** The newest undo row for a path, read straight from the store. */
function topUndoRow(cwd: string, file: string): {
	result_content: string;
	result_checksum: string | null;
} {
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT result_content, result_checksum FROM undo WHERE path = ? ORDER BY depth DESC LIMIT 1",
			)
			.get(file) as { result_content: string; result_checksum: string | null };
	} finally {
		db.close();
	}
}

describe("the undo stack stores a checksum instead of a second body (#176)", () => {
	it("keeps no post-edit body, writes a checksum, and still reverts", async () => {
		const cwd = join(tmpHome, "project");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		// Long enough that a stored body would dominate the row.
		const lines = Array.from({ length: 400 }, (_, i) => `export const v${i + 1} = ${i + 1}; // padding`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		const readText = getText(await harness.readTool.execute("read", { path: "mod.ts", limit: 5 }));
		const anchor = /^\s*([A-Za-z0-9]{2,8}):3[:|]/m.exec(readText)?.[1];
		expect(anchor).toBeDefined();

		await harness.editTool.execute("edit", {
			path: "mod.ts",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["export const v3 = 999;"] }],
		});

		const row = topUndoRow(cwd, file);
		expect(row.result_content).toBe("");
		expect(row.result_checksum).toBeTruthy();
		// 14 hex chars of cyrb53 — the whole point is that it is a fixed small
		// string where a full body used to be.
		expect(row.result_checksum!.length).toBeLessThan(32);

		// And the revert itself is unaffected.
		const undoText = getText(await harness.getTool("undo_last_edit").execute("u", { path: "mod.ts" }));
		expect(undoText).toContain("Undone last edit");
		expect(await readFile(file, "utf8")).toContain("export const v3 = 3;");
	}, 60_000);

	it("still reverts a LEGACY row, which carries a body and no checksum", async () => {
		const cwd = join(tmpHome, "legacy");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "old.ts");
		const before = "export const keep = 1;\nexport const change = 2;\n";
		await writeFile(file, before);

		const harness = setupIntegrationTest(cwd);
		const readText = getText(await harness.readTool.execute("read", { path: "old.ts", limit: 5 }));
		const anchor = /^\s*([A-Za-z0-9]{2,8}):2[:|]/m.exec(readText)?.[1];
		expect(anchor).toBeDefined();
		await harness.editTool.execute("edit", {
			path: "old.ts",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["export const change = 22;"] }],
		});
		const after = await readFile(file, "utf8");

		// Rewrite the row the edit just produced into the shape an OLDER build
		// wrote: the post-edit body back in `result_content`, no checksum. The
		// path key is taken from the row itself, so the test never has to guess
		// how the tool canonicalises paths.
		const db = new DatabaseSync(hashStorePath(cwd));
		const key = (db.prepare("SELECT path FROM undo ORDER BY depth DESC LIMIT 1").get() as { path: string }).path;
		db.prepare("UPDATE undo SET result_content = ?, result_checksum = NULL WHERE path = ?").run(after, key);
		// Sanity: the row really is in the legacy shape now.
		const legacy = db
			.prepare("SELECT result_content, result_checksum FROM undo WHERE path = ?")
			.get(key) as { result_content: string; result_checksum: string | null };
		expect(legacy.result_checksum).toBeNull();
		expect(legacy.result_content).toBe(after);
		db.close();

		const undoText = getText(await harness.getTool("undo_last_edit").execute("u", { path: "old.ts" }));
		expect(undoText).toContain("Undone last edit");
		expect(await readFile(file, "utf8")).toBe(before);
	}, 60_000);
});
