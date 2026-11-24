/**
 * #450 — a disposed agent must not be able to kill the host.
 *
 * The report: an AgentTeams team was archived (its members `removed`), the
 * parent session ran one ordinary `edit`, and the DSH host exited with
 * `INACTIVE_EFFECT`. Three facts had to line up:
 *
 * 1. the process-wide LSP manager held a root resolver bound to the LAST
 *    created agent — the archived child;
 * 2. `warm()` is `void this.#start(...)`, and `#start` awaited that resolver
 *    OUTSIDE its `try`;
 * 3. the host turns any unhandled rejection into `fatal load failure` +
 *    `process.exit(1)`.
 *
 * The fix removes the resolver entirely (ADR-0043): the root is a per-call
 * argument, so the manager holds no agent reference and there is no disposed
 * context left to call. These tests pin the two halves of that claim — the
 * structural one (no resolver exists) and the behavioural one (a throwing
 * root cannot escape as an unhandled rejection).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport, type SubprocessLike } from "../../src/lsp/transport.js";

const ROOT = "/repo";
const OTHER_ROOT = "/repo/.agents/worktrees/x";

/** A server that never answers: the spawn already happened, which is the fact under test. */
function silentHandle(): SubprocessLike {
	return {
		pid: 4242,
		stdin: { write: () => true },
		stdout: { on: () => undefined },
		stderr: { on: () => undefined },
		done: new Promise(() => undefined),
		async waitForExit() {
			return true;
		},
		terminate() {},
	};
}

function managerSpawning(spawns: string[]): LspManager {
	return new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async () => true,
		initializeTimeoutMs: 200,
		spawn: (_server, cwd) => {
			spawns.push(cwd);
			return { transport: subprocessTransport(silentHandle()) };
		},
	});
}

describe("#450 — the slot root is a per-call fact", () => {
	it("keeps no root resolver on the manager at all", () => {
		const source = readFileSync(join(process.cwd(), "src", "lsp", "manager.ts"), "utf8");
		// The structural half: the crash was a manager-held agent reference.
		// If either name comes back, the disposed-context window comes back.
		expect(source).not.toContain("setRootResolver");
		expect(source).not.toContain("#rootResolver");
		expect(source).not.toContain("#workspaceRoot");
	});

	it("keys slots by workspace root, so two directories get two servers", async () => {
		const spawns: string[] = [];
		const manager = managerSpawning(spawns);
		manager.warm(ROOT, "typescript");
		manager.warm(OTHER_ROOT, "typescript");
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(spawns).toEqual([ROOT, OTHER_ROOT]);
		await manager.dispose();
	});

	it("shares one server when two callers name the same root", async () => {
		const spawns: string[] = [];
		const manager = managerSpawning(spawns);
		manager.warm(ROOT, "typescript");
		manager.warm(ROOT, "typescript");
		manager.warm(ROOT, "typescript");
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(spawns).toHaveLength(1);
		await manager.dispose();
	});

	it("never lets a failing start escape as an unhandled rejection", async () => {
		// The behavioural half. A spawn that throws stands in for ANY failure
		// inside #start — the shape is what matters: `warm` is fire-and-forget,
		// so an escaping rejection reaches the host's fail-loud handler and
		// exits the process. The host's own handler is what killed the app.
		const seen: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			seen.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const manager = new LspManager({
				pathDirs: ["/bin"],
				isExecutable: async () => true,
				initializeTimeoutMs: 200,
				spawn: () => {
					throw new Error("cannot create effect on inactive context");
				},
			});
			manager.warm(ROOT, "typescript");
			for (let i = 0; i < 50; i++) await Promise.resolve();
			// The failure is RECORDED, not thrown: the slot reports it and the
			// retry backoff decides when to try again (#318).
			expect(manager.unavailability(ROOT, "typescript")?.reason).toBe("lsp-unavailable");
			await manager.dispose();
		} finally {
			process.off("unhandledRejection", onRejection);
		}
		expect(seen).toEqual([]);
	});

	it("reports every root a language is ready in, not just one", async () => {
		const manager = managerSpawning([]);
		// A failed slot is enough to prove the row carries its root; a ready one
		// would need a handshake this test does not care about.
		manager.warm(ROOT, "typescript");
		manager.warm(OTHER_ROOT, "typescript");
		for (let i = 0; i < 50; i++) await Promise.resolve();
		const rows = manager.snapshot().filter((row) => row.languageId === "typescript");
		expect(rows.map((row) => row.root).sort()).toEqual([OTHER_ROOT, ROOT].sort());
		await manager.dispose();
	});
});
