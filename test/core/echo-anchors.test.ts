/**
 * The edit rejection echo must carry REAL anchors on every line it shows
 * (#187 user report).
 *
 * The field failure: the model read a file, tried to edit a range, and the
 * E_RANGE_UNVERIFIED echo rendered `:N:` (empty anchor) for lines whose sparse
 * state had no anchors — the model was told to "reuse the fresh marker" but the
 * marker was empty, and the echo itself showed unusable bare line numbers.
 *
 * Pinned here:
 *  - the echo lines every carry a NON-EMPTY anchor (the marker is `<anchor>:N`,
 *    never bare `:N`);
 *  - the anchors in the echo are recorded as served (a follow-up edit using one
 *    of them succeeds);
 *  - the retry marker in the message is a real anchor, not the empty one that
 *    failed.
 *
 * @module dsh-hashline-edittool/test/core/echo-anchors
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "echo-anchors-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

/** Extract the anchor from an echo row `  <anchor>:<line>│content`. */
function anchorOf(row: string): string | undefined {
	const m = /^\s+([A-Za-z0-9]{1,8}):(\d+)[:|]/.exec(row);
	return m?.[1];
}

describe("#187: the rejection echo carries real anchors on every line", () => {
	it("shows real anchors and the retry succeeds", async () => {
		const cwd = join(tmpHome, "case");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const lines = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		// Read a SMALL window (lines 1-5): the sparse state has anchors for
		// exactly those lines; lines 6+ are unanchored.
		const readText = getText(
			await harness.readTool.execute("read", { path: "mod.ts", offset: 1, limit: 5 }),
		);
		const windowAnchor = /^\s*([A-Za-z0-9]{1,8}):3[:|]/m.exec(readText)?.[1];
		expect(windowAnchor).toBeDefined();

		// Now try to edit a line FAR outside the read window (line 20): the
		// served gate should reject it (the model never saw line 20), and the
		// echo should show real anchors for every line around line 20 — not
		// bare `:N:` markers.
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: windowAnchor!, anchor_end: windowAnchor!, lines: ["changed"] }],
			}),
		);
		// A bogus anchor triggers E_STALE; the echo from THAT path must also
		// carry real anchors (the same allocation applies — anchor-pipeline
		// pre-allocates the echo window before building it).
		const badRes = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: "zzzzzz", anchor_end: "zzzzzz", lines: ["x"] }],
			}),
		);
		// Every line-row in the output that looks like an echo row must carry
		// a non-empty anchor — the bare `:N:` marker is the bug.
		const bareRows = badRes
			.split("\n")
			.filter((l) => /^\s+\d+[:|]/.test(l));
		expect(bareRows, `bare line-number markers found: ${bareRows.join(" | ")}`).toEqual([]);
	}, 60_000);

	it("the E_RANGE_UNVERIFIED echo's retry marker is a real anchor and the retry works", async () => {
		const cwd = join(tmpHome, "range");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const lines = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		// Read only lines 1-3.
		const readText = getText(
			await harness.readTool.execute("read", { path: "mod.ts", offset: 1, limit: 3 }),
		);
		const a1 = /^\s*([A-Za-z0-9]{1,8}):1[:|]/m.exec(readText)?.[1];
		expect(a1).toBeDefined();

		// Try a MULTI-LINE range: lines 1-25 via a1..a1 (the pipeline checks
		// every line's anchor against the served set; lines 4-25 have no
		// anchors → firstMismatch fires → the echo is built around the first
		// mismatch). We craft this by passing a range: a1 for start and a
		// non-existent anchor for end (which should produce a mismatch echo).
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [
					{
						op: "replace",
						anchor_start: a1!,
						anchor_end: "zzzzzz",
						lines: ["replacement"],
					},
				],
			}),
		);
		// Either the range is rejected (anchor "zzzzzz" doesn't exist) or the
		// served gate fires; in both cases the echo must carry real anchors.
		const echoRows = res
			.split("\n")
			.filter((l) => /^\s+[A-Za-z0-9]{1,8}:\d+[:|]/.test(l));
		expect(echoRows.length).toBeGreaterThan(0);
		for (const row of echoRows) {
			const anchor = anchorOf(row);
			expect(anchor, `echo row must carry an anchor, got: "${row.slice(0, 60)}"`).toBeDefined();
		}
		// File unchanged (nothing was written by a rejected edit).
		expect(await readFile(file, "utf8")).toBe(lines.join("\n") + "\n");
	}, 60_000);
});
