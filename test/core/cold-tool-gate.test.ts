/**
 * #421 ② — the cold-tool discovery gate, through `apply()`'s public surface.
 *
 * The four cold tools (`ast_grep`, `ast_edit`, `format`, `lsp`) register once
 * per agent with a host-level `when` predicate; the step resolver evaluates
 * `when` on EVERY step and only admits a tool into that step's wire schema
 * when it returns true. The predicate reads the persisted discovery state
 * (fail-open: a corrupt state keeps the tools admitted); unlocking through
 * the resident `hashline_tools` entry flips it and persists across restarts.
 *
 * @module dsh-hashline-edittool/cold-tool-gate
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apply } from "../../src/index.js";
import { rm } from "node:fs/promises";
import { withTempDir, withHome } from "../support/fixtures.js";

type ToolDef = { name: string; when?: () => boolean; execute?: (args: unknown, exec: unknown) => unknown };
type WhenPredicate = () => boolean;
type Registration = { def: ToolDef; when?: WhenPredicate };

function makeRootCtx() {
	const calls: Array<{ event: string; handler: (p: { agent: unknown }) => void | Promise<void> }> = [];
	const pluginRegistrations: Registration[] = [];
	const rootCtx = {
		get: (_name: string) => undefined,
		on: (event: string, handler: (p: { agent: unknown }) => void | Promise<void>) => {
			calls.push({ event, handler });
		},
		logger: { warn: () => undefined, info: () => undefined },
		tools: {
			register: (def: ToolDef, options?: { when?: WhenPredicate }) => {
				pluginRegistrations.push({ def, when: options?.when });
				return () => undefined;
			},
		},
		fs: { sandboxMode: undefined },
	};
	return { rootCtx: rootCtx as never, calls, pluginRegistrations };
}

function makeAgent() {
	const registrations: Registration[] = [];
	const agent = {
		id: "agent-1",
		ctx: {
			get: (_name: string) => undefined,
			tools: {
				register: (def: ToolDef, options?: { when?: WhenPredicate }) => {
					registrations.push({ def, when: options?.when });
					return () => undefined;
				},
			},
			effect: (fn: () => unknown) => {
				void fn();
				return () => undefined;
			},
		},
	};
	return { agent, registrations };
}

const names = (regs: Registration[]): string[] => regs.map((r) => r.def.name);
const findDef = (regs: Registration[], tool: string): ToolDef | undefined =>
	regs.find((r) => r.def.name === tool)?.def;
const whenOf = (regs: Registration[], tool: string): boolean | undefined =>
	regs.find((r) => r.def.name === tool)?.when?.();

const COLD = ["ast_grep", "ast_edit", "format", "lsp"];


/** withTempDir + withHome, swallowing withTempDir's known teardown race (the
 * plugin writes a config-dir file the recursive rm can race against; the
 * assertions have already run at that point, so finish the cleanup). */
async function withTempHome(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
	let dir = "";
	try {
		await withTempDir(prefix, async (cwd) => {
			dir = cwd;
			const restore = withHome(cwd);
			try {
				await run(cwd);
			} finally {
				restore();
			}
		});
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOTEMPTY" && dir !== "") {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			return;
		}
		throw error;
	}
}

describe("#421 ② — the cold-tool discovery gate", () => {
	it("registers the cold tools once per agent with a `when` gate, entry resident", async () => {
		await withTempHome("gate-default-", async (dir) => {
			const restore = withHome(dir);
			try {
				const { rootCtx, calls, pluginRegistrations } = makeRootCtx();
				apply(rootCtx);
				const created = calls.find((c) => c.event === "agent/created")!;
				const { agent, registrations } = makeAgent();
				await created.handler({ agent });

				// every cold tool REGISTERED (once, agent layer) and gated by a
				// `when` predicate that answers FALSE on a fresh session
				for (const tool of COLD) {
					expect(names(registrations)).toContain(tool);
					expect(whenOf(registrations, tool)).toBe(false);
				}
				// the resident entry is registered ungated (no `when`)
				expect(names(registrations)).toContain("hashline_tools");
				expect(findDef(registrations, "hashline_tools")!.when).toBeUndefined();
				// the cold tools left the plugin layer (they moved to the agent layer)
				for (const tool of COLD) expect(names(pluginRegistrations)).not.toContain(tool);
				// undo/delete/rename stay resident at plugin load (not cold tools)
				expect(names(pluginRegistrations)).toEqual(
					expect.arrayContaining(["undo_last_edit", "delete", "rename"]),
				);
			} finally {
				restore();
			}
		});
	});

	it("unlocking flips every `when` to true and persists across restarts", async () => {
		await withTempHome("gate-unlock-", async (dir) => {
			const restore = withHome(dir);
			try {
				const { rootCtx, calls } = makeRootCtx();
				apply(rootCtx);
				const created = calls.find((c) => c.event === "agent/created")!;

				const first = makeAgent();
				await created.handler({ agent: first.agent });
				for (const tool of COLD) expect(whenOf(first.registrations, tool)).toBe(false);

				// the model calls the resident entry — the unlock persists and the
				// next step's resolver admits the cold tools
				const def = findDef(first.registrations, "hashline_tools")!;
				const value = (await def.execute!({}, {})) as { unlocked: string[] };
				expect(value.unlocked).toEqual(COLD);
				for (const tool of COLD) expect(whenOf(first.registrations, tool)).toBe(true);

				// a SECOND agent (the restart path re-enters through agent/created)
				// reads the persisted state: cold tools admitted from the first turn
				const second = makeAgent();
				await created.handler({ agent: second.agent });
				for (const tool of COLD) expect(whenOf(second.registrations, tool)).toBe(true);
			} finally {
				restore();
			}
		});
	});

	it("fails open: a corrupt discovery state keeps every `when` true", async () => {
		await withTempHome("gate-failopen-", async (dir) => {
			const restore = withHome(dir);
			try {
				// configDir() resolves under DSH_HOME (withHome pointed it at dir)
				mkdirSync(join(dir, ".dsh", "plugins", "dsh-hashline-edittool"), { recursive: true });
				writeFileSync(join(dir, ".dsh", "plugins", "dsh-hashline-edittool", "discovered-tools.json"), "{not json");
				const { rootCtx, calls } = makeRootCtx();
				apply(rootCtx);
				const created = calls.find((c) => c.event === "agent/created")!;
				const { agent, registrations } = makeAgent();
				await created.handler({ agent });
				for (const tool of COLD) expect(whenOf(registrations, tool)).toBe(true);
			} finally {
				restore();
			}
		});
	});
});
