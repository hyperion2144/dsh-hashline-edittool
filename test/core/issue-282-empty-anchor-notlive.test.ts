/**
 * Issue #282 — a sparse-projection empty slot ("") is not a caller anchor.
 *
 * `anchorsFor` fills never-allocated lines with ""; the edit path forwards
 * every hash in the edited span to `probeLines`, so an interior line that was
 * never READ arrived as the ref `{ anchor: "" }`. `byAnchor.get("")` can only
 * miss, which routed the line to CONDITION 1 (`not-live`) and the rejection
 * blamed "removed or rewritten" for a line the model never saw. The truth is
 * CONDITION 2 — this session was never shown the line — whose recovery copy
 * names the unserved runs and the exact re-read window (#212's prescription).
 *
 * Pins:
 *  1. cross-gap edit → E_RANGE_UNVERIFIED with the never-seen copy and exact
 *     re-read params (offset 13, limit 7); NOT the not-live copy. The edit
 *     must still REJECT — rendered ⊆ served survives #212.
 *  2. following the prescription once makes the SAME edit succeed.
 *  3. `probeLines` routes an explicit "" ref to never-seen, never not-live.
 *  4. the pure pipeline (no session) classifies a "" caller anchor as
 *     never-seen too — the fallback classifier knows "" means "none".
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getWritableTempRoot,
	makeExec,
	useNumberedRows,
} from "../support/fixtures.js";
// Numbered rows (`<anchor>:<line>`), so the marker regexes below can name a line.
useNumberedRows();
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { probeLines } from "../../src/domain/session/anchor-entry.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { applyEdit, type HEdit } from "../../src/hashline/anchor-pipeline.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "issue-282-notlive-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

const LINES = 30;

async function makeCase(name: string): Promise<{ cwd: string; text: string }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	const text =
		Array.from({ length: LINES }, (_, i) => `line-${String(i + 1).padStart(2, "0")} content`).join("\n") + "\n";
	await writeFile(join(cwd, "f.txt"), text);
	return { cwd, text };
}

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** Drive the raw tool builders as ONE named session over the workspace. */
function sessionTools(cwd: string, sessionKey: string) {
	const io: FileIO = localIO();
	const sandbox = testSandbox();
	const run = <T>(tool: { execute: (args: unknown, exec: unknown) => Promise<T> }, args: unknown): Promise<T> =>
		tool.execute(args, makeExec(cwd, sessionKey)(args));
	return {
		read: (args: Record<string, unknown>) =>
			run(buildReadTool(io) as never, args) as Promise<{ modelText: string }>,
		edit: (args: Record<string, unknown>) =>
			run(buildEditTool(io, sandbox) as never, args) as Promise<{ modelText: string }>,
	};
}

describe("#282 — an unread interior line is never-seen, not not-live", () => {
	it("cross-gap edit → never-seen copy with re-read params; following them once makes the same edit succeed", async () => {
		const { cwd, text } = await makeCase("gap");
		const tools = sessionTools(cwd, "gap-session");
		// Two disjoint windows: lines 10-12 and 20-22. Lines 13-19 are never shown.
		const w1 = (await tools.read({ path: "f.txt", offset: 10, limit: 3 })).modelText;
		const w2 = (await tools.read({ path: "f.txt", offset: 20, limit: 3 })).modelText;
		const anchor10 = /^\s*([A-Za-z0-9]{2,8}):10[:|]/m.exec(w1)?.[1];
		const anchor20 = /^\s*([A-Za-z0-9]{2,8}):20[:|]/m.exec(w2)?.[1];
		expect(anchor10).toBeDefined();
		expect(anchor20).toBeDefined();

		const editArgs = {
			path: "f.txt",
			edits: [
				{ op: "replace", anchor_start: anchor10, anchor_end: anchor20, lines: ["merged-10-to-20"] },
			],
		};
		const rejected = await tools.edit(editArgs);
		const message = rejected.modelText;
		expect(message).toContain("[E_RANGE_UNVERIFIED]");
		// The honest cause — the session was never shown those lines…
		expect(message).toContain("never shown in this session");
		// …the exact unserved run and re-read window (lines 13-19)…
		expect(message).toContain("lines 13-19");
		expect(message).toContain("offset: 13, limit: 7");
		// …and NOT the removed-or-rewritten lie (#282).
		expect(message).not.toContain("removed or rewritten");

		// The rejection stands: a cross-gap span still cannot write (#212 invariant).
		expect(await readFile(join(cwd, "f.txt"), "utf-8")).toBe(text);

		// Follow the prescription: one read of the named window …
		await tools.read({ path: "f.txt", offset: 13, limit: 7 });
		// … and the SAME edit succeeds.
		const retried = await tools.edit(editArgs);
		expect(retried.modelText).toContain("Successfully edited");
	});

	it("probeLines routes an explicit \"\" ref to never-seen, never not-live", async () => {
		const { cwd } = await makeCase("probe");
		const tools = sessionTools(cwd, "probe-session");
		const w3 = (await tools.read({ path: "f.txt", offset: 3, limit: 1 })).modelText;
		const anchor3 = /^\s*([A-Za-z0-9]{2,8}):3[:|]/m.exec(w3)?.[1];
		expect(anchor3).toBeDefined();
		const content = await readFile(join(cwd, "f.txt"), "utf-8");
		const path = join(cwd, "f.txt");

		// Sanity: the real anchor resolves for this session.
		// probeLines reads the workspace-scoped store: the edit engine always
		// enters `withWorkspace(cwd, …)` first (see edit-engine.ts), so the test
		// must too, or the persisted rows read back empty.
		const ok = await withWorkspace(cwd, () =>
			probeLines({ path, content, refs: [{ anchor: anchor3!, line: 3 }], sessionKey: "probe-session" }),
		);
		expect(ok.ok).toBe(true);

		// The "" slot: an unallocated interior line the caller's span covers.
		// The "" slot: an unallocated interior line the caller's span covers.
		const fail = await withWorkspace(cwd, () =>
			probeLines({
				path,
				content,
				refs: [
					{ anchor: anchor3!, line: 3 },
					{ anchor: "", line: 6 },
				],
				sessionKey: "probe-session",
			}),
		);
		expect(fail.ok).toBe(false);
		if (!fail.ok) {
			expect(fail.reason).toBe("never-seen");
			expect(fail.rows.map((r) => r.given)).toContain("");
		}
	});

	it("the pure pipeline (no session) classifies a \"\" caller anchor as never-seen", async () => {
		const content = Array.from({ length: 6 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
		// Sparse view: endpoints allocated, interiors are "" slots (never minted).
		const hashes = ["AA", "", "", "", "", "BB"];
		// Endpoints ARE served; only the "" interiors can fail the membership walk.
		const served = new Set(["AA", "BB"]);
		const edit: HEdit = {
			content_lines: ["merged"],
			hash_bounds: [
				{ anchor: "AA" },
				{ anchor: "BB" },
			],
		};
		try {
			await applyEdit(content, edit, undefined, hashes, "f.txt", served);
			expect.unreachable("a cross-gap pure edit must still be rejected");
		} catch (error) {
			expect((error as { name?: string }).name).toBe("ServedRejectionError");
			expect((error as { code?: string }).code).toBe("E_RANGE_UNVERIFIED");
			const message = (error as Error).message;
			expect(message).toContain("never shown in this session");
			expect(message).toContain("offset: 2, limit: 4");
			expect(message).not.toContain("removed or rewritten");
		}
	});
});
