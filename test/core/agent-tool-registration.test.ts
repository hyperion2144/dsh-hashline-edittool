/**
 * #398/#418 — the first turn of a RESUMED session must see the whole hashline
 * tool surface.
 *
 * Two halves, both observed through the plugin's public surface:
 *
 * - The tools that shadow nothing (`ast_grep`, `ast_edit`, `undo_last_edit`,
 *   `format`, `delete`, `rename`) are registered ONCE at plugin load, on the
 *   plugin's own tool layer — the way every other dsh plugin registers its
 *   tools. Before, they waited for an agent to exist AND for the guidance
 *   override read, so a resumed session's first turn had none of them.
 * - The agent-layer tools (`read`, `write`, `edit`, `grep`, plus `lsp` /
 *   `apply_patch` per #418) are registered BEFORE the first await. The
 *   `agent/created` listener resolves only once the install is complete,
 *   because the host holds a resumed session's queued input until every
 *   listener has returned. `lsp` / `apply_patch` probe NO registry (#418):
 *   the probe's per-process ownership check cannot survive a restart, and
 *   its plugin-layer fallback left the tools out of a resumed session's
 *   first turn.
 *
 * @module dsh-hashline-edittool/agent-tool-registration
 */
import { describe, expect, it, vi } from "vitest";
import { apply } from "../../src/index.js";

type ToolDef = { name: string };
type OnCall = {
	event: string;
	handler: (payload: { agent: unknown }) => void | Promise<void>;
};

function makeRootCtx() {
	const calls: OnCall[] = [];
	const pluginTools: string[] = [];
	const rootCtx = {
		// apply() probes optional services through ctx.get — absent stays absent.
		get: (_name: string) => undefined,
		on: (event: string, handler: (payload: { agent: unknown }) => void | Promise<void>) => {
			calls.push({ event, handler });
		},
		logger: { warn: vi.fn(), info: vi.fn() },
		// The plugin layer: tools registered here are inherited by every agent.
		tools: {
			register: (def: ToolDef) => {
				pluginTools.push(def.name);
				return () => undefined;
			},
		},
		fs: { sandboxMode: undefined },
	};
	return { rootCtx: rootCtx as never, calls, pluginTools };
}

function makeAgent(options: { deferEffect?: boolean } = {}) {
	const agentTools: string[] = [];
	let deferred: (() => unknown) | undefined;
	const agent = {
		id: "agent-1",
		ctx: {
			get: (_name: string) => undefined,
			tools: {
				register: (def: ToolDef) => {
					agentTools.push(def.name);
					return () => undefined;
				},
			},
			// cordis effects: run the body, hand back a disposer.
			effect: (fn: () => unknown) => {
				if (options.deferEffect === true) {
					deferred = fn;
					return () => undefined;
				}
				void fn();
				return () => undefined;
			},
		},
	};
	return {
		agent,
		agentTools,
		/** Run the effect body the fake held back — the install's moment of truth. */
		runEffect: (): void => {
			const body = deferred;
			deferred = undefined;
			void body?.();
		},
	};
}

/** An agent whose scope is already gone: `ctx.effect` refuses to run. */
function makeDisposedAgent() {
	return {
		id: "agent-dead",
		ctx: {
			get: (_name: string) => undefined,
			tools: { register: () => () => undefined },
			effect: () => {
				throw new Error("INACTIVE_EFFECT");
			},
		},
	};
}

describe("#398/#418 — a resumed session's first turn sees the whole tool surface", () => {
	it("registers the still-resident tools at plugin load, before any agent exists (#421 ② moved the cold four)", () => {
		const { rootCtx, pluginTools } = makeRootCtx();
		apply(rootCtx);
		expect(pluginTools).toEqual(
			expect.arrayContaining(["undo_last_edit", "delete", "rename"]),
		);
		// #421 ②: the cold four (ast_grep / ast_edit / format / lsp) moved to
		// the agent layer behind the discovery gate — they are NOT here anymore.
		expect(pluginTools).not.toContain("ast_grep");
		expect(pluginTools).not.toContain("ast_edit");
		expect(pluginTools).not.toContain("format");
	});

	it("has every agent-layer tool registered by the time the agent/created listener resolves", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created");
		expect(created).toBeDefined();
		// lsp and apply_patch live on the agent's own layer unconditionally (#418).
		const { agent, agentTools } = makeAgent();
		await created!.handler({ agent });
		expect(agentTools).toEqual(
			expect.arrayContaining(["read", "write", "edit", "grep", "lsp", "apply_patch"]),
		);
	});

	it("registers the cold tools on the agent layer, gated by the discovery flag (#421 ②)", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
			// The registration happens (the mock records it); whether a tool is
			// ACTIVE afterwards is cold-tool-gate.test's subject — there the mock
			// tracks disposals, here only the layer placement matters.
			for (const name of ["ast_grep", "ast_edit", "format", "lsp"]) {
				expect(agentTools).toContain(name);
			}
	});

	it("registers the non-shadowing tools once, not once per agent", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		for (const id of ["agent-1", "agent-2"]) {
			const { agent } = makeAgent();
			await created.handler({ agent });
		}
		for (const name of ["undo_last_edit", "delete", "rename"]) {
			expect(pluginTools.filter((registered) => registered === name)).toHaveLength(1);
		}
	});

	it("does not let the agent/created listener return before the install has run", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools, runEffect } = makeAgent({ deferEffect: true });
		let settled = false;
		const pending = Promise.resolve(created.handler({ agent })).then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(agentTools).toEqual([]);
		runEffect();
		await pending;
		expect(settled).toBe(true);
		expect(agentTools).toEqual(expect.arrayContaining(["read", "write", "edit", "grep", "lsp", "apply_patch"]));
	});

	it("returns from the agent/created listener even when the agent scope is already gone", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const result = created.handler({ agent: makeDisposedAgent() });
		await expect(Promise.resolve(result)).resolves.toBeUndefined();
	});

	it("registers lsp on the agent layer with NO built-in to shadow (#418)", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
		expect(agentTools).toContain("lsp");
		expect(pluginTools).not.toContain("lsp");
	});

	it("registers apply_patch on the agent layer (default-on, #418)", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
		expect(agentTools).toContain("apply_patch");
		expect(pluginTools).not.toContain("apply_patch");
	});

	it("keeps lsp and apply_patch off the plugin layer for every agent", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const first = makeAgent();
		const second = makeAgent();
		await created.handler({ agent: first.agent });
		await created.handler({ agent: second.agent });
		for (const { agentTools } of [first, second]) {
			expect(agentTools).toContain("lsp");
			expect(agentTools).toContain("apply_patch");
		}
		expect(pluginTools).not.toContain("lsp");
		expect(pluginTools).not.toContain("apply_patch");
	});

	it("does not register apply_patch when the setting is off (#418)", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx, { apply_patch: { enabled: false } });
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
		expect(agentTools).not.toContain("apply_patch");
		expect(pluginTools).not.toContain("apply_patch");
	});
});