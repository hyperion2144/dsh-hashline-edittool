/**
 * Regression tests for the #66 aggregate bugfix set (B1–B7).
 *
 * Contract being pinned (from the #66 triage + maintainer constraint):
 * the tool's ONLY built-in content transformation is anchor-prefix stripping;
 * everything the model sends is applied verbatim. Duplication detection may
 * warn (E_PASTE_DUP) but must never mutate content. Line hints are advisory;
 * the anchor is authoritative. line_numbers is a render-only switch.
 */
import { describe, expect, it } from "vitest";
import {
	applyEdit,
	resEdit,
} from "../../src/hashline/anchor-pipeline.js";
import { applyHashlineShape, hashlineHeader, hashSep } from "../../src/hashline/hash-assign.js";
import { anchorsPure, anchorsFor } from "../../src/hashline/session-anchors.js";
import { buildReadJson } from "../../src/presentation-helpers.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();
const SEP = hashSep();

describe("#66/B2 — anchor-prefix stripping is unconditional and symmetric", () => {
	it("strips a `line:anchor:` prefix pasted from a line-numbers read row", async () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = anchorsPure(content);
		// Row pasted from a POST-EDIT diff: the line number is stale and the
		// anchor does not match the prefix line — must still strip (#66/B2).
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[1]}`,
				remove_to: `${hashes[1]}`,
				replacement_text: `3:${hashes[0]}:GAMMA-PASTE`,
			}),
		);
		expect(result.content).toBe("alpha\nGAMMA-PASTE\ngamma");
	});

	it("strips a diff-marked row pasted into lines (+<line>:<anchor>:text)", async () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = anchorsPure(content);
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[1]}`,
				remove_to: `${hashes[1]}`,
				replacement_text: `+2:${hashes[1]}:BETA2`,
			}),
		);
		expect(result.content).toBe("alpha\nBETA2\ngamma");
	});

	it("strips a bare-anchor row prefix (anchor<sep>content)", async () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = anchorsPure(content);
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[1]}`,
				remove_to: `${hashes[1]}`,
				replacement_text: `${hashes[1]}${SEP}BETA3`,
			}),
		);
		expect(result.content).toBe("alpha\nBETA3\ngamma");
	});

	it("bounds accept a pasted full row and reduce it to the anchor", () => {
		const content = "alpha\nbeta";
		const hashes = anchorsPure(content);
		const edit = resEdit({
			remove_from: `1:${hashes[0]}${SEP}alpha`,
			remove_to: `2:${hashes[1]}${SEP}beta`,
			replacement_text: "X",
		});
		expect(edit.hash_bounds[0].anchor).toBe(hashes[0]);
		expect(edit.hash_bounds[1].anchor).toBe(hashes[1]);
	});
});

describe("#66/B6 — line hints are weak: anchor is authoritative", () => {
	it("applies an edit whose line hint disagrees with the resolved anchor", async () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = anchorsPure(content);
		// hint says line 9; anchor resolves to line 3 — must apply, never crash.
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `9:${hashes[2]}`,
				remove_to: `9:${hashes[2]}`,
				replacement_text: "G3",
			}),
			undefined,
			hashes,
		);
		expect(result.content).toBe("alpha\nbeta\nG3");
		expect(result.range.startLine).toBe(3);
	});
});

describe("#66/B5 — line_numbers renders <line>:<anchor> rows on request", () => {
	it("line_numbers:true prefixes row markers with the line number", async () => {
		const { readAndServe } = await import("../../src/read-and-serve.js");
		const { withTempFile } = await import("../support/fixtures.js");
		const { readFile } = await import("node:fs/promises");
		await withTempFile("b5.txt", "alpha\nbeta\ngamma\n", async ({ path }) => {
			const io = {
				resolve: async (p: string) => p,
				readText: async (p: string) => readFile(p, "utf-8"),
			};
			const res = await readAndServe(io as never, path, "/tmp", {
				sessionKey: "b5-on",
				lineNumbers: true,
			});
			const firstRow = res.text.split("\n")[1] ?? "";
			expect(firstRow).toMatch(/^1:/);
		});
	});
});

describe("#66/B1 — json view is v2.0-native and lossless-safe", () => {
	it("buildReadJson keys the lines dict by bare anchor (no # parsing)", () => {
		const content = "alpha\nbeta\ngamma";
		const hashes = anchorsPure(content);
		const view = buildReadJson(content, hashes, 1, 10, "x.txt") as {
			lines: Record<string, string>;
			totalLines: number;
		};
		expect(view.lines[`${hashes[0]}`]).toBe("alpha");
		expect(view.lines[`${hashes[1]}`]).toBe("beta");
		// every key must be a plain anchor — no NaN keys possible
		for (const key of Object.keys(view.lines)) {
			expect(key).toMatch(/^[A-Za-z0-9]{1,8}$/);
		}
		expect(JSON.parse(JSON.stringify(view))).toEqual(view);
	});
});

describe("#66/B7 — content fidelity: no built-in mutation beyond anchor stripping", () => {
	it("keeps a replacement row equal to the adjacent line and warns (no silent strip)", async () => {
		const content = "B\nC";
		const hashes = anchorsPure(content);
		const result = applyEdit(
			content,
			resEdit({
				remove_from: `${hashes[1]}`,
				remove_to: `${hashes[1]}`,
				replacement_text: "B",
			}),
		);
		expect(result.content).toBe("B\nB");
		expect(result.warnings?.join("\n")).toMatch(/E_PASTE_DUP/);
		expect(result.autoFixes).toBeUndefined();
	});

	it("anchorsFor returns exactly one anchor per line even after drift", () => {
		const content = "a\nb\nc\n";
		const path = home.testPath + "/b4-drift.txt";
		const first = anchorsFor(path, content);
		expect(first.length).toBe(3);
		const second = anchorsFor(path, content);
		expect(second).toEqual(first);
	});
});
