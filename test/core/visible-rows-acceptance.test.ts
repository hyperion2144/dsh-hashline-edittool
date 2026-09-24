/**
 * The maintainer's PR-169 probe table, pinned as an acceptance test:
 * per tool, anchor_lines must persist EXACTLY the model-visible rows —
 * no whole-file allocation (read/grep/edit/undo), no silent
 * non-persistence (ast_grep/lsp).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../src/infra/paths.js";
import { getWritableTempRoot, setupIntegrationTest, getText } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "visible-rows-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

function countRows(cwd: string, path: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { defensive: false } as never);
	try {
		const row = db.prepare("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?").get(path) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

/** The session's served mirror size — anchors the model has been shown. */
function countServed(cwd: string, path: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { defensive: false } as never);
	try {
		const rows = db.prepare("SELECT hashes FROM served WHERE path = ?").all(path) as Array<{ hashes: string }>;
		return rows.reduce((n, row) => n + (JSON.parse(row.hashes) as unknown[]).length, 0);
	} finally {
		db.close();
	}
}
/** 3000 lines: repeated `}` runs + blanks + unique markers — the churn shape. */
function bigContent(): string {
	const lines: string[] = [];
	for (let i = 1; i <= 3000; i++) {
		if (i % 10 === 0) lines.push("  }");
		else if (i % 5 === 0) lines.push("");
		else lines.push(`const mark${i} = ${i}; // ${i % 500 === 7 ? "needle-hit" : "miss"}`);
	}
	return lines.join("\n");
}

async function makeCase(name: string): Promise<{ cwd: string; p: string; harness: ReturnType<typeof setupIntegrationTest> }> {
	const cwd = join(tmpHome, name);
	await mkdir(cwd, { recursive: true });
	const p = join(cwd, "big.ts");
	await writeFile(p, bigContent());
	// NO manual store open here: the tools must open the workspace store
	// THEMSELVES before they allocate anchors — a read/grep/edit that is the
	// session's first tool call used to render anchors that never persisted
	// (the #171 live probe measured `read` at 0 rows). This test therefore
	// proves the fix, not the harness.
	return { cwd, p, harness: setupIntegrationTest(cwd) };
}

describe("per-tool persisted rows == model-visible rows (PR #169 review table)", () => {
	it("read window persists ONLY its 10 rows — not the file's 3000", async () => {
		const { cwd, p, harness } = await makeCase("read-case");
		await harness.readTool.execute("read", { path: "big.ts", offset: 1, limit: 10 });
		expect(countRows(cwd, p)).toBe(10);
	});

	it("grep persists ONLY the served match+context rows", async () => {
		const { cwd, p, harness } = await makeCase("grep-case");
		const expectedMatches = bigContent().split("\n").filter((l) => l.includes("needle-hit")).length;
		const res = await (harness.getTool("grep") as unknown as {
			execute: (id: string, args: unknown) => Promise<{ content: { text?: string }[] }>;
		}).execute("g", { path: "big.ts", pattern: "needle-hit", context: 0, limit: 100 });
		const text = getText(res);
		const servedRows = [...text.matchAll(/^\s*[A-Za-z0-9]{2,8}:\d+[:|]/gm)].length;
		expect(servedRows).toBe(expectedMatches);
		expect(countRows(cwd, p)).toBe(expectedMatches); // persisted == served == visible
	});

	it("edit persists the read window PLUS the response's diff window — not the file", async () => {
		const { cwd, p, harness } = await makeCase("edit-case");
		const readText = getText(await harness.readTool.execute("read", { path: "big.ts", offset: 1, limit: 10 }));
		const readAnchors = new Set(
			[...readText.matchAll(/^\s*([A-Za-z0-9]{2,8}):\d+[:|]/gm)].map((m) => m[1]!),
		);
		// Edit a line INSIDE the served window (line 7 carries the needle marker).
		const line7 = readText.split("\n").find((l) => /:\s*7[:|]/.test(l));
		const anchor7 = /^\s*([A-Za-z0-9]{2,8}):7[:|]/.exec(line7 ?? "")?.[1];
		expect(anchor7).toBeDefined();
		const editText = getText(
			await harness.editTool.execute("edit", {
				path: "big.ts",
				edits: [{ op: "replace", anchor_start: anchor7, anchor_end: anchor7, lines: ["const mark7 = 7; // edited"] }],
			}),
		);
		const diffAnchors = new Set(
			[...editText.matchAll(/^[+\- ]?\s*([A-Za-z0-9]{2,8}):\d+[:|]/gm)].map((m) => m[1]!),
		);
		const union = new Set([...readAnchors, ...diffAnchors]);
		const persisted = countRows(cwd, p);
		// Every line the model saw is anchored (the read window, the diff's live
		// rows) …
		expect(persisted).toBeGreaterThanOrEqual(readAnchors.size);
		// … nothing beyond what it saw is (a diff `-` row shows a RELEASED anchor,
		// so it is legitimately absent from the persisted set) …
		expect(persisted).toBeLessThanOrEqual(union.size);
		// … and NEVER the whole file.
		expect(persisted).toBeLessThan(3000);
	});

	it("undo persists the revert diff window — not the file", async () => {
		const { cwd, p, harness } = await makeCase("undo-case");
		const readText = getText(await harness.readTool.execute("read", { path: "big.ts", offset: 1, limit: 10 }));
		const anchor7 = /^\s*([A-Za-z0-9]{2,8}):7[:|]/m.exec(readText)?.[1];
		expect(anchor7).toBeDefined();
		await harness.editTool.execute("edit", {
			path: "big.ts",
			edits: [{ op: "replace", anchor_start: anchor7, anchor_end: anchor7, lines: ["const mark7 = 7; // edited"] }],
		});
		const undoText = getText(await harness.getTool("undo_last_edit").execute("u", { path: "big.ts" }));
		const undoAnchors = new Set(
			[...undoText.matchAll(/^[+\- ]?\s*([A-Za-z0-9]{2,8}):\d+[:|]/gm)].map((m) => m[1]!),
		);
		// The revert's `+` rows are LIVE anchors (advertised == persisted).
		const rows = [...undoAnchors];
		expect(rows.length).toBeGreaterThan(0);
		expect(countRows(cwd, p)).toBeGreaterThanOrEqual(rows.length);
		expect(countRows(cwd, p)).toBeLessThan(3000); // never the whole file
	});

	it("served mirror == anchor_lines through read → edit → undo (#171 parity)", async () => {
		const { cwd, p, harness } = await makeCase("parity-case");
		const readText = getText(await harness.readTool.execute("read", { path: "big.ts", limit: 10 }));
		// The read's rows are persisted AND served — the store is opened by the
		// tool itself (a first-action read used to persist 0 anchors).
		expect(countRows(cwd, p)).toBe(10);
		expect(countServed(cwd, p)).toBe(countRows(cwd, p));
		const anchor7 = /^\s*([A-Za-z0-9]{2,8}):7[:|]/m.exec(readText)?.[1];
		expect(anchor7).toBeDefined();
		await harness.editTool.execute("edit", {
			path: "big.ts",
			edits: [{ op: "replace", anchor_start: anchor7, anchor_end: anchor7, lines: ["const mark7 = 7; // edited"] }],
		});
		// The edit RELEASES the replaced line's anchor; the mirror is reconciled
		// to the live set, so the two stay equal instead of served ⊃ live.
		expect(countServed(cwd, p)).toBe(countRows(cwd, p));
		await harness.getTool("undo_last_edit").execute("u", { path: "big.ts" });
		expect(countServed(cwd, p)).toBe(countRows(cwd, p));
	});
});
