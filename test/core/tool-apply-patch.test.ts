/**
 * The `apply_patch` tool through its real builder and the local bridge.
 *
 * The tool's contract is a CHANGE SET, not an edit: the whole set is refused
 * together before a byte is written, or it is applied in order and stops at the
 * first wall. These tests drive the real tool over the local filesystem and
 * assert the three facts that contract rests on:
 *
 * 1. a patch that applies changes the disk, and reports what it changed;
 * 2. a patch that cannot apply changes NOTHING, and says every problem at once;
 * 3. the anchors a patch hands back are live — the next call can use them.
 *
 * Nothing here mocks the filesystem: the refusals under test are the ones the
 * real probe, the real anchor resolver and the real store produce.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildApplyPatchTool } from "../../src/tools/tool-apply-patch.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { applyEffective } from "../../src/config.js";
import { loadHashStore } from "../../src/domain/session/hash-store.js";
import { parsePatch } from "../../src/domain/patch/parse.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { preflightPatch } from "../../src/domain/patch/preflight.js";
import { commitPatch } from "../../src/domain/patch/commit.js";
import { stoppedText } from "../../src/domain/patch/text.js";
import {
	makeExec,
	servedRows,
	setupIntegrationTest,
	withTempDir,
} from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

// ---------------------------------------------------------------------------
// The value under test
// ---------------------------------------------------------------------------

/** One operation, as the tool reports it. */
interface PatchOperation {
	index: number;
	kind: string;
	path: string;
	destination?: string;
	/** Canonical destination path of a move, as the value reports it. */
	destinationPath?: string;
	line: number;
	hunkLine?: number;
	status: string;
	code?: string;
	message?: string;
	changes?: { path: string; before: string | null; after: string }[];
}

/** The tool's canonical value. A refusal returns only `modelText` + `error`. */
interface PatchValue {
	modelText: string;
	stopped?: boolean;
	cancelled?: boolean;
	operations?: PatchOperation[];
	affectedPaths?: string[];
	diffs?: unknown[];
	diffRowGroups?: unknown[];
	/** The paths a remove-only patch deleted (the delete card's section). */
	removed?: string[];
	warnings?: string[];
	error?: { code: string; message: string; context?: string };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** A sandbox controller with no confining backend — no escalation fields. */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** The tool under test, built the way the plugin registers it. */
function patchTool() {
	return buildApplyPatchTool(localIO(), testSandbox());
}

/** Run one patch and hand back the value the tool returned. */
async function runPatch(cwd: string, patch: string): Promise<PatchValue> {
	const tool = patchTool();
	return (await tool.execute({ patch }, makeExec(cwd)({ patch }))) as PatchValue;
}

/**
 * The anchor of the row whose content carries `needle`.
 *
 * Both dialects are tolerated: a read row (`<anchor>:<content>`) and a diff row
 * (`+ <anchor>:<content>`), with or without the line-number hint. The marker
 * is the leftmost column, so the diff prefix and the hint are both dropped.
 */
function anchorOf(text: string, needle: string): string {
	const row = text.split("\n").find((line) => line.includes(needle));
	if (row === undefined) throw new Error(`no row carrying ${needle} in:\n${text}`);
	const body = row.replace(/^[+\-~ ]+/, "");
	const anchor = body.split(":")[0] ?? "";
	if (!/^[0-9A-Za-z]{2,}$/.test(anchor)) {
		throw new Error(`row ${JSON.stringify(row)} carries no anchor`);
	}
	return anchor;
}

/** The store rows one path still owns, read through a separate connection. */
function countsFor(path: string, cwd: string): {
	anchorMeta: number;
	anchorLines: number;
	undo: number;
	served: number;
} {
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		const one = (sql: string): number =>
			Number((db.prepare(sql).get(path) as { n?: number } | undefined)?.n ?? 0);
		return {
			anchorMeta: one("SELECT COUNT(*) AS n FROM anchor_meta WHERE path = ?"),
			anchorLines: one("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?"),
			undo: one("SELECT COUNT(*) AS n FROM undo WHERE path = ?"),
			served: one("SELECT COUNT(*) AS n FROM served WHERE path = ?"),
		};
	} finally {
		db.close();
	}
}

/** Give one path an undo layer and a second session's served row. */
async function seedResidue(path: string, cwd: string): Promise<void> {
	const store = await loadHashStore(cwd);
	store.pushUndo(path, {
		content: "before\n",
		bom: "",
		ending: "\n",
		hashes: ["AAA"],
		resultContent: "after\n",
	});
	store.upsertServed("other-session", path, [["ZZZ", ""]]);
}

/** The three files the success fixtures share. */
async function seedTree(cwd: string): Promise<void> {
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src", "a.ts"), "one\ntwo\nthree\n", "utf-8");
	await writeFile(join(cwd, "src", "b.ts"), "alpha\nbeta\n", "utf-8");
	await writeFile(join(cwd, "src", "dead.ts"), "dead\n", "utf-8");
}

beforeEach(() => {
	// The tool reads the user's switches (line numbers, line content, output
	// format) from the effective snapshot — pin the defaults so the assertions
	// describe the tool, not whatever a sibling suite left behind.
	applyEffective(undefined);
});

afterEach(() => {
	applyEffective(undefined);
});

// ---------------------------------------------------------------------------
// The successful change set
// ---------------------------------------------------------------------------

describe("apply_patch — a change set that applies", () => {
	it("edits one file, creates one and removes one, and reports all three", async () => {
		await withTempDir("apply-patch-success-", async (cwd) => {
			await seedTree(cwd);
			const harness = setupIntegrationTest(cwd);
			// Two files are read: the one the patch edits (for its anchor) and the
			// one the patch removes (so the removal has a "before" text to show).
			const rows = await servedRows(harness, join(cwd, "src", "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two, "the read served a row for `two`").toBeDefined();
			await harness.readTool.execute("read", { path: join(cwd, "src", "dead.ts") });

			const patch = [
				"file src/a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"new src/hello.ts",
				"+export const x = 1",
				"",
				"remove src/dead.ts",
			].join("\n");

			const value = await runPatch(cwd, patch);

			// The disk: the edit landed, the file was created, the file is gone.
			expect(await readFile(join(cwd, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
			expect(await readFile(join(cwd, "src", "hello.ts"), "utf-8")).toBe("export const x = 1\n");
			expect(existsSync(join(cwd, "src", "dead.ts"))).toBe(false);

			// The ledger: three completed operations, in patch order.
			const operations = value.operations ?? [];
			expect(operations).toHaveLength(3);
			expect(operations.map((operation) => operation.kind)).toStrictEqual([
				"update",
				"add",
				"delete",
			]);
			for (const operation of operations) {
				expect(operation.status, `operation ${operation.index} completed`).toBe("completed");
			}

			// The changes: what each operation did, as before/after text.
			expect(operations[0].changes).toStrictEqual([
				{
					path: join(cwd, "src", "a.ts"),
					before: "one\ntwo\nthree\n",
					after: "one\nTWO\nthree\n",
				},
			]);
			expect(operations[1].changes).toStrictEqual([
				{ path: join(cwd, "src", "hello.ts"), before: null, after: "export const x = 1\n" },
			]);
			expect(operations[2].changes).toStrictEqual([
				{ path: join(cwd, "src", "dead.ts"), before: "dead\n", after: "" },
			]);

			// The affected paths: absolute, and one per touched file.
			expect(value.affectedPaths).toStrictEqual([
				join(cwd, "src", "a.ts"),
				join(cwd, "src", "hello.ts"),
				join(cwd, "src", "dead.ts"),
			]);

			// The model text: the summary AND the anchors.
			expect(value.modelText).toContain("Success. Updated the following files:");
			expect(value.modelText).toContain("M src/a.ts");
			expect(value.modelText).toContain("A src/hello.ts");
			expect(value.modelText).toContain("D src/dead.ts");
			expect(value.modelText).toContain("--- src/a.ts");
			expect(value.modelText).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
			expect(value.modelText).toMatch(/^\+\s*[0-9A-Za-z]{2,}:TWO$/m);
			expect(value.stopped).toBe(false);
			expect(value.cancelled).toBe(false);
		});
	});

	it("uses anchors from two different files in one patch", async () => {
		await withTempDir("apply-patch-two-anchors-", async (cwd) => {
			await seedTree(cwd);
			const harness = setupIntegrationTest(cwd);
			const a = await servedRows(harness, join(cwd, "src", "a.ts"));
			const b = await servedRows(harness, join(cwd, "src", "b.ts"));
			const two = a.find((row) => row.content === "two");
			const alpha = b.find((row) => row.content === "alpha");
			expect(two).toBeDefined();
			expect(alpha).toBeDefined();

			const patch = [
				"file src/a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"file src/b.ts",
				`insert ${alpha!.hash}`,
				"+ALPHA-EXTRA",
			].join("\n");

			const value = await runPatch(cwd, patch);

			expect(await readFile(join(cwd, "src", "a.ts"), "utf-8")).toBe("one\nTWO\nthree\n");
			// `insert` puts the new line BELOW the anchor line, and keeps it.
			expect(await readFile(join(cwd, "src", "b.ts"), "utf-8")).toBe(
				"alpha\nALPHA-EXTRA\nbeta\n",
			);
			expect((value.operations ?? []).map((operation) => operation.status)).toStrictEqual([
				"completed",
				"completed",
			]);
			expect(value.modelText).toContain("M src/a.ts");
			expect(value.modelText).toContain("M src/b.ts");
		});
	});

	it("hands back anchors the NEXT call can use (the re-serve contract)", async () => {
		await withTempDir("apply-patch-anchor-reuse-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();

			const first = await runPatch(
				cwd,
				["file a.ts", `replace ${two!.hash}`, "+TWO"].join("\n"),
			);
			expect(first.error).toBeUndefined();

			// The anchor of the NEW line rides in the diff block.
			const fresh = anchorOf(first.modelText, "TWO");
			expect(fresh).not.toBe(two!.hash);

			const second = await runPatch(
				cwd,
				["file a.ts", `replace ${fresh}`, "+TWO-AGAIN"].join("\n"),
			);

			expect(second.error, "the fresh anchor was accepted").toBeUndefined();
			expect(second.modelText).toContain("Success. Updated the following files:");
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\nTWO-AGAIN\nthree\n");
		});
	});

	it("hands the same anchor to `edit`, so the two tools share one anchor space", async () => {
		await withTempDir("apply-patch-anchor-edit-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();

			const patched = await runPatch(
				cwd,
				["file a.ts", `replace ${two!.hash}`, "+TWO"].join("\n"),
			);
			const fresh = anchorOf(patched.modelText, "TWO");

			const edited = await harness.editTool.execute("edit", {
				path: join(cwd, "a.ts"),
				edits: [{ op: "replace", anchor_start: fresh, lines: ["TWO-EDITED"] }],
			});
			const editText = edited.content[0]?.text ?? "";

			expect(editText, "the edit accepted the patch's anchor").not.toContain("[E_STALE]");
			expect(editText).not.toContain("[E_NOT_OBSERVED]");
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\nTWO-EDITED\nthree\n");
		});
	});
});

// ---------------------------------------------------------------------------
// The whole-patch refusal
// ---------------------------------------------------------------------------

describe("apply_patch — the whole patch is refused before anything is written", () => {
	it("reports every broken operation at once and writes NOTHING", async () => {
		await withTempDir("apply-patch-refused-", async (cwd) => {
			await seedTree(cwd);
			const harness = setupIntegrationTest(cwd);
			// Read the file, then rewrite it behind the tool's back: the served
			// anchor goes stale, which is the refusal a model actually hits.
			const rows = await servedRows(harness, join(cwd, "src", "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();
			await writeFile(join(cwd, "src", "a.ts"), "one\nrewritten\nthree\n", "utf-8");
			const before = await readFile(join(cwd, "src", "a.ts"), "utf-8");

			const patch = [
				"file src/a.ts",
				`replace ${two!.hash}`,
				"+CHANGED",
				"",
				"file src/missing.ts",
				"replace Zz",
				"+content",
				"",
				"new src/created.ts",
				"+content",
			].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.modelText).toContain("[E_PATCH_REFUSED]");
			expect(value.modelText).toContain("Patch rejected before any change (2 problems)");

			// Both problems, each addressed the way the contract says.
			const context = value.error?.context ?? "";
			expect(context).toContain("- operation 1 (update src/a.ts, patch line 2):");
			expect(context).toContain("- operation 2 (update src/missing.ts, patch line 5):");
			// The first operation's anchor no longer names that line: the file was
			// rewritten behind the tool's back, so the marker is unverifiable.
			expect(context).toContain("[E_RANGE_UNVERIFIED]");
			expect(context).toContain("[E_NOT_FOUND]");

			// And the disk: not one byte moved.
			expect(await readFile(join(cwd, "src", "a.ts"), "utf-8")).toBe(before);
			expect(existsSync(join(cwd, "src", "missing.ts"))).toBe(false);
			expect(existsSync(join(cwd, "src", "created.ts"))).toBe(false);
		});
	});

	it("refuses a patch whose anchor is no longer there at all", async () => {
		await withTempDir("apply-patch-stale-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();
			// The line the anchor named is GONE, not merely rewritten.
			await writeFile(join(cwd, "a.ts"), "one\n", "utf-8");

			const patch = ["file a.ts", `replace ${two!.hash}`, "+CHANGED"].join("\n");
			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_STALE]");
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\n");
		});
	});

	it("refuses two sections for the same path", async () => {
		await withTempDir("apply-patch-duplicate-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();

			const patch = [
				"file a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"file a.ts",
				`replace ${two!.hash}`,
				"+TWO-AGAIN",
			].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_BAD_SHAPE]");
			expect(value.error?.context ?? "").toContain("already appears in this patch");
			// The duplicate is refused; the file is untouched.
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\ntwo\n");
		});
	});

	it("refuses a `new` whose target already exists", async () => {
		await withTempDir("apply-patch-exists-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\n", "utf-8");
			const patch = ["new a.ts", "+content"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_EXISTS]");
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\n");
		});
	});

	it("refuses a `new` whose parent directory does not exist", async () => {
		await withTempDir("apply-patch-no-parent-", async (cwd) => {
			const patch = ["new nodir/a.ts", "+content"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_NOT_FOUND]");
			expect(value.error?.context ?? "").toContain("Parent directory does not exist");
			expect(existsSync(join(cwd, "nodir"))).toBe(false);
			expect(existsSync(join(cwd, "nodir", "a.ts"))).toBe(false);
		});
	});

	it("refuses a `remove` of a path that is not there", async () => {
		await withTempDir("apply-patch-remove-missing-", async (cwd) => {
			const patch = ["remove missing.ts"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_NOT_FOUND]");
			expect(value.error?.context ?? "").toContain("File not found");
			expect(existsSync(join(cwd, "missing.ts"))).toBe(false);
		});
	});

	it("refuses a symlink, and leaves both the link and its target alone", async () => {
		await withTempDir("apply-patch-symlink-", async (cwd) => {
			const target = join(cwd, "target.ts");
			await writeFile(target, "target\n", "utf-8");
			const link = join(cwd, "link.ts");
			await symlink(target, link);
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, target);
			const first = rows[0];
			expect(first).toBeDefined();

			const patch = ["file link.ts", `replace ${first!.hash}`, "+CHANGED"].join("\n");
			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_PATCH_REFUSED");
			expect(value.error?.context ?? "").toContain("[E_SYMLINK]");
			expect(existsSync(link)).toBe(true);
			expect(await readFile(target, "utf-8")).toBe("target\n");
		});
	});
});

// ---------------------------------------------------------------------------
// The syntax refusal
// ---------------------------------------------------------------------------

describe("apply_patch — the patch is not a patch", () => {
	it("refuses a `replace` that carries no content line, and names the line", async () => {
		await withTempDir("apply-patch-syntax-", async (cwd) => {
			const patch = ["file a.ts", "replace Zz"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_INVALID_PATCH");
			expect(value.modelText).toContain("[E_INVALID_PATCH]");
			expect(value.modelText).toContain("Invalid patch at line 2:");
			// The offending input line rides back as the context.
			expect(value.error?.context).toContain("replace Zz");
		});
	});

	it("refuses an unknown header, and names the line", async () => {
		await withTempDir("apply-patch-syntax-", async (cwd) => {
			const patch = ["file a.ts", "frobnicate Zz"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_INVALID_PATCH");
			expect(value.modelText).toContain("Invalid patch at line 2:");
			expect(value.error?.context).toContain("frobnicate Zz");
		});
	});

	it("refuses an `insert` that takes a range", async () => {
		await withTempDir("apply-patch-syntax-", async (cwd) => {
			const patch = ["file a.ts", "insert Zz..Yy", "+content"].join("\n");

			const value = await runPatch(cwd, patch);

			expect(value.error?.code).toBe("E_INVALID_PATCH");
			expect(value.modelText).toContain("Invalid patch at line 2:");
			expect(value.modelText).toContain("`insert` does not take a range");
		});
	});

	it("writes nothing when the patch is not a patch", async () => {
		await withTempDir("apply-patch-syntax-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\n", "utf-8");
			const patch = ["file a.ts", "replace Zz"].join("\n");

			await runPatch(cwd, patch);

			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\n");
		});
	});
});

// ---------------------------------------------------------------------------
// The empty patch and the stopped commit
// ---------------------------------------------------------------------------

describe("apply_patch — the edges", () => {
	it("treats an empty patch as a success with nothing to do", async () => {
		await withTempDir("apply-patch-empty-", async (cwd) => {
			const value = await runPatch(cwd, "");

			expect(value.modelText).toBe("Success. No operations in patch.");
			expect(value.stopped).toBe(false);
			expect(value.cancelled).toBe(false);
			expect(value.operations).toStrictEqual([]);
			expect(value.affectedPaths).toStrictEqual([]);
		});
	});

	it("refuses a path written twice, whichever section comes first", async () => {
		await withTempDir("apply-patch-double-write-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "alpha\n", "utf-8");
			// The same two writes in both orders: a move whose destination the patch
			// also creates. The refusal must not depend on which section the model
			// wrote first — an order-dependent answer let one spelling through the
			// preflight and stopped the other halfway.
			const moveFirst = ["move a.ts -> b.ts", "", "new b.ts", "+beta"].join("\n");
			const createFirst = ["new b.ts", "+beta", "", "move a.ts -> b.ts"].join("\n");

			for (const patch of [moveFirst, createFirst]) {
				const value = await runPatch(cwd, patch);
				expect(value.error?.code).toBe("E_PATCH_REFUSED");
				// Two wordings, one fact: whichever section came second is refused, and
				// the refusal names the write it collides with.
				expect(value.error?.context).toMatch(/already appears in this patch|is written twice in this patch/);
				// Nothing ran: neither the create nor the move reached the disk.
				expect(existsSync(join(cwd, "b.ts"))).toBe(false);
				expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("alpha\n");
			}
		});
	});

	it("stops at the first wall, keeps what ran, and reports the rest as skipped", async () => {
		await withTempDir("apply-patch-stopped-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			await writeFile(join(cwd, "b.ts"), "dead\n", "utf-8");
			await writeFile(join(cwd, "c.ts"), "dead\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();

			// Two phases, split by hand so the world can move between them: the
			// delete's probe is taken at preflight, and the file is rewritten
			// before the commit reaches it. That is the wall a stopped commit
			// exists for — and it is not reproducible through the tool alone,
			// because the tool runs both phases in one call.
			const patch = [
				"file a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"remove b.ts",
				"",
				"remove c.ts",
			].join("\n");
			const io = localIO();
			const exec = makeExec(cwd)({ patch });
			// Both phases run inside ONE workspace scope: the store resolver keys
			// off the ambient workspace, not off an argument.
			const { committed } = await withWorkspace(cwd, async () => {
				const plan = await preflightPatch({
					sections: parsePatch(patch),
					io,
					cwd,
					sessionKey: harness.sessionKey,
					exec,
					lineNumbers: false,
				});
				expect(plan.refusals).toStrictEqual([]);

				// The world moves between the phases: the delete's probe was taken by
				// the preflight, and the file no longer matches it.
				await writeFile(join(cwd, "b.ts"), "rewritten after the probe\n", "utf-8");

				const finished = await commitPatch({
					prepared: plan.prepared,
					io,
					cwd,
					sessionKey: harness.sessionKey,
					exec,
					sandbox: testSandbox(),
					sandboxPolicy: undefined,
					store: await loadHashStore(cwd),
					warnings: [],
				});
				return { preflight: plan, committed: finished };
			});

			expect(committed.stopped).toBe(true);
			expect(committed.operations.map((operation) => operation.status)).toStrictEqual([
				"completed",
				"failed",
				"skipped",
			]);
			expect(committed.operations[1]!.code).toBe("E_DELETE_STALE");
			// The completed operation really landed, the failed one changed nothing,
			// and the skipped one never ran — no rollback, no silence.
			expect(await readFile(join(cwd, "a.ts"), "utf-8")).toBe("one\nTWO\n");
			expect(await readFile(join(cwd, "b.ts"), "utf-8")).toBe("rewritten after the probe\n");
			expect(existsSync(join(cwd, "c.ts"))).toBe(true);

			// The same facts as the MODEL reads them.
			const text = stoppedText(committed.operations, false, []);
			expect(text).toContain("Patch stopped after 1 of 3 operations.");
			expect(text).toContain("Completed:\nM a.ts");
			expect(text).toContain("[E_DELETE_STALE]");
			expect(text).toContain("Not executed:\n- operation 3 (delete c.ts)");
		});
	});

});

// ---------------------------------------------------------------------------
// The declared output schema
// ---------------------------------------------------------------------------

describe("apply_patch — the declared output schema", () => {
	it("accepts the value a successful patch returns", async () => {
		await withTempDir("apply-patch-schema-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();

			const tool = patchTool();
			const patch = ["file a.ts", `replace ${two!.hash}`, "+TWO"].join("\n");
			const value = await tool.execute({ patch }, makeExec(cwd)({ patch }));

			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});

	it("accepts the value a refused patch returns", async () => {
		await withTempDir("apply-patch-schema-", async (cwd) => {
			const tool = patchTool();
			const patch = ["file a.ts", "replace Zz"].join("\n");
			const value = await tool.execute({ patch }, makeExec(cwd)({ patch }));

			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("apply_patch — the store", () => {
	it("reclaims all four row families when a file is removed", async () => {
		await withTempDir("apply-patch-store-remove-", async (cwd) => {
			const dead = join(cwd, "dead.ts");
			await writeFile(dead, "dead\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path: dead });
			await seedResidue(dead, cwd);
			expect(countsFor(dead, cwd).anchorLines).toBeGreaterThan(0);
			expect(countsFor(dead, cwd).undo).toBe(1);

			const value = await runPatch(cwd, ["remove dead.ts"].join("\n"));

			expect(value.error).toBeUndefined();
			expect(existsSync(dead)).toBe(false);
			expect(countsFor(dead, cwd)).toStrictEqual({
				anchorMeta: 0,
				anchorLines: 0,
				undo: 0,
				served: 0,
			});
		});
	});

	it("migrates the rows on a `move`: the old path has none, the new path has them", async () => {
		await withTempDir("apply-patch-store-move-", async (cwd) => {
			const oldPath = join(cwd, "old.ts");
			const newPath = join(cwd, "new.ts");
			await writeFile(oldPath, "alpha\nbeta\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			await harness.readTool.execute("read", { path: oldPath });
			expect(countsFor(oldPath, cwd).anchorMeta).toBeGreaterThan(0);

			const value = await runPatch(cwd, ["move old.ts -> new.ts"].join("\n"));

			expect(value.error).toBeUndefined();
			expect(existsSync(oldPath)).toBe(false);
			expect(existsSync(newPath)).toBe(true);
			// The old path's rows are gone; the new path owns them.
			expect(countsFor(oldPath, cwd)).toStrictEqual({
				anchorMeta: 0,
				anchorLines: 0,
				undo: 0,
				served: 0,
			});
			expect(countsFor(newPath, cwd).anchorMeta).toBeGreaterThan(0);
			expect(countsFor(newPath, cwd).anchorLines).toBeGreaterThan(0);
			// The move reports BOTH canonical paths it touched.
			expect(value.affectedPaths).toStrictEqual([oldPath, newPath]);
			expect(value.modelText).toContain("M old.ts -> new.ts");
		});
	});
});

// ---------------------------------------------------------------------------
// A move that also edits, and the card's per-file tabs
// ---------------------------------------------------------------------------

describe("apply_patch — a move that also edits", () => {
	it("renames first and lands the hunks at the destination", async () => {
		await withTempDir("apply-patch-move-edit-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two, "the read served a row for `two`").toBeDefined();

			const patch = ["move a.ts -> moved.ts", `replace ${two!.hash}`, "+TWO"].join("\n");
			const value = await runPatch(cwd, patch);

			// The operation SUCCEEDS as a whole — the rename fence must not read the
			// patch's own hunk write as somebody else's change.
			expect(value.error).toBeUndefined();
			expect(value.stopped).toBe(false);
			const operations = value.operations ?? [];
			expect(operations).toHaveLength(1);
			expect(operations[0]!.status).toBe("completed");
			expect(operations[0]!.destinationPath).toBe(join(cwd, "moved.ts"));

			// The disk: the source is gone, and the content landed at the destination
			// with the hunk applied — not at the source, and not only renamed.
			expect(existsSync(join(cwd, "a.ts"))).toBe(false);
			expect(await readFile(join(cwd, "moved.ts"), "utf-8")).toBe("one\nTWO\n");

			// The anchors are live AT THE DESTINATION: the next call can use one.
			const next = anchorOf(value.modelText!, "TWO");
			const second = await runPatch(cwd, ["file moved.ts", `replace ${next}`, "+TRIO"].join("\n"));
			expect(second.error).toBeUndefined();
			expect(await readFile(join(cwd, "moved.ts"), "utf-8")).toBe("one\nTRIO\n");
		});
	});
});

describe("apply_patch — the card's tabs", () => {
	it("gives every content section its own tab and hands a removal its own channel", async () => {
		await withTempDir("apply-patch-tabs-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			await writeFile(join(cwd, "dead.ts"), "dead\n", "utf-8");
			await writeFile(join(cwd, "old.ts"), "old\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two, "the read served a row for `two`").toBeDefined();

			const patch = [
				"new created.ts",
				"+alpha",
				"+beta",
				"",
				"file a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"remove dead.ts",
				"",
				"move old.ts -> renamed.ts",
			].join("\n");
			const tool = patchTool();
			const value = (await tool.execute({ patch }, makeExec(cwd)({ patch }))) as PatchValue;
			expect(value.error).toBeUndefined();

			interface CardMeta {
				diffRowGroups: {
					path: string;
					rows: unknown[];
					kind?: string;
					from?: string;
				}[];
				diffs: unknown[];
				stopped: boolean;
				rowTitle: { key: string; params?: Record<string, unknown> };
			}
			const meta = (tool.output as unknown as {
				presentationMeta: (args: unknown, value: unknown) => CardMeta;
			}).presentationMeta({ patch }, value);

			// One tab per section, in patch order, named by the caller's spelling:
			// the REMOVAL keeps a tab of its own (struck through on the strip) and
			// the tab says what the section did — a row-less tab is still a file.
			expect(meta.diffRowGroups.map((group) => group.path)).toStrictEqual([
				"created.ts",
				"a.ts",
				"dead.ts",
				"renamed.ts",
			]);
			expect(meta.diffRowGroups.map((group) => group.kind)).toStrictEqual([
				"added",
				"modified",
				"deleted",
				"renamed",
			]);
			// A rename names BOTH ends, because the tab's sentence has to.
			expect(meta.diffRowGroups[3]?.from).toBe("old.ts");
			// The creation and the edit carry rows; a move and a removal do not.
			expect(meta.diffRowGroups.map((group) => group.rows.length > 0)).toStrictEqual([
				true,
				true,
				false,
				false,
			]);
			// NO channel quotes the removed text back: `-` rows are the edit card's
			// vocabulary, and this file no longer exists.
			expect(meta.diffs.map((diff) => (diff as { path?: string }).path)).not.toContain("dead.ts");
			expect(meta.stopped).toBe(false);
			expect(meta.rowTitle).toStrictEqual({
				key: "row.title.apply_patch.files",
				params: { files: 4 },
			});
		});
	});

	it("gives a removal a tab that says the file is gone, never a content diff", async () => {
		await withTempDir("apply-patch-remove-card-", async (cwd) => {
			await writeFile(join(cwd, "gone.ts"), "one\ntwo\n", "utf-8");
			const patch = ["remove gone.ts"].join("\n");
			const tool = patchTool();
			const value = (await tool.execute({ patch }, makeExec(cwd)({ patch }))) as PatchValue;
			expect(value.error).toBeUndefined();
			expect(existsSync(join(cwd, "gone.ts"))).toBe(false);

			interface RemovalMeta {
				diffs: unknown[];
				diffRowGroups: { path: string; rows: unknown[]; kind?: string }[];
			}
			const meta = (tool.output as unknown as {
				presentationMeta: (args: unknown, value: unknown) => RemovalMeta;
			}).presentationMeta({ patch }, value);

			// The tab exists and says what happened; the diff channels stay empty,
			// because the text the removal took away is not a change to show.
			expect(meta.diffRowGroups).toHaveLength(1);
			expect(meta.diffRowGroups[0]?.path).toBe("gone.ts");
			expect(meta.diffRowGroups[0]?.kind).toBe("deleted");
			expect(meta.diffRowGroups[0]?.rows).toStrictEqual([]);
			expect(meta.diffs).toStrictEqual([]);
			// The model still learns WHICH file went away, without its content.
			expect(value.modelText).toContain("D gone.ts");
			expect(value.modelText).not.toContain("--- gone.ts");
		});
	});

	it("projects a stopped commit's failures and the stopped flag", () => {
		const tool = patchTool();
		interface StoppedMeta {
			failures?: { path: string; code?: string; message: string }[];
			stopped: boolean;
			rowTitle: { key: string };
		}
		const meta = (tool.output as unknown as {
			presentationMeta: (args: unknown, value: unknown) => StoppedMeta;
		}).presentationMeta({}, {
			modelText: "x",
			stopped: true,
			cancelled: false,
			operations: [
				{
					index: 0,
					kind: "update",
					path: "a.ts",
					line: 1,
					status: "completed",
					changes: [{ path: "a.ts", before: "one\n", after: "two\n" }],
				},
				{
					index: 1,
					kind: "delete",
					path: "b.ts",
					line: 4,
					status: "failed",
					code: "E_DELETE_STALE",
					message: "The file changed after it was probed.",
				},
			],
			affectedPaths: [],
			diffs: [],
			diffRowGroups: [],
		});

		expect(meta.stopped).toBe(true);
		expect(meta.failures).toStrictEqual([
			{
				path: "b.ts",
				code: "E_DELETE_STALE",
				message: "The file changed after it was probed.",
			},
		]);
		expect(meta.rowTitle).toStrictEqual({ key: "row.title.apply_patch.stopped" });
	});
});
