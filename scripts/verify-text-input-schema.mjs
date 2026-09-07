/**
 * Issue #51 empirical verification — what shapes can the dsh-tools parameter
 * schema actually take, and can a tool be dispatched with raw text arguments?
 *
 * Verifies:
 *   1. `defineTool` ALWAYS wraps parameters as `{type:"object", properties:{...}}`
 *      even when the spec is empty or has a single string property.
 *   2. `defineTool` rejects a root `type:"string"` spec — only object root is
 *      allowed for parameter specs.
 *   3. A raw `ToolDefinition` registered through `ctx.tools.register({...})`
 *      (bypassing `defineTool`) accepts arbitrary `parameters` and arbitrary
 *      `execute` args — including a raw string.
 *   4. The agent-loop's `parseArguments` (re-implemented here for unit-test
 *      purposes) JSON-parses the wire-form `arguments` field and falls back to
 *      a raw string when the JSON parse fails — so a model that returns raw
 *      text instead of `{"prompt":"..."}` reaches `execute(args)` with the
 *      raw string, not an object.
 *   5. Calling `runtime.execute(...)` against a raw-`ToolDefinition` tool
 *      hands whatever shape the caller chose (object or string) to the tool
 *      body untouched.
 *
 * Run: node scripts/verify-text-input-schema.mjs
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";

// ToolRuntime's constructor calls `ctx.systemPrompt.tools(...)`; stub it.
class SystemPromptStub extends Service {
	constructor(ctx) {
		super(ctx, "systemPrompt");
	}
	tools() {}
	section() {}
}

const ctx = new Context();
new SystemPromptStub(ctx);

let changeEvents = 0;
ctx.on("tools/change", () => {
	changeEvents += 1;
});

const runtime = new ToolRuntime(ctx, {});

// Mirror of the agent-loop's parser in
// dsh-agent-loop/lib/index.js:147-154 (`parseArguments`).
function parseArguments(raw) {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return raw;
	}
}

// --- 1. defineTool ALWAYS wraps parameters in an object root ----------------
const defEmpty = defineTool({
	name: "empty_props",
	description: "empty properties spec — schema is still object-rooted",
	parameters: {},
	output: { schema: { type: "string" }, render: () => [] },
	execute: async () => "ok",
});
const defOneString = defineTool({
	name: "one_string",
	description: "single required string property",
	parameters: {
		prompt: { type: "string", required: true, description: "the text" },
	},
	output: { schema: { type: "string" }, render: () => [] },
	execute: async () => "ok",
});

console.log("[1] empty-parameters schema:", JSON.stringify(defEmpty.parameters));
console.log(
	"[1] one-string-parameters schema:",
	JSON.stringify(defOneString.parameters),
);
console.log(
	"[1] empty-parameters required array:",
	JSON.stringify(defEmpty.parameters.required ?? "(undefined)"),
);
console.log(
	"[1] one-string-parameters required array:",
	JSON.stringify(defOneString.parameters.required ?? "(undefined)"),
);

// --- 2. defineTool REJECTS a root `type:"string"` spec ----------------------
let rootStringRejected = false;
try {
	defineTool({
		name: "root_string_attempt",
		description: "should fail",
		parameters: { type: "string" }, // nonsense root shape
		output: { schema: { type: "string" }, render: () => [] },
		execute: async () => "ok",
	});
} catch (err) {
	rootStringRejected = true;
	console.log("[2] defineTool root `type:'string'` rejected:", err.message);
}
if (!rootStringRejected) console.log("[2] root type:'string' was accepted (unexpected)");

// --- 3. raw ToolDefinition accepts arbitrary parameters + arbitrary execute args ----
// Register a raw definition (skipping defineTool's compile-time wrapping).
const rawDispatchedArgs = [];
const rawDispose = runtime.register({
	name: "raw_text_or_json",
	description: "accepts whatever shape the model sends",
	parameters: {
		// Note: this `parameters` shape goes straight onto the wire — the
		// adapter (dsh-llm-deepseek, dsh-llm-pi-ai) maps it 1:1 to the model.
		type: "object",
		additionalProperties: true,
		properties: {
			prompt: { type: "string", description: "optional JSON-channel text" },
		},
	},
	output: {
		schema: { type: "string" },
		render: (_args, value) => [{ type: "text", text: String(value) }],
	},
	async execute(args, exec) {
		// Mirror the dispatch contract at dsh-tools/lib/index.js:3193 —
		// the body receives whatever `args` shape the caller / model supplied.
		rawDispatchedArgs.push({
			typeof: typeof args,
			isArray: Array.isArray(args),
			preview:
				typeof args === "string"
					? args.slice(0, 80)
					: JSON.stringify(args).slice(0, 80),
			callName: exec.name,
		});
		return `received ${typeof args === "string" ? `raw(${args.length})` : `object(${Object.keys(args ?? {}).length})`}`;
	},
});

console.log("[3] raw tool visible after register:", runtime.get("raw_text_or_json")?.name);

// --- 4. wire-format parsing: object vs raw-text paths ----------------------
const jsonArgs = parseArguments('{"prompt":"hello world"}');
const textArgs = parseArguments("just plain text without JSON braces");
const emptyArgs = parseArguments("");
console.log("[4] parseArguments(json)    ->", typeof jsonArgs, JSON.stringify(jsonArgs));
console.log("[4] parseArguments(text)    ->", typeof textArgs, JSON.stringify(textArgs));
console.log("[4] parseArguments(empty)   ->", typeof emptyArgs, JSON.stringify(emptyArgs));

// --- 5. runtime.execute against the raw tool — caller-chosen shape ---------
const signal = new AbortController().signal;
const callJson = await runtime.execute({
	callId: "call-json",
	name: "raw_text_or_json",
	arguments: jsonArgs,
	signal,
});
const callText = await runtime.execute({
	callId: "call-text",
	name: "raw_text_or_json",
	arguments: textArgs,
	signal,
});
const callEmpty = await runtime.execute({
	callId: "call-empty",
	name: "raw_text_or_json",
	arguments: emptyArgs,
	signal,
});
console.log("[5] executed JSON-channel call:   ", callJson.isError ? "ERR" : callJson.value);
console.log("[5] executed raw-text channel call:", callText.isError ? "ERR" : callText.value);
console.log("[5] executed empty-args call:     ", callEmpty.isError ? "ERR" : callEmpty.value);
console.log(
	"[5] body saw these argument shapes:",
	JSON.stringify(rawDispatchedArgs),
);

rawDispose();
console.log("[3] after dispose, get() ->", runtime.get("raw_text_or_json") === undefined);
console.log("[*] tools/change fired", changeEvents, "time(s) total");
