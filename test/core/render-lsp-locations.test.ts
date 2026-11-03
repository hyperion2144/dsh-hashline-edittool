/**
 * The pure half of a navigation answer: URIs to display paths, protocol
 * positions to one-based ones, and the bounds that keep the answer honest.
 *
 * Everything here is a pure function, so the cases are the contract rather
 * than a simulation: what a `file:` URI means inside and outside the
 * workspace, which of the two "where" shapes a server sends, and what happens
 * to a location whose range is missing.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	boundText,
	DEFAULT_MAX_LOCATIONS,
	DEFAULT_MAX_RESULT_CHARS,
	groupLocations,
	hoverContents,
	normalizeLocationList,
	renderUri,
	resolveLocations,
	sameDocumentUri,
} from "../../src/render/lsp-locations.js";

// Built from the platform's temp dir, never a POSIX literal: on Windows a
// root under `/tmp` resolves to the current drive, and every expectation
// below would then be comparing against a path that cannot exist.
const ROOT = join(tmpdir(), "lsp-locations-root");
const ROOT_URI = pathToFileURL(ROOT).href;

describe("renderUri", () => {
	it("renders a file inside the workspace relative to it", () => {
		const uri = pathToFileURL(join(ROOT, "src", "a.ts")).href;
		expect(renderUri(uri, ROOT_URI)).toBe("src/a.ts");
	});

	it("renders the workspace root itself as `.`", () => {
		expect(renderUri(ROOT_URI, ROOT_URI)).toBe(".");
	});

	it("renders a file outside the workspace as an absolute path", () => {
		const outside = join(tmpdir(), "elsewhere", "b.ts");
		// `renderUri` prints a Windows location with forward slashes; the POSIX
		// world is identity. Both are "the path as the reader's platform writes it".
		expect(renderUri(pathToFileURL(outside).href, ROOT_URI)).toBe(outside.replaceAll("\\", "/"));
	});

	it("leaves a non-file URI verbatim", () => {
		expect(renderUri("https://example.test/a.ts", ROOT_URI)).toBe("https://example.test/a.ts");
	});

	it("leaves a malformed URI verbatim rather than inventing a path", () => {
		expect(renderUri("file://%", ROOT_URI)).toBe("file://%");
	});
});

describe("normalizeLocationList", () => {
	it("reads a `Location` and a `LocationLink` in one answer", () => {
		const location = { uri: "file:///a.ts", range: { start: { line: 1, character: 2 } } };
		const link = { targetUri: "file:///b.ts", targetSelectionRange: { start: { line: 3, character: 4 } } };
		expect(normalizeLocationList([location, link])).toEqual([
			{ uri: "file:///a.ts", range: location.range },
			{ uri: "file:///b.ts", range: link.targetSelectionRange },
		]);
	});

	it("accepts a single location that is not wrapped in an array", () => {
		const location = { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } } };
		expect(normalizeLocationList(location)).toHaveLength(1);
	});

	it("answers an empty list for null and for garbage", () => {
		expect(normalizeLocationList(null)).toEqual([]);
		expect(normalizeLocationList([null, 3, { uri: 7 }])).toEqual([]);
	});
});

describe("resolveLocations", () => {
	it("turns zero-based protocol positions into one-based ones", () => {
		const resolved = resolveLocations(
			[{ uri: pathToFileURL(join(ROOT, "a.ts")).href, range: { start: { line: 0, character: 0 } } }],
			ROOT_URI,
		);
		expect(resolved).toEqual([
			{
				uri: pathToFileURL(join(ROOT, "a.ts")).href,
				displayPath: "a.ts",
				absolutePath: join(ROOT, "a.ts"),
				line: 1,
				character: 1,
			},
		]);
	});

	it("DROPS a location whose range has no start, rather than pointing at line 1", () => {
		const resolved = resolveLocations(
			[
				{ uri: "file:///a.ts", range: null },
				{ uri: "file:///b.ts", range: { start: { line: 2 } } },
			],
			ROOT_URI,
		);
		expect(resolved.map((location) => location.line)).toEqual([3]);
	});

	it("keeps a non-file URI but reports no local path for it", () => {
		const resolved = resolveLocations([{ uri: "https://example.test/x", range: { start: { line: 0, character: 0 } } }], ROOT_URI);
		expect(resolved[0]?.absolutePath).toBeUndefined();
		expect(resolved[0]?.displayPath).toBe("https://example.test/x");
	});
});

describe("groupLocations", () => {
	it("groups by display path, preserving first-seen order", () => {
		const groups = groupLocations([
			{ uri: "file:///a.ts", displayPath: "a.ts", line: 1, character: 1 },
			{ uri: "file:///b.ts", displayPath: "b.ts", line: 2, character: 3 },
			{ uri: "file:///a.ts", displayPath: "a.ts", line: 9, character: 1 },
		]);
		expect(groups.map((group) => [group.displayPath, group.entries.length])).toEqual([
			["a.ts", 2],
			["b.ts", 1],
		]);
	});
});

describe("hoverContents", () => {
	it("reduces a plain string, a MarkupContent and a MarkedString[] to text", () => {
		expect(hoverContents("docs")).toBe("docs");
		expect(hoverContents({ contents: { kind: "markdown", value: "**docs**" } })).toBe("**docs**");
		expect(hoverContents({ contents: ["first", { language: "ts", value: "second" }] })).toBe("first\n\nsecond");
	});

	it("answers null for no hover, for an empty one, and for a shape it cannot read", () => {
		expect(hoverContents(null)).toBeNull();
		expect(hoverContents({ contents: "" })).toBeNull();
		expect(hoverContents({ contents: 42 })).toBeNull();
	});
});

describe("boundText", () => {
	it("leaves a text under the budget untouched", () => {
		expect(boundText("short", 100, "hover")).toBe("short");
	});

	it("cuts an over-budget text and keeps the notice inside the budget", () => {
		const bounded = boundText("x".repeat(500), 100, "hover");
		expect(bounded.length).toBe(100);
		expect(bounded).toContain("hover truncated");
	});
});

describe("the caps", () => {
	it("default to the seam's own budget", () => {
		expect(DEFAULT_MAX_LOCATIONS).toBe(100);
		expect(DEFAULT_MAX_RESULT_CHARS).toBe(16_000);
	});
});

describe("sameDocumentUri", () => {
	it("folds the drive letter's case in the Windows world", () => {
		// The bug the #397 review found: a server spells the URI with an
		// encoded colon and a lower-case drive letter, the host spells it with
		// a plain colon and an upper-case drive letter. Both name the SAME file —
		// a Windows path is case-insensitive — and a string compare said no,
		// which silently disabled the cold-index retry on every Windows host.
		expect(sameDocumentUri("file:///d%3A/vault/projects/x.ts", "file:///D:/vault/projects/x.ts")).toBe(true);
		expect(sameDocumentUri("file:///D:/vault/projects/x.ts", "file:///d%3A/vault/projects/x.ts")).toBe(true);
		// The round trip does NOT fix it: Node preserves the original case.
		expect(sameDocumentUri("file:///d%3A/vault/projects/x.ts", "file:///d%3A/vault/projects/x.ts")).toBe(true);
	});

	it("keeps the case exact OUTSIDE the Windows world", () => {
		// On a case-sensitive filesystem `a.ts` and `A.ts` are two files;
		// folding them into one would merge two answers into one row.
		expect(sameDocumentUri("file:///home/x/a.ts", "file:///home/x/A.ts")).toBe(false);
		expect(sameDocumentUri("file:///home/x/a.ts", "file:///home/x/a.ts")).toBe(true);
	});

	it("says no for two different files, and for a URI that names none", () => {
		expect(sameDocumentUri("file:///D:/vault/a.ts", "file:///D:/vault/b.ts")).toBe(false);
		expect(sameDocumentUri("file:///D:/vault/a.ts", "untitled:Untitled-1")).toBe(false);
		expect(sameDocumentUri("untitled:Untitled-1", "untitled:Untitled-1")).toBe(true);
	});
});
