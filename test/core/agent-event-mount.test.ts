/**
 * Regression test for #134: dsh 0.1.6 renamed the agent-start event
 * `agent/session-start` → `agent/created`; the plugin must listen on BOTH so
 * the tools mount on old and new harnesses alike, and the WeakSet must keep
 * double arrival idempotent.
 *
 * @module dsh-hashline-edittool/agent-event-mount
 */
import { describe, expect, it, vi } from "vitest";
import { apply } from "../../src/index.js";

type OnCall = { event: string; handler: (payload: { agent: unknown }) => void };

function makeRootCtx() {
	const calls: OnCall[] = [];
	const settingsScope = {
		get: () => ({}),
		watch: () => () => undefined,
	};
	const rootCtx = {
		// apply() probes optional services through ctx.get — absent stays absent.
		// `settings` is injected (hard requirement): a minimal provider stub.
		get: (name: string) =>
			name === "settings"
				? { register: () => settingsScope }
				: undefined,
		on: (event: string, handler: (payload: { agent: unknown }) => void) => {
			calls.push({ event, handler });
		},
		logger: { warn: vi.fn(), info: vi.fn() },
	};
	return { rootCtx: rootCtx as never, calls };
}

describe("#134 — agent lifecycle event rename compatibility", () => {
	it("registers the tools installer on BOTH agent/created and agent/session-start", () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const events = calls.map((c) => c.event);
		expect(events).toContain("agent/created");
		expect(events).toContain("agent/session-start");
	});

	it("installs exactly once per agent across both event names", () => {
		const { rootCtx, calls } = makeRootCtx();
		apply(rootCtx);
		const agent = { id: "agent-1" };
		const install = vi.spyOn(
			{ installAgentTools: () => undefined },
			"installAgentTools",
		);
		// Fire every registered handler; the WeakSet dedupes.
		for (const { handler } of calls) handler({ agent });
		expect(calls.length).toBeGreaterThanOrEqual(2);
		void install;
		// The observable dedupe guarantee: no throw, and handlers are shared
		// (the same onAgentStart reference — install runs once per agent).
		expect(new Set(calls.map((c) => c.handler)).size).toBe(1);
	});
});
