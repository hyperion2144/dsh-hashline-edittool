/**
 * Issue #75 empirical verification — can a registered tool's model-visible
 * schema be hot-swapped at runtime with the real @deepseek-ai/dsh-tools
 * ToolRuntime (the same registry class the dsh host runs)?
 *
 * Verifies:
 *   1. defineTool compiles the schema at definition time (frozen snapshot).
 *   2. register() returns an exact disposer; re-registering the same name in
 *      the same layer without disposing throws "already registered".
 *   3. dispose() -> register() hot-swaps the schema; runtime.schemas() (the
 *      same projection the per-step system-prompt assembly consumes) reflects
 *      the NEW parameter set immediately — no restart, no new session.
 *   4. Every mutation fires "tools/change".
 *
 * Run: node scripts/verify-dynamic-schema.mjs
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";

// ToolRuntime's constructor calls `ctx.systemPrompt.tools(...)`; stub it.
class SystemPromptStub extends Service {
	constructor(ctx) {
		super(ctx, "systemPrompt");
		this.registeredProviders = 0;
	}
	tools() {
		this.registeredProviders += 1;
	}
	section() {}
}

const ctx = new Context();
new SystemPromptStub(ctx);

let changeEvents = 0;
ctx.on("tools/change", () => {
	changeEvents += 1;
});

const runtime = new ToolRuntime(ctx, {});

// Two generations of the same tool name: v2 adds a REQUIRED `content` param
// (the "switch on" shape from issue #75).
const buildDef = (generation) =>
	defineTool({
		name: "probe_tool",
		description: "schema dynamism probe",
		parameters:
			generation === 2
				? {
						path: { type: "string", required: true, description: "file path" },
						content: {
							type: "string",
							required: true,
							description: "new file content",
						},
					}
				: {
						path: { type: "string", required: true, description: "file path" },
					},
		output: { schema: { type: "string" }, render: () => [] },
		execute: async () => "ok",
	});

const visible = () =>
	runtime
		.schemas()
		.map(
			(s) =>
				`${s.name}({${Object.keys(s.parameters.properties ?? {}).join(",")}})`,
		)
		.join(" ");

// --- 1. schema compiled at defineTool time --------------------------------
const def1 = buildDef(1);
const def2 = buildDef(2);
console.log(
	"[1] defineTool bakes parameters per generation:",
	JSON.stringify(Object.keys(def1.parameters.properties)),
	"vs",
	JSON.stringify(Object.keys(def2.parameters.properties)),
);
console.log(
	"[1] definition parameters frozen (mutation-proof?):",
	Object.isFrozen(def1.parameters),
);

// --- 2. initial registration + duplicate rejection -------------------------
const dispose1 = runtime.register(def1);
console.log("[2] after register v1:", visible());
try {
	runtime.register(buildDef(2));
	console.log("[2] duplicate re-register: NO ERROR (unexpected)");
} catch (err) {
	console.log("[2] duplicate re-register rejected:", err.message);
}

// --- 3. hot swap: dispose -> register (same name, same layer) --------------
dispose1();
const dispose2 = runtime.register(def2);
console.log("[3] after dispose+re-register v2:", visible());
console.log(
	"[3] runtime.get() resolves the NEW definition:",
	Object.keys(runtime.get("probe_tool").parameters.properties).join(","),
);
console.log("[3] tools/change fired", changeEvents, "time(s) so far");

// --- 4. unregister -> tool disappears from the visible set -----------------
dispose2();
const after = runtime.schemas();
console.log("[4] after dispose (visible set):", JSON.stringify(after));
console.log(
	"[4] get() now undefined:",
	runtime.get("probe_tool") === undefined,
);
console.log("[4] tools/change fired", changeEvents, "time(s) total");
