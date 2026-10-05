/**
 * Issue #212 / root cause C — the served-loss rejection.
 *
 * `verifyServedRange` requires every line of the edited range to be in the
 * SESSION's served set; a session restart clears that set while the anchors
 * themselves persist, so the very first cross-restart range edit must reject —
 * and the rejection must say so honestly (the old copy blamed "a previous edit
 * shifted lines"), name the unserved runs, and hand over exact re-read
 * parameters that make the SAME edit succeed.
 *
 * A second harness with a different session key over the SAME workspace
 * simulates the restart: anchors persist (same store), served does not.
 * Also pins the Q4 decision: `E_RANGE_UNSERVED` is gone everywhere.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot, setupIntegrationTest, getText, makeExec, useNumberedRows } from "../support/fixtures.js";
// #244: the line-number switch belongs to the user now and defaults OFF; this
// file asserts numbered rows, so every test here pins it ON.
useNumberedRows();
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildGrepTool } from "../../src/tools/tool-grep.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "issue-212-served-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

const LINES = 20;

async function makeCase(name: string): Promise<{ cwd: string }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	await writeFile(
		join(cwd, "f.txt"),
		Array.from({ length: LINES }, (_, i) => `line-${String(i + 1).padStart(2, "0")} content`).join("\n") + "\n",
	);
	return { cwd };
}

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** Drive the raw tool builders as a DIFFERENT session over the same workspace. */
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

describe("#212 served-loss rejection: honest cause, unserved runs, exact re-read params", () => {
	it("restart + range edit → names the unserved runs, gives re-read params; one read makes the SAME edit succeed", async () => {
		const { cwd } = await makeCase("restart");
		// Session A: read the whole file — every line served & anchored.
		const a = setupIntegrationTest(cwd);
		const fullText = getText(await a.readTool.execute("read", { path: "f.txt" }));
		const anchor1 = /^\s*([A-Za-z0-9]{2,8}):1[:|]/m.exec(fullText)?.[1];
		const anchor20 = /^\s*([A-Za-z0-9]{2,8}):20[:|]/m.exec(fullText)?.[1];
		expect(anchor1).toBeDefined();
		expect(anchor20).toBeDefined();

		// Session B ("restart"): served is empty; only lines 1-2 get served now.
		const b = sessionTools(cwd, "session-b-restart");
		await b.read({ path: "f.txt", offset: 1, limit: 2 });

		// The cross-restart range edit: anchors exist (persisted state) but the
		// middle lines were never shown to THIS session.
		const rejected = await b.edit({
			path: "f.txt",
			edits: [
				{ op: "replace", anchor_start: anchor1, anchor_end: anchor20, lines: ["rewritten-range"] },
			],
		});
		const message = rejected.modelText;
		expect(message).toContain("[E_RANGE_UNVERIFIED]");
		// Honest dual cause — restart first, never-read second; NO stale-shift blame.
		expect(message).toContain("never shown in this session");
		expect(message).toContain("session restart clears the served record");
		expect(message).not.toContain("usually happens after a previous edit shifted lines");
		// The unserved runs and the EXACT re-read parameters (lines 3-20).
		expect(message).toContain("lines 3-20");
		expect(message).toContain('offset: 3, limit: 18');
		// The echo still carries real anchors only.
		expect(/\n\s*:\d+[:|]/.test(`\n${message}`)).toBe(false);

		// Follow the prescription: one read of the named window …
		await b.read({ path: "f.txt", offset: 3, limit: 18 });
		// … and the SAME edit succeeds.
		const retried = await b.edit({
			path: "f.txt",
			edits: [
				{ op: "replace", anchor_start: anchor1, anchor_end: anchor20, lines: ["rewritten-range"] },
			],
		});
		expect(retried.modelText).toContain("Successfully edited");
	});

	it("grep-hit rows stay directly editable (cross-tool serve contract intact)", async () => {
		const { cwd } = await makeCase("grep-edit");
		const h = sessionTools(cwd, "grep-session");
		// No read at all — the grep hit itself is the serve.
		const g = buildGrepTool(localIO());
		const grepValue = (await g.execute(
			{ path: "f.txt", pattern: "line-07", context: 0 },
			makeExec(cwd, "grep-session")({ path: "f.txt", pattern: "line-07", context: 0 }),
		)) as unknown as { modelText: string };
		const anchor7 = /^\s*([A-Za-z0-9]{2,8}):7[:|]/m.exec(grepValue.modelText)?.[1];
		expect(anchor7).toBeDefined();
		const edited = await h.edit({
			path: "f.txt",
			edits: [{ op: "replace", anchor_start: anchor7, anchor_end: anchor7, lines: ["line-07 edited"] }],
		});
		expect(edited.modelText).toContain("Successfully edited");
	});
});

describe("#212 >2000-line unserved span: the capped prescription stays actionable", () => {
	it("caps the prescribed window, and following the re-read params converges to success", async () => {
		const cwd = join(tmpHome, "capped-span");
		await mkdir(cwd, { recursive: true });
		const TOTAL = 2100;
		await writeFile(
			join(cwd, "big.txt"),
			Array.from({ length: TOTAL }, (_, i) => `l${String(i + 1).padStart(4, "0")}`).join("\n") + "\n",
		);
		// Session A serves the whole file in two windows (the second has no
		// budget cut — 100 rows fit easily).
		const a = setupIntegrationTest(cwd);
		await a.readTool.execute("read", { path: "big.txt", offset: 1, limit: 2000 });
		const tailText = getText(await a.readTool.execute("read", { path: "big.txt", offset: 2001, limit: 100 }));
		const headText = getText(await a.readTool.execute("read", { path: "big.txt", offset: 1, limit: 2000 }));
		const anchor1 = /^\s*([A-Za-z0-9]{2,8}):1[:|]/m.exec(headText)?.[1];
		const anchorEnd = /^\s*([A-Za-z0-9]{2,8}):2100[:|]/m.exec(tailText)?.[1];
		expect(anchor1).toBeDefined();
		expect(anchorEnd).toBeDefined();

		// Session B ("restart"): serves only lines 1-2, then spans 1..2100 —
		// 2098 unserved lines, over the 2000-line prescription cap.
		const b = sessionTools(cwd, "session-b-capped");
		await b.read({ path: "big.txt", offset: 1, limit: 2 });
		const editArgs = {
			path: "big.txt",
			edits: [{ op: "replace", anchor_start: anchor1, anchor_end: anchorEnd, lines: ["rewritten"] }],
		};
		const rejected = await b.edit(editArgs);
		expect(rejected.modelText).toContain("window capped");
		expect(rejected.modelText).toContain("offset: 3, limit: 2000");

		// The prescription stays actionable: each rejection names a window;
		// reading it (plus the read's own resume footer when the char budget
		// cuts it) shrinks the unserved set until the SAME edit succeeds.
		let succeeded = false;
		for (let round = 0; round < 6; round++) {
			const retry = await b.edit(editArgs);
			if (retry.modelText.includes("Successfully edited")) {
				succeeded = true;
				break;
			}
			const params = /offset: (\d+), limit: (\d+)/.exec(retry.modelText);
			if (params === null) {
				throw new Error(`rejection must keep prescribing re-read params:\n${retry.modelText}`);
			}
			await b.read({ path: "big.txt", offset: Number(params[1]), limit: Number(params[2]) });
		}
		expect(succeeded).toBe(true);
	});
});

describe("#212 Q4 decision: the dead `E_RANGE_UNSERVED` promise is gone", () => {
	it("no residue in the shipped contract surfaces", async () => {
		const root = process.cwd();
		for (const file of [
			join(root, "README.md"),
			join(root, "README.zh.md"),
			join(root, "src", "domain", "edit", "prompts.ts"),
			join(root, "src", "hashline", "anchor-pipeline.ts"),
		]) {
			const text = await readFile(file, "utf-8");
			expect(text, `${file} still mentions E_RANGE_UNSERVED`).not.toContain("E_RANGE_UNSERVED");
		}
	});
});

/**
 * §2.4: one code, four causes — and the wording has to match the cause.
 *
 * `verifyServedRange` used to explain every served-set failure with "a session
 * restart clears the served record". That is true for exactly one of the four
 * cases. For a line whose CONTENT changed underneath the session it prescribes
 * the wrong recovery: the model is told to go re-read a file it could already
 * fix with the marker the rejection echoes.
 */
describe("#212 §2.4 — the refusal distinguishes restart from a changed line", () => {
	it("a line rewritten out-of-band is refused, and the file is untouched", async () => {
		const { cwd } = await makeCase("cause");
		const tools = sessionTools(cwd, "cause-session");
		const first = await tools.read({ path: "f.txt" });
		// The anchor of line 3, taken from the read the model would have seen.
		const anchor = /^\s*([A-Za-z0-9]{2,8}):3[:|]/m.exec(first.modelText)?.[1];
		expect(anchor).toBeDefined();

		// Out-of-band rewrite of THAT line. No tool call in between, so nothing
		// reconciles the served mirror.
		const rewritten =
			Array.from({ length: LINES }, (_, i) =>
				i === 2 ? "line-03 REWRITTEN" : `line-${String(i + 1).padStart(2, "0")} content`,
			).join("\n") + "\n";
		await writeFile(join(cwd, "f.txt"), rewritten);

		const res = await tools.edit({
			path: "f.txt",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["x"] }],
		});
		// The code set is unchanged — only the wording differs by cause.
		expect(res.modelText).toMatch(/E_STALE|E_RANGE_UNVERIFIED/);
		// Refusal is all-or-nothing: the out-of-band rewrite survives.
		expect(await readFile(join(cwd, "f.txt"), "utf-8")).toBe(rewritten);
	});
});
