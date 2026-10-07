/**
 * Issue #212 / root cause A — the read window seam.
 *
 * `fmtReadPreview` renders, allocates and serves exactly the requested
 * `offset`/`limit` window, but the tool layer used to derive its presentation
 * window from `nextOffset` — a value that only exists when the CHAR BUDGET cut
 * the rows. A limit-cut therefore fell back to EOF and rebuilt the WHOLE file:
 * rows the model could see but that were never served (bare-number rows for
 * unallocated lines, "not in served set" for persisted ones).
 *
 * These tests pin the contract end to end: rendered rows == requested window
 * == served rows, every rendered row carries a real anchor, and a limit-cut
 * never mints a resume token (that stays budget-cut-only, per ADR-0013).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../src/infra/paths.js";
import { decodeServedAnchors } from "../../src/domain/session/served-codec.js";
import { getWritableTempRoot, setupIntegrationTest, getText, makeExec, useNumberedRows } from "../support/fixtures.js";
// #244: the line-number switch belongs to the user now and defaults OFF; this
// file asserts numbered rows, so every test here pins it ON.
useNumberedRows();
import { buildReadTool } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "issue-212-window-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

function twelveLines(): string {
	return (
		Array.from({ length: 12 }, (_, i) => `line-${String(i + 1).padStart(2, "0")} content`)
			.join("\n") + "\n"
	);
}

async function makeCase(name: string): Promise<{ cwd: string; p: string }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "f.txt"), twelveLines());
	return { cwd, p: join(cwd, "f.txt") };
}

function rowNumbers(text: string): number[] {
	return [...text.matchAll(/^\s*[A-Za-z0-9]{2,8}:(\d+):/gm)].map((m) => Number(m[1]));
}

function countServed(cwd: string, path: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { defensive: false } as never);
	try {
		const rows = db.prepare("SELECT hashes FROM served WHERE path = ?").all(path) as Array<{ hashes: string }>;
		return rows.reduce((n, row) => n + (decodeServedAnchors(row.hashes)?.size ?? 0), 0);
	} finally {
		db.close();
	}
}

describe("#212 read window: rendered rows == requested window == served rows", () => {
	it("read {offset, limit} returns ONLY the window rows — not the rest of the file", async () => {
		const { cwd } = await makeCase("only-window");
		const h = setupIntegrationTest(cwd);
		const text = getText(await h.readTool.execute("read", { path: "f.txt", offset: 5, limit: 3 }));
		expect(rowNumbers(text)).toEqual([5, 6, 7]);
		expect(text).not.toContain("line-01");
		expect(text).not.toContain("line-12");
	});

	it("no rendered row is ever a bare-number placeholder (`:N:`)", async () => {
		const { cwd } = await makeCase("no-bare-rows");
		const h = setupIntegrationTest(cwd);
		const text = getText(await h.readTool.execute("read", { path: "f.txt", offset: 1, limit: 4 }));
		// The window rows carry real markers …
		expect(rowNumbers(text)).toEqual([1, 2, 3, 4]);
		// … and NOTHING outside the window is rendered — in particular no
		// unallocated line can leak through as a bare `:N:` row.
		expect(/\n\s*:\d+[:|]/.test(`\n${text}`)).toBe(false);
		for (const m of text.matchAll(/^\s*([A-Za-z0-9]{2,8}):\d+:/gm)) {
			expect(m[1]).not.toBe("");
		}
	});

	it("a limit-cut serves exactly the window rows and mints NO resume token", async () => {
		const { cwd, p } = await makeCase("no-resume");
		const h = setupIntegrationTest(cwd);
		const text = getText(await h.readTool.execute("read", { path: "f.txt", offset: 5, limit: 3 }));
		// ADR-0013: resume tokens are minted by CHAR-BUDGET cuts only.
		expect(text).not.toContain("resume:");
		expect(text).not.toContain("(Omitted");
		// persisted == served == visible (the #169 invariant, now window-exact)
		expect(countServed(cwd, p)).toBe(3);
	});

	it("the structured value (lines/hashlines) honors offset+limit end-to-end", async () => {
		const { cwd } = await makeCase("structured");
		const args = { path: "f.txt", offset: 5, limit: 3 };
		const tool = buildReadTool(localIO());
		const exec = makeExec(cwd, "structured-session")(args);
		const value = (await tool.execute(args, exec)) as unknown as {
			lines: Array<{ number: number; text: string }>;
			hashlines: Array<{ number: number; hash: string; text: string }>;
		};
		expect(value.lines.map((l) => l.number)).toEqual([5, 6, 7]);
		expect(value.hashlines.map((l) => l.number)).toEqual([5, 6, 7]);
		for (const hl of value.hashlines) {
			expect(hl.hash).not.toBe("");
			expect(hl.text).toBe(`line-${String(hl.number).padStart(2, "0")} content`);
		}
	});
});
