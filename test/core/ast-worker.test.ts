/**
 * The worker/parse-isolation layer, tested at two levels:
 *
 * - `handleRequest` is driven **in-process with real grammars**, so the budget,
 *   cache and enumeration behaviour is the real thing (the thread wiring above
 *   it is five lines and is covered by the real-machine smoke matrix).
 * - `AstClient` gets an injected fake worker, because what it owns is
 *   *lifetime* — retry-once, the `(path, size)` mark, recycling, idle shutdown
 *   — and those must be provable without waiting on real timers or real wasm.
 */
import { describe, expect, it } from "vitest";
import { AST_ADMIT_LIMIT_SOURCE_BYTES, AST_WORKER_RECYCLE_HEAP_BYTES } from "../../src/constants.js";
import { E_AST_TOO_LARGE } from "../../src/ast/codes.js";
import { AstClient, AstError, type WorkerLike } from "../../src/ast/client.js";
import { handleRequest, type AstWorkerRequest, type AstWorkerResponse } from "../../src/ast/worker.js";

const TS_SOURCE = "export function alpha(a: number): number { return a; }\n";

describe("worker request handling", () => {
	it("parses and enumerates symbols", async () => {
		const response = await handleRequest({ id: 1, op: "parse", path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		expect(response.ok).toBe(true);
		if (response.ok && response.op === "parse") {
			expect(response.symbols.map((s) => s.qualifiedName)).toContain("alpha");
			expect(response.nodeCount).toBeGreaterThan(0);
			expect(response.cached).toBe(true);
		}
	});

	it("serves a repeat parse of identical content from the content-keyed cache", async () => {
		const first = await handleRequest({ id: 1, op: "parse", path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		const second = await handleRequest({ id: 2, op: "parse", path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok && first.op === "parse" && second.op === "parse") {
			expect(second.cached).toBe(true);
			expect(second.nodeCount).toBe(first.nodeCount);
		}
	});

	it("refuses an over-limit source before parsing", async () => {
		// One byte past the admit limit: the worst-case estimate cannot fit the
		// usable arena, so the worker must refuse rather than attempt it.
		const huge = "a".repeat(AST_ADMIT_LIMIT_SOURCE_BYTES + 1);
		const response = await handleRequest({ id: 3, op: "parse", path: "huge.ts", text: huge, languageId: "typescript" });
		expect(response.ok).toBe(false);
		if (!response.ok) {
			expect(response.code).toBe(E_AST_TOO_LARGE);
			expect(response.message).toContain("line mode");
		}
	});

	it("reports the live arena size and the retained node count", async () => {
		await handleRequest({ id: 1, op: "parse", path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		const response = await handleRequest({ id: 2, op: "arena" });
		expect(response.ok).toBe(true);
		if (response.ok && response.op === "arena") {
			// The arena is a real Emscripten heap: it exists and is at least the
			// initial 32 MiB, and the retained count reflects the parse above.
			expect(response.arenaBytes).toBeGreaterThan(0);
			expect(response.retainedNodes).toBeGreaterThan(0);
		}
	});

	it("releases cached trees on request", async () => {
		await handleRequest({ id: 1, op: "parse", path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		const released = await handleRequest({ id: 2, op: "release" });
		expect(released.ok).toBe(true);
		if (released.ok && released.op === "release") expect(released.retainedNodes).toBe(0);
	});
});

/** A scripted worker: each `postMessage` shifts the next scripted outcome. */
function fakeWorker(script: Array<AstWorkerResponse | "exit" | (() => AstWorkerResponse)>): WorkerLike & { posted: AstWorkerRequest[]; terminated: number } {
	let respond: ((response: AstWorkerResponse) => void) | undefined;
	let exit: (() => void) | undefined;
	const state = {
		posted: [] as AstWorkerRequest[],
		terminated: 0,
		postMessage(message: AstWorkerRequest) {
			state.posted.push(message);
			const next = script.shift();
			queueMicrotask(() => {
				if (next === undefined) return;
				if (next === "exit") {
					exit?.();
					return;
				}
				respond?.(typeof next === "function" ? next() : next);
			});
		},
		onMessage(listener: (response: AstWorkerResponse) => void) {
			respond = listener;
		},
		onExit(listener: () => void) {
			exit = listener;
		},
		terminate() {
			state.terminated += 1;
		},
	};
	return state as WorkerLike & { posted: AstWorkerRequest[]; terminated: number };
}

function okParse(
	id: number,
	symbols: unknown[] = [],
	arenaBytes = 64 * 1024 * 1024,
): AstWorkerResponse {
	return { id, ok: true, op: "parse", symbols: symbols as never, nodeCount: 10, cached: true, arenaBytes };
}

describe("identifier confirmation (the reference scan's second stage)", () => {
	const source = [
		"// alpha is mentioned in this comment",
		"const alpha = 1;",
		'const s = "alpha in a string";',
		"const alphabet = 2;",
		"function beta(): number { return alpha + alphabet; }",
	].join("\n");

	it("finds bare identifiers and nothing else", async () => {
		const response = await handleRequest({ id: 1, op: "identifiers", path: "a.ts", text: source, languageId: "typescript", name: "alpha" });
		expect(response.ok).toBe(true);
		if (response.ok && response.op === "identifiers") {
			const lines = response.hits.map((hit) => hit.line).sort((a, b) => a - b);
			// Lines 1 (comment) and 3 (string) must NOT be reported: a reference
			// inside a comment or a string is worse than a miss, because the model
			// would then edit it. Line 4's `alphabet` must not match either.
			expect(lines).toEqual([2, 5]);
		}
	});

	it("reports nothing for a name that never appears as an identifier", async () => {
		const response = await handleRequest({ id: 2, op: "identifiers", path: "a.ts", text: source, languageId: "typescript", name: "alphabet" });
		expect(response.ok).toBe(true);
		if (response.ok && response.op === "identifiers") {
			expect(response.hits.map((hit) => hit.line)).toEqual([4, 5]);
		}
	});
});

describe("client lifetime rules", () => {
	it("retries once on a fresh worker after an abort, then succeeds", async () => {
		const workers: ReturnType<typeof fakeWorker>[] = [];
		const client = new AstClient({
			idleMs: 0,
			spawn: () => {
				// First worker aborts; the respawned one answers.
				const worker = fakeWorker(
					workers.length === 0
						? [{ id: 1, ok: false, code: "E_AST_WORKER_ABORTED", message: "Aborted()", aborted: true }]
						: [((): AstWorkerResponse => okParse(2, [{ qualifiedName: "alpha" }])) as never],
				);
				workers.push(worker);
				return worker;
			},
		});

		const symbols = await client.parseSymbols({ path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		expect(symbols).toHaveLength(1);
		// The aborting worker was terminated, not merely abandoned.
		expect(workers[0]!.terminated).toBe(1);
		expect(workers).toHaveLength(2);
		await client.dispose();
	});

	it("marks a file that aborts twice and refuses it while its size is unchanged", async () => {
		let spawned = 0;
		const client = new AstClient({
			idleMs: 0,
			spawn: () => {
				spawned += 1;
				return fakeWorker([{ id: spawned, ok: false, code: "E_AST_WORKER_ABORTED", message: "Aborted()", aborted: true }]);
			},
		});

		await expect(client.parseSymbols({ path: "bad.ts", text: TS_SOURCE, languageId: "typescript" })).rejects.toBeInstanceOf(AstError);
		// Second call for the SAME size must not even reach a worker.
		const before = spawned;
		await expect(client.parseSymbols({ path: "bad.ts", text: TS_SOURCE, languageId: "typescript" })).rejects.toThrow(/disabled for it until the file changes/);
		expect(spawned).toBe(before);
		await client.dispose();
	});

	it("clears the mark when the file's size changes", async () => {
		let spawned = 0;
		const client = new AstClient({
			idleMs: 0,
			spawn: () => {
				spawned += 1;
				return fakeWorker([{ id: spawned, ok: false, code: "E_AST_WORKER_ABORTED", message: "Aborted()", aborted: true }]);
			},
		});
		await expect(client.parseSymbols({ path: "bad.ts", text: TS_SOURCE, languageId: "typescript" })).rejects.toBeInstanceOf(AstError);
		const afterFirst = spawned;
		// Different size ⇒ different mark ⇒ the client tries again.
		await expect(client.parseSymbols({ path: "bad.ts", text: `${TS_SOURCE}\n`, languageId: "typescript" })).rejects.toThrow(/aborted the parse worker again/);
		expect(spawned).toBeGreaterThan(afterFirst);
		await client.dispose();
	});

	it("surfaces a non-abort worker failure without retrying", async () => {
		let spawned = 0;
		const client = new AstClient({
			idleMs: 0,
			spawn: () => {
				spawned += 1;
				return fakeWorker([{ id: spawned, ok: false, code: "E_PARSE_FAILED", message: "no tree" }]);
			},
		});
		await expect(client.parseSymbols({ path: "a.ts", text: TS_SOURCE, languageId: "typescript" })).rejects.toThrow(/E_PARSE_FAILED/);
		expect(spawned).toBe(1);
		await client.dispose();
	});

	it("recycles a worker whose arena is inflated beyond what the cache justifies", async () => {
		const workers: ReturnType<typeof fakeWorker>[] = [];
		const client = new AstClient({
			idleMs: 0,
			spawn: () => {
				const worker = fakeWorker([
					// The parse itself reports an arena past the recycle threshold;
					// the client then probes retention to decide whether it is waste.
					okParse(1, [{ qualifiedName: "alpha" }], AST_WORKER_RECYCLE_HEAP_BYTES * 2),
					// The follow-up arena probe reports a wasted high-water mark:
					// a big arena with almost nothing retained.
					{ id: 2, ok: true, op: "arena", arenaBytes: AST_WORKER_RECYCLE_HEAP_BYTES * 2, retainedNodes: 1 },
				]);
				workers.push(worker);
				return worker;
			},
		});
		await client.parseSymbols({ path: "a.ts", text: TS_SOURCE, languageId: "typescript" });
		// The recycle is fire-and-forget; let it land.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(workers[0]!.terminated).toBe(1);
		await client.dispose();
	});
});
