/**
 * Issue 374 — the read window says whether the response budget CUT it.
 *
 * `end < totalLines` says NOTHING about a cut: a small `limit` ends before the
 * file does, and a window that was cut and a window that was merely asked to
 * stop look identical from the outside. Only the char budget mints a resume
 * token, so the host marks the window with `truncated` exactly when it minted
 * one — and the card can then say "resume to continue" instead of guessing.
 *
 * The schema pin matters as much as the flag: the host validates a RETURNED
 * value against the tool's declared output schema when a session mounts the
 * tool, and it rejects an undeclared field outright. A flag the schema does
 * not name passes every unit test and fails in a user's session.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEffective } from "../../src/config.js";
import { buildReadTool, readPresentationMeta } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { getWritableTempRoot, makeExec } from "../support/fixtures.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "issue-374-window-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

afterEach(() => {
	applyEffective(undefined);
});

/** The read value shape these assertions read. */
interface ReadWindowValue {
	window?: { start: number; end: number; totalLines: number; truncated?: boolean };
	continuation?: { resume: string; remaining: number };
	modelText: string;
}

/** A file of `lines` rows, each wide enough for the budget to bite. */
async function makeCase(name: string, lines: number): Promise<string> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	await writeFile(
		join(cwd, "big.txt"),
		`${Array.from({ length: lines }, (_, i) => `row-${String(i + 1).padStart(4, "0")} ${"x".repeat(40)}`).join("\n")}\n`,
	);
	return cwd;
}

/** One read, as the tool returns it. */
async function readValue(
	cwd: string,
	session: string,
	args: Record<string, unknown>,
): Promise<ReadWindowValue> {
	const tool = buildReadTool(localIO());
	return (await tool.execute(args, makeExec(cwd, session)(args))) as unknown as ReadWindowValue;
}

describe("issue 374 — the window says whether the response budget cut it", () => {
	it("marks a budget-cut window and mints the resume token with it", async () => {
		applyEffective({ max_response_chars: 8000 });
		const cwd = await makeCase("budget-cut", 400);
		const tool = buildReadTool(localIO());
		const args = { path: "big.txt" };
		const value = (await tool.execute(args, makeExec(cwd, "budget-cut")(args))) as unknown as ReadWindowValue;

		expect(value.window?.truncated).toBe(true);
		expect(value.window?.end).toBeLessThan(value.window!.totalLines);
		expect(value.continuation?.resume).toMatch(/^rs-[0-9a-f]{32}$/);
		// The host validates the RETURNED value when a session mounts the tool, and
		// it rejects an undeclared field outright.
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("does NOT mark a limit-cut window — it simply ended early", async () => {
		const cwd = await makeCase("limit-cut", 400);
		const tool = buildReadTool(localIO());
		const args = { path: "big.txt", limit: 5 };
		const value = (await tool.execute(args, makeExec(cwd, "limit-cut")(args))) as unknown as ReadWindowValue;

		// The window ends before the file does — and NOTHING was cut.
		expect(value.window).toEqual({ start: 1, end: 5, totalLines: 400 });
		expect(value.window?.truncated).toBeUndefined();
		expect(value.continuation).toBeUndefined();
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("marks a resumed window that is cut again", async () => {
		applyEffective({ max_response_chars: 8000 });
		const cwd = await makeCase("resumed-cut", 400);
		const first = await readValue(cwd, "resumed-cut", { path: "big.txt" });
		expect(first.window?.truncated).toBe(true);

		const second = await readValue(cwd, "resumed-cut", {
			path: "big.txt",
			resume: first.continuation!.resume,
		});
		expect(second.window?.truncated).toBe(true);
		// The resumed window continues where the first one stopped.
		expect(second.window?.start).toBe(first.window!.end + 1);
	});

	it("says nothing for a resumed window that reads the rest of the file", async () => {
		applyEffective({ max_response_chars: 8000 });
		const cwd = await makeCase("resumed-done", 150);
		const first = await readValue(cwd, "resumed-done", { path: "big.txt" });
		expect(first.window?.truncated).toBe(true);

		const second = await readValue(cwd, "resumed-done", {
			path: "big.txt",
			resume: first.continuation!.resume,
		});
		expect(second.window?.end).toBe(second.window!.totalLines);
		expect(second.window?.truncated).toBeUndefined();
		expect(second.continuation).toBeUndefined();
	});

	it("carries the flag into the card's meta", async () => {
		applyEffective({ max_response_chars: 8000 });
		const cwd = await makeCase("meta", 400);
		const value = await readValue(cwd, "meta", { path: "big.txt" });
		const meta = readPresentationMeta(value as never);
		// The projection has no surface on the tool object (the DSL consumes it),
		// so this is where the card's data is pinned.
		expect("window" in meta ? meta.window?.truncated : undefined).toBe(true);
	});
});
