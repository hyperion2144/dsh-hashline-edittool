/**
 * The `lsp` tool, driven against a fake manager.
 *
 * A fake is the right instrument here and the honest one: the tool's job is to
 * turn what a server says into an answer and to REFUSE clearly when there is no
 * server. What a real server sends is #112's business; whether this tool
 * distinguishes its answers is this file's.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildLspTool } from "../../src/tools/tool-lsp.js";
import { E_LSP_NO_SERVER } from "../../src/tools/tool-lsp.js";
import { pathToFileURL } from "node:url";

const FILE = "/tmp/lsp-tool-probe/a.ts";
/**
 * The uri the tool derives for {@link FILE}.
 *
 * `pathToFileURL`, not string concatenation: on Windows the tool asks for
 * `file:///D:/tmp/…` while `` file://${FILE} `` says `file:///tmp/…`, and the
 * fake server's pushed map is keyed by the tool's own spelling.
 */
const FILE_URI = pathToFileURL(FILE).href;

/** What a fake server will answer, per method. */
interface Fake {
	readonly answers?: Record<string, unknown>;
	/** Push these on open, as a real server does unprompted. */
	readonly pushOnOpen?: readonly unknown[];
	readonly ready?: boolean;
}

/**
 * Every request the fake server received, oldest first.
 *
 * The ANSWER only proves a call arrived; what it carried — the params the tool
 * built — is what a payload test has to assert.
 */
let requested: Array<{ method: string; params: unknown }> = [];

function install(fake: Fake) {
	requested = [];
	const pushed = new Map<string, readonly unknown[]>();
	let revision = 0;
	// The PRODUCT derives the document uri with `pathToFileURL`; the fake server
	// must key its pushes the same way, or on Windows the tool asks for
	// `file:///D:/tmp/…` while the map holds `file:///tmp/…` — three diagnostics
	// cases silently "found nothing" for that reason.
	const uri = FILE_URI;
	const session = {
		get diagnosticsRevision() {
			return revision;
		},
		getDiagnostics: (u: string) => pushed.get(u),
		request: async (method: string, params: unknown) => {
			requested.push({ method, params });
			return fake.answers?.[method];
		},
	};
	setLspManager({
		waitForSession: async () => (fake.ready === false ? undefined : (session as never)),
		unavailability: () => ({ message: "no server is installed for typescript" }),
		openDocumentFor: () => (text: string) => {
			// The SENTINEL PROBE (verifiedReport): probe text carries a guaranteed
			// syntax error naming a nonce — a real server reports it verbatim.
			const nonce = /dsh_probe_[a-z0-9]+_[a-z0-9]+/.exec(text)?.[0];
			if (nonce !== undefined) {
				pushed.set(uri, [{ message: `Cannot find name '${nonce}'.`, severity: 1, range: { start: { line: 0 } } }]);
				revision += 1;
				return;
			}
			if (fake.pushOnOpen !== undefined) {
				pushed.set(uri, fake.pushOnOpen);
				revision += 1;
			}
		},
	} as never);
}

const io = {
	resolve: async (p: string) => p,
	readText: async () => "export function alpha() {}\nconst b = 1;\n",
	// The tool OBSERVES what it serves; a stub without this is not a FileIO.
	emitObserved: async () => undefined,
} as never;

const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: "/tmp" } } } } as never;

function run(args: Record<string, unknown>) {
	return buildLspTool(io).execute({ path: FILE, ...args }, exec) as Promise<{
		server: string;
		symbols: Array<{ name: string; kind: string; line: number; depth: number }>;
		raw?: string;
		modelText?: string;
	}>;
}

afterEach(() => setLspManager(undefined));

describe("lsp — refusing is a different answer from finding nothing", () => {
	it("REFUSES when no client is enabled, rather than reporting no symbols", async () => {
		setLspManager(undefined);
		// The distinction the whole tool is built around: an empty list would say
		// "this file has no symbols", which is a claim about the CODE.
		await expect(run({ operation: "symbols" })).resolves.toMatchObject({ modelText: expect.stringMatching(new RegExp(E_LSP_NO_SERVER.replace(/[[\]]/g, "\\$&"))) });
	});

	it("refuses with the MANAGER's reason when no server could be started", async () => {
		install({ ready: false });
		await expect(run({ operation: "symbols" })).resolves.toMatchObject({ modelText: expect.stringMatching(/no server is installed for typescript/) });
	});
});

describe("lsp — symbols", () => {
	it("flattens a nested DocumentSymbol tree and 1-indexes the lines", async () => {
		install({
			answers: {
				"textDocument/documentSymbol": [
					{
						name: "Box",
						kind: 5,
						range: { start: { line: 0 } },
						children: [{ name: "render", kind: 6, range: { start: { line: 2 } } }],
					},
				],
			},
		});
		const value = await run({ operation: "symbols" });
		expect(value.symbols.map((s) => [s.name, s.kind, s.line, s.depth])).toEqual([
			["Box", "class", 1, 0],
			["render", "method", 3, 1],
		]);
	});

	it("carries BOTH output modes, keyed `<anchor>:<line>` in each", async () => {
		// The symbol must sit on a line the stub file actually HAS: a row only
		// becomes editable when its line has an anchor, so an out-of-range
		// symbol has no row to key.
		install({
			answers: {
				"textDocument/documentSymbol": [{ name: "alpha", kind: 12, location: { range: { start: { line: 0 } } } }],
			},
		});
		// Text mode lists the anchored rows; JSON mode keys them by the SAME
		// marker, so a symbol line is editable straight from either answer.
		applyEffective({ output_format: "text" });
		const text = await run({ operation: "symbols" });
		expect(String(text.modelText)).toMatch(/[A-Za-z0-9]{2,8}:1: export function alpha/);
		applyEffective({ output_format: "json" });
		const json = await run({ operation: "symbols" });
		const parsed = JSON.parse(String(json.modelText)) as { hashlines: Record<string, string> };
		const keys = Object.keys(parsed.hashlines);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9]{2,8}:1$/);
		// And the DECLARATION holds: the host validates the returned value against
		// the output schema, so a field the schema does not name fails in a
		// session even though every body-level assertion passes.
		const tool = buildLspTool(io);
		for (const mode of ["text", "json"] as const) {
			applyEffective({ output_format: mode });
			const value = await tool.execute({ operation: "symbols", path: FILE }, exec);
			expect(schemaViolations(outputSchemaOf(tool), value), mode).toEqual([]);
		}
	});

	it("renders its rows with the CONFIGURED separator, not a hardcoded colon", async () => {
		// The divider between a row's marker and its content is `separator` from the
		// settings. A hardcoded `:` here emitted `anchor:line: …` in a deployment
		// configured with `|` while every other tool emitted `anchor:line| …`.
		// The marker's own colon is NOT the separator and stays a colon: it is the
		// contract `edit` parses, whichever divider is configured.
		install({
			answers: {
				"textDocument/documentSymbol": [{ name: "alpha", kind: 12, location: { range: { start: { line: 0 } } } }],
			},
		});
		applyEffective({ output_format: "text", separator: "|" });
		const text = String((await run({ operation: "symbols" })).modelText);
		expect(text).toMatch(/[A-Za-z0-9]{2,8}:1\| export function alpha/);
		expect(text).not.toMatch(/[A-Za-z0-9]{2,8}:1: /);
	});

	it("reads SymbolInformation's location.range too, not only DocumentSymbol's range", async () => {
		// A server sends whichever the client advertised. Reading one shape would
		// report every line as 0 against half of them.
		install({
			answers: {
				"textDocument/documentSymbol": [{ name: "flat", kind: 12, location: { range: { start: { line: 4 } } } }],
			},
		});
		expect((await run({ operation: "symbols" })).symbols[0]?.line).toBe(5);
	});

	it("says a file HAS none without implying the server failed", async () => {
		install({ answers: { "textDocument/documentSymbol": [] } });
		const value = await run({ operation: "symbols" });
		expect(value.symbols).toEqual([]);
	});
});

describe("lsp — code_actions lists and never applies", () => {
	it("returns the titles a server offers at a position", async () => {
		install({
			answers: {
				"textDocument/codeAction": [
					{ title: "Add import from './m'", kind: "quickfix" },
					{ title: "Convert to arrow function" },
				],
			},
		});
		const value = await run({ operation: "code_actions", line: 1, symbol: "alpha" });
		expect(value.raw).toBe("Add import from './m'  [quickfix]\nConvert to arrow function");
	});

	it("distinguishes 'the server offers nothing' from an error", async () => {
		install({ answers: { "textDocument/codeAction": [] } });
		expect((await run({ operation: "code_actions", line: 1 })).raw).toBe("No action is offered here.");
	});
});

describe("lsp — diagnostics", () => {
	it("reports what was pushed, with the line", async () => {
		install({ pushOnOpen: [{ message: "unused", severity: 1, range: { start: { line: 1 } } }] });
		const value = await run({ operation: "diagnostics" });
		expect(value.raw).toBe("L2 error: unused");
	});

	it("says NO diagnostics when a server looked and pushed an empty list", async () => {
		install({ pushOnOpen: [] });
		expect((await run({ operation: "diagnostics" })).raw).toContain("reported NO diagnostics");
	});

	it("gives a line ONE row carrying ALL of its messages", async () => {
		// Two shapes were wrong before this one. Dedup-only parked the messages in
		// `raw`, so the body and the messages disagreed. One-row-per-diagnostic
		// fixed that and then printed the source line once per error — the same text
		// three times over in a channel the model pays for.
		install({
			pushOnOpen: [
				{ message: "first error", severity: 1, range: { start: { line: 0 } } },
				{ message: "second error", severity: 1, range: { start: { line: 0 } } },
				{ message: "third error", severity: 2, range: { start: { line: 1 } } },
			],
		});
		const value = await run({ operation: "diagnostics" });
		const rows = (value as unknown as { hashlines: Array<{ number: number; hash: string; text: string; messages?: string[]; severities?: number[] }> }).hashlines;
		// A line is the unit the reader acts on, so there are TWO rows here. The row
		// IS the source line (nothing appended), and the diagnostics ride beside it
		// as data — one entry per error, never merged into the text — because a card
		// cannot style a diagnostic differently from the line it sits under while
		// both are the same string.
		expect(rows.map((row) => row.number)).toEqual([1, 2]);
		expect(rows[0]!.text).toBe("export function alpha() {}");
		expect(rows[0]!.messages).toEqual(["error: first error", "error: second error"]);
		expect(rows[1]!.messages).toEqual(["warning: third error"]);
		// The severity CODES ride beside the labels, so the card can count errors
		// and warnings for its title suffix without parsing "error: …" back apart.
		expect(rows[0]!.severities).toEqual([1, 1]);
		expect(rows[1]!.severities).toEqual([2]);
		expect(rows[1]!.text).toBe("const b = 1;");
		// THE SOURCE LINE APPEARS ONCE in the model text — this is the repetition the
		// shape exists to avoid, so it is COUNTED rather than merely matched.
		const text = String((value as unknown as { modelText: string }).modelText);
		expect(text.split("export function alpha() {}").length - 1).toBe(1);
		// And the diagnostics are on their own INDENTED lines under it, one each, so
		// no reader has to guess which text is the file and which is a machine's
		// opinion of the file.
		expect(text).toMatch(/^\s*↳ error: first error$/m);
		expect(text).toMatch(/^\s*↳ error: second error$/m);
		expect(text).toMatch(/^\s*↳ warning: third error$/m);
		// Every row keeps its anchor, so any of them can be acted on.
		for (const row of rows) expect(row.hash).not.toBe("");
	});
});

describe("lsp — request", () => {
	it("needs a method, and says so instead of sending nothing", async () => {
		install({});
		await expect(run({ operation: "request" })).resolves.toMatchObject({ modelText: expect.stringMatching(/E_LSP_BAD_OPERATION/) });
	});

	it("passes an unwrapped method through and returns its answer", async () => {
		install({ answers: { "textDocument/definition": [{ uri: "file:///x" }] } });
		const value = await run({ operation: "request", query: "textDocument/definition" });
		expect(value.raw).toContain("file:///x");
	});

	it("merges the document into a payload that does not carry one (#151/P8)", async () => {
		// `payload` is the method's PARAMS, not a replacement for the document. A
		// `textDocument/definition` payload carrying only a `position` used to
		// reach the server with no `textDocument` at all, and the server answered
		// `Cannot read properties of undefined (reading 'uri')`.
		install({ answers: { "textDocument/definition": [{ uri: "file:///x" }] } });
		await run({ operation: "request", query: "textDocument/definition", payload: JSON.stringify({ position: { line: 0, character: 0 } }) });
		expect(requested).toHaveLength(1);
		expect(requested[0]!.params).toEqual({
			position: { line: 0, character: 0 },
			textDocument: { uri: FILE_URI },
		});

		// A payload that NAMES a document keeps it — including a uri the caller
		// chose, and extra fields the server's method needs.
		await run({
			operation: "request",
			query: "textDocument/definition",
			payload: JSON.stringify({ textDocument: { uri: "file:///other.ts" }, position: { line: 3, character: 1 } }),
		});
		expect(requested[1]!.params).toEqual({
			textDocument: { uri: "file:///other.ts" },
			position: { line: 3, character: 1 },
		});

		// And a payload that has a document but no uri gets one filled in.
		await run({
			operation: "request",
			query: "textDocument/definition",
			payload: JSON.stringify({ textDocument: { languageId: "typescript" } }),
		});
		expect(requested[2]!.params).toEqual({
			textDocument: { languageId: "typescript", uri: FILE_URI },
		});
	});
});
