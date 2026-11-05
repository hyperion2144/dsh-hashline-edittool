/**
 * #416 — `apply_patch` reuses the single-function tools' methods, and every row
 * the model sees carries an anchor.
 *
 * Three facts this file pins:
 *
 * 1. a `new` section returns the new file's ANCHORS (the write path's own
 *    method mints and serves them) — the model can edit the file it just
 *    created without a re-read (ADR-0009: everything the model sees);
 * 2. a mixed patch anchors BOTH files' rows — the difference is the operation,
 *    not the file;
 * 3. a sandbox denial is a REFUSAL (`failed`), not an unknown outcome, and the
 *    model sees the shared `[sandbox: …]` vocabulary.
 *
 * @module dsh-hashline-edittool/issue-416-patch-reuse.test
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
import { buildApplyPatchTool } from "../../src/tools/tool-apply-patch.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { makeExec, servedRows, setupIntegrationTest, withTempDir } from "../support/fixtures.js";

/** A sandbox controller with no confining backend — no escalation fields. */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** One operation, as the tool reports it. */
interface PatchOperation {
	index: number;
	kind: string;
	path: string;
	status: string;
	code?: string;
	message?: string;
}

/** The value the tool returns. */
interface PatchValue {
	modelText: string;
	stopped?: boolean;
	operations?: PatchOperation[];
	error?: { code: string; message: string; context?: string };
}

/** Run one patch and hand back the value the tool returned. */
async function runPatch(
	cwd: string,
	patch: string,
	io: FileIO = localIO(),
): Promise<PatchValue> {
	const tool = buildApplyPatchTool(io, testSandbox());
	return (await tool.execute({ patch }, makeExec(cwd)({ patch }))) as PatchValue;
}

/**
 * The anchor of the row whose content carries `needle`.
 *
 * The marker is the leftmost column, so the diff prefix and the line-number
 * hint are both dropped.
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

/** The store rows one path owns, read through a separate connection. */
function countsFor(path: string, cwd: string): { anchorLines: number; served: number } {
	const db = new DatabaseSync(hashStorePath(cwd), { readOnly: true });
	try {
		const one = (sql: string): number =>
			Number((db.prepare(sql).get(path) as { n?: number } | undefined)?.n ?? 0);
		return {
			anchorLines: one("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?"),
			served: one("SELECT COUNT(*) AS n FROM served WHERE path = ?"),
		};
	} finally {
		db.close();
	}
}

describe("#416 — a `new` section returns the new file's anchors", () => {
	it("mints and serves them, and they work right away", async () => {
		await withTempDir("apply-patch-new-anchors-", async (cwd) => {
			const patch = ["new created.ts", "+alpha", "+beta"].join("\n");
			const value = await runPatch(cwd, patch);
			expect(value.error).toBeUndefined();

			// The rows the model sees carry anchors — not an empty gutter column.
			const alpha = anchorOf(value.modelText!, "alpha");
			const beta = anchorOf(value.modelText!, "beta");
			expect(alpha).not.toBe("");
			expect(beta).not.toBe("");

			// The store holds them, and the session holds them as served.
			const counts = countsFor(join(cwd, "created.ts"), cwd);
			expect(counts.anchorLines).toBe(2);
			expect(counts.served).toBe(1);

			// And they are usable: the next patch edits the file the first one
			// created, with the anchor the first one handed back.
			const second = await runPatch(
				cwd,
				["file created.ts", `replace ${alpha}`, "+ALPHA"].join("\n"),
			);
			expect(second.error).toBeUndefined();
			expect(await readFile(join(cwd, "created.ts"), "utf-8")).toBe("ALPHA\nbeta\n");
		});
	});

	it("anchors BOTH files' rows in a mixed patch", async () => {
		await withTempDir("apply-patch-mixed-anchors-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\ntwo\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two, "the read served a row for `two`").toBeDefined();

			const patch = [
				"file a.ts",
				`replace ${two!.hash}`,
				"+TWO",
				"",
				"new created.ts",
				"+alpha",
			].join("\n");
			const value = await runPatch(cwd, patch);
			expect(value.error).toBeUndefined();

			// The updated file's row and the created file's row both carry anchors.
			expect(anchorOf(value.modelText!, "TWO")).not.toBe("");
			expect(anchorOf(value.modelText!, "alpha")).not.toBe("");
			expect(countsFor(join(cwd, "created.ts"), cwd).anchorLines).toBe(1);
		});
	});
});

describe("#416 — a sandbox denial is a refusal", () => {
	it("reports `failed` with the shared [sandbox: …] vocabulary", async () => {
		await withTempDir("apply-patch-sandbox-denial-", async (cwd) => {
			const io = localIO();
			const denying: FileIO = {
				...io,
				writeText: async () => {
					throw new FsError("denied", "FS_SANDBOX_DENIED");
				},
			};
			const patch = ["new created.ts", "+alpha"].join("\n");
			const value = await runPatch(cwd, patch, denying);

			// A refusal is `failed`, NOT `unknown`: nothing was written, so the
			// model must not be told to re-read a file that never changed.
			const operation = value.operations?.[0];
			expect(operation?.status).toBe("failed");
			expect(value.stopped).toBe(true);
			// And the model sees the shared vocabulary — the marker and the
			// same-turn escalation hint.
			expect(operation?.message).toContain("[sandbox: file access denied");
			expect(operation?.message).toContain("sandbox_permissions");
		});
	});
});
