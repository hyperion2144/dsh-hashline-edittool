/**
 * Every line the model SEES must carry a real anchor (#187 audit).
 *
 * Pinned here: the served-gate rejection (E_RANGE_UNVERIFIED) builds its echo
 * from lines that may have no anchors in the sparse state. The fix allocates
 * the echo window before rendering, so every echoed row carries a real anchor.
 *
 * @module dsh-hashline-edittool/test/core/echo-anchors
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "echo-anchors-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

describe("#187: the rejection echo carries real anchors", () => {
	it("no bare `:N:` markers in any rejection echo", async () => {
		const cwd = join(tmpHome, "case");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const lines = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		// Read a small window (lines 1-3): lines 4+ have no anchors.
		const readText = getText(
			await harness.readTool.execute("read", { path: "mod.ts", offset: 1, limit: 3 }),
		);
		const a1 = /^\s*([A-Za-z0-9]{1,8}):1[:|]/m.exec(readText)?.[1];
		expect(a1).toBeDefined();

		// Re-read the FULL file: now all lines have anchors.
		const fullRead = getText(await harness.readTool.execute("read", { path: "mod.ts" }));
		// Trigger a rejection: edit line 1 with a multi-line replacement whose
		// text matches line 2 (ins shape → the served gate checks line 1 only).
		// Instead, use an anchor that EXISTS in the file but was NOT served
		// in a read window the model has seen (create a stale view by editing
		// the file externally first).
		//
		// Simplest deterministic rejection: use a real anchor from a read, then
		// overwrite the file externally so the content-key no longer matches.
		const externalContent = lines.map((l, i) => (i === 0 ? "const v1 = 999;" : l)).join("\n") + "\n";
		await writeFile(file, externalContent);
		// Now the state's checksum differs from the file → realign fires →
		// line 1's anchor may change → editing with a1 may be rejected.
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: a1!, anchor_end: a1!, lines: ["const v1 = 1;"] }],
			}),
		);
		// Whether it succeeds (realign preserved a1) or is rejected, there
		// must be NO bare `:N:` markers in the output.
		const bareRows = res.split("\n").filter((l) => /^\s+\d+[:|]/.test(l));
		expect(bareRows, `bare markers found: ${bareRows.join(" | ")}`).toEqual([]);
	}, 60_000);

	it("the served-gate echo carries real anchors for all echoed lines", async () => {
		const cwd = join(tmpHome, "served");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const lines = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		// Read only lines 1-3.
		const readText = getText(
			await harness.readTool.execute("read", { path: "mod.ts", offset: 1, limit: 3 }),
		);
		const a1 = /^\s*([A-Za-z0-9]{1,8}):1[:|]/m.exec(readText)?.[1];
		expect(a1).toBeDefined();

		// Overwrite the file externally: every line's content changes.
		const changed = lines.map((l, i) => `// ${l}`).join("\n") + "\n";
		await writeFile(file, changed);

		// Edit with the old anchor: the realign fires, a1 may not survive,
		// and the served gate may reject → the ECHO must carry real anchors.
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: a1!, anchor_end: a1!, lines: ["x"] }],
			}),
		);
		// No bare `:N:` markers in the output.
		const bareRows = res.split("\n").filter((l) => /^\s+\d+[:|]/.test(l));
		expect(bareRows, `bare markers: ${bareRows.join(" | ")}`).toEqual([]);
	}, 60_000);
});
