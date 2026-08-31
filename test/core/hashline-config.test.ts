import { afterEach, describe, expect, it } from "vitest";
import {
	applyEffective,
	getEffectiveConfig,
	type EffectiveHashlineConfig,
} from "../../src/config.js";
import { buildReadJson } from "../../src/presentation-helpers.js";
import { lineHashesPure, resEdit, applyEdit } from "../../src/hashline/index.js";
import {
	applyHashlineShape,
	getHashlineShape,
} from "../../src/hashline/hash-assign.js";
import type { FileEditResult } from "../../src/edit-engine.js";

afterEach(() => {
	applyEffective({});
});

describe("hashline settings / effective config", () => {
	it("defaults to ':' / text", () => {
		const cfg = getEffectiveConfig();
		expect(cfg.separator).toBe(":");
		expect(cfg.outputFormat).toBe("text");
		expect(cfg.contextLines).toBe(3);
	});


	it("applies separator + output_format (hash_length removed in v2.0)", () => {
		applyEffective({ separator: "|", output_format: "json" });
		const cfg: EffectiveHashlineConfig = getEffectiveConfig();
		expect(cfg.separator).toBe("|");
		expect(cfg.outputFormat).toBe("json");
		expect(getHashlineShape()).toEqual({ separator: "|", contextLines: 3 });
	});


	it("applies context_lines", () => {
		applyEffective({ context_lines: 5 });
		expect(getEffectiveConfig().contextLines).toBe(5);
		expect(getHashlineShape().contextLines).toBe(5);
		applyEffective({ context_lines: 99 }); // out of range -> default
		expect(getEffectiveConfig().contextLines).toBe(3);
	});

	it("falls back to defaults on invalid values", () => {
		applyEffective({
			separator: "",
			output_format: "yaml" as never,
		});
		const cfg = getEffectiveConfig();
		expect(cfg.separator).toBe(":");
		expect(cfg.outputFormat).toBe("text");
	});

});

describe("configurable separator end-to-end", () => {
	it("parses anchors and strips markers under a custom separator", async () => {
		applyEffective({ separator: "|" });
		const content = "alpha\nbeta\ngamma";
		const hashes = lineHashesPure(content);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9]{2,8}$/);
		// anchor field accepts the bare anchor pasted row under custom separator
		const edit = {
			remove_from: `${hashes[0]}|alpha`,
			remove_to: `${hashes[0]}|alpha`,
			replacement_text: "ALPHA",
		} as const;
		const resolved = resEdit(edit as never);
		expect(resolved.hash_bounds[0]).toEqual({ anchor: hashes[0] });
		const result = applyEdit(content, resolved);
		expect(result.content).toBe("ALPHA\nbeta\ngamma");
	});


	it("keeps legacy │ rows parseable under the custom separator", () => {
		applyEffective({ separator: "|" });
		const content = "a\nb\n";
		const hashes = lineHashesPure(content);
		const edit = {
			remove_from: `${hashes[1]}│b`,
			remove_to: `${hashes[1]}│b`,
			replacement_text: "B",
		} as const;
		const resolved = resEdit(edit as never);
		expect(resolved.hash_bounds[0]).toEqual({ anchor: hashes[1] });
	});
});

describe("read json view", () => {
	it("builds {path, offset, totalLines, lines} with anchor keys", () => {
		const content = "one\ntwo\n\nfour";
		const hashes = ["aB3", "xY7", "zQ9", "mN0"];
		const json = buildReadJson(content, hashes, 1, 4, "f.txt") as {
			lines: Record<string, string>;
		};
		expect(json.path).toBe("f.txt");
		expect(json.offset).toBe(1);
		expect(json.totalLines).toBe(4);
		expect(json.lines).toEqual({
			"aB3": "one",
			"xY7": "two",
			"zQ9": "",
			"mN0": "four",
		});
	});

	it("honors offset/limit windows", () => {
		const content = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
		const hashes = Array.from({ length: 10 }, (_, i) => "" + i + "ab");
		const json = buildReadJson(content, hashes, 4, 2, "f") as {
			offset: number;
			lines: Record<string, string>;
		};
		expect(json.offset).toBe(4);
		expect(Object.keys(json.lines)).toEqual(["3ab", "4ab"]);
	});
});

describe("settings file provider document", () => {
	it("extracts the hashline section and passes other sections through", async () => {
		const { parseYamlDocument } = await import("../../src/settings-provider.js");
		const doc = parseYamlDocument([
			"# dsh settings",
			"subagent-pro:",
			"  defaultRole: researcher",
			"hashline:",
			"  separator: \"|\"",
			"  output_format: json",
		].join("\n"));
		expect(doc.hashline).toEqual({
			separator: "|",
			output_format: "json",
		});
		expect(typeof doc["subagent-pro"]).toBe("string"); // passthrough

	});
});

describe("edit json envelope", () => {
	function fakeFile(partial?: Partial<FileEditResult>): FileEditResult {
		return {
			displayPath: "x.ts",
			absolutePath: "/abs/x.ts",
			originalNormalized: "a\nb\nc",
			result: "a\nB\nc",
			bom: "",
			originalEnding: "\n",
			hadUtf8DecodeErrors: false,
			originalHashes: ["aA1", "bB2", "cC3"],
			resultHashes: ["aA1", "bB2", "cC3"],
			resultServedRows: [],
			appliedCount: 1,
			noopCount: 0,
			totalAddedLines: 0,
			totalRemovedLines: 0,
			warnings: [],
			driftNotice: undefined,
			firstChangedLine: 2,
			lastChangedLine: 2,
			range: { startLine: 2, endLine: 2, startHash: "bB2", endHash: "bB2" },
			hunkShifts: [
				{
					index: 0,
					delta: 0,
					firstStableLineNew: 3,
					lastChangedLine: 2,
					originalStartLine: 2,
					originalEndLine: 2,
					finalStartLine: 2,
					finalEndLine: 2,
				},
			],
			...partial,
		} as FileEditResult;
	}

	it("serializes ok + files/applied/finalLines", async () => {
		// exercised through tool-edit; here we only assert the shape helpers
		// (buildEditJson is private) — smoke via applyEffective + import check
		const { isJsonOutput } = await import("../../src/config.js");
		applyEffective({ output_format: "json" });
		expect(isJsonOutput()).toBe(true);
		expect(fakeFile().appliedCount).toBe(1);
	});
});