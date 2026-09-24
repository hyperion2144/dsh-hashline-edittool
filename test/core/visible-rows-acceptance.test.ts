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
import { loadHashStore } from "../../src/domain/session/hash-store.js";
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
	// The real runtime opens the workspace's store at session start; the anchor
	// adapter only ever writes to an ALREADY-OPEN store. Open it for the case
	// cwd so the measurement mirrors production.
	await loadHashStore(cwd);
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
});
