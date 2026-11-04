/**
 * The patch domain layer, below the tool: the operation plan, the preflight,
 * and the three model-facing texts.
 *
 * The tool suite proves the WHOLE thing works; these tests pin the pieces the
 * tool composes, so a failure says WHICH piece moved. Nothing here touches the
 * filesystem except the preflight, which is asked about real files on purpose —
 * a preflight that only ever sees a mock proves nothing about the refusals it
 * is supposed to raise.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parsePatch } from "../../src/domain/patch/parse.js";
import { operationsFromSections, type PatchOperation } from "../../src/domain/patch/plan.js";
import { preflightPatch, type PatchRefusal } from "../../src/domain/patch/preflight.js";
import {
	REFUSAL_LIMIT,
	refusalBody,
	refusalHead,
	stoppedText,
	successText,
} from "../../src/domain/patch/text.js";
import type { CommittedOperation } from "../../src/domain/patch/commit.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { makeExec, servedRows, setupIntegrationTest, withTempDir } from "../support/fixtures.js";
import { openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A committed operation, with only the fields a text composer reads. */
function committed(overrides: Partial<CommittedOperation> & { index: number; kind: CommittedOperation["kind"]; path: string }): CommittedOperation {
	return {
		line: 1,
		status: "completed",
		absolutePath: `/tmp/${overrides.path}`,
		...overrides,
	};
}

/** A refusal, with the operation it belongs to. */
function refusal(
	operation: PatchOperation,
	code: string,
	message: string,
	hunkLine?: number,
): PatchRefusal {
	return {
		operation,
		...(hunkLine !== undefined ? { hunkLine } : {}),
		code,
		message,
	};
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe("operationsFromSections — the section vocabulary becomes the effect vocabulary", () => {
	it("maps every section keyword to its effect, in patch order", () => {
		const sections = parsePatch(
			[
				"file src/a.ts",
				"replace Ab",
				"+x",
				"",
				"new src/b.ts",
				"+y",
				"",
				"move src/c.ts -> src/d.ts",
				"",
				"remove src/e.ts",
			].join("\n"),
		);

		const operations = operationsFromSections(sections);

		expect(operations.map((operation) => operation.kind)).toStrictEqual([
			"update",
			"add",
			"move",
			"delete",
		]);
		expect(operations.map((operation) => operation.index)).toStrictEqual([0, 1, 2, 3]);
		expect(operations.map((operation) => operation.path)).toStrictEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/e.ts",
		]);
		// The move keeps its destination; the others have none.
		expect(operations[2].destination).toBe("src/d.ts");
		expect(operations[0].destination).toBeUndefined();
	});

	it("carries the input line of every section header, for the refusal address", () => {
		const sections = parsePatch(["", "", "new src/b.ts", "+y"].join("\n"));

		const operations = operationsFromSections(sections);

		expect(operations[0].line).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------

describe("successText — the change-set summary", () => {
	it("lists one line per completed operation, with the letter of its effect", () => {
		const operations = [
			committed({ index: 0, kind: "update", path: "src/a.ts" }),
			committed({ index: 1, kind: "add", path: "src/b.ts" }),
			committed({ index: 2, kind: "delete", path: "src/e.ts" }),
		];

		const text = successText(operations, false, []);

		expect(text).toBe(
			"Success. Updated the following files:\nM src/a.ts\nA src/b.ts\nD src/e.ts",
		);
	});

	it("shows a move as `M from -> to`", () => {
		const operations = [
			committed({
				index: 0,
				kind: "move",
				path: "src/c.ts",
				destination: "src/d.ts",
			}),
		];

		expect(successText(operations, false, [])).toContain("M src/c.ts -> src/d.ts");
	});

	it("says so when there is nothing to do", () => {
		expect(successText([], false, [])).toBe("Success. No operations in patch.");
	});
});

describe("stoppedText — the commit that hit a wall", () => {
	it("names where it stopped, what ran, what failed and what never ran", () => {
		const operations = [
			committed({ index: 0, kind: "add", path: "src/b.ts" }),
			committed({
				index: 1,
				kind: "move",
				path: "src/c.ts",
				destination: "src/d.ts",
				status: "failed",
				code: "E_EXISTS",
				message: "Destination already exists: src/d.ts.",
			}),
			committed({ index: 2, kind: "delete", path: "src/e.ts", status: "skipped" }),
		];

		const text = stoppedText(operations, false, []);

		expect(text).toContain("Patch stopped after 1 of 3 operations.");
		expect(text).toContain("Completed:\nA src/b.ts");
		expect(text).toContain(
			"Failed:\n- operation 2 (move src/c.ts -> src/d.ts): [E_EXISTS] Destination already exists: src/d.ts.",
		);
		expect(text).toContain("Not executed:\n- operation 3 (delete src/e.ts)");
	});
});

describe("refusalHead / refusalBody — the whole-patch refusal", () => {
	const operation = operationsFromSections(
		parsePatch(["file src/a.ts", "replace Ab", "+x"].join("\n")),
	)[0];

	it("counts the problems in the head", () => {
		expect(refusalHead(1)).toBe("Patch rejected before any change (1 problem):");
		expect(refusalHead(2)).toBe("Patch rejected before any change (2 problems):");
	});

	it("addresses every problem the way the contract says", () => {
		const body = refusalBody([refusal(operation, "E_STALE", "the anchor is gone.")]);

		expect(body).toBe(
			"- operation 1 (update src/a.ts, patch line 1): [E_STALE] the anchor is gone.",
		);
	});

	it("addresses the HUNK's line when the problem is about one hunk", () => {
		const body = refusalBody([refusal(operation, "E_STALE", "gone.", 7)]);

		expect(body).toContain("patch line 7");
	});

	it("shows a move's destination in the address", () => {
		const move = operationsFromSections(
			parsePatch(["move src/c.ts -> src/d.ts"].join("\n")),
		)[0];
		const body = refusalBody([refusal(move, "E_EXISTS", "the destination is there.")]);

		expect(body).toContain("operation 1 (move src/c.ts -> src/d.ts, patch line 1)");
	});

	it("summarizes the problems beyond the limit instead of listing them all", () => {
		const refusals = Array.from({ length: REFUSAL_LIMIT + 3 }, (_, index) =>
			refusal({ ...operation, index }, "E_STALE", `gone ${index}.`),
		);

		const body = refusalBody(refusals);

		expect(body.split("\n")).toHaveLength(REFUSAL_LIMIT + 1);
		expect(body).toContain("- and 3 more");
	});
});

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

describe("preflightPatch — the refusals are values, not throws", () => {
	it("prepares what can run and collects every refusal of what cannot", async () => {
		await withTempDir("patch-preflight-", async (cwd) => {
			await mkdir(join(cwd, "src"), { recursive: true });
			await writeFile(join(cwd, "src", "a.ts"), "one\ntwo\n", "utf-8");
			const harness = setupIntegrationTest(cwd);
			const rows = await servedRows(harness, join(cwd, "src", "a.ts"));
			const two = rows.find((row) => row.content === "two");
			expect(two).toBeDefined();
			// The preflight reads the served anchors out of the WORKSPACE's
			// store, and that store is the one the read above wrote to — so the
			// preflight has to run inside the workspace scope the tool gives it.
			const result = await withWorkspace(cwd, async () => {
				await openWorkspaceStore(cwd);
				return preflightPatch({
					sections: parsePatch(
						[
							"file src/a.ts",
							`replace ${two!.hash}`,
							"+TWO",
							"",
							"file src/missing.ts",
							"replace Zz",
							"+content",
						].join("\n"),
					),
					io: localIO(),
					cwd,
					sessionKey: "test-session",
					exec: makeExec(cwd)({ patch: "" }),
					lineNumbers: false,
				});
			});
			// The good operation is prepared; the bad one is a refusal.
			expect(result.prepared).toHaveLength(1);
			expect(result.prepared[0].kind).toBe("update");
			expect(result.refusals).toHaveLength(1);
			expect(result.refusals[0].code).toBe("E_NOT_FOUND");
			expect(result.refusals[0].operation.index).toBe(1);
		});
	});

	it("refuses a `file` section that carries no hunks rather than ignoring it", async () => {
		await withTempDir("patch-preflight-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\n", "utf-8");
			const sections = parsePatch(["file a.ts"].join("\n"));

			const result = await preflightPatch({
				sections,
				io: localIO(),
				cwd,
				sessionKey: "test-session",
				exec: makeExec(cwd)({ patch: "" }),
				lineNumbers: false,
			});

			expect(result.prepared).toHaveLength(0);
			expect(result.refusals).toHaveLength(1);
			expect(result.refusals[0].code).toBe("E_BAD_SHAPE");
			expect(result.refusals[0].message).toContain("has no hunks");
		});
	});

	it("refuses the SECOND section for a path the first one already claimed", async () => {
		await withTempDir("patch-preflight-", async (cwd) => {
			await writeFile(join(cwd, "a.ts"), "one\n", "utf-8");
			const sections = parsePatch(
				["file a.ts", "replace Ab", "+x", "", "file a.ts", "replace Cd", "+y"].join("\n"),
			);

			const result = await preflightPatch({
				sections,
				io: localIO(),
				cwd,
				sessionKey: "test-session",
				exec: makeExec(cwd)({ patch: "" }),
				lineNumbers: false,
			});

			const duplicate = result.refusals.find(
				(refusal) => refusal.code === "E_BAD_SHAPE" && refusal.operation.index === 1,
			);
			expect(duplicate, "the second section is the duplicate").toBeDefined();
			expect(duplicate!.message).toContain("already appears in this patch");
		});
	});
});
