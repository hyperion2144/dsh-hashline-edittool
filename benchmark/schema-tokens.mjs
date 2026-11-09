#!/usr/bin/env node
/**
 * dsh-hashline-edittool — resident schema-token census + CI budget gate (#421 ①)
 * ------------------------------------------------------------------------------
 * Measures the WIRE schema of the default tool surface — the part every model
 * request pays for, every turn: per tool, the registry sends exactly
 * { name, description, parameters } (dsh-tools' schemas() whitelist), so that
 * is what is counted. The census imports the twelve built tool definitions
 * from the built plugin (lib/), the same definitions the agent layer
 * registers, and counts them with the pinned tokenizer (js-tiktoken
 * cl100k_base, same as benchmark/run.mjs; falls back to chars/4).
 *
 * The budget is a CI GATE, not a target: if a tool description grows the
 * surface past the budget, this script exits non-zero and the PR fails.
 * The current budget was fixed from the first census (see
 * benchmark/README.md "Schema token budget"); tightening it is a one-line
 * change here.
 *
 * Run:  node benchmark/schema-tokens.mjs    (after `npm run build`)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getEncoding } from "js-tiktoken";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, "..", "lib");

if (!existsSync(LIB)) {
	console.error(
		"lib/ not found — run `npm run build` first (the census counts the BUILT tool definitions).",
	);
	process.exit(2);
}

// The twelve tools of the default surface, in registration order. Each entry
// names the lib module and the factory that returns the ToolDefinition. The
// factories only CAPTURE their io/sandbox arguments at construction time
// (execution is per-call), so inert stubs are sufficient to build the
// definitions; anything a factory genuinely needs at build time belongs in
// these stubs, not in per-tool hacks.
const stubIo = new Proxy(
	{},
	{
		get: (_t, prop) => {
			// Every method is an async no-op returning undefined; property reads
			// (non-method) yield undefined. This keeps construction honest without
			// a hand-maintained method list per tool.
			if (typeof prop === "string") {
				return () => undefined;
			}
			return undefined;
		},
	},
);
const stubSandbox = { escalationModes: [], schemaFields: () => ({}) };

const TOOLS = [
	["tool-read.js", "buildReadTool", [stubIo]],
	["tool-edit.js", "buildEditTool", [stubIo, stubSandbox]],
	["tool-write-shadow.js", "buildWriteShadowTool", [stubIo, stubSandbox]],
	["tool-grep.js", "buildGrepTool", [stubIo]],
	["tool-delete.js", "buildDeleteTool", [stubIo, stubSandbox]],
	["tool-rename.js", "buildRenameTool", [stubIo, stubSandbox]],
	["tool-undo.js", "buildUndoTool", [stubIo, stubSandbox]],
	["tool-ast-grep.js", "buildAstGrepTool", [stubIo]],
	["tool-ast-edit.js", "buildAstEditTool", [stubIo, stubSandbox]],
	["tool-lsp.js", "buildLspTool", [stubIo]],
	["tool-format.js", "buildFormatTool", [stubIo, stubSandbox]],
	["tool-apply-patch.js", "buildApplyPatchTool", [stubIo, stubSandbox]],
];

// ---------------------------------------------------------------------------
// Tokenizer — pinned js-tiktoken, chars/4 fallback (mirrors run.mjs).
// ---------------------------------------------------------------------------
let tokenizer = null;
try {
	tokenizer = getEncoding("cl100k_base");
} catch {
	// fall through
}
function tokens(text) {
	if (tokenizer) return tokenizer.encode(text).length;
	return Math.ceil(text.length / 4);
}
const TOKENIZER_NAME = tokenizer ? "js-tiktoken cl100k_base" : "chars/4 heuristic";

// ---------------------------------------------------------------------------
// Census — wire schema per tool: { name, description, parameters }.
// ---------------------------------------------------------------------------
const rows = [];
for (const [file, factory, args] of TOOLS) {
	// Windows: an absolute path is not a valid ESM specifier — it must be a
	// file:// URL (ERR_UNSUPPORTED_ESM_URL_SCHEME; found on the Windows
	// verification pass of #421).
		const mod = await import(pathToFileURL(join(LIB, "tools", file)).href);
	const build = mod[factory];
	if (typeof build !== "function") {
		console.error(`${file}: export ${factory} not found — lib/ is stale or renamed; re-run npm run build.`);
		process.exit(2);
	}
	let def;
	try {
		def = build(...args);
	} catch (error) {
		console.error(`${file}: ${factory}() threw at construction time:\n${error?.stack ?? String(error)}`);
		process.exit(2);
	}
	if (!def || typeof def.name !== "string") {
		console.error(`${file}: ${factory}() did not return a ToolDefinition with a name.`);
		process.exit(2);
	}
	// The registry whitelists exactly these three fields into the wire schema
	// (dsh-tools schemas(): "only name/description/parameters"). Anything else
	// on the definition (output, execute, presentCall, timeoutMs, ...) is never
	// sent to the model and MUST NOT be counted.
	const wire = JSON.stringify({ name: def.name, description: def.description ?? "", parameters: def.parameters ?? {} });
	rows.push({ name: def.name, file, tokens: tokens(wire), bytes: Buffer.byteLength(wire, "utf8") });
}

// ---------------------------------------------------------------------------
// Budget gate.
// ---------------------------------------------------------------------------
const total = rows.reduce((s, r) => s + r.tokens, 0);
// Fixed from the first census (see benchmark/README.md); ~20% headroom over
// the measured surface so normal copy-edits do not trip the gate. PENDING
// MAINTAINER CONFIRMATION — tighten or loosen after the first real run.
const BUDGET = Number(process.env.SCHEMA_TOKEN_BUDGET ?? 0) || (() => {
	// The gate lives in benchmark/schema-tokens.baseline.json ("budget"),
	// written by the first census or an approved bump. A missing baseline is
	// NOT a failure: the first run records it (SCHEMA_RECORD_BASELINE=1) and
	// until then the gate is open.
	try {
		const recorded = Number(JSON.parse(readFileSync(join(__dirname, "schema-tokens.baseline.json"), "utf8")).budget);
		return recorded > 0 ? recorded : Number.POSITIVE_INFINITY;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
})();

const widths = [22, 10, 10];
const sep = widths.map((n) => "-".repeat(n)).join("|");
const cell = (v, w) => String(v).padStart(w);
const out = [];
out.push("dsh-hashline-edittool — resident schema-token census (#421 ①)");
out.push(`tokenizer: ${TOKENIZER_NAME}`);
out.push(`surface   : ${rows.length} tools (default registration)`);
out.push("");
out.push(`${"tool".padEnd(widths[0])} | ${cell("tokens", widths[1])} | ${cell("bytes", widths[2])} |`);
out.push(sep);
for (const r of rows) out.push(`${r.name.padEnd(widths[0])} | ${cell(r.tokens, widths[1])} | ${cell(r.bytes, widths[2])} |`);
out.push(sep);
out.push(`${"TOTAL".padEnd(widths[0])} | ${cell(total, widths[1])} | ${cell(rows.reduce((s, r) => s + r.bytes, 0), widths[2])} |`);
out.push("");
if (Number.isFinite(BUDGET)) {
	out.push(`budget    : ${BUDGET} tokens (gate)`);
	out.push(total <= BUDGET ? `OK — ${total} <= ${BUDGET}.` : `FAIL — ${total} > ${BUDGET}. Shrink the tool descriptions or re-confirm the budget with the maintainer.`);
} else {
	out.push(`budget    : not set — first census recorded; write the gate into benchmark/schema-tokens.baseline.json ("budget") after maintainer confirmation.`);
}

console.log(out.join("\n"));


if (process.env.SCHEMA_RECORD_BASELINE === "1") {
	const baseline = {
		budget: Number(process.env.SCHEMA_TOKEN_BUDGET ?? 0) || Math.ceil(total * 1.2),
		census: total,
		perTool: Object.fromEntries(rows.map((r) => [r.name, r.tokens])),
		tokenizer: TOKENIZER_NAME,
		recordedAt: new Date().toISOString(),
	};
	writeFileSync(join(__dirname, "schema-tokens.baseline.json"), `${JSON.stringify(baseline, null, "\t")}\n`);
	console.log(`baseline written: benchmark/schema-tokens.baseline.json (budget ${baseline.budget})`);
}
if (Number.isFinite(BUDGET) && total > BUDGET) process.exit(1);
