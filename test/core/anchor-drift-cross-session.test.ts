/**
 * Line-number drift is a HINT, never a refusal (contract §2.5, #224).
 *
 * The anchor is the identity. A model that read a file and then had its line
 * numbers shifted — because ANOTHER session inserted or deleted lines above —
 * still holds valid handles, and must be able to use them. Its remembered line
 * number is stale; the anchor is not.
 *
 * This is the property that makes cross-session anchors worth sharing at all.
 * The tempting alternative — "you said line 5, your anchor is now line 7, so
 * refuse" — would make every file that anyone else touched uneditable for every
 * other session, which is exactly what `#212`'s "the checksum is not a
 * rejection condition" rule exists to prevent.
 *
 * @module dsh-hashline-edittool/test/core/anchor-drift-cross-session
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { withTempDir, setupIntegrationTest, servedRows, getText } from "../support/fixtures.js";

/** Five distinct lines; the anchor under test is the one on "charlie". */
const CONTENT = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

describe("an anchor survives a line-number shift caused elsewhere (#224)", () => {
	it("applies the edit at the anchor's NEW line, not the remembered one", async () => {
		await withTempDir("drift-x-1-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			// Session A reads: it now holds an anchor for "charlie" AND remembers
			// it as line 3.
			const a = setupIntegrationTest(dir);
			const rows = await servedRows(a, "f.ts");
			const charlie = rows.find((row) => row.content === "charlie")!;
			expect(charlie.hash).not.toBe("");
			const rememberedLine = 3;

			// Session B inserts two lines at the top. "charlie" is now line 5.
			const b = setupIntegrationTest(dir);
			await b.editTool.execute("edit", {
				path: "f.ts",
				edits: [{ op: "ins", anchor_after: rows[0]!.hash, lines: ["inserted-1", "inserted-2"] }],
			});
			const shifted = ["alpha", "inserted-1", "inserted-2", "bravo", "charlie", "delta", "echo"].join("\n");
			expect(await readFile(path, "utf8")).toBe(shifted);

			// Session A comes back with its OLD line number (3) but its valid
			// anchor. The anchor wins; the write must land on "charlie".
			const res = await a.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{
						op: "replace",
						anchor_start: charlie.hash,
						anchor_end: charlie.hash,
						lines: ["CHARLIE CHANGED"],
					},
				],
			});
			expect(getText(res)).toContain("Successfully edited");
			expect(await readFile(path, "utf8")).toBe(
				["alpha", "inserted-1", "inserted-2", "bravo", "CHARLIE CHANGED", "delta", "echo"].join("\n"),
			);
			// The remembered line really was stale — that is the point of the case.
			expect(rememberedLine).toBe(3);
		});
	});

	it("still refuses an anchor that another session actually replaced", async () => {
		await withTempDir("drift-x-2-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const a = setupIntegrationTest(dir);
			const rows = await servedRows(a, "f.ts");
			const charlie = rows.find((row) => row.content === "charlie")!;

			// B REPLACES that very line, so A's anchor is released for real.
			const b = setupIntegrationTest(dir);
			await b.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: charlie.hash, anchor_end: charlie.hash, lines: ["B TOUCHED THIS"] },
				],
			});

			// Drift tolerance must not become "any stale anchor is accepted": an
			// anchor whose line was genuinely rewritten is gone.
			const res = await a.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: charlie.hash, anchor_end: charlie.hash, lines: ["A RETRIES"] },
				],
			});
			//
			// NOTE ON THE CODE. The contract narrows `#223`'s vocabulary to two codes
			// and assigns "the anchor is not live" to `E_RANGE_UNVERIFIED`. This path
			// answers `[E_STALE]` instead, because the anchor fails to RESOLVE (the
			// pipeline's locate step, `anchor-pipeline.ts:321`) before
			// `verifyServedRange` — where the served-set verdict lives — is even
			// reached. That is pre-existing shipped vocabulary, not something this
			// refactor introduced, so the test pins what the tool actually does: the
			// edit is REFUSED and nothing is written. Re-labelling it is a
			// model-visible behaviour change and belongs in its own decision, not in
			// a refactor that promised not to move the error surface.
			const text = getText(res);
			expect(text).toMatch(/E_STALE|E_RANGE_UNVERIFIED/);
			expect(text).toContain("rejected");
			// And nothing was written — refusal is all-or-nothing.
			expect(await readFile(path, "utf8")).toBe(
				["alpha", "bravo", "B TOUCHED THIS", "delta", "echo"].join("\n"),
			);
		});
	});

	it("keeps a session's own anchors live across its own earlier insert", async () => {
		await withTempDir("drift-x-3-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const a = setupIntegrationTest(dir);
			const rows = await servedRows(a, "f.ts");
			const delta = rows.find((row) => row.content === "delta")!;

			// The session inserts ABOVE the line it will touch next.
			await a.editTool.execute("edit", {
				path: "f.ts",
				edits: [{ op: "ins", anchor_after: rows[0]!.hash, lines: ["new"] }],
			});

			// Its pre-insert handle for "delta" must still work: an insertion
			// elsewhere is a REMAP, not a release (§4.3).
			const res = await a.editTool.execute("edit", {
				path: "f.ts",
				edits: [
					{ op: "replace", anchor_start: delta.hash, anchor_end: delta.hash, lines: ["DELTA CHANGED"] },
				],
			});
			expect(getText(res)).toContain("Successfully edited");
			expect(await readFile(path, "utf8")).toBe(
				["alpha", "new", "bravo", "charlie", "DELTA CHANGED", "echo"].join("\n"),
			);
		});
	});
});

/**
 * The liveness half of the verdict — it holds because of WHERE it is enforced.
 *
 * A dead anchor can sit in the served set (an external rewrite of that line,
 * with no tool call in between to reconcile the mirror). Measured on the
 * fixture below: `served.has(old) === true` while `anchorsFor()` no longer
 * contains it.
 *
 * The refusal comes from RESOLUTION, not from the served check: the anchor is
 * not in the live view, so the range never resolves and the request dies as
 * `[E_STALE]` before `verifyServedRange` is reached. I first added an explicit
 * liveness condition inside `verifyServedRange` for this shape, then measured
 * it: with that condition reverted the case still refused, so the condition was
 * dead code and I removed it. These cases pin the BEHAVIOUR (and its positive
 * control) rather than any one guard that happens to produce it.
 */
describe("an anchor must be live, not merely served (#224)", () => {
	it("refuses an anchor the state has already released", async () => {
		await withTempDir("drift-x-4-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const harness = setupIntegrationTest(dir);
			const rows = await servedRows(harness, "f.ts");
			const doomed = rows[1]!.hash; // line 2, "bravo"

			// An EXTERNAL rewrite of that one line — nobody edits through the tool,
			// so nothing reconciles the served mirror: the old anchor stays served
			// while the state releases it.
			const rewritten = ["alpha", "BRAVO REWRITTEN", "charlie", "delta", "echo"].join("\n");
			await writeFile(path, rewritten, "utf8");

			const res = await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [{ op: "replace", anchor_start: doomed, anchor_end: doomed, lines: ["EDITED"] }],
			});
			expect(getText(res)).toMatch(/E_STALE|E_RANGE_UNVERIFIED/);
			// Refusal is all-or-nothing: the external rewrite is untouched.
			expect(await readFile(path, "utf8")).toBe(rewritten);
		});
	});

	it("still accepts an anchor that is served AND live", async () => {
		await withTempDir("drift-x-5-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			const harness = setupIntegrationTest(dir);
			const rows = await servedRows(harness, "f.ts");

			// The positive control for the liveness check: without it, a condition
			// that simply rejected everything would look like a fix.
			const res = await harness.editTool.execute("edit", {
				path: "f.ts",
				edits: [{ op: "replace", anchor_start: rows[1]!.hash, anchor_end: rows[1]!.hash, lines: ["EDITED"] }],
			});
			expect(getText(res)).toContain("Successfully edited");
			expect(await readFile(path, "utf8")).toBe(
				["alpha", "EDITED", "charlie", "delta", "echo"].join("\n"),
			);
		});
	});
});
