/**
 * text-input parser core tests — external behavior of the shared lexical
 * grammar and the four per-tool bindings. Each "parses to the same payload
 * the JSON channel would accept" assertion is the parity contract of spec
 * #85; the E_PARSE_* error assertions cover strictness + self-correction
 * echoes (line number, expectation, actual).
 *
 * @module test/core/text-input-parser.test
 */

import { describe, expect, it } from "vitest";
import { DslParseError } from "../../src/text-input/core.js";
import {
	parseEditText,
	parseGrepText,
	parseReadText,
	parseWriteText,
} from "../../src/text-input/parse.js";

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof DslParseError) return err.code;
		throw err;
	}
	throw new Error("expected a DslParseError");
}

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof DslParseError) return err.message;
		throw err;
	}
	throw new Error("expected a DslParseError");
}

describe("read text DSL", () => {
	it("parses a bare file path payload", () => {
		expect(parseReadText("src/index.ts")).toEqual({ file_path: "src/index.ts" });
	});

	it("parses option rows after the path", () => {
		expect(parseReadText("src/index.ts\noffset: 5\nlimit: 40\nline_numbers: true")).toEqual({
			file_path: "src/index.ts",
			offset: 5,
			limit: 40,
			line_numbers: true,
		});
	});

	it("ignores # comment rows and blank rows", () => {
		expect(
			parseReadText("# the file\nguide.md\n\n# page down\noffset: 20\n# cap\nlimit: 5"),
		).toEqual({ file_path: "guide.md", offset: 20, limit: 5 });
	});

	it("rejects an empty payload with E_PARSE_EMPTY", () => {
		expect(codeOf(() => parseReadText(""))).toBe("E_PARSE_EMPTY");
	});

	it("rejects an unknown option with E_PARSE_UNKNOWN_OPTION and the offending line", () => {
		const msg = messageOf(() => parseReadText("src/index.ts\nlines: 5"));
		expect(msg).toContain("[E_PARSE_UNKNOWN_OPTION]");
		expect(msg).toContain('Unknown option "lines"');
	});

	it("rejects trailing content with E_PARSE_TRAILING", () => {
		expect(codeOf(() => parseReadText("src/index.ts\njunk row"))).toBe("E_PARSE_TRAILING");
	});

	it("rejects a non-numeric option value with E_PARSE_OPTION_VALUE", () => {
		const msg = messageOf(() => parseReadText("src/index.ts\noffset: many"));
		expect(msg).toContain('[E_PARSE_OPTION_VALUE] Option "offset" expects a number');
	});
});

describe("grep text DSL", () => {
	it("parses pattern as the primary payload", () => {
		expect(parseGrepText("foobar")).toEqual({ pattern: "foobar" });
	});

	it("parses full option set", () => {
		expect(
			parseGrepText('anchor\\w+\npath: src/\ninclude: "*.ts"\nregex: false\ncontext: 2\nlimit: 50\nline_numbers: false'),
		).toEqual({
			pattern: "anchor\\w+",
			path: "src/",
			include: '"*.ts"',
			regex: false,
			context: 2,
			limit: 50,
			line_numbers: false,
		});
	});

	it("treats a bare regex flag as true", () => {
		expect(parseGrepText("foo\nregex:")).toEqual({ pattern: "foo", regex: true });
	});

	it("rejects a path that is not a grep option row after the pattern", () => {
		expect(codeOf(() => parseGrepText("foo\nno_such_option: 1"))).toBe(
			"E_PARSE_UNKNOWN_OPTION",
		);
	});
});

describe("write text DSL", () => {
	it("parses a heredoc file body exactly", () => {
		expect(parseWriteText("out/hello.txt\n<<<END\nline 1\nline 2\n<<<END")).toEqual({
			file_path: "out/hello.txt",
			content: "line 1\nline 2",
		});
	});

	it("keeps spaces, blank lines, quotes and colons inside the heredoc untouched", () => {
		const body = "  indented\n\n{\"a\": 1, 'b': 2}\n# not a comment\n<<<END"; // inner <<<END not literal — see below
		void body;
		const payload =
			"out/a.json\n<<<END\n  indented\n\n{\"a\": 1, 'b': 2}\n# not a comment\n<<<END";
		expect(parseWriteText(payload)).toEqual({
			file_path: "out/a.json",
			content: '  indented\n\n{"a": 1, \'b\': 2}\n# not a comment',
		});
	});

	it("parses sandbox option rows before the heredoc", () => {
		expect(
			parseWriteText("src/x.ts\nsandbox_permissions: workspace-write\njustification: build it\n<<<END\ncode\n<<<END"),
		).toEqual({
			file_path: "src/x.ts",
			sandbox_permissions: "workspace-write",
			justification: "build it",
			content: "code",
		});
	});

	it("accepts an empty heredoc as empty content", () => {
		expect(parseWriteText("empty.txt\n<<<END\n<<<END")).toEqual({
			file_path: "empty.txt",
			content: "",
		});
	});

	it("rejects a missing heredoc with E_PARSE_HEREDOC_EXPECTED", () => {
		const msg = messageOf(() => parseWriteText("out/a.txt\ncontent without heredoc"));
		expect(msg).toContain("[E_PARSE_HEREDOC_EXPECTED]");
		expect(msg).toContain("<<<END");
	});

	it("rejects an unterminated heredoc with E_PARSE_HEREDOC_UNTERMINATED", () => {
		expect(codeOf(() => parseWriteText("out/a.txt\n<<<END\nnever closed"))).toBe(
			"E_PARSE_HEREDOC_UNTERMINATED",
		);
	});
});

const A1 = "AbCdEf";
const A2 = "xY9zWq";
const A3 = "q1w2e3";

describe("edit text DSL — default (require_line_content OFF)", () => {
	it("parses a single-file delete", () => {
		expect(parseEditText(`src/a.ts\ndel ${A1}`, { requireLineContent: false })).toEqual({
			path: "src/a.ts",
			edits: [{ op: "del", anchor_start: A1 }],
		});
	});

	it("parses a replace with a heredoc of multiple lines", () => {
		expect(
			parseEditText(
				`src/a.ts\nreplace ${A1} ${A2}\n<<<END\nline one\nline two\n<<<END`,
				{ requireLineContent: false },
			),
		).toEqual({
			path: "src/a.ts",
			edits: [
				{ op: "replace", anchor_start: A1, anchor_end: A2, lines: ["line one", "line two"] },
			],
		});
	});

	it("parses a bare-anchor item when the file has no default header and @@ sections", () => {
		expect(
			parseEditText(`@@ path/a.ts\ndel ${A1}\n@@ path/b.ts\ndel ${A2}`, {
				requireLineContent: false,
			}),
		).toEqual({
			edits: [
				{ op: "del", anchor_start: A1, path: "path/a.ts" },
				{ op: "del", anchor_start: A2, path: "path/b.ts" },
			],
		});
	});

	it("accepts line_numbers as an option before the file", () => {
		expect(
			parseEditText(`line_numbers: false\nsrc/a.ts\ndel ${A1}`, {
				requireLineContent: false,
			}),
		).toEqual({ path: "src/a.ts", line_numbers: false, edits: [{ op: "del", anchor_start: A1 }] });
	});

	it("parses an item with an anchor_end + heredoc", () => {
		expect(
			parseEditText(`src/a.ts\ndel ${A1} ${A2}`, { requireLineContent: false }),
		).toEqual({
			path: "src/a.ts",
			edits: [{ op: "del", anchor_start: A1, anchor_end: A2 }],
		});
	});

	it("rejects a missing anchor with E_PARSE_MISSING_ANCHOR", () => {
		expect(codeOf(() => parseEditText("src/a.ts\ndel", { requireLineContent: false }))).toBe(
			"E_PARSE_MISSING_ANCHOR",
		);
	});

	it("rejects a bad op with E_PARSE_BAD_OP and echoes the line", () => {
		const msg = messageOf(() => parseEditText(`src/a.ts\nfrob ${A1}`, { requireLineContent: false }));
		expect(msg).toContain("[E_PARSE_BAD_OP]");
		expect(msg).toContain('[E_PARSE_BAD_OP]');
	});

	it("rejects an item with no file context with E_PARSE_NO_FILE", () => {
		expect(codeOf(() => parseEditText(`del ${A1}`, { requireLineContent: false }))).toBe(
			"E_PARSE_NO_FILE",
		);
	});

	it("rejects an empty edit payload with E_PARSE_EMPTY", () => {
		expect(codeOf(() => parseEditText("src/a.ts", { requireLineContent: false }))).toBe(
			"E_PARSE_EMPTY",
		);
	});
});

describe("edit text DSL — require_line_content ON", () => {
	const decl1 = `12:${A1}: const x = 1`;
	const decl2 = `34:${A2}: const y = 2`;

	it("parses a replace whose anchors are verbatim read rows on their own lines", () => {
		expect(
			parseEditText(`src/a.ts\nreplace\n${decl1}\n${decl2}\n<<<END\nconst z = 3\n<<<END`, {
				requireLineContent: true,
			}),
		).toEqual({
			path: "src/a.ts",
			edits: [
				{
					op: "replace",
					anchor_start: { anchor: `12:${A1}`, line: "const x = 1" },
					anchor_end: { anchor: `34:${A2}`, line: "const y = 2" },
					lines: ["const z = 3"],
				},
			],
		});
	});

	it("parses a del with one declared anchor", () => {
		expect(parseEditText(`src/a.ts\ndel\n${decl1}`, { requireLineContent: true })).toEqual({
			path: "src/a.ts",
			edits: [{ op: "del", anchor_start: { anchor: `12:${A1}`, line: "const x = 1" } }],
		});
	});

	it("parses a declaration whose content contains spaces and colons", () => {
		const row = `7:${A3}: const s = fn({ a: 1 });`;
		expect(parseEditText(`src/a.ts\ndel\n${row}`, { requireLineContent: true })).toEqual({
			path: "src/a.ts",
			edits: [{ op: "del", anchor_start: { anchor: `7:${A3}`, line: "const s = fn({ a: 1 });" } }],
		});
	});

	it("rejects an inline anchor in ON mode (declaration required)", () => {
		const msg = messageOf(() =>
			parseEditText(`src/a.ts\ndel ${A1}`, { requireLineContent: true }),
		);
		expect(msg).toContain("[E_PARSE_BAD_OP]");
	});

	it("rejects a bad declaration row with E_PARSE_MISSING_ANCHOR", () => {
		expect(
			codeOf(() => parseEditText(`src/a.ts\nreplace\nnot a read row\n<<<END\nx\n<<<END`, {
				requireLineContent: true,
			})),
		).toBe("E_PARSE_MISSING_ANCHOR");
	});

	it("honors a custom separator in declaration rows (issue #83 parity)", () => {
		expect(
			parseEditText(`src/a.ts\nreplace\n12|${A1}| const x = 1\n<<<END\ny\n<<<END`, {
				requireLineContent: true,
				separator: "|",
			}),
		).toEqual({
			path: "src/a.ts",
			edits: [
				{
					op: "replace",
					anchor_start: { anchor: `12:${A1}`, line: "const x = 1" },
					lines: ["y"],
				},
			],
		});
	});
});
