/**
 * Issue #212 / root cause B — the bare-digit rejection echo.
 *
 * The mismatch echo pre-allocates anchors for the window it shows (#187), but
 * the window collection read each mismatch's `ref.line` — a field a BARE digit
 * does not have (the digit lives in `ref.anchor`). The bare-digit path
 * therefore allocated nothing: the echo rendered bare `:N:` rows and the
 * guidance interpolated an EMPTY "fresh marker". These tests pin the repaired
 * path: real anchors on every echo row, a non-empty guidance marker, and an
 * echo anchor that starts a successful edit immediately.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../src/infra/paths.js";
import { decodeServedAnchors } from "../../src/domain/session/served-codec.js";
import { getWritableTempRoot, setupIntegrationTest, getText, useNumberedRows } from "../support/fixtures.js";
// #244: the line-number switch belongs to the user now and defaults OFF; this
// file asserts numbered rows, so every test here pins it ON.
useNumberedRows();

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "issue-212-bare-echo-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

async function makeCase(name: string): Promise<{ cwd: string; p: string }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	const p = join(cwd, "f.txt");
	await writeFile(
		p,
		Array.from({ length: 10 }, (_, i) => `line-${String(i + 1).padStart(2, "0")} content`).join("\n") + "\n",
	);
	return { cwd, p };
}

/** The session's served mirror size — anchors the model has been shown. */
function countServed(cwd: string, path: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { defensive: false } as never);
	try {
		const rows = db.prepare("SELECT hashes FROM served WHERE path = ?").all(path) as Array<{ hashes: string }>;
		return rows.reduce((n, row) => n + (decodeServedAnchors(row.hashes)?.size ?? 0), 0);
	} finally {
		db.close();
	}
}

describe("#212 bare-digit rejection echo carries real, usable anchors", () => {
	it("the [E_BAD_REF] echo shows only anchored rows and names a NON-empty marker", async () => {
		const { cwd, p } = await makeCase("echo-shape");
		const h = setupIntegrationTest(cwd);
		// Serve only lines 1-3: line 8 never gets an anchor, so a bare "8"
		// cannot be repaired and must reject — with a USABLE echo.
		await h.readTool.execute("read", { path: "f.txt", offset: 1, limit: 3 });
		const text = getText(
			await h.editTool.execute("edit", {
				path: "f.txt",
				edits: [{ op: "replace", anchor_start: "8", anchor_end: "8", lines: ["x"] }],
			}),
		);
		expect(text).toContain("[E_BAD_REF]");
		// The echo shows rows …
		const echoRows = [...text.matchAll(/^\s*([A-Za-z0-9]{2,8}):(\d+):/gm)];
		expect(echoRows.length).toBeGreaterThan(0);
		// … every one of them with a REAL anchor (no bare `:N:` rows) …
		expect(/\n\s*:\d+[:|]/.test(`\n${text}`)).toBe(false);
		for (const m of echoRows) expect(m[1]).not.toBe("");
		// … the guidance names a non-empty fresh marker (was: an empty
		// "reuse the fresh marker  without calling read") …
		const marker = /reuse the fresh marker (\S+) without calling read/.exec(text)?.[1];
		expect(marker).toBeDefined();
		expect(marker).not.toBe("");
		expect(marker).not.toBe("?");
		// … and the echo rows were recorded as SERVED (acceptance 3): the read
		// window served lines 1-3; the echo window (5-10, clamped to the file)
		// adds six more.
		expect(countServed(cwd, p)).toBe(9);
	});

	it("an echo anchor starts a successful edit immediately — no re-read needed", async () => {
		const { cwd } = await makeCase("echo-retry");
		const h = setupIntegrationTest(cwd);
		await h.readTool.execute("read", { path: "f.txt", offset: 1, limit: 3 });
		// Step 1 — the bare digit rejects, but its echo now allocates + serves
		// the window it shows (here: lines 5-11, including line 8).
		const echoText = getText(
			await h.editTool.execute("edit", {
				path: "f.txt",
				edits: [{ op: "replace", anchor_start: "8", anchor_end: "8", lines: ["x"] }],
			}),
		);
		expect(echoText).toContain("[E_BAD_REF]");
		// Step 2 — take the fresh marker for line 8 from that very echo …
		const anchor8 = /^\s*([A-Za-z0-9]{2,8}):8[:|]/m.exec(echoText)?.[1];
		expect(anchor8).toBeDefined();
		// … and the retry with THAT anchor must succeed: the echo was served.
		const retry = getText(
			await h.editTool.execute("edit", {
				path: "f.txt",
				edits: [
					{ op: "replace", anchor_start: anchor8, anchor_end: anchor8, lines: ["line-08 rewritten"] },
				],
			}),
		);
		expect(retry).toContain("Successfully edited");
	});
});
