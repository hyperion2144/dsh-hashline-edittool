/**
 * The `lsp` tool's NAVIGATION operations, driven against a fake server.
 *
 * Four properties are the contract here, and each one is a place a thin
 * wrapper would quietly get it wrong:
 *
 * 1. a capability the server never advertised is a REFUSAL, not an empty
 *    answer — "unsupported" and "nothing there" are different facts;
 * 2. a hit on another file is SERVED, so its row carries an anchor `edit`
 *    accepts (that is the whole reason this tool has its own navigation path);
 * 3. a hit whose file cannot be read keeps its row and loses only the anchor;
 * 4. the answer is bounded, and the notice that it was bounded is inside it.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildLspTool, looksLikeImportBinding, lspPresentationMeta } from "../../src/tools/tool-lsp.js";
import { grepPresentationFromMeta } from "../../src/render/grep-card.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

// The platform's own temp dir, not a POSIX literal: a hit's path is decoded
// from its `file:` URI, so on Windows it comes back with a drive letter and
// backslashes — a `/tmp/...` literal would never match it.
const CWD = join(tmpdir(), "lsp-navigation-probe");
const SOURCE = join(CWD, "a.ts");
const OTHER = join(CWD, "b.ts");
const MISSING = join(CWD, "gone.ts");

const SOURCE_URI = pathToFileURL(SOURCE).href;
const OTHER_URI = pathToFileURL(OTHER).href;

// Keyed by BASENAME: the queried file arrives as the caller spelled it, while a
// hit arrives decoded from its URI, and the two spellings differ by more than
// separators on Windows. Three files with distinct names is all the stub needs.
const CONTENT: Record<string, string> = {
	"a.ts": "const alpha = 1;\nconst beta = 2;\n",
	"b.ts": "import { alpha } from './a';\nconsole.log(alpha);\n",
};

/** What the fake server advertises by default: all four navigation queries. */
const FULL_CAPABILITIES = {
	definitionProvider: true,
	referencesProvider: true,
	implementationProvider: true,
	hoverProvider: true,
	textDocumentSync: { openClose: true },
};

interface Fake {
	readonly capabilities?: Record<string, unknown>;
	readonly answers?: Record<string, unknown>;
	/** Pretend the server is still indexing its project. */
	readonly projectLoading?: boolean;
	/** Answers handed out in order, one per request — for retry sequences. */
	readonly sequence?: Record<string, unknown[]>;
}

let requested: Array<{ method: string; params: unknown }> = [];
/** How many times a navigation call waited for the project index. */
let waitedForProjectLoad = 0;

function install(fake: Fake = {}) {
	requested = [];
	const session = {
		serverCapabilities: fake.capabilities ?? FULL_CAPABILITIES,
		projectLoading: fake.projectLoading === true,
		waitForProjectLoad: async () => {
			waitedForProjectLoad += 1;
			return "idle" as const;
		},
		request: async (method: string, params: unknown) => {
			requested.push({ method, params });
			const queued = fake.sequence?.[method];
			if (queued !== undefined && queued.length > 0) return queued.shift();
			return fake.answers?.[method];
		},
	};
	setLspManager({
		waitForSession: async () => session as never,
		unavailability: () => ({ message: "no server is installed for typescript" }),
		// `status` reads the slot table; an empty table is the "nothing started" case.
		snapshot: () => [],
		openDocumentFor: () => () => undefined,
	} as never);
}

const io = {
	resolve: async (p: string) => p,
	readText: async (p: string) => {
		const name = p.split(/[\\/]/u).pop() ?? "";
		const text = CONTENT[name];
		if (text === undefined) throw new Error(`no such file: ${p}`);
		return text;
	},
	emitObserved: async () => undefined,
} as never;

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: CWD } } } } as never;

function run(args: Record<string, unknown>) {
	return buildLspTool(io).execute({ path: SOURCE, line: 1, ...args }, exec) as Promise<
		Record<string, unknown> & { modelText: string }
	>;
}

afterEach(() => setLspManager(undefined));

describe("lsp navigation — capability is checked before anything is asked", () => {
	it("REFUSES an operation the server never advertised, and asks nothing", async () => {
		install({ capabilities: { hoverProvider: true }, answers: { "textDocument/implementation": [] } });
		const value = await run({ operation: "goToImplementation", symbol: "alpha" });
		expect(value.modelText).toContain("[E_LSP_UNSUPPORTED_OPERATION]");
		expect(requested, "an unadvertised method must not reach the server").toEqual([]);
		expect(schemaViolations(outputSchemaOf(buildLspTool(io)), value)).toEqual([]);
	});

	it("refuses a server that explicitly refuses `didOpen`", async () => {
		install({ capabilities: { ...FULL_CAPABILITIES, textDocumentSync: { openClose: false } } });
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		expect(value.modelText).toContain("[E_LSP_UNSUPPORTED_SYNC]");
		expect(requested).toEqual([]);
	});
});

describe("lsp navigation — the answer", () => {
	it("turns a location in ANOTHER file into a served, anchored row", async () => {
		install({
			answers: {
				"textDocument/definition": [{ uri: OTHER_URI, range: { start: { line: 1, character: 12 } } }],
			},
		});
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		expect(value.locations).toEqual([{ path: "b.ts", line: 2, character: 13 }]);
		const groups = value.groups as Array<{ path: string; rows: Array<{ number: number; hash: string; text: string }> }>;
		expect(groups).toHaveLength(1);
		expect(groups[0]?.path).toBe("b.ts");
		expect(groups[0]?.rows[0]?.number).toBe(2);
		expect(groups[0]?.rows[0]?.text).toBe("console.log(alpha);");
		// THE POINT of the port: the row is editable without a second read.
		expect(groups[0]?.rows[0]?.hash, "the hit's line must be anchored").not.toBe("");
		expect(value.modelText).toContain("b.ts");
		expect(value.modelText).toContain("console.log(alpha);");
		expect(schemaViolations(outputSchemaOf(buildLspTool(io)), value)).toEqual([]);
	});

	it("asks `findReferences` with declarations included", async () => {
		install({ answers: { "textDocument/references": [] } });
		await run({ operation: "findReferences", symbol: "alpha" });
		expect(requested).toHaveLength(1);
		expect(requested[0]?.method).toBe("textDocument/references");
		expect(requested[0]?.params).toMatchObject({
			textDocument: { uri: SOURCE_URI },
			position: { line: 0, character: 6 },
			context: { includeDeclaration: true },
		});
	});

	it("derives the column from `symbol` rather than asking for UTF-16 counting", async () => {
		install({ answers: { "textDocument/hover": null } });
		await run({ operation: "hover", line: 2, symbol: "beta" });
		expect(requested[0]?.params).toMatchObject({ position: { line: 1, character: 6 } });
	});

	it("falls back to an explicit one-based `character` when `symbol` is absent", async () => {
		install({ answers: { "textDocument/hover": null } });
		await run({ operation: "hover", character: 7 });
		expect(requested[0]?.params).toMatchObject({ position: { line: 0, character: 6 } });
	});

	it("keeps the row of an unreadable file and loses only its anchor", async () => {
		install({
			answers: {
				"textDocument/definition": [{ uri: pathToFileURL(MISSING).href, range: { start: { line: 4, character: 0 } } }],
			},
		});
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		const groups = value.groups as Array<{ path: string; rows: Array<{ hash: string }> }>;
		expect(groups[0]?.rows[0]?.hash).toBe("");
		expect(value.modelText).toContain("gone.ts");
		expect(value.modelText).toContain("5:1");
	});

	it("answers a hover with its text, and a missing one as a distinct sentence", async () => {
		install({ answers: { "textDocument/hover": { contents: { kind: "markdown", value: "**alpha**" } } } });
		const hovered = await run({ operation: "hover", symbol: "alpha" });
		expect(hovered.modelText).toContain("**alpha**");

		install({ answers: { "textDocument/hover": null } });
		const empty = await run({ operation: "hover", symbol: "alpha" });
		expect(empty.modelText).toContain("No hover information.");
	});

	it("bounds a huge reference list and says so inside the answer", async () => {
		const locations = Array.from({ length: 150 }, (_unused, index) => ({
			uri: OTHER_URI,
			range: { start: { line: index, character: 0 } },
		}));
		install({ answers: { "textDocument/references": locations } });
		const value = await run({ operation: "findReferences", symbol: "alpha" });
		expect(value.truncated).toBe(true);
		expect(value.totalLocations).toBe(150);
		expect(value.locations).toHaveLength(100);
		expect(value.modelText).toContain("50 more locations omitted");
		expect(schemaViolations(outputSchemaOf(buildLspTool(io)), value)).toEqual([]);
	});

	it("says `No results.` when the server answers with nothing — not a failure", async () => {
		install({ answers: { "textDocument/definition": [] } });
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		expect(value.modelText).toContain("No results.");
		expect(value.error).toBeUndefined();
	});
});

describe("lsp navigation — the projection", () => {
	it("projects the multi-file (grep) card, which the client can validate", async () => {
		install({
			answers: { "textDocument/definition": [{ uri: OTHER_URI, range: { start: { line: 0, character: 0 } } }] },
		});
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		const meta = lspPresentationMeta(value as never);
		expect(meta.files).toBeDefined();
		expect(grepPresentationFromMeta(meta), "the client's grep card must accept this meta").not.toBeUndefined();
	});

	it("names the answer's WIDTH for the folded row (#397 review)", async () => {
		// The folded row showed only the queried path, so a two-file answer was
		// invisible until expanded. The width rides at the row's end instead.
		install({
			answers: {
				"textDocument/definition": [
					{ uri: SOURCE_URI, range: { start: { line: 0, character: 0 } } },
					{ uri: OTHER_URI, range: { start: { line: 0, character: 0 } } },
				],
			},
		});
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		const meta = lspPresentationMeta(value as never);
		expect(meta.rowTitle).toEqual({
			key: "row.title.lsp.nav.stats",
			params: { locations: 2, files: 2 },
		});
	});

	it("keeps an EMPTY navigation answer off the multi-file card", async () => {
		// An empty multi-file card would draw nothing; the row has to fall back
		// to the generic body, because that is where "No results." is shown.
		install({ answers: { "textDocument/definition": [] } });
		const value = await run({ operation: "goToDefinition", symbol: "alpha" });
		const meta = lspPresentationMeta(value as never);
		expect(meta.files).toBeUndefined();
		expect(grepPresentationFromMeta(meta)).toBeUndefined();
	});

	it("keeps the read projection for the single-file operations", async () => {
		install({ answers: { "textDocument/documentSymbol": [] } });
		const value = await run({ operation: "symbols" });
		const meta = lspPresentationMeta(value as never);
		expect(meta.groups).toBeUndefined();
		expect(meta.path).toBe(SOURCE);
	});
});

describe("lsp navigation — the cold-start index", () => {
	it("waits for the project index before asking, when the server says it is loading", async () => {
		waitedForProjectLoad = 0;
		install({ projectLoading: true, answers: { "textDocument/definition": [] } });
		await run({ operation: "goToDefinition", symbol: "alpha" });
		expect(waitedForProjectLoad).toBe(1);
		expect(requested).toHaveLength(1);
	});

	it("does NOT wait when the server never opened a loading bracket", async () => {
		waitedForProjectLoad = 0;
		install({ answers: { "textDocument/definition": [] } });
		await run({ operation: "goToDefinition", symbol: "alpha" });
		expect(waitedForProjectLoad).toBe(0);
	});
});

describe("lsp — the status projection", () => {
	it("projects a CARD that carries the sentence when there is no slot", async () => {
		install({});
		const value = await run({ operation: "status" });
		// No slots is still an answer: the card says the sentence instead of
		// drawing rows, so the status is a one-line card and not a JSON dump.
		const meta = lspPresentationMeta(value as never);
		expect(meta.card).toBe("lsp-status");
		expect(meta.slots).toEqual([]);
		expect(meta.note).toBe(value.raw);
	});
});

describe("lsp navigation — the cold-index retry", () => {
	it("re-asks when the answer is the import clause that names the symbol", async () => {
		// The measured cold-start failure: an imported symbol resolves to the
		// import clause in the SAME file until the index lands.
		install({
			sequence: {
				"textDocument/definition": [
					[{ uri: OTHER_URI, range: { start: { line: 0, character: 9 } } }],
					[{ uri: SOURCE_URI, range: { start: { line: 0, character: 6 } } }],
				],
			},
		});
		const value = await run({ operation: "goToDefinition", path: OTHER, line: 1, symbol: "alpha" });
		expect(requested).toHaveLength(2);
		expect(value.locations).toEqual([{ path: "a.ts", line: 1, character: 7 }]);
	});

	it("asks ONCE when the answer is already a declaration", async () => {
		install({ answers: { "textDocument/definition": [{ uri: SOURCE_URI, range: { start: { line: 1, character: 0 } } }] } });
		await run({ operation: "goToDefinition", path: OTHER, line: 1, symbol: "alpha" });
		expect(requested).toHaveLength(1);
	});

	it("stops retrying when the server keeps answering shallowly", { timeout: 30_000 }, async () => {
		const shallow = [{ uri: OTHER_URI, range: { start: { line: 0, character: 9 } } }];
		// A CONSTANT shallow answer, not a finite sequence: the loop must stop
		// because its TIME budget ran out, and an exhausted sequence would end
		// it for the wrong reason (an `undefined` answer).
		install({ answers: { "textDocument/definition": shallow } });
		const value = await run({ operation: "goToDefinition", path: OTHER, line: 1, symbol: "alpha" });
		// The loop is bounded by TIME (COLD_RETRY_BUDGET_MS), so the shallow
		// answer is still returned honestly rather than empty.
		expect(requested.length).toBeGreaterThanOrEqual(3);
		expect(value.locations).toEqual([{ path: "b.ts", line: 1, character: 10 }]);
	});
});

describe("lsp — every answer is a card (#397 review)", () => {
	it("projects a hover as its own card, not an empty read", () => {
		const hover = "```typescript\nconst alpha: number\n```";
		const meta = lspPresentationMeta({ operation: "hover", path: "a.ts", hover } as never);
		expect(meta).toEqual({ operation: "hover", path: "a.ts", hover });
	});

	it("projects the action list structured, with the sentence for an empty one", () => {
		const actions = [{ title: "Add missing import", kind: "quickfix" }];
		expect(lspPresentationMeta({ operation: "code_actions", path: "a.ts", actions } as never)).toEqual({
			operation: "code_actions",
			path: "a.ts",
			actions,
		});
		// An EMPTY list is still the answer: the host's sentence rides in `note`.
		expect(
			lspPresentationMeta({ operation: "code_actions", path: "a.ts", actions: [], raw: "No action is offered here." } as never),
		).toEqual({ operation: "code_actions", path: "a.ts", actions: [], note: "No action is offered here." });
	});

	it("projects a raw request answer as the JSON card", () => {
		const json = '{\n  "ok": true\n}';
		expect(lspPresentationMeta({ operation: "request", path: "a.ts", raw: json } as never)).toEqual({
			operation: "request",
			path: "a.ts",
			json,
		});
	});

	it("draws an EMPTY navigation answer as a sentence card", () => {
		// `No results.` is the answer. Falling back to the read projection made
		// the row dump the whole call instead of saying that.
		expect(
			lspPresentationMeta({ operation: "goToDefinition", path: "a.ts", groups: [], raw: "No results." } as never),
		).toEqual({ operation: "goToDefinition", path: "a.ts", note: "No results." });
	});

	it("keeps the sentence when a hover has no contents", () => {
		expect(lspPresentationMeta({ operation: "hover", path: "a.ts", hover: "", raw: "No hover information." } as never)).toEqual({
			operation: "hover",
			path: "a.ts",
			note: "No hover information.",
		});
	});
});

describe("lsp navigation — the cold-index shape check", () => {
	it("recognizes the import clause when the server spells the URI the Windows way", () => {
		// The bug the #397 review found on Windows: tsserver answers with an
		// ENCODED colon and a lower-case drive letter (`file:///d%3A/...`) while
		// the host asks about a plain colon and an upper-case drive letter
		// (`file:///D:/...`). A string compare called them different files, so
		// the shape check never fired — and the retry loop never ran at all.
		const answer = [
			{ uri: "file:///d%3A/vault/projects/b.ts", range: { start: { line: 0, character: 9 } } },
		];
		const input = {
			operation: "goToDefinition",
			symbol: "alpha",
			uri: "file:///D:/vault/projects/b.ts",
			text: "import { alpha } from './a';\n",
		};
		expect(looksLikeImportBinding(answer, input as never)).toBe(true);
	});

	it("says no for an answer in ANOTHER file — a real definition is not a fallback", () => {
		const answer = [
			{ uri: "file:///d%3A/vault/projects/a.ts", range: { start: { line: 0, character: 6 } } },
		];
		const input = {
			operation: "goToDefinition",
			symbol: "alpha",
			uri: "file:///D:/vault/projects/b.ts",
			text: "import { alpha } from './a';\n",
		};
		expect(looksLikeImportBinding(answer, input as never)).toBe(false);
	});
});
