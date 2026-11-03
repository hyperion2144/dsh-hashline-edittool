/**
 * #398 — the first turn of a RESUMED session must see the whole hashline
 * tool surface.
 *
 * Two halves, both observed through the plugin's public surface:
 *
 * - The tools that shadow nothing (`ast_grep`, `ast_edit`, `undo_last_edit`,
 *   `format`, `delete`, `rename`) are registered ONCE at plugin load, on the
 *   plugin's own tool layer — the way every other dsh plugin registers its
 *   tools. Before, they waited for an agent to exist AND for the guidance
 *   override read, so a resumed session's first turn had none of them.
 * - The tools that MUST shadow a built-in (`read`, `write`, `edit`, `grep`,
 *   `lsp`) stay on the agent's own layer, and they are registered BEFORE the
 *   first await. The `agent/created` listener resolves only once the install
 *   is complete, because the host holds a resumed session's queued input
 *   until every listener has returned.
 *
 * @module dsh-hashline-edittool/agent-tool-registration
 */
import { describe, expect, it, vi } from "vitest";
import { apply } from "../../src/index.js";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";

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

function makeAgent(options: { deferEffect?: boolean; builtInLsp?: boolean; registryThrows?: boolean } = {}) {
	const agentTools: string[] = [];
	let deferred: (() => unknown) | undefined;
	// A REAL scoped context: the `lsp` placement decision reads the scope
	// tag to ask the registry what the agent's view already carries.
	const scope = createScope(new Context(), {});
	const builtInLsp = options.builtInLsp === true ? { name: "lsp" } : undefined;
	const agent = {
		id: "agent-1",
		ctx: scope.ctx.extend({
			get: (_name: string) => undefined,
			tools: {
				// The registry's view for this agent: a built-in `lsp` shows up
				// here BEFORE the plugin registers its own.
				get: (name: string) => {
					// A registry that refuses to answer: the probe cannot tell
					// whether a built-in `lsp` is there.
					if (options.registryThrows === true) throw new Error("REGISTRY_UNAVAILABLE");
					return name === "lsp" ? builtInLsp : undefined;
				},
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
		}),
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

describe("#398 — a resumed session's first turn sees the whole tool surface", () => {
	it("registers the tools that shadow nothing at plugin load, before any agent exists", () => {
		const { rootCtx, pluginTools } = makeRootCtx();
		apply(rootCtx);
		expect(pluginTools).toEqual(
			expect.arrayContaining([
				"ast_grep",
				"ast_edit",
				"undo_last_edit",
				"format",
				"delete",
				"rename",
			]),
		);
	});

	it("has every shadowing tool registered by the time the agent/created listener resolves", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created");
		expect(created).toBeDefined();
		// A built-in `lsp` is there: it belongs on the agent's own layer.
		const { agent, agentTools } = makeAgent({ builtInLsp: true });
		await created!.handler({ agent });
		expect(agentTools).toEqual(
			expect.arrayContaining(["read", "write", "edit", "grep", "lsp"]),
		);
	});

	it("keeps the non-shadowing tools off the agent's own layer", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
		for (const name of ["ast_grep", "ast_edit", "undo_last_edit", "format", "delete", "rename"]) {
			expect(agentTools).not.toContain(name);
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
		for (const name of ["ast_grep", "ast_edit", "undo_last_edit", "format", "delete", "rename"]) {
			expect(pluginTools.filter((registered) => registered === name)).toHaveLength(1);
		}
	});

	it("does not let the agent/created listener return before the install has run", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools, runEffect } = makeAgent({ deferEffect: true, builtInLsp: true });
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
		expect(agentTools).toEqual(expect.arrayContaining(["read", "write", "edit", "grep", "lsp"]));
	});

	it("returns from the agent/created listener even when the agent scope is already gone", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const result = created.handler({ agent: makeDisposedAgent() });
		await expect(Promise.resolve(result)).resolves.toBeUndefined();
	});

	it("registers lsp on the agent layer when a built-in lsp is there to shadow", async () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent({ builtInLsp: true });
		await created.handler({ agent });
		expect(agentTools).toContain("lsp");
	});

	it("registers lsp on the plugin layer when no built-in lsp exists", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		const { agent, agentTools } = makeAgent();
		await created.handler({ agent });
		expect(agentTools).not.toContain("lsp");
		expect(pluginTools).toContain("lsp");
	});

	it("registers lsp on the plugin layer when the registry cannot answer", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		// "Cannot tell" is not "there is a built-in": the tool goes where
		// it is present from the first turn of every agent.
		const { agent, agentTools } = makeAgent({ registryThrows: true });
		await created.handler({ agent });
		expect(agentTools).not.toContain("lsp");
		expect(pluginTools).toContain("lsp");
	});

	it("registers the plugin-layer lsp once, not once per agent", async () => {
		const { rootCtx, calls, pluginTools } = makeRootCtx();
		apply(rootCtx);
		const created = calls.find((c) => c.event === "agent/created")!;
		for (const id of ["agent-1", "agent-2"]) {
			const { agent } = makeAgent();
			await created.handler({ agent });
		}
		expect(pluginTools.filter((name) => name === "lsp")).toHaveLength(1);
	});
});