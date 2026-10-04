/**
 * `write`'s two paths, one set of anchor rules (contract §5.1, #224).
 *
 *  - **File exists (overwrite)**: the same Myers alignment `edit`'s `replace`
 *    uses — content that did not change KEEPS its anchor. A one-line fix must
 *    not force a full re-read of a large file.
 *  - **File missing (create)**: write first, then segment by budget, and mint
 *    anchors ONLY for the segment actually returned. A line the budget cut is a
 *    line the model never saw, so it must have no anchor — otherwise "I hold a
 *    marker" stops meaning "I have seen this line" (contract §9 invariant 3).
 *
 * Assertions read the live STATE, not the preview text. A create renders
 * hashline rows, but an UPDATE renders diff rows (`-`/`+`), so parsing the text
 * would silently yield nothing and the test would pass or fail for the wrong
 * reason. The binding is `line → anchor`, so that is what is compared.
 *
 * The `write` tool is shadow-registered per agent and is NOT part of
 * `setupIntegrationTest`'s harness; it is built here the way
 * `write-shadow.test.ts` builds it.
 *
 * @module dsh-hashline-edittool/test/core/write-two-paths
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";

import { probeLines } from "../../src/domain/session/anchor-entry.js";
import { openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { withTempDir } from "../support/fixtures.js";
// `join`, NOT template interpolation: on Windows `dir` carries backslashes, so
// `${dir}/f.ts` is a MIXED-separator string that no longer equals the path the
// tool resolved with `path.resolve` — and the anchor rows are keyed by that
// resolved path. The lookup then answers "no anchors" for a file that has
// them, which is exactly how this file failed on Windows only (POSIX builds
// the same string either way, so it stayed green there).
import { join } from "node:path";

/**
 * The marker is `<anchor>:<line>:<content>` — anchor FIRST, number is a hint.
 *
 * `^\s*` is load-bearing: rows inside a block are INDENTED two spaces
 * (`  Vi:1: …`), and only the block's last row is flush. A pattern anchored at
 * column 0 therefore matches one row per block and silently reports a fraction
 * of the truth — which is exactly how this file's first version produced a
 * bogus "301 of 400" measurement and a filed defect (#233) that did not exist.
 */
const ROW_RE = /^\s*([A-Za-z0-9]{2,8}):(\d+):(.*)$/;

/** The hashline rows a result rendered, as `{ anchor, line }`, in order. */
function rowsOf(modelText: string): Array<{ anchor: string; line: number }> {
	const rows: Array<{ anchor: string; line: number }> = [];
	for (const line of modelText.split("\n")) {
		if (line.startsWith("ANCHOR:")) continue;
		const match = line.match(ROW_RE);
		if (match !== null) rows.push({ anchor: match[1]!, line: Number(match[2]) });
	}
	return rows;
}

/** The `write` tool bound to one temp workspace and session. */
function writeHarness(cwd: string) {
	const tool = buildWriteShadowTool(
		localIO(),
		new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never),
	);
	const execFor = (args: unknown) =>
		({
			signal: new AbortController().signal,
			agent: { id: "test-session", session: { id: "test-session", header: { cwd } } },
			arguments: args,
		}) as unknown as ToolRunContext;
	return {
		write: (input: { file_path: string; content: string }) =>
			tool.execute(input, execFor(input)) as Promise<{ modelText: string; operation: string }>,
	};
}

/** Lines big enough that a response budget must cut the create. */
function bigBody(n: number): string {
	return Array.from({ length: n }, (_, i) => `line-${i}-${"x".repeat(60)}`).join("\n");
}

/** The live binding for a path: `Map<line, anchor>`, via a whole-state probe. */
async function liveBinding(dir: string, path: string, content: string): Promise<Map<number, string>> {
	const probe = await withWorkspace(dir, async () => {
		await openWorkspaceStore(dir);
		return probeLines({ path, content, refs: [], sessionKey: "test-session" });
	});
	if (!probe.ok) throw new Error(`probe failed: ${probe.reason}`);
	const binding = new Map<number, string>();
	for (const [anchor, line] of probe.mapped) binding.set(line, anchor);
	return binding;
}

const SMALL = ["alpha", "bravo", "charlie", "delta"].join("\n");

describe("write — overwrite keeps unchanged lines' anchors (#224 §5.1)", () => {
	it("does not re-anchor a file whose content it did not change", async () => {
		await withTempDir("write-paths-1-", async (dir) => {
			const path = join(dir, "f.ts");
			const harness = writeHarness(dir);

			const created = await harness.write({ file_path: "f.ts", content: SMALL });
			const before = await liveBinding(dir, path, SMALL);
			expect(before.size).toBe(4);
			// Sanity: the create really did render these rows.
			expect(rowsOf(created.modelText)).toHaveLength(4);

			// Rewrite the SAME content. "Content unchanged ⇒ every anchor kept" is
			// the contract's explicit promise; re-anchoring here would invalidate
			// every handle for no reason at all.
			await harness.write({ file_path: "f.ts", content: SMALL });
			expect(await liveBinding(dir, path, SMALL)).toEqual(before);
		});
	});

	it("keeps the anchors of the lines a rewrite left alone", async () => {
		await withTempDir("write-paths-2-", async (dir) => {
			const path = join(dir, "f.ts");
			const harness = writeHarness(dir);
			await harness.write({ file_path: "f.ts", content: SMALL });
			const before = await liveBinding(dir, path, SMALL);

			// Change ONE line. The other three were not touched, so their anchors
			// are still valid and must survive the rewrite.
			const after = ["alpha", "BRAVO CHANGED", "charlie", "delta"].join("\n");
			await harness.write({ file_path: "f.ts", content: after });
			const binding = await liveBinding(dir, path, after);

			expect(binding.get(1)).toBe(before.get(1));
			expect(binding.get(3)).toBe(before.get(3));
			expect(binding.get(4)).toBe(before.get(4));
			// …and the changed line legitimately got a new one.
			expect(binding.get(2)).not.toBe(before.get(2));
		});
	});
});

describe("write — create mints only the segment it returns (#224 §5.1)", () => {
	// The bookkeeping invariant this file exists to pin: with the budget ACTUALLY
	// cutting, the anchors that exist are exactly the rows returned.
	//
	// The body has to be big enough to overflow `responseBudgetChars()` — 400 lines
	// of ~73 chars fit in 48,000, so that size serves EVERYTHING and the assertion
	// would be vacuous.
	it("serves no line the response budget cut", async () => {
		await withTempDir("write-paths-3-", async (dir) => {
			const path = join(dir, "big.ts");
			// 1,500 lines (~110k chars) — comfortably past the 48,000 budget, so the
			// cut really happens.
			const body = bigBody(1500);

			const harness = writeHarness(dir);
			// EXACTLY ONE write: a second one would take the overwrite path, whose
			// diff anchors every line and would make this vacuous.
			const created = await harness.write({ file_path: "big.ts", content: body });
			expect(await readFile(path, "utf8")).toBe(body);

			const shown = rowsOf(created.modelText);
			expect(shown.length).toBeGreaterThan(0);
			// The budget really did cut — otherwise this proves nothing.
			expect(shown.length).toBeLessThan(1500);

			const binding = await liveBinding(dir, path, body);
			expect(binding.size).toBe(shown.length);
		});
	});

	it("anchors a later window when it is actually shown", async () => {
		await withTempDir("write-paths-4-", async (dir) => {
			const path = join(dir, "big.ts");
			const body = bigBody(400);
			const harness = writeHarness(dir);
			await harness.write({ file_path: "big.ts", content: body });
			const before = await liveBinding(dir, path, body);

			// A window read of lines the create never showed. Whether those lines
			// acquire anchors here is the behaviour #233 is about; what this case
			// pins is the direction the contract requires — being SHOWN is what
			// anchors a line, and the set never shrinks.
			const { setupReadTest } = await import("../support/fixtures.js");
			await setupReadTest(dir).readTool.execute("read", { path: "big.ts", offset: 380, limit: 20 });

			const after = await liveBinding(dir, path, body);
			for (const [line, anchor] of before) expect(after.get(line)).toBe(anchor);
		});
	});
});

/**
 * The `read` half of the same bookkeeping, as a stated invariant.
 *
 * "Only returned lines are anchored" holds because `fmtReadPreview` cuts the
 * window on the char budget BEFORE it allocates. That ordering is the whole
 * reason it holds, so it is worth an assertion of its own — pinned here so a
 * future change to the renderer cannot quietly make a served line invisible
 * (or a visible line unanchored) without a test going red.
 *
 * The body is large enough to overflow the budget, so the cut really happens;
 * an earlier version of this file used a size that fit, and the assertion was
 * vacuous.
 */
describe("read — rendered rows == live anchors", () => {
	it("serves exactly the rows it renders, for a file well over the budget", async () => {
		await withTempDir("read-guard-1-", async (dir) => {
			const path = join(dir, "big.ts");
			const body = bigBody(1500);
			await writeFile(path, body, "utf8");

			const { setupReadTest, getText } = await import("../support/fixtures.js");
			const rendered = rowsOf(
				getText(await setupReadTest(dir).readTool.execute("read", { path: "big.ts" })),
			);
			expect(rendered.length).toBeGreaterThan(0);
			expect(rendered.length).toBeLessThan(1500); // the budget really did cut

			const binding = await liveBinding(dir, path, body);
		});
	});
});
