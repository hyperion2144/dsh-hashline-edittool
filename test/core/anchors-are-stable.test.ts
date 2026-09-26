/**
 * An allocated anchor must NEVER change while its line's content is unchanged
 * (#187 field report).
 *
 * The failure: a `read` handed the model `ai:405` for a line, then an edit was
 * rejected and the ECHO answered `WQ:405` for that same, unchanged line — and
 * the read's own anchor was reported as `[E_STALE] "ai"`. Root cause: the
 * echo-window allocation was fed a REBUILT content string
 * (`fileLines.join("\n")`), which lacks the file's trailing newline, so
 * `ensureState` saw a checksum mismatch and realigned — releasing valid anchors
 * and minting new ones for lines nobody had touched.
 *
 * This pins the invariant directly: capture every anchor, trigger a rejection
 * whose echo covers the same lines, and require the anchor set to be IDENTICAL
 * afterwards. Any future realign-on-read (or on a rejected edit) fails here.
 *
 * @module dsh-hashline-edittool/test/core/anchors-are-stable
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";
import { anchorsFor, allocateForLines } from "../../src/hashline/session-anchors.js";
import { withWorkspace, openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { splitLines } from "../../src/infra/utils.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "anchors-stable-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

/** Anchors as the file's state has them RIGHT NOW (dense view). */
async function currentAnchors(cwd: string, file: string, content: string): Promise<string[]> {
	return (await withWorkspace(cwd, async () => anchorsFor(file, content))) as string[];
}

describe("#187: an allocated anchor never changes while content is unchanged", () => {
	it("a rejected edit does not rewrite anchors, and its echo matches the state", async () => {
		const cwd = join(tmpHome, "stable");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const lines = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
		const content = lines.join("\n") + "\n";
		await writeFile(file, content);

		const harness = setupIntegrationTest(cwd);
		// A read serves lines 1-5 (the anchor set the model holds).
		const readText = getText(
			await harness.readTool.execute("read", { path: "mod.ts", offset: 1, limit: 5 }),
		);
		const readAnchors = new Map<number, string>();
		for (const row of readText.split("\n")) {
			const m = /^\s*([A-Za-z0-9]{1,8}):(\d+)[:|]/.exec(row);
			if (m) readAnchors.set(Number(m[2]), m[1]!);
		}
		expect(readAnchors.size).toBeGreaterThan(0);

		// Persist anchors for lines 8-12 WITHOUT serving them (a pure allocation,
		// exactly what an echo-window allocation does).
		await withWorkspace(cwd, async () => {
			allocateForLines(file, content, [8, 9, 10, 11, 12]);
		});
		const before = await currentAnchors(cwd, file, content);
		expect(before.filter((a) => a !== "").length).toBeGreaterThanOrEqual(10);

		// Trigger a served-gate rejection on line 10 (its anchor exists but was
		// never served): the echo covers lines 7-13.
		const tenAnchor = before[9]!;
		expect(tenAnchor).not.toBe("");
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: `${tenAnchor}:10`, anchor_end: `${tenAnchor}:10`, lines: ["const v10 = 999;"] }],
			}),
		);
		expect(res).toMatch(/E_RANGE_UNVERIFIED|E_STALE/);

		// INVARIANT (the user's rule): every line that ALREADY had an anchor keeps
		// it, byte for byte. Lines that had none may (and must) get one — that is
		// what the echo window allocation is for.
		const after = await currentAnchors(cwd, file, content);
		for (let i = 0; i < before.length; i++) {
			if (before[i] !== "") {
				expect(after[i], `line ${i + 1} had anchor ${before[i]} and it must not change`).toBe(before[i]);
			}
		}
		// No anchor is ever duplicated across lines (uniqueness per file).
		const live = after.filter((a) => a !== "");
		expect(new Set(live).size).toBe(live.length);

		// Every echoed row carries a NON-EMPTY anchor (the original complaint was a
		// bare `:N:` marker). Rows for lines that had no anchor are minted by the
		// echo-window allocation — by design — so this checks the marker is real,
		// not that it equals a pre-existing value.
		let echoed = 0;
		for (const row of res.split("\n")) {
			const m = /^\s+([A-Za-z0-9]{1,8}):(\d+)[:|]/.exec(row);
			if (!m) continue;
			echoed += 1;
			expect(m[1], `echo row for line ${m[2]} must carry a real anchor`).not.toBe("");
		}
		expect(echoed, "the rejection echo must show rows").toBeGreaterThan(0);
		// The file itself was not touched by the rejected edit.
		expect(await readFile(file, "utf8")).toBe(content);
	}, 60_000);

	it("the echo-window allocation reuses anchors instead of minting new ones", async () => {
		const cwd = join(tmpHome, "reuse");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const content = Array.from({ length: 12 }, (_, i) => `const w${i + 1} = ${i + 1};`).join("\n") + "\n";
		await writeFile(file, content);
		await openWorkspaceStore(cwd);

		// First allocation: lines 1-4.
		const first = (await withWorkspace(cwd, async () => allocateForLines(file, content, [1, 2, 3, 4]))) as string[];
		// Second allocation over a WINDOW THAT OVERLAPS: lines 2-6. Lines 2-4
		// already have anchors and MUST keep them; 5-6 are new.
		const second = (await withWorkspace(cwd, async () => allocateForLines(file, content, [2, 3, 4, 5, 6]))) as string[];
		expect(second.slice(0, 3)).toEqual(first.slice(1, 4));
		// And the whole view is unchanged for the lines that had anchors.
		const view = (await withWorkspace(cwd, async () => anchorsFor(file, content))) as string[];
		expect(view.slice(0, 4)).toEqual(first);
		expect(splitLines(content).length).toBe(view.length);
	}, 60_000);
});
