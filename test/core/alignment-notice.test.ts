/**
 * The alignment-degradation notice (#182, ADR-0011): when a bounded realign
 * gives up, every anchor the session holds for that file stops existing — and
 * the model must be TOLD, in one plain line, rather than discovering it as an
 * unexplained never-served rejection.
 *
 * Two layers are pinned here:
 *  - the registry's one-shot semantics (unit);
 *  - the real edit path, with the DP budget pinned small so the degraded branch
 *    is reachable from an ordinary edit instead of only from a direct call to
 *    the aligner.
 *
 * @module dsh-hashline-edittool/test/core/alignment-notice
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ALIGNMENT_DEGRADED_NOTICE,
	noteAlignmentDegraded,
	resetAlignmentNotices,
	takeAlignmentNotice,
} from "../../src/hashline/session-anchors.js";
import {
	resetEffectiveDpBudgetForTests,
	setEffectiveDpBudgetForTests,
} from "../../src/hashline/align-bounded.js";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "align-notice-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

afterEach(() => {
	resetAlignmentNotices();
	resetEffectiveDpBudgetForTests();
});

describe("the notice registry", () => {
	it("hands the notice out once per path, then forgets it", () => {
		noteAlignmentDegraded("/tmp/a.ts");
		expect(takeAlignmentNotice("/tmp/a.ts")).toBe(ALIGNMENT_DEGRADED_NOTICE);
		// One-shot: the second take must not repeat the same line at every
		// later tool call.
		expect(takeAlignmentNotice("/tmp/a.ts")).toBeUndefined();
	});

	it("keeps paths apart", () => {
		noteAlignmentDegraded("/tmp/a.ts");
		expect(takeAlignmentNotice("/tmp/b.ts")).toBeUndefined();
		expect(takeAlignmentNotice("/tmp/a.ts")).toBe(ALIGNMENT_DEGRADED_NOTICE);
	});

	it("says what to do about it, in the language of the card and the tools", () => {
		// The message is the model's only instruction here: it must name the
		// action (re-read) rather than describe an internal state.
		expect(ALIGNMENT_DEGRADED_NOTICE).toContain("read");
		expect(ALIGNMENT_DEGRADED_NOTICE).not.toContain("E_");
		expect(ALIGNMENT_DEGRADED_NOTICE.length).toBeLessThan(120);
	});
});

describe("the notice reaches the edit result", () => {
	it("an edit after a degraded realign carries the notice, exactly once", async () => {
		const cwd = join(tmpHome, "project");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "big.ts");
		const lines = Array.from({ length: 60 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
		await writeFile(file, lines.join("\n") + "\n");

		const harness = setupIntegrationTest(cwd);
		const readText = getText(await harness.readTool.execute("read", { path: "big.ts", limit: 10 }));
		const anchor = /^\s*([A-Za-z0-9]{2,8}):5[:|]/m.exec(readText)?.[1];
		expect(anchor).toBeDefined();

		// Pin the DP budget so small that ANY realign degrades: the same branch
		// a 10 k-line file takes on a small heap, reachable here in milliseconds.
		setEffectiveDpBudgetForTests(1);
		// An EXTERNAL rewrite (not a tool edit) is what routes through
		// `ensureState`'s whole-file realign — the degraded path.
		const rewritten = lines.map((line) => `${line} // rewritten`).join("\n") + "\n";
		await writeFile(file, rewritten);

		// The degraded realign dropped every pre-rewrite anchor, so the edit must
		// use a FRESH one — which is exactly what the notice tells the model to
		// do. The read below triggers the realign (and records the notice); the
		// edit then drains it into the result the model sees.
		const readText2 = getText(await harness.readTool.execute("read", { path: "big.ts", limit: 10 }));
		const fresh = /^\s*([A-Za-z0-9]{2,8}):5[:|]/m.exec(readText2)?.[1];
		expect(fresh).toBeDefined();
		const first = getText(
			await harness.editTool.execute("edit", {
				path: "big.ts",
				edits: [{ op: "replace", anchor_start: fresh, anchor_end: fresh, lines: ["export const v5 = 500;"] }],
			}),
		);
		expect(first).toContain(ALIGNMENT_DEGRADED_NOTICE);

		// And it does not nag: with the budget back to normal the next read+edit
		// on the same file degrades nothing, so the notice stays gone.
		setEffectiveDpBudgetForTests(undefined);

		// And it does not nag: the next edit on the same file is quiet.
		const readText3 = getText(await harness.readTool.execute("read", { path: "big.ts", limit: 10 }));
		const anchor2 = /^\s*([A-Za-z0-9]{2,8}):6[:|]/m.exec(readText3)?.[1];
		expect(anchor2).toBeDefined();
		const second = getText(
			await harness.editTool.execute("edit", {
				path: "big.ts",
				edits: [{ op: "replace", anchor_start: anchor2, anchor_end: anchor2, lines: ["export const v6 = 600;"] }],
			}),
		);
		expect(second).not.toContain(ALIGNMENT_DEGRADED_NOTICE);
	}, 60_000);
});
