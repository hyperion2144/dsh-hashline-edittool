/**
 * The three tools the split produced, driven through their real seams.
 *
 * The AST client is given an IN-PROCESS worker rather than a spawned one, so the
 * grammar really parses and the pattern really matches — a mocked tree would
 * test nothing, and the whole point of this layer is that it agrees with what
 * tree-sitter produces.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAstClient, type WorkerLike } from "../../src/ast/client.js";
import { handleRequest, type AstWorkerRequest, type AstWorkerResponse } from "../../src/ast/worker.js";
import { buildAstGrepTool } from "../../src/tool-ast-grep.js";
import { buildAstEditTool } from "../../src/tool-ast-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { applyEffective } from "../../src/config.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

function inProcessWorker(): WorkerLike {
	let respond: ((response: AstWorkerResponse) => void) | undefined;
	return {
		postMessage(message: AstWorkerRequest) {
			void handleRequest(message).then((response) => respond?.(response));
		},
		onMessage(listener) {
			respond = listener;
		},
		onExit() {},
		terminate() {},
	};
}

const SOURCE = [
	'import { a, b } from "./m";',
	'import Default from "./d";',
	'import * as ns from "./n";',
	"const x = f(1, 2);",
	"export function alpha() {",
	"  return 1;",
	"}",
].join("\n");

let dir: string;
let file: string;

function exec(cwd: string) {
	return (args: unknown) =>
		({ signal: new AbortController().signal, agent: { id: "s", session: { id: "s", header: { cwd } } }, arguments: args }) as never;
}

beforeEach(async () => {
	// AST is OFF by default, and these tools now honour the switch — so the tests
	// that exercise them have to turn it on. That is the gate working, and the
	// refusal it produces has its own test below.
	applyEffective({ ast: { enabled: true } });
	dir = await mkdtemp(join(tmpdir(), "tool-ast-"));
	file = join(dir, "a.ts");
	await writeFile(file, SOURCE, "utf-8");
	// The client type is not exported by name; the seam takes an instance and the
	// constructor is reachable through the module the tests already import.
	const { AstClient } = (await import("../../src/ast/client.js")) as unknown as {
		AstClient: new (opts: { spawn: () => WorkerLike; idleMs: number }) => Parameters<typeof setAstClient>[0];
	};
	setAstClient(new AstClient({ spawn: inProcessWorker, idleMs: 0 }));
});

afterEach(async () => {
	applyEffective(undefined);
	setAstClient(undefined);
	await rm(dir, { recursive: true, force: true });
});

describe("ast_grep", () => {
	const run = async (args: Record<string, unknown>) => {
		const tool = buildAstGrepTool(localIO());
		return (await tool.execute({ path: file, ...args }, exec(dir)(args))) as {
			matches: Array<{ startLine: number; endLine: number; rows: string[]; captures: string[] }>;
			outline?: string;
			modelText?: string;
		};
	}

	// The declaration, not just the body: `defineTool` types `execute` FROM the
	// output schema and the host validates the value against it at mount time,
	// so a field the schema does not name passes every body-level test and then
	// fails in a session (`value.modelText is not declared`).
	it("returns a value that matches its own declared output schema", async () => {
		const tool = buildAstGrepTool(localIO());
		for (const args of [{ pat: "export function $N() { $$$B }" }, {}]) {
			for (const mode of ["text", "json"] as const) {
				applyEffective({ ast: { enabled: true }, output_format: mode });
				const value = await tool.execute({ path: file, ...args }, exec(dir)(args));
				expect(
					schemaViolations(outputSchemaOf(tool), value),
					`${mode} ${JSON.stringify(args)}`,
				).toEqual([]);
			}
		}
	});

	it("carries BOTH output modes, both keyed `<anchor>:<line>`", async () => {
		// Text mode: rendered rows the caller can act on directly.
		applyEffective({ ast: { enabled: true }, output_format: "text" });
		const text = await run({ pat: "export function $N() { $$$B }" });
		expect(text.modelText).toMatch(/\s[A-Za-z0-9]{2,8}:\d+: export function alpha\(\) \{/);
		// JSON mode: the same rows, keyed by that same marker — one projection,
		// two channels, so a key pasted back into `edit` names the same line.
		applyEffective({ ast: { enabled: true }, output_format: "json" });
		const json = await run({ pat: "export function $N() { $$$B }" });
		const parsed = JSON.parse(json.modelText!) as {
			total: number;
			matches: Array<{ rows: Record<string, string> }>;
		};
		expect(parsed.total).toBeGreaterThan(0);
		const keys = Object.values(parsed.matches).flatMap((m) => Object.keys(m.rows));
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9]{2,8}:\d+$/);
		expect(Object.values(parsed.matches[0]!.rows)).toContain("export function alpha() {");
	});

	it("finds imports by SHAPE, with no kind table involved", async () => {
		const value = await run({ pat: 'import $$$BODY from "$MODULE"' });
		// Three forms — named, default, namespace — and a name-keyed rule can only
		// ever see the first of them, because the other two have no specifier.
		expect(value.matches).toHaveLength(3);
		// Read by NAME, not by position: the capture order follows the pattern's
		// nodes, and an assertion on `captures[0]` would be pinning an ordering
		// nobody promised.
		expect(value.matches.map((m) => m.captures.find((c) => c.startsWith("MODULE=")))).toEqual([
			'MODULE="./m"',
			'MODULE="./d"',
			'MODULE="./n"',
		]);
	});

	it("returns rows in the SAME form `read` produces", async () => {
		const value = await run({ pat: "const $NAME = $INIT;" });
		expect(value.matches).toHaveLength(1);
		// `line:anchor:content` — the row shape the model copies into `edit`.
		expect(value.matches[0]!.rows[0]).toMatch(/^[^:]+:\d+: /);
		expect(value.matches[0]!.rows[0]).toContain("const x = f(1, 2);");
	});

	it("refuses a pattern the grammar cannot parse, rather than returning nothing", async () => {
		// An empty result and a refusal are different answers: the first says the
		// code is not there, the second says the question was malformed.
		await expect(run({ pat: "const" })).rejects.toThrow(/E_AST_PATTERN/);
	});
});

describe("ast_edit", () => {
	const run = async (args: Record<string, unknown>) => {
		const { FsSandboxController } = await import("../../src/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const tool = buildAstEditTool(localIO(), sandbox);
		return (await tool.execute({ path: file, ...args }, exec(dir)(args))) as {
			count: number;
			ok: boolean;
			message: string;
		};
	};

	it("applies a shape-matched change through the hashline engine", async () => {
		// The pattern is the whole declaration on purpose — see the test below for
		// why a bare `f($$$ARGS)` would NOT match this call.
		const value = await run({ pat: "const $NAME = f($$$ARGS);", out: "const $NAME = g($$$ARGS);" });
		expect(value.ok).toBe(true);
		expect(value.count).toBe(1);
		const after = await readFile(file, "utf-8");
		expect(after).toContain("const x = g(1, 2);");
		// Untouched lines keep their text — the engine edits a range, not the file.
		expect(after).toContain('import Default from "./d";');
	});

	it("answers with the SAME diff an edit answers with — not the new body", async () => {
		// The model channel is `edit`'s, from `edit`'s own builder: the diff
		// legend, the `-`/`+` rows with their fresh anchors, the success line.
		// Returning the rewritten body instead told the model nothing about the
		// change and made it re-read what it had just written.
		applyEffective({ ast: { enabled: true }, output_format: "text" });
		const value = await run({ pat: "const $NAME = f($$$ARGS);", out: "const $NAME = g($$$ARGS);" });
		const text = String((value as unknown as { modelText: string }).modelText);
		expect(text).toContain("Diff rows:");
		// Diff rows carry no space after the separator (unlike read rows).
		expect(text).toMatch(/^-[A-Za-z0-9]{2,8}:\d+:const x = f\(1, 2\);$/m);
		expect(text).toMatch(/^\+[A-Za-z0-9]{2,8}:\d+:const x = g\(1, 2\);$/m);
		expect(text).toContain("Successfully edited in");
		// And the JSON mode is the edit envelope, its diff keyed `anchor:line`.
		// The file is reset first: the run above already applied the change, and
		// a second identical edit would be a noop with an empty diff.
		await writeFile(file, SOURCE, "utf-8");
		applyEffective({ ast: { enabled: true }, output_format: "json" });
		const json = await run({ pat: "const $NAME = f($$$ARGS);", out: "const $NAME = g($$$ARGS);" });
		const parsed = JSON.parse(String((json as unknown as { modelText: string }).modelText)) as {
			ok: boolean;
			diff: Record<string, string>;
		};
		expect(parsed.ok).toBe(true);
		const added = Object.keys(parsed.diff).find((key) => key.startsWith("+")) ?? "";
		expect(added).toMatch(/^\+[A-Za-z0-9]{2,8}:\d+$/);
	});

	it("hands the web card real hunks — an empty `diffs` reads as 'nothing applied'", async () => {
		// The card falls back to raw input/output when the meta carries no hunks, so
		// the derived-from-before/after part is load-bearing, not decorative: the
		// first version passed an empty array and the card silently disappeared.
		const { FsSandboxController } = await import("../../src/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const tool = buildAstEditTool(localIO(), sandbox);
		const value = await tool.execute(
			{ path: file, pat: "const $NAME = f($$$ARGS);", out: "const $NAME = g($$$ARGS);" },
			exec(dir)({}),
		);
		const { presentationMeta } = tool.output as unknown as {
			presentationMeta?: (args: unknown, value: unknown) => { diffs?: unknown[]; diffRows?: unknown[] };
		};
		const meta = presentationMeta?.({}, value);
		expect(Array.isArray(meta?.diffs)).toBe(true);
		expect(meta?.diffs?.length).toBeGreaterThan(0);
		expect(meta?.diffRows?.length).toBeGreaterThan(0);
		// `presentResult` is NOT asserted here: it is wrapped by the tool DSL (its
		// own `result` argument carries the runtime outcome), and a direct call
		// returns undefined for `edit` too — so a unit call would pin nothing. The
		// META is the half this layer owns, and it is the half that was empty.
	});

	it("is undoable by `undo_last_edit` — the same commit, so the same entry", async () => {
		// `ast_edit` commits through `commitFileResult`, which owns persist-undo,
		// so the entry is written by the same transaction an `edit` writes. This
		// pins that: a structural change is revertible like any other edit.
		const before = await readFile(file, "utf-8");
		const { buildUndoTool } = await import("../../src/tool-undo.js");
		const { FsSandboxController } = await import("../../src/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const applied = await run({ pat: "const $NAME = f($$$ARGS);", out: "const $NAME = g($$$ARGS);" });
		expect(applied.count).toBe(1);
		expect(await readFile(file, "utf-8")).toContain("const x = g(1, 2);");
		const undo = buildUndoTool(localIO(), sandbox);
		const value = (await undo.execute({ path: file }, exec(dir)({}))) as { empty?: boolean };
		// `empty: false` means an entry was found AND reverted. The bug this pins
		// was the tool answering "No undo history" for an `ast_edit` that had
		// happened, because the entry was written under another workspace.
		expect(value.empty).toBe(false);
		expect(await readFile(file, "utf-8")).toBe(before);
	});

	it("refuses the WHOLE batch when the change breaks syntax, writing nothing", async () => {
		const before = await readFile(file, "utf-8");
		// Deleting the closing brace leaves the function unterminated. The engine's
		// gate must catch it and leave the file exactly as it was — the whole point
		// of routing this tool through that engine rather than writing directly.
		let outcome: { count: number; ok: boolean } | undefined;
		let threw = false;
		try {
			outcome = await run({ pat: "export function alpha() {\n  return 1;\n}", out: "export function alpha() {\n  return 1;" });
		} catch {
			threw = true;
		}
		// The guarantee is the FILE, not the error style: whether the engine throws
		// or reports a refusal, nothing may reach the disk.
		expect(await readFile(file, "utf-8")).toBe(before);
		// And the pattern must have been found — otherwise "nothing was written"
		// would be true for the wrong reason and this test would pass while the
		// gate it claims to check was never reached.
		expect(threw || outcome?.count === 1).toBe(true);
		if (!threw) expect(outcome?.ok).toBe(false);
	});

	it("a bare call pattern matches the call wherever it sits, declaration or not", async () => {
		// CORRECTED CONTRACT. This test used to pin the opposite — that `f($$$ARGS)`
		// parses as an expression STATEMENT and so cannot match the call inside
		// `const x = f(1, 2);`. That pin documented a BUG as if it were ast-grep
		// semantics: the statement wrapper is an artifact of a pattern being a whole
		// program, and keeping it as the pattern root silently matched NOTHING for
		// the most ordinary searches (`entry.install`, `process.platform`).
		// `compilePattern` now unwraps it, so the expression is the pattern.
		// Order matters: the FIRST run mutates the fixture, so the narrower pattern
		// goes first — the bare one would otherwise rewrite the call out from under
		// the declaration pattern.
		expect((await run({ pat: "const $NAME = f($$$ARGS);", out: "const $NAME = f($$$ARGS);" })).count).toBe(1);
		expect((await run({ pat: "f($$$ARGS)", out: "g($$$ARGS)" })).count).toBe(1);
	});

	it("is a no-op when nothing matches, and says so rather than failing", async () => {
		const before = await readFile(file, "utf-8");
		const value = await run({ pat: "nothingMatchesThis($$$A)", out: "x" });
		expect(value.count).toBe(0);
		expect(await readFile(file, "utf-8")).toBe(before);
	});

	it("substitutes $$$NAME before $NAME", async () => {
		// The one-node rule would otherwise eat the first `$` and leave `$$`,
		// substituting the wrong text rather than failing loudly.
		const value = await run({ pat: "f($$$ARGS)", out: "h($A, $B)" });
		expect(value.ok).toBe(true);
		// `$A`/`$B` are not bound, so they resolve to nothing — the point is that
		// `$$$ARGS` did NOT become `$$`+`ARGS`.
		const after = await readFile(file, "utf-8");
		expect(after).not.toContain("$");
	});
});

describe("ast_grep — no pattern means the OUTLINE", () => {
	/**
	 * This capability used to be `read {summary: true}` — an AST question folded
	 * into the line reader, which is the fold the split exists to undo. It lives
	 * here now, and these tests hold the two things that matter about the move:
	 * the outline still FOLDS what it should, and its rows are still SERVED, so an
	 * outline row is editable exactly as a read row is.
	 */
	// Bodies of FIVE lines: `AST_SUMMARY_MIN_BODY_LINES` is 4, so a two-line body
	// is not foldable and the file would come back as "nothing to fold" — which
	// is what my first fixture produced, correctly.
	const big = (count: number) =>
		[
			'import { a } from "./m";',
			"",
			...Array.from({ length: count }, (_, i) =>
				[
					`export function fn${i}() {`,
					`  const a${i} = ${i};`,
					`  const b${i} = a${i} + 1;`,
					`  const c${i} = b${i} * 2;`,
					`  return c${i};`,
					"}",
					"",
				].join("\n"),
			),
		].join("\n");

	const write = async (text: string) => {
		await writeFile(file, text, "utf-8");
		return text;
	};

	const outlineOf = async () => {
		const tool = buildAstGrepTool(localIO());
		return (await tool.execute({ path: file }, exec(dir)({}))) as {
			matches: unknown[];
			outline?: string;
			cardFiles?: Array<{ path: string; rows: Array<{ number: number; hash: string; text: string }> }>;
			total?: number;
			isOutline?: boolean;
		};
	};

	it("folds bodies and keeps the markers, and serves what it shows", async () => {
		// 40 bodies of 7 lines each: past the 100-line gate and past the shrink
		// ratio, which is the pair of conditions a real outline has to satisfy.
		await write(big(40));
		const value = await outlineOf();
		expect(value.outline).toBeDefined();
		expect(value.outline).toContain("fn0");
		// A folded body is a RANGE, carried as the marker's line part.
		expect(value.outline).toMatch(/[A-Za-z0-9]{2,8}:\d+-\d+:/);
		// And the rows came back in the same shape `read` produces, so one can be
		// handed straight to `edit` — which is only true because they were served.
		// Markers are right-aligned into a column, so leading padding is expected.
		expect(value.outline).toMatch(/^\s*[A-Za-z0-9]{2,8}:\d+: /m);
		// BUG-3 regression (#131 field report): the CARD data must carry the
		// outline rows — an empty `files` rendered the search card's 无结果
		// while the model was reading a full outline. Rows are the grep shape
		// (integer line, anchor, text, no match highlight), and the outline
		// flag rides the value so the meta — and the card's footer — can tell
		// an outline from a match list.
		expect(value.cardFiles).toHaveLength(1);
		expect(value.cardFiles![0]!.path).toBe(file);
		expect(value.cardFiles![0]!.rows.length).toBeGreaterThan(0);
		for (const row of value.cardFiles![0]!.rows) {
			expect(Number.isInteger(row.number)).toBe(true);
			expect(row.hash).not.toBe("");
			expect(row.text).not.toContain("undefined");
		}
		expect(value.total).toBe(value.cardFiles![0]!.rows.length);
		expect(value.isOutline).toBe(true);
	});

	it("names the gate it failed, rather than reporting 'no symbols'", async () => {
		// A SHORT file hits the line gate, not the fold-worthy check: two different
		// reasons, and the message has to say which. Silence here would read as a
		// claim about the CODE instead of about the size limit that was hit.
		await write("const a = 1;\nconst b = 2;\n");
		expect((await outlineOf()).outline).toContain("no outline");

		// Long enough for the gate, but nothing worth folding: a DIFFERENT answer,
		// and it must not be the same sentence.
		await write(["const a = 1;", "const b = 2;", ...Array.from({ length: 120 }, () => "// filler")].join("\n"));
		expect((await outlineOf()).outline).toContain("nothing to fold");
	});

	it("names the rule for a file past the SIZE gate too", async () => {
		// Two different ceilings, two different sentences — the model has to be able
		// to tell "too many lines" from "too many bytes" from "no grammar".
		const huge = Array.from({ length: 30_000 }, () => "const x = 1;").join("\n");
		await write(huge);
		expect((await outlineOf()).outline).toContain("no outline");
	});
});

describe("the AST switch gates the AST tools", () => {
	/**
	 * It used to gate `read`'s selectors and `edit`'s block ops. When those left,
	 * it gated NOTHING — so "AST off" still ran structural searches, and the card
	 * said something that had stopped being true.
	 */
	it("REFUSES when the capability is off, rather than reporting no match", async () => {
		applyEffective({ ast: { enabled: false } });
		const tool = buildAstGrepTool(localIO());
		// "Switched off" is a fact about the session; "no matches" is a claim about
		// the code. Reporting the first as the second is the failure this whole
		// family of tools is built to avoid.
		await expect(tool.execute({ path: file, pat: "const $N = $V;" }, exec(dir)({}))).rejects.toThrow(/E_AST_DISABLED/);
	});

	it("refuses per-language too, and names the language", async () => {
		// The per-language switches only NARROW the master switch, so this is the
		// second gate rather than a replacement for the first.
		// The SETTINGS shape, not the internal one: `ast.languages[id].enabled`.
		// The `!id` form is how it is stored after parsing, and writing that here
		// tested nothing — the `!` was taken as a language named `!typescript`.
		applyEffective({ ast: { enabled: true, languages: { typescript: { enabled: false } } } });
		const tool = buildAstGrepTool(localIO());
		await expect(tool.execute({ path: file, pat: "const $N = $V;" }, exec(dir)({}))).rejects.toThrow(/turned off for/);
	});

	it("lets `ast_edit` through only when the switch is on", async () => {
		applyEffective({ ast: { enabled: false } });
		const { FsSandboxController } = await import("../../src/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const tool = buildAstEditTool(localIO(), sandbox);
		await expect(tool.execute({ path: file, pat: "const $N = $V;", out: "x" }, exec(dir)({}))).rejects.toThrow(/E_AST_DISABLED/);
	});
});
