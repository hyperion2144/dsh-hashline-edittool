/**
 * The write diff's anchor allocation is O(rendered rows), not O(file) (#188).
 *
 * Why this exists: when the post-write preview fails, `buildDiffRows` used to
 * fall back to `lineHashes(content, path)`, which allocates anchors for EVERY
 * line and persists them. Measured on an 800k-line file that is 394 MB of heap
 * and ~29 s inside one tool call — the dense allocator has no bound, so it is
 * the same fatal-abort family as the alignment DP table that #182 clamped. The
 * work is also wasted: a write's diff renders a handful of hunks.
 *
 * Two things are pinned here, because either could regress silently:
 *   1. SCALE — the rows persisted for the path are the diff's window, not the
 *      file's line count (a 40k-line file with two small changes must not
 *      allocate 40k rows);
 *   2. EQUIVALENCE — the rendered diff is identical to the one the old dense
 *      allocation produced, anchors included.
 *
 * @module dsh-hashline-edittool/test/core/write-diff-bounded
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { allocateForRenderedRows } from "../../src/tools/tool-write-shadow.js";
import { genDiff } from "../../src/render/edit-diff.js";
import { anchorsFor, allocateForLines } from "../../src/hashline/session-anchors.js";
import { splitLines } from "../../src/infra/utils.js";
import { contextLinesCfg } from "../../src/hashline/hash-assign.js";
import { withWorkspace } from "../../src/domain/session/session-view.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "write-diff-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

/** Persisted anchor rows for a path — the observable cost of an allocation. */
function anchorRowCount(cwd: string, path: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		return (
			db.prepare("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?").get(path) as {
				n: number;
			}
		).n;
	} finally {
		db.close();
	}
}

/** A file whose two small edits sit far apart. */
function bigPair(fileLines: number): { before: string; after: string } {
	const line = (i: number) => `export const value_${i} = ${i}; // filler filler filler`;
	const before = Array.from({ length: fileLines }, (_, i) => line(i)).join("\n") + "\n";
	const changed = before.split("\n");
	changed[10] = "export const value_10 = 999;";
	changed[fileLines - 5] = "export const value_tail = -1;";
	return { before, after: changed.join("\n") };
}

describe("#188: a write's diff allocates its window, not the file", () => {
	it("allocates only the rendered rows and renders the same diff", async () => {
		const cwd = join(tmpHome, "scale");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "big.ts");
		const { before, after } = bigPair(40_000);
		await writeFile(file, before);

		const harness = setupIntegrationTest(cwd);
		// A window read establishes the session state (`anchorsFor` needs it) and
		// is exactly what a real write's preview would have served.
		await harness.readTool.execute("read", { path: "big.ts", limit: 5 });

		// Persistence is wired per workspace scope (the write tool runs inside it),
		// so the probe enters the same scope its real caller would.
		const view = await withWorkspace(cwd, () =>
			allocateForRenderedRows(file, before, after, undefined),
		);
		expect(view.length).toBe(splitLines(after).length);

		// SCALE: the rows that actually rendered have anchors; the file did not
		// get allocated. Two hunks with context is tens of lines, not 40k.
		const rendered = genDiff(before, after, contextLinesCfg(), view, undefined);
		const renderedLines = rendered.rows.length;
		expect(renderedLines).toBeGreaterThan(0);
		// `row.hash` is the PURE anchor ("" when the line has none); `row.anchor`
		// is the formatted marker, which renders four spaces when the hash is
		// missing — so it can never prove anything here.
		const changedRows = rendered.rows.filter((row) => row.kind === "+");
		expect(changedRows.length).toBe(2);
		expect(changedRows.every((row) => row.hash !== "")).toBe(true);
		expect(rendered.rows.filter((row) => row.kind === " ").every((row) => row.hash !== "")).toBe(true);
		const persisted = anchorRowCount(cwd, file);
		expect(persisted).toBeGreaterThanOrEqual(renderedLines);
		expect(persisted).toBeLessThan(renderedLines * 3 + 50);
		// EQUIVALENCE: the old dense allocation renders the same rows, anchors
		// included — so this is a cost change, not a behaviour change.
		const denseAfter = allocateForLines(
			file,
			after,
			Array.from({ length: splitLines(after).length }, (_, i) => i + 1),
		);
		const denseRows = genDiff(before, after, contextLinesCfg(), denseAfter, undefined).rows;
		const shape = (rows: typeof denseRows) =>
			rows.map((r) => [r.kind, r.lineNumber, r.hash, r.content]);
		expect(shape(denseRows)).toEqual(shape(rendered.rows));
	}, 120_000);

	it("keeps the sparse view's inheritance when nothing new needs allocating", async () => {
		const cwd = join(tmpHome, "inherit");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "mod.ts");
		const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		await writeFile(file, before);
		const harness = setupIntegrationTest(cwd);
		await harness.readTool.execute("read", { path: "mod.ts" });

		// Same content on both sides: nothing to render, so nothing to allocate
		// beyond what the session already holds.
		const beforeCount = anchorRowCount(cwd, file);
		const view = await withWorkspace(cwd, () =>
			allocateForRenderedRows(file, before, before, undefined),
		);
		expect(anchorRowCount(cwd, file)).toBe(beforeCount);
		expect(view.length).toBe(splitLines(before).length);
		expect(view.some((a) => a !== "")).toBe(true);
	}, 60_000);
});
