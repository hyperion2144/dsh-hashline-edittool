/**
 * #247 (C1) — a PARTIALLY failed multi-file `edit` must be visible in the card.
 *
 * The persisted channel is exclusive and exhaustive:
 *
 *   - the call changed NOTHING → `presentationMeta = { error }`, exactly as
 *     before (the whole-call failure card owns that path);
 *   - at least one file succeeded → the success side exactly as before PLUS
 *     `failures`, one entry per failed file, in input order. NEVER both;
 *   - every file succeeded → no `failures` key at all.
 *
 * The entries reuse the persisted error shape, so the card renders a failed
 * file with the same component as a whole-call failure.
 *
 * Two traps these tests exist for:
 *
 *   1. the list must NOT live inside the "has hunks" branch. When the only
 *      successful file was a no-op, `multiDiffs` is empty — a list nested in
 *      that branch would vanish while the row reads "success";
 *   2. a failure's code must come from the HEAD of the inner cause, never from
 *      the LAST `[E_*]` literal in the message: the ±3 echo is kept verbatim, so
 *      an echoed source line that itself carries a code literal must not be able
 *      to rename the failure.
 *
 * @module dsh-hashline-edittool/test/partial-failure-meta
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { makeExec, withTempFile } from "../support/fixtures.js";

/** One failed file, as the card's error card consumes it (`ErrorMeta`). */
interface FailureEntry {
	path: string;
	code?: string;
	message: string;
	context?: string;
	hint?: string;
}

interface EditMeta {
	error?: { code: string; message: string; path?: string; context?: string };
	failures?: FailureEntry[];
	diffs?: unknown[];
	diffRowGroups?: Array<{ path: string; rows: unknown[] }>;
}

interface EditValue {
	success?: unknown[];
	fail?: Array<{ path: string; code: string; message: string }>;
	error?: { code: string };
	multiDiffs?: unknown[];
	multiDiffRowGroups?: Array<{ path: string; rows: unknown[] }>;
}

/** The two seams these tests read: the canonical value and its persisted meta. */
function harness(cwd: string) {
	const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
	const read = buildReadTool(localIO()) as unknown as {
		execute: (args: unknown, exec: unknown) => Promise<{ hashlines: Array<{ number: number; hash: string; text: string }> }>;
	};
	const edit = buildEditTool(localIO(), sandbox) as unknown as {
		execute: (args: unknown, exec: unknown) => Promise<EditValue>;
		output: { presentationMeta: (args: unknown, value: unknown) => EditMeta };
	};
	const exec = makeExec(cwd)({});
	return { read, edit, exec };
}

/** Serve `file` and return the anchor of the line whose text is `text`. */
async function anchorOf(
	read: ReturnType<typeof harness>["read"],
	exec: unknown,
	file: string,
	text: string,
): Promise<string> {
	const served = await read.execute({ file_path: file }, exec);
	const row = served.hashlines.find((h) => h.text === text);
	if (row === undefined) throw new Error(`no served row ${text} in ${file}`);
	return row.hash;
}

/** A replace of exactly the served line — same text = the file is a NO-OP. */
function replaceLine(path: string, anchor: string, lines: string[]) {
	return { path, op: "replace", anchor_start: anchor, anchor_end: anchor, lines };
}

describe("#247 failures channel — a partially failed multi-file edit", () => {
	it("mixed: the success side stays, `failures` is added, and there is no `error`", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "x\ny\n", "utf-8");
			const { read, edit, exec } = harness(cwd);
			const alpha = await anchorOf(read, exec, "a.txt", "alpha");

			const value = await edit.execute(
				{
					edits: [
						replaceLine("a.txt", alpha, ["ALPHA!"]),
						replaceLine("b.txt", "!zzz", ["X!"]),
					],
				},
				exec,
			);
			const meta = edit.output.presentationMeta({ edits: [] }, value);

			expect(value.success).toHaveLength(1);
			expect(value.fail).toHaveLength(1);
			expect(value.error).toBeUndefined();
			// The success side is untouched: hunks + the per-file gutter groups.
			expect(Array.isArray(meta.diffs)).toBe(true);
			expect(meta.diffs).toHaveLength(1);
			expect(meta.diffRowGroups).toHaveLength(1);
			expect(meta.error).toBeUndefined();

			const failures = meta.failures!;
			expect(failures).toHaveLength(1);
			expect(failures[0]!.path).toBe("b.txt");
			// The per-file VALUE keeps ADR-0004's bracketed marker; the card channel
			// carries the same code normalized, so both name the same failure.
			expect(value.fail![0]!.code).toBe("[E_BAD_REF]");
			expect(failures[0]!.code).toBe("E_BAD_REF");
			expect(failures[0]!.code).toBe(value.fail![0]!.code.replace(/^\[|\]$/g, ""));
			// E_BAD_REF rejects the malformed anchor before any echo is built: the
			// entry is exactly the three persisted fields, no empty placeholders.
			expect(Object.keys(failures[0]!).sort()).toEqual(["code", "message", "path"]);
			expect(failures[0]!.message).toMatch(/E_BAD_REF|Invalid anchor/);
			expect(failures[0]!.message).not.toContain("The whole batch was rejected");
		});
	});

	it("all failed: the aggregate error, and no `failures` key", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "beta\n", "utf-8");
			const { edit, exec } = harness(cwd);

			const value = await edit.execute(
				{
					edits: [replaceLine("a.txt", "!zzz", ["A"]), replaceLine("b.txt", "!zzz", ["B"])],
				},
				exec,
			);
			const meta = edit.output.presentationMeta({ edits: [] }, value);

			expect(value.success).toEqual([]);
			expect(value.error?.code).toBe("E_BAD_REF");
			expect(Object.keys(meta)).toEqual(["error"]);
			expect(meta.error?.message).toContain("2 file(s) failed");
		});
	});

	it("all succeeded: no `failures` key and no error", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "beta\n", "utf-8");
			const { read, edit, exec } = harness(cwd);
			const alpha = await anchorOf(read, exec, "a.txt", "alpha");
			const beta = await anchorOf(read, exec, "b.txt", "beta");

			const value = await edit.execute(
				{ edits: [replaceLine("a.txt", alpha, ["A!"]), replaceLine("b.txt", beta, ["B!"])] },
				exec,
			);
			const meta = edit.output.presentationMeta({ edits: [] }, value);

			expect(value.fail).toEqual([]);
			expect("failures" in meta).toBe(false);
			expect(meta.error).toBeUndefined();
			expect(meta.diffRowGroups).toHaveLength(2);
		});
	});

	it("keeps the list when the only successful file was a NO-OP (trap 1)", async () => {
		await withTempFile("a.txt", "alpha\nbeta\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "x\ny\n", "utf-8");
			const { read, edit, exec } = harness(cwd);
			const alpha = await anchorOf(read, exec, "a.txt", "alpha");

			const value = await edit.execute(
				{
					edits: [
						// Same text on both sides: the file is unchanged, so the call has
						// NO hunks even though it "succeeded" — the branch that used to
						// swallow the failure list.
						replaceLine("a.txt", alpha, ["alpha"]),
						replaceLine("b.txt", "!zzz", ["X!"]),
					],
				},
				exec,
			);
			const meta = edit.output.presentationMeta({ edits: [] }, value);

			expect(value.success).toHaveLength(1);
			expect(value.multiDiffs).toHaveLength(0);
			expect(value.multiDiffRowGroups).toHaveLength(1);
			expect(value.multiDiffRowGroups![0]!.rows).toEqual([]);
			// The no-op group is a REAL group with zero rows: the client must keep
			// it (and the tab) instead of refusing the whole array.
			expect(meta.diffs).toEqual([]);
			expect(meta.diffRowGroups).toHaveLength(1);
			expect(meta.diffRowGroups![0]!.rows).toEqual([]);
			expect(meta.failures).toHaveLength(1);
			expect(meta.failures![0]!.path).toBe("b.txt");
			expect(meta.error).toBeUndefined();
		});
	});

	it("takes the code from the head of the cause, never from the echoed line (trap 2)", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "alpha\nbeta\ngamma\n", "utf-8");
			const { read, edit, exec } = harness(cwd);
			const alpha = await anchorOf(read, exec, "a.txt", "alpha");
			const beta = await anchorOf(read, exec, "b.txt", "beta");

			// External drift AFTER the serve: the served-staleness check fires, and
			// its rejection carries the ±3 echo of the CURRENT content — which here
			// carries a code literal of its own.
			// External drift AFTER the serve: the served-staleness check fires on the
			// anchor's OWN line, and its rejection carries the ±3 echo of the CURRENT
			// content — which here carries a code literal of its own.
			await writeFile(join(cwd, "b.txt"), 'alpha\nconst code = "[E_BAD_SHAPE]";\ngamma\n', "utf-8");

			const value = await edit.execute(
				{ edits: [replaceLine("a.txt", alpha, ["A!"]), replaceLine("b.txt", beta, ["B!"])] },
				exec,
			);
			const meta = edit.output.presentationMeta({ edits: [] }, value);

			const failure = meta.failures![0]!;
			expect(failure.path).toBe("b.txt");
			// The real cause is the stale family, NOT the literal the echo shows.
			expect(failure.code).toMatch(/^E_(RANGE_UNVERIFIED|STALE)$/);
			expect(failure.code).not.toBe("E_BAD_SHAPE");
			expect(failure.code).toBe(value.fail![0]!.code.replace(/^\[|\]$/g, ""));
			// The echo is preserved verbatim — that is the whole point of keeping it —
			// and so is the recovery guidance next to it.
			const visible = `${failure.message}\n${failure.context ?? ""}`;
			expect(failure.context).toBeDefined();
			expect(failure.context).toContain("[E_BAD_SHAPE]");
			expect(visible).toMatch(/fresh anchor|Call read|read /i);
		});
	});

	it("lists the failed files in input order, not in outcome order", async () => {
		await withTempFile("a.txt", "alpha\n", async ({ cwd }) => {
			await writeFile(join(cwd, "b.txt"), "beta\n", "utf-8");
			await writeFile(join(cwd, "c.txt"), "gamma\n", "utf-8");
			const { read, edit, exec } = harness(cwd);
			const alpha = await anchorOf(read, exec, "a.txt", "alpha");

			const forward = await edit.execute(
				{
					edits: [
						replaceLine("a.txt", alpha, ["A!"]),
						replaceLine("b.txt", "!zzz", ["B"]),
						replaceLine("c.txt", "!zzz", ["C"]),
					],
				},
				exec,
			);
			expect(edit.output.presentationMeta({ edits: [] }, forward).failures!.map((f) => f.path)).toEqual([
				"b.txt",
				"c.txt",
			]);

			const afterForward = await anchorOf(read, exec, "a.txt", "A!");
			const reversed = await edit.execute(
				{
					edits: [
						replaceLine("c.txt", "!zzz", ["C"]),
						replaceLine("b.txt", "!zzz", ["B"]),
						replaceLine("a.txt", afterForward, ["AA!"]),
					],
				},
				exec,
			);
			expect(edit.output.presentationMeta({ edits: [] }, reversed).failures!.map((f) => f.path)).toEqual([
				"c.txt",
				"b.txt",
			]);
		});
	});
});
