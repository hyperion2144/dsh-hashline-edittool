/**
 * The noop guard's boundary, pinned (#185, triage 2026-09-25).
 *
 * The issue reported "an edit that only changes leading whitespace is folded to
 * a noop". Triage refuted the premise — the predicate is a whole-content byte
 * comparison (`result === input.content`) and nothing normalises whitespace —
 * and found that the recorded event was a genuine noop: the payload was
 * byte-identical to the range it targeted. What the event DID expose is a
 * message problem: the caller read "range already has this text" as "the tool
 * rewrote my text" and then burned a dozen attempts on sentinel hacks
 * (`PLACEHOLDER_X9Z`, `[AUTOFIX_MARKER]`, …), even writing them into the file.
 *
 * So this file pins both halves of the contract, because either half silently
 * regressing would put callers back in that loop:
 *   1. an indentation-only replace IS a change and must be written — in both
 *      directions (spaces widened, tab <-> spaces);
 *   2. a byte-identical replace is still a noop, and the loop notice/error say
 *      WHY in terms of bytes and say how to change indentation on purpose.
 *
 * @module dsh-hashline-edittool/test/core/noop-indentation
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";

let tmpHome: string;

beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "noop-indent-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
});

/** Write a file, read one line's anchor, and hand back the harness. */
async function openFile(
	dir: string,
	content: string,
	line: number,
): Promise<{ harness: ReturnType<typeof setupIntegrationTest>; file: string; anchor: string }> {
	const cwd = join(tmpHome, dir);
	await mkdir(cwd, { recursive: true });
	const file = join(cwd, "mod.ts");
	await writeFile(file, content);
	const harness = setupIntegrationTest(cwd);
	const readText = getText(await harness.readTool.execute("read", { path: "mod.ts" }));
	const re = new RegExp(`^\\s*([A-Za-z0-9]{1,8}):${line}[:|]`, "m");
	const anchor = re.exec(readText)?.[1];
	expect(anchor, `no anchor for line ${line} in:\n${readText}`).toBeDefined();
	return { harness, file, anchor: anchor! };
}

describe("#185: indentation is part of the text, never a formatting hint", () => {
	it("writes a replace that only widens leading whitespace", async () => {
		const before = "export const a = 1;\n    export const b = 2;\nexport const c = 3;\n";
		const { harness, file, anchor } = await openFile("widen", before, 2);
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["        export const b = 2;"] }],
			}),
		);
		expect(res).not.toContain("No changes made");
		expect((await readFile(file, "utf8")).split("\n")[1]).toBe("        export const b = 2;");
	}, 60_000);

	it("writes a replace that only converts a tab to spaces", async () => {
		const before = "const a = 1;\n\tconst b = 2;\nconst c = 3;\n";
		const { harness, file, anchor } = await openFile("tab-to-space", before, 2);
		await harness.editTool.execute("edit", {
			path: "mod.ts",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["  const b = 2;"] }],
		});
		expect((await readFile(file, "utf8")).split("\n")[1]).toBe("  const b = 2;");
	}, 60_000);

	it("writes a replace that only converts spaces to a tab", async () => {
		const before = "const a = 1;\n  const b = 2;\nconst c = 3;\n";
		const { harness, file, anchor } = await openFile("space-to-tab", before, 2);
		await harness.editTool.execute("edit", {
			path: "mod.ts",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["\tconst b = 2;"] }],
		});
		expect((await readFile(file, "utf8")).split("\n")[1]).toBe("\tconst b = 2;");
	}, 60_000);
});

describe("#185: a byte-identical replace stays a noop, and says why", () => {
	it("reports no changes and leaves the file alone", async () => {
		const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const { harness, file, anchor } = await openFile("identical", before, 2);
		const res = getText(
			await harness.editTool.execute("edit", {
				path: "mod.ts",
				edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["const b = 2;"] }],
			}),
		);
		expect(res).toContain("No changes made");
		expect(await readFile(file, "utf8")).toBe(before);
	}, 60_000);

	it("names the cause in bytes and points at indentation when the payload repeats", async () => {
		const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const { harness, file, anchor } = await openFile("repeat", before, 2);
		const payload = {
			path: "mod.ts",
			edits: [{ op: "replace", anchor_start: anchor, anchor_end: anchor, lines: ["const b = 2;"] }],
		};
		// First attempt: an ordinary noop.
		expect(getText(await harness.editTool.execute("edit", payload))).toContain("No changes made");
		// Second: the loop guard speaks, and it must say WHY (bytes) and HOW to
		// change indentation on purpose — the wording that the live session
		// misread as "the tool normalised my whitespace".
		const second = getText(await harness.editTool.execute("edit", payload));
		expect(second).toContain("[E_NOOP_LOOP]");
		expect(second).toContain("BYTE-IDENTICAL");
		expect(second).toContain("INDENTATION");
		expect(second).toContain("leading whitespace");
		// Third: a hard rejection, still naming the byte comparison.
		let third = "";
		try {
			third = getText(await harness.editTool.execute("edit", payload));
		} catch (error) {
			third = String((error as Error).message ?? error);
		}
		expect(third).toContain("submitted 3×");
		expect(third).toContain("BYTE-IDENTICAL");
		// The file never changed through any of it.
		expect(await readFile(file, "utf8")).toBe(before);
	}, 60_000);
});
