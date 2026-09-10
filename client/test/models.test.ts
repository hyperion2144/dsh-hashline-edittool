import { describe, expect, it } from "vitest";

import {
	diffCardModel,
	writeCardModel,
	metaDiffRows,
	metaDiffRowGroups,
	editAnchorHints,
	narrowDiffs,
	readCardModel,
	toolRowModel,
} from "../src/client/models.js";
import type { ToolCallBlock } from "../src/client/types.js";

/** Build a settled result node fixture. */
function settled(overrides: Partial<Extract<ToolCallBlock, { kind: "tool-result" }>> = {}): ToolCallBlock {
	return {
		kind: "tool-result",
		seq: 1,
		time: 0,
		callId: "c1",
		call: { name: "read", argsRaw: "{}" },
		callTime: 0,
		content: [],
		isError: false,
		subCalls: [],
		...overrides,
	};
}

/** Build a running call fixture. */
function running(argsRaw: string, name = "read"): ToolCallBlock {
	return {
		callId: "c1",
		name,
		argsRaw,
		turn: 1,
		step: 1,
		time: 0,
		subCalls: [],
	};
}

/** A settled read call with envelope text, meta, and standard args. */
function settledRead(opts: {
	meta?: unknown;
	text?: string;
	argsRaw?: string;
	hashlines?: Array<{ number: number; hash: string; text: string }>;
}): ToolCallBlock {
	const meta = opts.meta ?? {
		path: "/w/src/a.ts",
		offset: 1,
		totalLines: 3,
		lines: [
			{ number: 1, text: "const a = 1;" },
			{ number: 2, text: "const b = 2;" },
		],
		...(opts.hashlines !== undefined ? { hashlines: opts.hashlines } : {}),
		lang: "ts",
	};
	const text =
		opts.text ?? "<path>/w/src/a.ts</path>\n<type>file</type>\n<content>\nconst a = 1;\nconst b = 2;\n</content>";
	return settled({
		call: { name: "read", argsRaw: opts.argsRaw ?? JSON.stringify({ file_path: "/w/src/a.ts" }) },
		content: [{ type: "text", text }],
		meta,
	});
}

describe("readCardModel", () => {
	it("renders `<line>:<anchor>` gutter cells from valid hashlines meta", () => {
		const card = readCardModel(
			settledRead({
				hashlines: [
					{ number: 1, hash: "a1", text: "const a = 1;" },
					{ number: 2, hash: "b2", text: "const b = 2;" },
				],
			}),
			"/w",
			undefined,
		);
		expect(card).not.toBeNull();
		expect(card?.lines.map((line) => line.number)).toEqual(["1:a1", "2:b2"]);
		expect(card?.lines.map((line) => line.text)).toEqual(["const a = 1;", "const b = 2;"]);
		expect(card?.label).toBe("src/a.ts");
		expect(card?.lang).toBe("ts");
	});

	it("falls back to the bare number when a row's hash is empty", () => {
		const card = readCardModel(
			settledRead({
				hashlines: [
					{ number: 1, hash: "", text: "const a = 1;" },
					{ number: 2, hash: "b2", text: "const b = 2;" },
				],
			}),
			undefined,
			undefined,
		);
		expect(card?.lines.map((line) => line.number)).toEqual([1, "2:b2"]);
	});

	it("keeps official parity (bare numbers) when meta carries no hashlines", () => {
		const card = readCardModel(settledRead({}), undefined, undefined);
		expect(card?.lines.map((line) => line.number)).toEqual([1, 2]);
	});

	it("renders the card WITHOUT the dsh envelope text (issue #71: meta alone)", () => {
		const card = readCardModel(
			settledRead({
				text: "ANCHOR:FILELINE\n1:a1:const a = 1;\n2:b2:const b = 2;\n\n[End of file - total 2 lines.]",
				hashlines: [
					{ number: 1, hash: "a1", text: "const a = 1;" },
					{ number: 2, hash: "b2", text: "const b = 2;" },
				],
			}),
			undefined,
			undefined,
		);
		expect(card).not.toBeNull();
		expect(card?.lines.map((line) => line.number)).toEqual(["1:a1", "2:b2"]);
	});

	it("still renders enveloped pre-0.4.2 history (legacy tolerance)", () => {
		const legacy = "<path>/w/src/a.ts</path>\n<type>file</type>\n<content>\nrows\n</content>";
		const card = readCardModel(settledRead({ text: legacy }), undefined, undefined);
		expect(card).not.toBeNull();
	});

	it("returns null for the generic path: malformed meta, running call", () => {
		expect(readCardModel(settledRead({ meta: { broken: true } }), undefined, undefined)).toBeNull();
		expect(
			readCardModel(running(JSON.stringify({ file_path: "/w/a.ts" })), undefined, undefined),
		).toBeNull();
	});

	it("returns null when hashlines is malformed (defends against foreign meta)", () => {
		const card = readCardModel(
			settledRead({
				meta: {
					path: "/w/src/a.ts",
					offset: 1,
					totalLines: 3,
					lines: [{ number: 1, text: "const a = 1;" }],
					hashlines: [{ number: 1, text: "no hash field" }],
				},
			}),
			undefined,
			undefined,
		);
		expect(card).toBeNull();
	});
});

describe("diffCardModel", () => {
	const hashlineArgs = JSON.stringify({
		path: "/w/src/a.ts",
		edits: [{ anchor_start: "2:b2", anchor_end: "2:b2", lines: ["const b = 42;"] }],
	});
	const hunks = [{ path: "/w/src/a.ts", oldText: "const b = 2;", newText: "const b = 42;" }];

	it("renders the applied multi-hunk diff card from meta.diffs (hashline contract)", () => {
		const block = settled({
			call: { name: "edit", argsRaw: hashlineArgs },
			content: [{ type: "text", text: "ok" }],
			meta: { diffs: [...hunks, { path: "/w/src/a.ts", oldText: "x", newText: "y" }] },
		});
		const card = diffCardModel(block);
		expect(card?.diffs).toHaveLength(2);
		expect(card?.diffs[0]).toEqual(hunks[0]);
	});

	it("renders null for a settled hashline edit without applied diffs (generic parity)", () => {
		const block = settled({
			call: { name: "edit", argsRaw: hashlineArgs },
			content: [{ type: "text", text: "ok" }],
			meta: {},
		});
		expect(diffCardModel(block)).toBeNull();
	});

	it("keeps the shipped intended-diff behavior for a running standard edit", () => {
		const block = running(
			JSON.stringify({ file_path: "/w/a.ts", old_string: "a", new_string: "b" }),
			"edit",
		);
		const card = diffCardModel(block);
		expect(card?.diffs).toEqual([{ path: "/w/a.ts", oldText: "a", newText: "b" }]);
	});

	it("renders null for a running hashline edit (no card until diffs land)", () => {
		expect(diffCardModel(running(hashlineArgs, "edit"))).toBeNull();
	});

	it("renders null for error results", () => {
		const block = settled({
			call: { name: "edit", argsRaw: hashlineArgs },
			isError: true,
			meta: { diffs: hunks },
		});
		expect(diffCardModel(block)).toBeNull();
	});

	it("rejects malformed hunks through the narrowDiffs gate", () => {
		expect(narrowDiffs([{ path: 3, oldText: null, newText: "" }])).toBeNull();
		expect(narrowDiffs([{ path: "p", oldText: 3, newText: "" }])).toBeNull();
		expect(narrowDiffs([{ path: "p", oldText: null, newText: "x" }])).toHaveLength(1);
	});
});

describe("writeCardModel (native parity + hashline gutter)", () => {
	const writeArgs = JSON.stringify({ file_path: "/w/src/a.ts", content: "one\ntwo\n" });

	it("prefers structured diffRows so the card draws the `行号:锚点` gutter", () => {
		const block = settled({
			call: { name: "write", argsRaw: writeArgs },
			content: [{ type: "text", text: "ok" }],
			meta: {
				path: "/w/src/a.ts",
				diffs: [],
				diffRows: [
					{ kind: "+", lineNumber: 1, hash: "a1", text: "one" },
					{ kind: "+", lineNumber: 2, hash: "a2", text: "two" },
				],
			},
		});
		const card = writeCardModel(block);
		expect(card?.path).toBe("/w/src/a.ts");
		expect(card?.rows).toHaveLength(2);
		expect(card?.rows?.[0]).toEqual({ kind: "+", lineNumber: 1, hash: "a1", text: "one" });
		// A create carries no hunks — the rows are the whole card material.
		expect(card?.diffs).toEqual([]);
	});

	it("carries mixed rows for an overwrite (removals keep their pre-write anchor)", () => {
		const block = settled({
			call: { name: "write", argsRaw: writeArgs },
			content: [{ type: "text", text: "ok" }],
			meta: {
				path: "/w/src/a.ts",
				diffs: [{ path: "/w/src/a.ts", oldText: "one\nold\n", newText: "one\nnew\n" }],
				diffRows: [
					{ kind: " ", lineNumber: 1, hash: "a1", text: "one" },
					{ kind: "-", lineNumber: 2, hash: "b9", text: "old" },
					{ kind: "+", lineNumber: 2, hash: "c3", text: "new" },
				],
			},
		});
		const card = writeCardModel(block);
		expect(card?.rows?.map((row) => row.kind)).toEqual([" ", "-", "+"]);
		expect(card?.diffs).toHaveLength(1);
	});

	it("degrades to the built-in intended diff when no structured rows exist", () => {
		const block = settled({
			call: { name: "write", argsRaw: writeArgs },
			content: [{ type: "text", text: "ok" }],
			meta: { path: "/w/src/a.ts", diffs: [] },
		});
		const card = writeCardModel(block);
		expect(card?.rows).toBeUndefined();
		expect(card?.diffs).toEqual([
			{ path: "/w/src/a.ts", oldText: null, newText: "one\ntwo\n" },
		]);
	});

	it("shows the intended diff while the write is still running", () => {
		const card = writeCardModel(running(writeArgs, "write"));
		expect(card?.diffs).toEqual([
			{ path: "/w/src/a.ts", oldText: null, newText: "one\ntwo\n" },
		]);
	});

	it("renders null for error results", () => {
		const block = settled({
			call: { name: "write", argsRaw: writeArgs },
			isError: true,
			meta: { path: "/w/src/a.ts", diffRows: [{ kind: "+", lineNumber: 1, hash: "a1", text: "one" }] },
		});
		expect(writeCardModel(block)).toBeNull();
	});
});

describe("editAnchorHints", () => {
	it("collects `edits[].anchor_start` as displayed `line:anchor` hints", () => {
		const argsRaw = JSON.stringify({
			path: "/w/a.ts",
			edits: [
				{ anchor_start: "2:b2", lines: ["x"] },
				{ anchor_start: "9:c3", lines: ["y"] },
			],
		});
		expect(editAnchorHints(argsRaw)).toEqual(["2:b2", "9:c3"]);
	});

	it("normalizes the legacy `line#hash` spelling", () => {
		const argsRaw = JSON.stringify({ edits: [{ anchor_start: "2#b2" }] });
		expect(editAnchorHints(argsRaw)).toEqual(["2:b2"]);
	});

	it("caps the hint list with an ellipsis", () => {
		const edits = [1, 2, 3, 4, 5].map((n) => ({ anchor_start: `${n}:h${n}` }));
		expect(editAnchorHints(JSON.stringify({ edits }))).toEqual(["1:h1", "2:h2", "3:h3", "…"]);
	});

	it("returns empty for unparseable or non-hashline args (never throws)", () => {
		expect(editAnchorHints("not json")).toEqual([]);
		expect(editAnchorHints(JSON.stringify({ file_path: "/w/a.ts" }))).toEqual([]);
		expect(editAnchorHints(JSON.stringify({ edits: [{ anchor_start: "  " }, "junk"] }))).toEqual([]);
	});
});

describe("toolRowModel", () => {
	it("derives the summary, file path, and state from the call args", () => {
		const model = toolRowModel(
			"edit",
			running(JSON.stringify({ path: "/w/src/a.ts", edits: [] }), "edit"),
			"/w",
			"/Users/mutou",
		);
		expect(model.summary).toBe("src/a.ts");
		expect(model.filePath).toBe("/w/src/a.ts"); // real path — it feeds onOpenFile
		expect(model.state).toBe("running");
		expect(model.titleKey).toBe("tool.title.edit");
	});

	it("marks interrupted results stopped and failures errored", () => {
		const interrupted = settled({
			call: { name: "edit", argsRaw: "{}" },
			error: { name: "AbortError", code: "interrupted" },
		});
		expect(toolRowModel("edit", interrupted, undefined, undefined).state).toBe("stopped");
		const failed = settled({
			call: { name: "edit", argsRaw: "{}" },
			isError: true,
			content: [{ type: "text", text: "[E_STALE] 2 stale anchors" }],
		});
		const model = toolRowModel("edit", failed, undefined, undefined);
		expect(model.state).toBe("error");
		expect(model.errorSummary).toBe("[E_STALE] 2 stale anchors");
	});

	it("issue #81: edit with no top-level path shows per-item path in summary (single file)", () => {
		const argsRaw = JSON.stringify({
			edits: [{ op: "replace", path: "/w/src/a.ts", anchor_start: "2:b2", lines: ["x"] }],
		});
		const model = toolRowModel("edit", running(argsRaw, "edit"), "/w", undefined);
		expect(model.summary).toBe("src/a.ts");
		expect(model.filePath).toBe("/w/src/a.ts");
	});

	it("issue #81: edit with no top-level path shows all unique paths (multi file)", () => {
		const argsRaw = JSON.stringify({
			edits: [
				{ op: "replace", path: "/w/src/a.ts", anchor_start: "2:b2", lines: ["x"] },
				{ op: "replace", path: "/w/src/b.ts", anchor_start: "5:c3", lines: ["y"] },
			],
		});
		const model = toolRowModel("edit", running(argsRaw, "edit"), "/w", undefined);
		expect(model.summary).toBe("src/a.ts, src/b.ts");
		expect(model.filePath).toBeUndefined();
	});

	it("issue #81: edit with no top-level path deduplicates identical per-item paths", () => {
		const argsRaw = JSON.stringify({
			edits: [
				{ op: "replace", path: "/w/src/a.ts", anchor_start: "2:b2", lines: ["x"] },
				{ op: "ins", path: "/w/src/a.ts", anchor_start: "5:c3", lines: ["y"] },
			],
		});
		const model = toolRowModel("edit", running(argsRaw, "edit"), "/w", undefined);
		expect(model.summary).toBe("src/a.ts");
		expect(model.filePath).toBe("/w/src/a.ts");
	});

	it("issue #81: edit with no top-level path and no per-item paths falls back to raw", () => {
		const argsRaw = JSON.stringify({ edits: [{ op: "replace", anchor_start: "2:b2", lines: ["x"] }] });
		const model = toolRowModel("edit", running(argsRaw, "edit"), undefined, undefined);
		// No path anywhere — unchanged fallback: summary is the raw JSON (pre-existing behavior)
		expect(model.summary).toBe(argsRaw);
		expect(model.filePath).toBeUndefined();
	});
});

describe("metaDiffRows (rendering channel, issue #71)", () => {
	const meta = {
		diffs: [{ path: "/w/a.ts", oldText: "b", newText: "B" }],
		diffRows: [
			{ kind: " ", lineNumber: 1, hash: "a1", text: "a" },
			{ kind: "-", lineNumber: 2, hash: "old", text: "b" },
			{ kind: "+", lineNumber: 2, hash: "n9", text: "B" },
		],
	};
	const block = settled({
		call: { name: "edit", argsRaw: JSON.stringify({ path: "/w/a.ts", edits: [{ anchor_start: "2:old" }] }) },
		content: [{ type: "text", text: "ok" }],
		meta,
	});

	it("exposes structured rows on the card for the `行号:锚点` gutter", () => {
		const card = diffCardModel(block);
		expect(card?.rows?.map((row) => `${row.lineNumber}:${row.hash}`)).toEqual(["1:a1", "2:old", "2:n9"]);
		expect(card?.diffs).toHaveLength(1);
	});

	it("falls back to the official plain block when diffRows are malformed", () => {
		const broken = settled({
			call: { name: "edit", argsRaw: "{}" },
			content: [{ type: "text", text: "ok" }],
			meta: { diffs: [{ path: "p", oldText: null, newText: "x" }], diffRows: [{ kind: "x" }] },
		});
		const card = diffCardModel(broken);
		expect(card?.rows).toBeUndefined();
		expect(card?.diffs).toHaveLength(1);
	});

	it("rejects non-object meta", () => {
		expect(metaDiffRows("nope")).toBeNull();
		expect(metaDiffRows({ diffRows: "rows" })).toBeNull();
		expect(metaDiffRows({ diffRows: [] })).toBeNull();
	});
});

describe("metaDiffRowGroups (issue #82: multi-file tab rendering)", () => {
	it("validates well-formed per-file groups", () => {
		const groups = metaDiffRowGroups({
			diffRowGroups: [
				{ path: "a.txt", rows: [{ kind: "+", lineNumber: 1, hash: "a1", text: "new" }] },
				{ path: "b.txt", rows: [{ kind: "-", lineNumber: 2, hash: "b2", text: "old" }] },
			],
		});
		expect(groups).not.toBeNull();
		expect(groups).toHaveLength(2);
		expect(groups![0]!.path).toBe("a.txt");
		expect(groups![0]!.rows).toHaveLength(1);
		expect(groups![1]!.path).toBe("b.txt");
		expect(groups![1]!.rows).toHaveLength(1);
	});

	it("returns null for missing or empty groups", () => {
		expect(metaDiffRowGroups("nope")).toBeNull();
		expect(metaDiffRowGroups({ diffRowGroups: "x" })).toBeNull();
		expect(metaDiffRowGroups({ diffRowGroups: [] })).toBeNull();
	});

	it("returns null when a group has malformed rows", () => {
		expect(metaDiffRowGroups({
			diffRowGroups: [{ path: "a.txt", rows: [{ kind: "x" }] }],
		})).toBeNull();
	});

	it("diffCardModel exposes rowGroups for multi-file edit", () => {
		const block = settled({
			call: { name: "edit", argsRaw: JSON.stringify({ edits: [{ path: "a.txt" }, { path: "b.txt" }] }) },
			content: [{ type: "text", text: "ok" }],
			meta: {
				diffs: [
					{ path: "a.txt", oldText: "old", newText: "new" },
					{ path: "b.txt", oldText: null, newText: "created" },
				],
				diffRowGroups: [
					{ path: "a.txt", rows: [{ kind: "+", lineNumber: 1, hash: "a1", text: "new" }] },
					{ path: "b.txt", rows: [{ kind: "+", lineNumber: 1, hash: "b1", text: "created" }] },
				],
			},
		});
		const card = diffCardModel(block);
		expect(card).not.toBeNull();
		expect(card?.rowGroups).toHaveLength(2);
		expect(card?.rowGroups?.[0]?.path).toBe("a.txt");
		expect(card?.rowGroups?.[1]?.path).toBe("b.txt");
	});
});
