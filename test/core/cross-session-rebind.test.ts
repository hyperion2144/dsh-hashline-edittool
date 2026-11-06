/**
 * Issue #420 — cross-session anchor rebind.
 *
 * The persisted layer keeps "anchor ↔ content" consistent (a re-mint IS a new
 * identity), but the served verdict only checked MEMBERSHIP: A's served record
 * for an anchor X outlives B's release of X, and when B's next edit re-mints X
 * onto a different line, A's stale handle passes every check and the edit
 * lands on a line A has never seen.
 *
 * The scenario below drives the REAL verdict chain — `probeLines` plus the
 * `verifyServedRange` wiring the edit engine uses — over real persisted state
 * built by the real primitives (`anchorFor`, `releaseLines`,
 * `updateAnchorsAfterEdit`). Only the slot-crafting (finding content whose
 * content key lands on X's freed slot) mirrors the measurement script
 * `07-silent-wrong-line-proof.ts`; no test seeds a store by hand.
 *
 * @module dsh-hashline-edittool/test/core/cross-session-rebind
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contentKey } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/infra/utils.js";
import {
	ServedRejectionError,
	verifyServedRange,
} from "../../src/hashline/anchor-pipeline.js";
import {
	anchorForContent,
	clearReleasePool,
	probeLines,
	releaseLines,
} from "../../src/domain/session/anchor-entry.js";
import { updateAnchorsAfterEdit } from "../../src/domain/session/anchor-state.js";
import { buildServedRowsFromDiff } from "../../src/domain/edit/served-rows.js";
import { recordEchoServes } from "../../src/domain/session/session-view.js";
import { loadServed } from "../../src/domain/session/served.js";
import { openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { withTempDir } from "../support/fixtures.js";

const SESSION_A = "cross-session-a";
const SESSION_B = "cross-session-b";

/** 400 distinct lines — anchors land in the 2-char layer (3844 slots). */
const LINES = Array.from(
	{ length: 400 },
	(_, i) => `const row_${i + 1} = fn_${(i + 1) % 17}(${i + 1});`,
);
const L1 = 201;
const L2 = 350;
const TEXT0 = LINES.join("\n");
const TEXT1 = LINES
	.map((line, i) => (i === L1 - 1 ? `const row_${L1} = EDITED_BY_B();` : line))
	.join("\n");

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const anchorValue = (anchor: string): number =>
	[...anchor].reduce((value, ch) => value * 62 + BASE62.indexOf(ch), 0);

/**
 * Content whose slot in the 2-char layer IS `anchor`'s slot — the allocator's
 * first probe for it mints the released anchor back. Bounded: the average hit
 * is ~1900 candidates, and the cap keeps CI honest even on an unlucky seed.
 */
function craftRebind(target: string): string {
	const slot = anchorValue(target) % 3844;
	for (let i = 0; i < 2_000_000; i++) {
		const candidate = `const REASSIGNED_${i} = shard(${i}) + "${i}";`;
		if (contentKey(candidate) % 3844 === slot) return candidate;
	}
	throw new Error("slot crafting found no candidate within the cap");
}

describe("a cross-session rebind must not silently edit a line the session never saw (#420)", () => {
	it("refuses the stale anchor with a rebound verdict, not a silent write", async () => {
		await withTempDir("rebind-420-1-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, TEXT0, "utf8");

			await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);

				// 1. A reads the file: line L1 gets anchor X, served to A.
				const a0 = await anchorForContent({
					path,
					lines: LINES.map((_, i) => i + 1),
					content: TEXT0,
					sessionKey: SESSION_A,
				}).then((r) => r.anchors);
				const stale = a0[L1 - 1]!;
				expect(stale).toBeTruthy();

				// 2. B edits line L1: the real release — out of `anchor_lines`,
				//    out of B's served set. A's record stays.
				await releaseLines({
					path,
					lines: [L1],
					content: TEXT0,
					sessionKey: SESSION_B,
				});
				// The release pool is per-CALL state; a real edit call ends here.
				clearReleasePool(path);

				// Window phase (the safe refusal that already works): A cannot
				// write with X — the anchor is not live at all.
				const windowProbe = await probeLines({
					path,
					content: TEXT1,
					refs: [{ anchor: stale, line: L1 }],
					sessionKey: SESSION_A,
				});
				expect(windowProbe.ok).toBe(false);
				if (!windowProbe.ok) expect(windowProbe.reason).toBe("not-live");

				// 3. B's second edit writes crafted content onto L2; the freed
				//    slot makes the allocator re-mint X there.
				const repl = craftRebind(stale);
				const text2 = TEXT1
					.split("\n")
					.map((line, i) => (i === L2 - 1 ? repl : line))
					.join("\n");
				const a1 = await updateAnchorsAfterEdit({
					path,
					oldContent: TEXT0,
					newContent: TEXT1,
					oldAnchors: [...a0],
					hunks: [
						{ oldStart1: L1, oldEnd1: L1, finalStart1: L1, finalEnd1: L1 },
					],
				});
				const a2 = await updateAnchorsAfterEdit({
					path,
					oldContent: TEXT1,
					newContent: text2,
					oldAnchors: a1,
					hunks: [
						{ oldStart1: L2, oldEnd1: L2, finalStart1: L2, finalEnd1: L2 },
					],
				});
				// The rebind precondition itself: X is live again, on L2.
				expect(a2[L2 - 1]).toBe(stale);

				// 4. A edits with the stale X (it never re-read; it believes L1).
				//    Both conditions used to pass and the edit silently landed on
				//    L2 — the defect. The fix: the served mirror records WHICH
				//    binding A saw, and the verdict compares it.
				const probe = await probeLines({
					path,
					content: text2,
					refs: [{ anchor: stale, line: L1 }],
					sessionKey: SESSION_A,
				});
				expect(probe.ok).toBe(false);
				if (!probe.ok) expect(probe.reason).toBe("rebound");

				// The same verdict through the pipeline wiring the edit engine
				// uses — rejected with E_RANGE_STALE, echoing line L2's CURRENT
				// content (the echo is what re-serves A).
				const served = await loadServed(SESSION_A, path);
				let rejection: ServedRejectionError | undefined;
				try {
					verifyServedRange({
						served,
						startAnchor: stale,
						endAnchor: stale,
						startLine: L2,
						endLine: L2,
						fileAnchors: a2,
						fileLines: splitLines(text2),
						filePath: path,
						content: text2,
						verdict: { ok: false, badLines: [L2], reason: "rebound" },
					});
				} catch (error) {
					if (error instanceof ServedRejectionError) rejection = error;
					else throw error;
				}
				expect(rejection).toBeDefined();
				expect(rejection!.code).toBe("E_RANGE_STALE");
				expect(rejection!.message).toContain("REASSIGNED_");

				// 5. The echo re-served the NEW binding to A: one round-trip
				//    later, the same anchor is usable again — for the line it
				//    NOW names.
				if (rejection && rejection.servedRows.length > 0) {
					await recordEchoServes(
						SESSION_A,
						path,
						rejection.servedRows,
						"live",
					);
					const retry = await probeLines({
						path,
						content: text2,
						refs: [{ anchor: stale, line: L2 }],
						sessionKey: SESSION_A,
					});
					expect(retry.ok).toBe(true);
				}
			});
		});
	});

	it("keeps the releasing session itself unharmed: B may reuse its own re-minted anchor", async () => {
		await withTempDir("rebind-420-2-", async (dir) => {
			const path = join(dir, "f.ts");
			await writeFile(path, TEXT0, "utf8");

			await withWorkspace(dir, async () => {
				await openWorkspaceStore(dir);

				const a0 = await anchorForContent({
					path,
					lines: LINES.map((_, i) => i + 1),
					content: TEXT0,
					sessionKey: SESSION_B,
				}).then((r) => r.anchors);
				const anchor = a0[L1 - 1]!;

				await releaseLines({
					path,
					lines: [L1],
					content: TEXT0,
					sessionKey: SESSION_B,
				});
				clearReleasePool(path);

				const repl = craftRebind(anchor);
				const text2 = TEXT1
					.split("\n")
					.map((line, i) => (i === L2 - 1 ? repl : line))
					.join("\n");
				const a1 = await updateAnchorsAfterEdit({
					path,
					oldContent: TEXT0,
					newContent: TEXT1,
					oldAnchors: [...a0],
					hunks: [
						{ oldStart1: L1, oldEnd1: L1, finalStart1: L1, finalEnd1: L1 },
					],
				});
				const a2 = await updateAnchorsAfterEdit({
					path,
					oldContent: TEXT1,
					newContent: text2,
					oldAnchors: a1,
					hunks: [
						{ oldStart1: L2, oldEnd1: L2, finalStart1: L2, finalEnd1: L2 },
					],
				});
				expect(a2[L2 - 1]).toBe(anchor);

				// B's own edit serves its diff window through the engine's serve
				// path (buildServedRowsFromDiff → anchorForInWorkspace): the same
				// write that minted X for L2 records the binding served to B,
				// exactly as a real edit call would.
				await buildServedRowsFromDiff({
					before: TEXT1,
					after: text2,
					resultHashes: [...a2],
					absolutePath: path,
					cwd: dir,
					sessionKey: SESSION_B,
				});

				// B minted X for L2 in its own edit; the mint recorded the
				// binding served. The fingerprint comparison must PASS for B —
				// the same-session legal reuse the fix must not hurt.
				const probe = await probeLines({
					path,
					content: text2,
					refs: [{ anchor, line: L2 }],
					sessionKey: SESSION_B,
				});
				expect(probe.ok).toBe(true);
			});
		});
	});
});
