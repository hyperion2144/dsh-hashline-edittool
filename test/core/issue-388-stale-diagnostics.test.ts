/**
 * #388 — a late LSP diagnostic must never describe a file version the model
 * has already moved past.
 *
 * The field report: two edits on the SAME file. The first edit's diagnostics
 * are slow enough to leave the inline window, so the delivery switches to the
 * bounded background wait; the model edits the same file again; the FIRST
 * edit's background wait then lands — after the newer edit — and the model
 * receives diagnostics whose source rows are the OLD file's, with anchors
 * that no longer exist in the file.
 *
 * The seam is `deliverDiagnosticsAfterWrite` — what every write tool calls
 * after a write — driven by a stand-in language server that keeps ONE text
 * per document and computes its diagnostics from the text it was last given
 * (the full-text-sync contract the real session speaks: `didChange` sends
 * the whole document). The plugin's own probe (`verifiedReport`) hands the
 * server a text, so the stand-in is what makes the bug visible: a probe can
 * put an OLD text back into a server that already learned the new one.
 *
 * What makes this loop red (every element is load-bearing):
 *
 *   1. the first write's diagnostics leave the inline window — the server
 *      answers LATER than the 1s window, so the delivery moves to the
 *      background wait;
 *   2. a second write to the SAME file lands before that wait finishes;
 *   3. the wait therefore completes after the file already moved on.
 *
 * The clock is faked, so the whole sequence is deterministic and instant.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ASYNC_TIMEOUT_MS,
	INLINE_WINDOW_MS,
	deliverDiagnosticsAfterWrite,
	prepareWriteDiagnostics,
	type AfterWriteInput,
	type WriteDiagContext,
} from "../../src/lsp/auto-diag.js";
import { notifyDocumentWritten } from "../../src/lsp/sync.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { withTempDir } from "../support/fixtures.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { LspSession } from "../../src/lsp/session.js";

afterEach(() => {
	setLspManager(undefined);
	vi.useRealTimers();
});

/** The error a server reports for a name it cannot resolve. */
function diagnosticsFor(text: string): unknown[] {
	const items: unknown[] = [];
	text.split("\n").forEach((line, index) => {
		const declared = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
		const bare = /^\s*([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(line);
		const name = declared?.[1] ?? bare?.[1];
		if (name === undefined) return;
		items.push({
			message: `Cannot find name '${name}'.`,
			severity: 1,
			range: { start: { line: index } },
		});
	});
	return items;
}

/**
 * A stand-in language server: one text per document, diagnostics computed
 * from the text it was last given, and every text it was handed recorded so
 * a test can see what the plugin pushed into it.
 */
function fakeServer(options: { delayMs: number }): {
	session: LspSession;
	/** Every text the plugin (or the write path) handed the server, in order. */
	opened: string[];
} {
	const state = {
		opened: [] as string[],
		pushed: undefined as unknown[] | undefined,
		revision: 0,
	};
	const openText = (text: string): void => {
		state.opened.push(text);
		// The server analyses what it was given; the answer lands later.
		setTimeout(() => {
			state.revision += 1;
			state.pushed = diagnosticsFor(text);
		}, options.delayMs);
	};
	return {
		opened: state.opened,
		session: {
			get diagnosticsRevision() {
				return state.revision;
			},
			getDiagnostics: () => state.pushed,
			openText,
			documentVersion: () => 1,
			diagnosticsVersion: () => undefined,
			supportsPullDiagnostics: () => false,
			pullDiagnostics: async () => undefined,
		} as never,
	};
}

/** A manager whose typescript slot is ready and serves the given session. */
function installReady(session: LspSession): void {
	setLspManager({
		readySessionFor: () => session,
		readyLanguages: ["typescript"],
		openDocumentFor: () => (text: string) => (session as { openText?: (t: string) => void }).openText?.(text),
	} as never);
}

function makeExec(cwd: string, inject: (message: unknown) => void): ToolRunContext {
	return {
		signal: new AbortController().signal,
		callId: "call-1",
		name: "edit",
		arguments: {},
		agent: {
			id: "test-session",
			session: { id: "test-session", header: { cwd } },
			inject: (m: unknown) => inject(m),
		},
		deferContext() {},
		concludeTurn() {},
	} as unknown as ToolRunContext;
}

function makeInput(
	ctx: WriteDiagContext,
	text: string,
	absolutePath: string,
	cwd: string,
	inject: (message: unknown) => void,
): AfterWriteInput {
	return {
		...ctx,
		toolName: "edit",
		text,
		absolutePath,
		displayPath: "a.ts",
		io: { emitObserved: async () => undefined } as never,
		exec: makeExec(cwd, inject),
	};
}

/**
 * Let the pending background work land — and keep waiting until it stops.
 *
 * The injection is not a timer: it is real I/O (the anchor mint opens the
 * store and writes rows), and on a FRESH store that takes more event-loop
 * turns than on a warm one. So the loop waits for the CONDITION, then for
 * a quiet period — never for a guessed number of turns.
 */
async function untilQuiet(
	count: () => number,
	quietTurns = 500,
	maxTurns = 20_000,
): Promise<void> {
	let last = -1;
	let quiet = 0;
	for (let i = 0; i < maxTurns; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		const now = count();
		if (now !== last) {
			last = now;
			quiet = 0;
			continue;
		}
		quiet += 1;
		if (now > 0 && quiet >= quietTurns) return;
	}
}

	describe("#388 — a stale diagnostic must not reach the model", () => {
		it("never delivers the first edit's diagnostics after a newer edit landed", async () => {
			await withTempDir("issue-388-stale-", async (cwd) => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
				const server = fakeServer({ delayMs: 900 });
				installReady(server.session);
				const injected: string[] = [];
			const absolutePath = join(cwd, "a.ts");

			// ---- write #1 -------------------------------------------------
			// The OLD content: "gamma" is the marker for it.
			const text1 = "const alpha = 1;\nconst gamma = 2;\n";
			await writeFile(absolutePath, text1, "utf-8");
			const ctx1 = prepareWriteDiagnostics(absolutePath, cwd);
			expect(ctx1).toBeDefined();
			notifyDocumentWritten(absolutePath, text1);
			const first = deliverDiagnosticsAfterWrite(
				makeInput(ctx1!, text1, absolutePath, cwd, (m) => injected.push(JSON.stringify(m))),
			);
			// The inline window lapses with nothing verified: the delivery moves
			// to the bounded background wait.
			await vi.advanceTimersByTimeAsync(INLINE_WINDOW_MS + 50);
			expect(await first).toBeUndefined();

			// ---- write #2 -------------------------------------------------
			// The model edits the same file again before the first wait lands.
			// The NEW content: "delta" is the marker for it.
			const text2 = "const alpha = 1;\nconst delta = 3;\n";
			await writeFile(absolutePath, text2, "utf-8");
			notifyDocumentWritten(absolutePath, text2);
			const ctx2 = prepareWriteDiagnostics(absolutePath, cwd);
			const second = deliverDiagnosticsAfterWrite(
				makeInput(ctx2!, text2, absolutePath, cwd, (m) => injected.push(JSON.stringify(m))),
			);
			prepareWriteDiagnostics(absolutePath, cwd);
			await vi.advanceTimersByTimeAsync(200);

			// ---- the first edit's late diagnostics land --------------------
			await vi.advanceTimersByTimeAsync(ASYNC_TIMEOUT_MS);
			// The second delivery went the same way: the server answers too late
			// for the inline window, so its report also arrives asynchronously.
			expect(await second).toBeUndefined();
			// The report is real I/O behind the injection (the anchor mint writes
			// the store): wait for it to land, and to stop landing.
			await untilQuiet(() => injected.length);

			// THE SYMPTOM: nothing the model receives may describe the OLD
			// file's content.
			expect(injected.join("\n")).not.toContain("gamma");
			// AND the newer write's diagnostics DO arrive: the model is not left
			// in the dark — it gets exactly one report, about the current file.
			expect(injected).toHaveLength(1);
			expect(injected.join("\n")).toContain("delta");
			// AND the mechanism behind it: once the server knows the new text,
			// the plugin must never push the old one back into it.
			const told = server.opened.indexOf(text2);
			expect(told).toBeGreaterThan(-1);
			expect(server.opened.slice(told + 1).join("\n")).not.toContain("gamma");
		});
	});
	});
