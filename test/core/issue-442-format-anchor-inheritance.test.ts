/**
 * #442 — the format pass inherits anchors (edit-style) instead of
 * recomputing the whole file (P1), and the write section's eligibility gate
 * reads the preview's anchors instead of a second whole-file assignment (P1b).
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { applyEffective } from "../../src/config.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { hunksBetween } from "../../src/domain/edit/edit-engine.js";
import { buildWriteFormatSection } from "../../src/domain/format/write-section.js";
import { lineHashesPure } from "../../src/hashline/hash-assign.js";
import { join } from "node:path";
import { anchorsFor } from "../../src/domain/session/anchor-state.js";
import { withWorkspace } from "../../src/domain/session/session-view.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { localIO } from "../support/local-io.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import {
	getText,
	setupIntegrationTest,
	makeExec,
	useNumberedRows,
	withTempFile,
} from "../support/fixtures.js";

useNumberedRows();

interface FormatAnswers {
	range?: unknown[];
	full?: unknown[];
	syncs: string[];
}

function fakeFormatManager(answers: FormatAnswers): void {
	const session = {
		serverCapabilities: { documentFormattingProvider: true, documentRangeFormattingProvider: true },
		request: async (method: string) => {
			if (method === "textDocument/rangeFormatting") return answers.range ?? [];
			if (method === "textDocument/formatting") return answers.full ?? [];
			return undefined;
		},
		notify: async () => {},
	};
	setLspManager({
		readyLanguages: ["typescript"],
		readySessionFor: () => session,
		status: async () => [{ language: "typescript", server: { server: { displayName: "fake-ts" } } }],
		openDocumentFor: () => () => {},
		waitForSession: async () => session,
	} as never);
}

/** Unconfined sandbox controller for direct-execute tools (test default). */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

/** Rewrite any 1-based line — `character` past EOL clamps to it (LSP). */
function editAt(line: number, replacement: string) {
	return {
		range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1000 } },
		newText: replacement,
	};
}

/** Insert a full line ABOVE the given 1-based line. */
function insertAbove(line: number, text: string) {
	return {
		range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 0 } },
		newText: `${text}\n`,
	};
}

const FILE = [
	"const a = 1;",
	"",
	"const b = 2;",
	"",
	"const c = 3;",
	"",
	"const d = 4;",
	"",
	"const e = 5;",
	"",
].join("\n") + "\n";

/** Read through the `read` tool; return per-row {hash, content, line}. */
async function readRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
	offset?: number,
	limit?: number,
): Promise<Array<{ hash: string; content: string; line: number }>> {
	const res = await harness.readTool.execute("read", { path, ...(offset !== undefined ? { offset, limit } : {}) });
	const rows: Array<{ hash: string; content: string; line: number }> = [];
	for (const raw of getText(res).split("\n")) {
		if (raw.startsWith("ANCHOR:")) continue;
		const line = raw.replace(/^[+\- ]+/, "");
		const m = /^([A-Za-z0-9]{2,8}):(.*)$/.exec(line);
		if (m) rows.push({ hash: m[1]!, content: m[2]!, line: (offset ?? 1) + rows.length });
	}
	return rows;
}

afterEach(() => {
	setLspManager(undefined);
	applyEffective({});
});

describe("#442 format-pass anchor inheritance (P1)", () => {
	it("E1: formatter swaps a blank for code — untouched lines keep their anchors", async () => {
		await withTempFile("f.ts", FILE, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" }, lsp: { auto_diagnostics: false } });
			fakeFormatManager({ range: [editAt(2, 'import x from "y";')], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const before = await readRows(harness, path);
			expect(before).toHaveLength(10);
			const b = before.find((r) => r.content === "const b = 2;")!;

			await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: b.hash, anchor_end: b.hash, lines: ["const b = 222;"] }],
			});

			const after = await readRows(harness, path);
			// Lines 4..10 (blanks + c/d/e) were untouched by model and formatter.
			for (const row of after) {
				if ([4, 5, 6, 7, 8, 9, 10].includes(row.line)) {
					expect(`${row.line}:${row.hash}`).toBe(`${row.line}:${before[row.line - 1]!.hash}`);
				}
			}
			expect(await readFile(path, "utf-8")).toContain('import x from "y";');
			// P1-4: the served mirror equals the store snapshot — every row the
			// re-read shows is the store's own binding for that line.
			const disk = await readFile(path, "utf-8");
			const abs = await harness.io.resolve(path, cwd, undefined);
			const storeAnchors = await withWorkspace(cwd, async () => anchorsFor(abs, disk));
			for (const row of after) {
				expect(`${row.line}:${row.hash}`).toBe(`${row.line}:${storeAnchors[row.line - 1]}`);
			}
		});
	});

	it("E2: formatter inserts a line above the blank run — blanks remap, anchors keep", async () => {
		await withTempFile("f.ts", FILE, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" }, lsp: { auto_diagnostics: false } });
			fakeFormatManager({ range: [insertAbove(2, 'import x from "y";')], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const before = await readRows(harness, path);
			const b = before.find((r) => r.content === "const b = 2;")!;

			await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: b.hash, anchor_end: b.hash, lines: ["const b = 222;"] }],
			});

			const after = await readRows(harness, path);
			expect(after).toHaveLength(11);
			// Every pre-call line's anchor must survive on its shifted position:
			// old line k (k>=3) now sits at k+1 with the SAME anchor.
			const byLine = new Map(after.map((r) => [r.line, r]));
			for (let k = 1; k <= 10; k++) {
				if (k === 3) continue; // the model's own edit legitimately re-anchors line 3
				const moved = byLine.get(k === 1 ? 1 : k + 1)!;
				expect(`${k}->${moved.line}:${moved.hash}`).toBe(`${k}->${moved.line}:${before[k - 1]!.hash}`);
			}
		});
	});

	it("E3: formatter exactly reverts the model's edit — store must not be stranded", async () => {
		await withTempFile("f.ts", FILE, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" }, lsp: { auto_diagnostics: false } });
			fakeFormatManager({ range: [editAt(3, "const b = 2;")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const before = await readRows(harness, path);
			const b = before.find((r) => r.content === "const b = 2;")!;
			const c = before.find((r) => r.content === "const c = 3;")!;

			await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: b.hash, anchor_end: b.hash, lines: ["const b = 222;"] }],
			});
			// The formatter reverted the model's change: disk is back to FILE.
			expect(await readFile(path, "utf-8")).toBe(FILE);

			// Untouched lines' anchors must be intact for the NEXT call.
			const followUp = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: c.hash, anchor_end: c.hash, lines: ["const c = 333;"] }],
			});
			expect(getText(followUp)).toContain("Successfully edited");
			expect(await readFile(path, "utf-8")).toContain("const c = 333;");

			const after = await readRows(harness, path);
			// Untouched lines — line 1 and every blank — keep their anchors
			// through the edit + revert + follow-up dance.
			const byLine = new Map(after.map((r) => [r.line, r]));
			for (const k of [1, 2, 4, 6, 8, 10]) {
				expect(`${k}:${byLine.get(k)!.hash}`).toBe(`${k}:${before[k - 1]!.hash}`);
			}
		});
	});

	it("E4: window-read history + formatter revert — untouched unique lines keep anchors", async () => {
		await withTempFile("f.ts", FILE, async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" }, lsp: { auto_diagnostics: false } });
			fakeFormatManager({ range: [editAt(4, "")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			// Window read: lines 3–5 only (c b, blank@4, c3) — sparse history.
			const window1 = await readRows(harness, path, 3, 3);
			const blank4 = window1.find((r) => r.content === "")!;

			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: blank4.hash, anchor_end: blank4.hash, lines: ["// note"] }],
			});
			expect(getText(res)).toContain("Successfully edited");
			// The formatter reverted the model's blank→note edit: disk is FILE again.
			expect(await readFile(path, "utf-8")).toBe(FILE);
			const after = await readRows(harness, path);
			const byLine = new Map(after.map((r) => [r.line, r]));
			// Unique untouched lines keep their anchors under the sparse history.
			expect(byLine.get(3)!.hash).toBe(window1.find((r) => r.content === "const b = 2;")!.hash);
			expect(byLine.get(5)!.hash).toBe(window1.find((r) => r.content === "const c = 3;")!.hash);
			// The restored blank is anchored (fresh: the anchor the model held was
			// legitimately released by its own edit).
			expect(byLine.get(4)!.hash).not.toBe("");
		});
	});

	it("E5: edit + format on a 10k-line file — scale correctness", async () => {
		await withTempFile("big.ts", FILE + Array.from({ length: 10_000 }, (_, i) => (i % 7 === 0 ? "" : `stmt_${i} = ${i};`)).join("\n") + "\n", async ({ cwd, path }) => {
			applyEffective({ format: { auto: "range" }, lsp: { auto_diagnostics: false } });
			fakeFormatManager({ range: [editAt(3, "const b = 222; // fmt")], syncs: [] });
			const harness = setupIntegrationTest(cwd);
			const head = await readRows(harness, path, 1, 10);
			const b = head.find((r) => r.content === "const b = 2;")!;
			const res = await harness.editTool.execute("edit", {
				path,
				edits: [{ op: "replace", anchor_start: b.hash, anchor_end: b.hash, lines: ["const b = 222;"] }],
			});
			expect(getText(res)).toContain("Successfully edited");
			// The formatter's line-3 rewrite is on disk. The whole-file
			// assignment is gone from the path by construction (ADR-0041);
			// this test pins scale behavior, not timing.
			expect(await readFile(path, "utf-8")).toContain("const b = 222; // fmt");
		});
	});

	it("E6: write + format on a 10k-line file — the padded-preview path", async () => {
		applyEffective({ format: { auto: "full" }, lsp: { auto_diagnostics: false } });
		fakeFormatManager({ full: [editAt(1, "// formatted header")], syncs: [] });
		await withTempFile("holder.txt", "holder\n", async ({ cwd }) => {
			const tool = buildWriteShadowTool(localIO(), testSandbox());
			const content =
				Array.from({ length: 10_000 }, (_, i) => (i % 7 === 0 ? "" : `stmt_${i} = ${i};`)).join("\n") + "\n";
			const started = Date.now();
			const value = (await tool.execute(
				{ file_path: "big-write.ts", content },
				makeExec(cwd)({ file_path: "big-write.ts", content }) as never,
			)) as { modelText: string; formats?: Array<{ status?: string }> };
			// A 10k-line echo truncates/spills the model text — assert the section
			// structurally, not through the prose.
			expect(value.formats?.[0]?.status).toBe("formatted");
			expect(await readFile(join(cwd, "big-write.ts"), "utf-8")).toContain("// formatted header");
		});
	});
});

describe("#442 hunksBetween — the format step's EditHunk mapping", () => {
	it("returns no hunks for identical texts", () => {
		expect(hunksBetween("a\nb\nc", "a\nb\nc")).toEqual([]);
	});

	it("encodes a pure insertion as an empty old range", () => {
		expect(hunksBetween("a\nb\nc", "a\nX\nY\nb\nc")).toEqual([
			{ oldStart1: 2, oldEnd1: 1, finalStart1: 2, finalEnd1: 3 },
		]);
	});

	it("encodes a pure deletion as an empty final range", () => {
		expect(hunksBetween("a\nb\nc", "a\nc")).toEqual([
			{ oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 1 },
		]);
	});

	it("encodes a one→two line replacement", () => {
		expect(hunksBetween("a\nb\nc", "a\nX\nY\nc")).toEqual([
			{ oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 3 },
		]);
	});

	it("splits changes separated by unchanged lines", () => {
		expect(hunksBetween("a\nb\nc\nd\ne", "A\nb\nc\nD\ne")).toEqual([
			{ oldStart1: 1, oldEnd1: 1, finalStart1: 1, finalEnd1: 1 },
			{ oldStart1: 4, oldEnd1: 4, finalStart1: 4, finalEnd1: 4 },
		]);
	});

	it("handles a file without a trailing newline", () => {
		// "b" (no terminator) and "b\n" are different tokens, so the tail add
		// arrives as a line-2 modification — sound for anchors: the in-hunk
		// pairing matches "b"↔"b" and only "c" is fresh.
		expect(hunksBetween("a\nb", "a\nb\nc")).toEqual([
			{ oldStart1: 2, oldEnd1: 2, finalStart1: 2, finalEnd1: 3 },
		]);
	});
});

describe("#442 write-section preCallHashes — the preview family decides (P1b)", () => {
	const MODEL = "alpha\n\nbeta";
	const lineage = new Map<number, ReadonlySet<number>>([
		[1, new Set([1])],
		[2, new Set([2])],
		[3, new Set([3])],
	]);

	function section(input: Partial<Parameters<typeof buildWriteFormatSection>[0]> = {}) {
		return buildWriteFormatSection({
			outcome: { status: "formatted", attempted: true, content: "\talpha\n\nbeta", finalToModel: lineage },
			modelContent: MODEL,
			sessionKey: "s1",
			preCallServed: new Map([["pA", ""]]),
			created: false,
			servedHashes: ["pA", "pB", "pC"],
			...input,
		});
	}

	it("quotes the PREVIEW anchor for a served re-indented line", () => {
		// The preview served line 1 as pA and pA is in the pre-call served set;
		// the whole-file family's value for the same line is a DIFFERENT string
		// that is not served — under the old recompute this row came back
		// unserved (a second allocation family, #437 P1b).
		const pure = lineHashesPure(MODEL)[0]!;
		expect(pure).not.toBe("pA");
		const s = section();
		expect(s.rows ?? []).toHaveLength(1);
		expect((s.rows ?? [])[0]!.hash).toBe("pA");
		expect(s.unservedRows ?? 0).toBe(0);
	});

	it("counts a formatter-invented line as unserved — no anchor quoted", () => {
		const s = section({ outcome: { status: "formatted", attempted: true, content: "\talpha\n\nbeta\n// tail", finalToModel: lineage } });
		// The re-indented line 1 stays an eligible ROW (its preview anchor is
		// served); only the invented tail counts as unserved.
		expect(s.rows ?? []).toHaveLength(1);
		expect((s.rows ?? [])[0]!.hash).toBe("pA");
		expect(s.unservedRows ?? 0).toBe(1);
	});

	it("falls back to the whole-file family when there is no preview", () => {
		const pure = lineHashesPure(MODEL)[0]!;
		const s = section({ servedHashes: undefined, preCallServed: new Map([[pure, ""]]) });
		expect(s.rows ?? []).toHaveLength(1);
		expect((s.rows ?? [])[0]!.hash).toBe(pure);
	});

	it("created: nothing is served — every changed row counts unserved", () => {
		const s = section({ created: true, preCallServed: new Map() });
		expect(s.rows ?? []).toHaveLength(0);
		expect(s.unservedRows ?? 0).toBe(1);
	});

	it("a truncated preview pads uncovered lines — no second family sneaks in", () => {
		// Line 3 is re-indented but sits beyond the truncated preview window.
		// The PURE family's anchor for it happens to be served (a same-text
		// binding elsewhere); the old fallback quoted it — an anchor the model
		// was never shown. The padded preview refuses the row instead.
		const pure3 = lineHashesPure(MODEL)[2]!;
		expect(pure3).not.toBe("pC");
		const s = section({
			outcome: { status: "formatted", attempted: true, content: "alpha\n\n\tbeta", finalToModel: lineage },
			servedHashes: ["pA", "pB"],
			preCallServed: new Map([[pure3, ""]]),
		});
		expect(s.rows ?? []).toHaveLength(0);
		expect(s.unservedRows ?? 0).toBe(1);
	});
});
