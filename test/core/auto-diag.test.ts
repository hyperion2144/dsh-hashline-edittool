/**
 * Automatic diagnostics after a write (issue #131).
 *
 * Three seams, exactly as the spec's testing decisions lay out:
 *   1. the inline path through the REAL edit tool (fake manager, real write),
 *   2. the async path against `auto-diag` directly (fake session + agent),
 *   3. the config toggle (feature off → no section, no wait).
 *
 * A fake manager is the honest instrument here — the same choice
 * `tool-lsp.test.ts` makes: what this code does with a push is our business;
 * what a real server pushes is the server's.
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
	diagnosticsJson,
	diagnosticsMeta,
	formatDiagnosticsSection,
	prepareWriteDiagnostics,
	type AfterWriteInput,
	type FileDiagnostics,
} from "../../src/lsp/auto-diag.js";
import { applyEffective, getEffectiveConfig, isAutoDiagnosticsEnabled, parseSettingsYaml } from "../../src/config.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { withTempDir } from "../support/fixtures.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { LspSession } from "../../src/lsp/session.js";

const SOURCE = "export const alpha = 1;\nexport const beta = 2;\n";

afterEach(() => {
	setLspManager(undefined);
	vi.useRealTimers();
	// Absent settings = defaults, so the switch lands back on "on".
	applyEffective({});
});

/**
 * A session whose push schedule the test controls. Until `push()` is called
 * the session reports revision 0 and NO diagnostics — a server that has not
 * pushed yet, which is the honest "unknown", not "clean". After it, the
 * revision is 1 and `diagnostics` are on the table, exactly as a real
 * `publishDiagnostics` notification would leave the session.
 *
 * Document version is 1 (matching the `didOpen` a real session would have
 * done); `push()` carries the push's version — undefined = unversioned push.
 * `pullDiagnostics` defaults to unsupported (undefined), so tests exercise
 * the push fallback unless a pull result is installed.
 */
function fakeSession(diagnostics: unknown[] | undefined): {
	session: LspSession;
	push: (opts?: { version?: number | undefined }) => void;
	installPull: (items: readonly unknown[]) => void;
} {
	const state = {
		revision: 0,
		docVersion: 1,
		pushVersion: undefined as number | undefined,
		pullItems: undefined as readonly unknown[] | undefined,
	};
	return {
		session: {
				get diagnosticsRevision() {
					return state.revision;
				},
				getDiagnostics: (uri: string) => (state.revision > 0 ? diagnostics : undefined),
				documentVersion: () => state.docVersion,
				diagnosticsVersion: () => state.pushVersion,
				supportsPullDiagnostics: () => state.pullItems !== undefined,
				pullDiagnostics: async () =>
					state.pullItems === undefined
						? undefined
						: { items: state.pullItems, version: state.docVersion },
			} as never,
		push: (opts?: { version?: number | undefined }) => {
				state.revision += 1;
				state.pushVersion = opts?.version;
			},
		installPull: (items: readonly unknown[]) => {
			state.pullItems = items;
		},
	};
}

/** A manager whose typescript slot is ready and serves the given session. */
function installReady(session: LspSession): void {
	setLspManager({
		readySessionFor: () => session,
		readyLanguages: ["typescript"],
		openDocumentFor: () => () => undefined,
	} as never);
}

function makeExec(cwd: string, inject: ((message: unknown) => void) | undefined): ToolRunContext {
	return {
		signal: new AbortController().signal,
		callId: "call-1",
		name: "edit",
		arguments: {},
		agent: {
			id: "test-session",
			session: { id: "test-session", header: { cwd } },
			...(inject === undefined ? {} : { inject: (m: unknown) => inject(m) }),
		},
		deferContext() {},
		concludeTurn() {},
	} as unknown as ToolRunContext;
}

const DIAGNOSTICS = [
	{ message: "'beta' is declared but never used.", severity: 2, range: { start: { line: 1 } } },
	{ message: "Cannot find name 'gamma'.", severity: 1, range: { start: { line: 0 } } },
	// Information and hints are deliberately NOT reported (#130 Q5).
	{ message: "prefer const", severity: 3, range: { start: { line: 1 } } },
	{ message: "unused hint", severity: 4, range: { start: { line: 1 } } },
];

function makeInput(overrides: Partial<AfterWriteInput> & { cwd: string }): AfterWriteInput {
	const { cwd, ...rest } = overrides;
	// The DEFAULT session is one whose push has ALREADY arrived — the inline
	// story. Tests that want silence build their own unpushed session.
	const hot = fakeSession(DIAGNOSTICS);
	hot.push();
	return {
		session: hot.session,
		languageId: "typescript",
		workspaceRoot: cwd,
		uri: pathToFileURL(join(cwd, "a.ts")).href,
		revisionBefore: 0,
		toolName: "edit",
		text: SOURCE,
		absolutePath: join(cwd, "a.ts"),
		displayPath: "a.ts",
		io: { emitObserved: async () => undefined } as never,
		exec: makeExec(cwd, () => undefined),
		...rest,
	};
}

describe("prepareWriteDiagnostics — the skip rules", () => {
	it("skips entirely when the switch is off", () => {
		applyEffective({ lsp: { auto_diagnostics: false } });
		expect(isAutoDiagnosticsEnabled()).toBe(false);
		expect(prepareWriteDiagnostics("/repo/a.ts", "/repo")).toBeUndefined();
	});

	it("skips when no manager is installed", () => {
		setLspManager(undefined);
		expect(prepareWriteDiagnostics("/repo/a.ts", "/repo")).toBeUndefined();
	});

	it("returns a PENDING context for a cold language and fires the warm", () => {
		// Field report #131 (BUG-1): a cold start used to skip the whole
		// feature because only a READY session qualified. Now the warm is
		// fired (fire-and-forget) and the async path waits the boot out.
		const warm = vi.fn();
		setLspManager({ readySessionFor: () => undefined, warm } as never);
		const context = prepareWriteDiagnostics("/repo/a.ts", "/repo");
		expect(context).toBeDefined();
		expect(context!.session).toBeUndefined();
		expect(context!.languageId).toBe("typescript");
		expect(context!.workspaceRoot).toBe("/repo");
		expect(context!.revisionBefore).toBe(0);
		expect(warm).toHaveBeenCalledWith("typescript", "/repo");
	});

	it("skips files with no language at all", () => {
		installReady(fakeSession(DIAGNOSTICS).session);
		expect(prepareWriteDiagnostics("/repo/a.definitely-not-a-language", "/repo")).toBeUndefined();
	});

	it("snapshots a revision baseline when a session is ready", () => {
		installReady(fakeSession(DIAGNOSTICS).session);
		const context = prepareWriteDiagnostics("/repo/a.ts", "/repo");
		expect(context).toBeDefined();
		expect(context!.revisionBefore).toBe(0);
		expect(context!.uri).toBe(pathToFileURL("/repo/a.ts").href);
	});
});

describe("the inline path — a push inside the 300ms window", () => {
	it("collects, filters to error+warning, and reports `<anchor>:<line>` rows", async () => {
		await withTempDir("auto-diag-inline-", async (cwd) => {
			// A report that never OBSERVED its rows would be servable but not
			// writable — the same trap the reject-echo path fell into (#66).
			const emitObserved = vi.fn(async () => undefined);
			const report = await deliverDiagnosticsAfterWrite(
				makeInput({ cwd, io: { emitObserved } as never }),
			);
			expect(report).toBeDefined();
			expect(report!.rows.map((row) => [row.number, row.messages])).toEqual([
				[1, ["error: Cannot find name 'gamma'."]],
				[2, ["warning: 'beta' is declared but never used."]],
			]);
			// The rows carry the POST-write anchors, so the model can edit with them.
			for (const row of report!.rows) expect(row.hash).not.toBe("");
			// The anchors were SERVED and the observation emitted — an unserved
			// anchor would be decorative, not editable.
			expect(emitObserved).toHaveBeenCalledTimes(1);
			expect(report!.totalSeen).toBe(2);
			expect(report!.truncated).toBe(false);
		});
	});

	it("reports nothing for a clean push and starts no background wait", async () => {
		await withTempDir("auto-diag-clean-", async (cwd) => {
			const inject = vi.fn();
			const clean = fakeSession([]);
			clean.push();
			const input = makeInput({
				cwd,
				session: clean.session,
				exec: makeExec(cwd, (m) => inject(m)),
			});
			const report = await deliverDiagnosticsAfterWrite(input);
			expect(report).toBeUndefined();
			// No late delivery either: a clean file must not wake the model later.
			expect(inject).not.toHaveBeenCalled();
		});
	});

	it("caps the report at 50 entries and says so", async () => {
		await withTempDir("auto-diag-cap-", async (cwd) => {
			const many = Array.from({ length: 60 }, (_, index) => ({
				message: `error ${index}`,
				severity: 1,
				range: { start: { line: 0 } },
			}));
			const capped = fakeSession(many);
			capped.push();
			const report = await deliverDiagnosticsAfterWrite(
				makeInput({ cwd, session: capped.session }),
			);
			expect(report!.rows[0]!.messages).toHaveLength(50);
			expect(report!.totalSeen).toBe(50);
			expect(report!.truncated).toBe(true);
			// And the model-facing section carries the truncation note.
			expect(formatDiagnosticsSection([report!])).toContain("capped at 50");
		});
	});
});

describe("the async path — a push later than the window", () => {
	it("returns immediately, then injects at the next natural step", async () => {
		await withTempDir("auto-diag-async-", async (cwd) => {
			const injected: unknown[] = [];
			const late = fakeSession(DIAGNOSTICS);
			const input = makeInput({
				cwd,
				session: late.session,
				exec: makeExec(cwd, (m) => injected.push(m)),
			});
			const promise = deliverDiagnosticsAfterWrite(input);
			// The inline window elapses with no push: the tool result carries no
			// diagnostics section and returns at the window, not at the push.
			const started = Date.now();
			expect(await promise).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(INLINE_WINDOW_MS + 2_000);
			// But the bounded background wait is listening; when the push lands,
			// the report is injected — without waking anyone.
			late.push();
			await vi.waitFor(() => expect(injected).toHaveLength(1));
			const message = injected[0] as {
				role: string;
				content: Array<{ text: string }>;
				source: { kind: string; plugin: string; form: string };
			};
			expect(message.role).toBe("user");
			expect(message.source.kind).toBe("plugin");
			expect(message.source.plugin).toBe("dsh-hashline-edittool");
			const text = message.content[0]!.text;
			// Story 15: file, tool, and call id all identify the edit that caused it.
			expect(text).toContain("a.ts");
			expect(text).toContain("written by edit (call call-1)");
			// Story 3: the positions are usable anchors, not bare line numbers.
			expect(text).toMatch(/:2: export const beta/);
		});
	});

	it("gives up after 10s and never injects stale diagnostics", async () => {
		await withTempDir("auto-diag-timeout-", async (cwd) => {
			// Date is faked with the timers so the wait's 10s deadline can be
			// crossed without really sleeping for it.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const injected: unknown[] = [];
			const late = fakeSession(DIAGNOSTICS);
			const input = makeInput({
				cwd,
				session: late.session,
				exec: makeExec(cwd, (m) => injected.push(m)),
			});
			const promise = deliverDiagnosticsAfterWrite(input);
			await vi.advanceTimersByTimeAsync(INLINE_WINDOW_MS + 50);
			expect(await promise).toBeUndefined();
			// The budget runs out FIRST; a push that lands after it is dropped.
			await vi.advanceTimersByTimeAsync(ASYNC_TIMEOUT_MS + 100);
			late.push();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(injected).toHaveLength(0);
		});
	});

	it("aborts the background wait with the call's signal", async () => {
		await withTempDir("auto-diag-abort-", async (cwd) => {
			const injected: unknown[] = [];
			const late = fakeSession(DIAGNOSTICS);
			const controller = new AbortController();
			const exec = makeExec(cwd, (m) => injected.push(m));
			(exec as { signal: AbortSignal }).signal = controller.signal;
			const input = makeInput({
				cwd,
				session: late.session,
				exec,
			});
			const promise = deliverDiagnosticsAfterWrite(input);
			// Let the inline window lapse, then cancel the call.
			await new Promise((resolve) => setTimeout(resolve, INLINE_WINDOW_MS + 50));
			expect(await promise).toBeUndefined();
			controller.abort();
			late.push();
			// Long enough for a live poll to see the push; the aborted one must not.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(injected).toHaveLength(0);
		});
	});
});

describe("the model-facing section", () => {
	it("renders anchored rows with the diagnostics indented under their line", async () => {
		await withTempDir("auto-diag-section-", async (cwd) => {
			const report = await deliverDiagnosticsAfterWrite(makeInput({ cwd }));
			const section = formatDiagnosticsSection([report!]);
			expect(section).toContain("LSP diagnostics — a.ts (1 error(s), 1 warning(s))");
			// `<anchor>:<line>: <source>` rows and one ↳ per diagnostic.
			expect(section).toMatch(/:1: export const alpha = 1;/);
			expect(section).toMatch(/^\s*↳ error: Cannot find name 'gamma'\.$/m);
			expect(section).toMatch(/^\s*↳ warning: 'beta' is declared but never used\.$/m);
			// And the meta projection carries the same rows for the web card.
			const meta = diagnosticsMeta([report!]);
			expect(meta).toEqual([
				{ path: "a.ts", rows: report!.rows },
			]);
		});
	});

	it("is empty for an empty report list", () => {
		expect(formatDiagnosticsSection([])).toBe("");
	});
});

describe("the JSON projection — marker-keyed, diff-aligned (#131 field feedback)", () => {
	it("keys rows by `<anchor>:<line>` and spells severities as words", async () => {
		await withTempDir("auto-diag-json-", async (cwd) => {
			const report = await deliverDiagnosticsAfterWrite(makeInput({ cwd }));
			const json = diagnosticsJson([report!]);
			expect(json).toHaveLength(1);
			const rows = json[0]!.rows;
			// NO `hash` field and NO bare `number`: the anchor IS the identity,
			// and the line trails it inside the key — the exact vocabulary of the
			// diff and read envelopes. The value is a dictionary.
			for (const key of Object.keys(rows)) expect(key).toMatch(/^[A-Za-z0-9]{1,8}:\d+$/);
			expect(Object.keys(rows).sort()).toEqual(
				[
					[report!.rows[0]!.hash, report!.rows[0]!.number].join(":"),
					[report!.rows[1]!.hash, report!.rows[1]!.number].join(":"),
				].sort(),
			);
			const first = Object.values(rows)[0]!;
			expect(first).toEqual({
				text: report!.rows[0]!.text,
				messages: report!.rows[0]!.messages,
				// Severity as WORDS: `1` means nothing to a reader.
				severities: ["error"],
			});
		});
	});

	it("falls back to the bare line number when a row has no anchor", () => {
		const synthetic = {
			path: "a.ts",
			absolutePath: "/repo/a.ts",
			toolName: "edit",
			totalSeen: 1,
			truncated: false,
			rows: [{ number: 7, hash: "", text: "x", messages: ["error: boom"], severities: [1] }],
		} as FileDiagnostics;
		const json = diagnosticsJson([synthetic]);
		expect(Object.keys(json[0]!.rows)).toEqual(["7"]);
	});
});

describe("the config toggle (seam 3)", () => {
	it("parses `lsp.auto_diagnostics` from settings.yaml", () => {
		const settings = parseSettingsYaml(
			"hashline:\n  lsp:\n    servers:\n      typescript: tsserver\n    auto_diagnostics: false\n",
		);
		expect(settings.lsp?.servers).toEqual({ typescript: "tsserver" });
		expect(settings.lsp?.auto_diagnostics).toBe(false);
		applyEffective(settings);
		expect(isAutoDiagnosticsEnabled()).toBe(false);
	});

	it("leaves the feature ON when the key is absent", () => {
		applyEffective({ lsp: { servers: { typescript: "tsserver" } } });
		expect(isAutoDiagnosticsEnabled()).toBe(true);
	});

	it("keeps the edit result free of a diagnostics section when off", async () => {
		await withTempDir("auto-diag-off-", async (cwd) => {
			applyEffective({ lsp: { auto_diagnostics: false } });
			const ready = vi.fn(() => fakeSession(DIAGNOSTICS).session);
			setLspManager({ readySessionFor: ready, readyLanguages: ["typescript"] } as never);
			const file = join(cwd, "a.ts");
			await writeFile(file, SOURCE, "utf-8");
			const io = localIO();
			const tool = buildEditTool(io, new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never));
			const exec = makeExec(cwd, () => undefined);
			// Read first: the served-state check is the contract, not an obstacle.
			await buildReadTool(io).execute({ path: file }, exec);
			const hashes = (await import("../../src/hashline/index.js")).lineHashes;
			const anchors = await hashes(SOURCE, file);
			const value = (await tool.execute(
				{
					path: file,
					edits: [
						{
							op: "replace",
							anchor_start: `${anchors[0]}:1`,
							anchor_end: `${anchors[0]}:1`,
							lines: ["export const alpha = 9;"],
						},
					],
				},
				exec,
			)) as { modelText: string; diagnostics?: unknown };
			// The feature is off: no diagnostics section, and the session was
			// never even asked (no ready-lookup happened for the delivery).
			expect(ready).not.toHaveBeenCalled();
			expect(value.diagnostics).toBeUndefined();
			expect(value.modelText).not.toContain("LSP diagnostics");
		});
	});
});

describe("seam 1 — the real edit tool delivers inline diagnostics", () => {
	it("appends the section to the result and persists the capsule meta", async () => {
		await withTempDir("auto-diag-edit-", async (cwd) => {
			const file = join(cwd, "a.ts");
			await writeFile(file, SOURCE, "utf-8");
			const uri = pathToFileURL(file).href;
			// The fake pushes ON the sync (didOpen → push), which is what real
			// hot servers do — that is the whole inline story.
			let revision = 0;
			const pushed = new Map<string, unknown[]>();
			const session = {
				get diagnosticsRevision() {
					return revision;
				},
				getDiagnostics: (u: string) => pushed.get(u),
				documentVersion: () => revision,
				diagnosticsVersion: () => revision,
				supportsPullDiagnostics: () => false,
				pullDiagnostics: async () => undefined,
			} as never;
			setLspManager({
				readySessionFor: () => session,
				readyLanguages: ["typescript"],
				openDocumentFor: () => () => {
					pushed.set(uri, DIAGNOSTICS);
					revision += 1;
				},
			} as never);
			const io = localIO();
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const tool = buildEditTool(io, sandbox);
			const exec = makeExec(cwd, () => undefined);
			// Read first: the served-state check is the contract, not an obstacle.
			await buildReadTool(io).execute({ path: file }, exec);
			const { lineHashes } = await import("../../src/hashline/index.js");
			const anchors = await lineHashes(SOURCE, file);
			const value = (await tool.execute(
				{
					path: file,
					edits: [
						{
							op: "replace",
							anchor_start: `${anchors[0]}:1`,
							anchor_end: `${anchors[0]}:1`,
							lines: ["export const alpha = 9;"],
						},
					],
				},
				exec,
			)) as { modelText: string; diagnostics?: Array<{ path: string; rows: unknown[] }> };
			// The result carries the diagnostics: structured meta for the card…
			expect(value.diagnostics).toHaveLength(1);
			expect(value.diagnostics![0]!.path).toBe(file);
			// …and an anchored section in the model channel.
			expect(value.modelText).toContain("LSP diagnostics");
			expect(value.modelText).toMatch(/error: Cannot find name 'gamma'\./);
		});
	});

	it("carries the marker-keyed dictionary in the JSON envelope", async () => {
			// The field report: the JSON diagnostics must align with the diff dict —
			// `<anchor>:<line>` as the KEY, a dictionary as the value, severities as
			// words. No `hash` field, no bare `number`.
			await withTempDir("auto-diag-edit-json-", async (cwd) => {
				const file = join(cwd, "a.ts");
				await writeFile(file, SOURCE, "utf-8");
				const uri = pathToFileURL(file).href;
				let revision = 0;
				const pushed = new Map<string, unknown[]>();
				const session = {
					get diagnosticsRevision() {
						return revision;
					},
					getDiagnostics: (u: string) => pushed.get(u),
					documentVersion: () => revision,
					diagnosticsVersion: () => revision,
					supportsPullDiagnostics: () => false,
					pullDiagnostics: async () => undefined,
				} as never;
				setLspManager({
					readySessionFor: () => session,
					readyLanguages: ["typescript"],
					openDocumentFor: () => () => {
						pushed.set(uri, DIAGNOSTICS);
						revision += 1;
					},
				} as never);
				const io = localIO();
				const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
				const tool = buildEditTool(io, sandbox);
				const exec = makeExec(cwd, () => undefined);
				await buildReadTool(io).execute({ path: file }, exec);
				const { lineHashes } = await import("../../src/hashline/index.js");
				const anchors = await lineHashes(SOURCE, file);
				const previousMode = getEffectiveConfig().outputFormat;
				applyEffective({ output_format: "json" });
				try {
					const value = (await tool.execute(
						{
							path: file,
							edits: [
								{
									op: "replace",
									anchor_start: `${anchors[0]}:1`,
									anchor_end: `${anchors[0]}:1`,
									lines: ["export const alpha = 9;"],
								},
							],
						},
						exec,
					)) as { modelText: string };
					const envelope = JSON.parse(value.modelText) as {
						diagnostics?: Array<{ path: string; rows: Record<string, { text: string; messages: string[]; severities: string[] }> }>;
					};
					expect(envelope.diagnostics).toHaveLength(1);
					const rows = envelope.diagnostics![0]!.rows;
					const keys = Object.keys(rows);
					expect(keys.length).toBe(2);
					for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9]{1,8}:\d+$/);
					const anyRow = Object.values(rows)[0]!;
					expect(anyRow.severities.every((s) => s === "error" || s === "warning")).toBe(true);
					expect(anyRow.messages[0]).toContain("Cannot find name 'gamma'");
				} finally {
					applyEffective({ output_format: previousMode });
				}
			});
	});

	it("returns the result un-delayed when the server never pushes", async () => {
		await withTempDir("auto-diag-edit-cold-", async (cwd) => {
			const file = join(cwd, "a.ts");
			await writeFile(file, SOURCE, "utf-8");
			// No push at all: revision never moves, getDiagnostics stays undefined.
			installReady(fakeSession(undefined).session);
			const io = localIO();
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const tool = buildEditTool(io, sandbox);
			// Read first: the served-state check is the contract, not an obstacle.
			// The exec carries an agent WITHOUT inject: the async wait starts but
			// has no channel to inject through, and the served SESSION KEY stays
			// the same from read to edit.
			const exec = makeExec(cwd, undefined);
			await buildReadTool(io).execute({ path: file }, exec);
			const { lineHashes } = await import("../../src/hashline/index.js");
			const anchors = await lineHashes(SOURCE, file);
			const started = Date.now();
			const value = (await tool.execute(
				{
					path: file,
					edits: [
						{
							op: "replace",
							anchor_start: `${anchors[0]}:1`,
							anchor_end: `${anchors[0]}:1`,
							lines: ["export const alpha = 9;"],
						},
					],
				},
				exec,
			)) as { modelText: string; diagnostics?: unknown };
			// The edit SUCCEEDED and reported, within the window + slack.
			expect(Date.now() - started).toBeLessThan(INLINE_WINDOW_MS + 5_000);
			expect(value.diagnostics).toBeUndefined();
			expect(value.modelText).not.toContain("LSP diagnostics");
			expect(value.modelText).toContain("Successfully edited");
		});
	});
});

describe("timing sanity", () => {
	it("uses the documented budgets", () => {
		// 800ms: a hot typescript-language-server pushes consistently past
		// 300ms (#131 field report); 800 stays inside the perception band.
		expect(INLINE_WINDOW_MS).toBe(800);
		expect(ASYNC_TIMEOUT_MS).toBe(10_000);
	});
});

describe("seam 1b — write delivers inline diagnostics too (story 20)", () => {
	it("attaches the section to the write result", async () => {
		const { buildWriteShadowTool } = await import("../../src/tools/tool-write-shadow.js");
		await withTempDir("auto-diag-write-", async (cwd) => {
			const file = join(cwd, "a.ts");
			const uri = pathToFileURL(file).href;
			let revision = 0;
			const pushed = new Map<string, unknown[]>();
			const session = {
				get diagnosticsRevision() {
					return revision;
				},
				getDiagnostics: (u: string) => pushed.get(u),
				documentVersion: () => revision,
				diagnosticsVersion: () => revision,
				supportsPullDiagnostics: () => false,
				pullDiagnostics: async () => undefined,
			} as never;
			setLspManager({
				readySessionFor: () => session,
				readyLanguages: ["typescript"],
				openDocumentFor: () => () => {
					pushed.set(uri, DIAGNOSTICS);
					revision += 1;
				},
			} as never);
			const io = localIO();
			const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
			const tool = buildWriteShadowTool(io, sandbox);
			const exec = makeExec(cwd, () => undefined);
			const value = (await tool.execute(
				{ file_path: file, content: SOURCE },
				exec,
			)) as { modelText: string; diagnostics?: Array<{ path: string }> };
			// The write synced the server (didOpen), the push landed inside the
			// window, and the result reports it — the same contract as `edit`.
			expect(value.diagnostics).toHaveLength(1);
			expect(value.modelText).toContain("LSP diagnostics");
			expect(value.modelText).toMatch(/error: Cannot find name 'gamma'\./);
		});
	});
});

describe("BUG-1 regression — a cold start delivers through the async path", () => {
	it("waits for the warm, syncs the fresh session, then injects", async () => {
		await withTempDir("auto-diag-cold-", async (cwd) => {
			const injected: unknown[] = [];
			const late = fakeSession(DIAGNOSTICS);
			const opened: string[] = [];
			// A cold manager: no ready session until `waitForSession` resolves.
			const manager = {
				readySessionFor: () => undefined,
				warm: vi.fn(),
				waitForSession: async () => {
					// Simulate the boot: by the time the wait resolves, the
					// server is up but has NEVER seen this document.
					return late.session;
				},
				openDocumentFor: (_languageId: string, uri: string) => (text: string) => {
					opened.push(`${uri} ${text.split("\n")[0]}`);
				},
			};
			setLspManager(manager as never);
			const input = makeInput({
				cwd,
				session: undefined,
				exec: makeExec(cwd, (m) => injected.push(m)),
			});
			const started = Date.now();
			// No inline wait at all: with nobody to wait on, the delivery
			// hands straight to the background path.
			expect(await deliverDiagnosticsAfterWrite(input)).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(200);
			// The background wait boots the session and TELLS it about the
			// file — an LSP server has no disk watcher, so without this
			// `didOpen` it would never learn the write happened.
			await vi.waitFor(() => expect(opened).toHaveLength(1));
			expect(opened[0]).toContain(input.uri);
			expect(opened[0]).toContain("export const alpha = 1;");
			// Then the push lands and the report is injected.
			late.push();
			await vi.waitFor(() => expect(injected).toHaveLength(1));
			const message = injected[0] as { content: Array<{ text: string }> };
			expect(message.content[0]!.text).toContain("a.ts");
		});
	});

	it("gives up when the boot never finishes", async () => {
		await withTempDir("auto-diag-cold-boot-timeout-", async (cwd) => {
			const injected: unknown[] = [];
			// Date is faked with the timers so the boot wait crosses its
			// budget without really sleeping for it.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const manager = {
				readySessionFor: () => undefined,
				warm: vi.fn(),
				waitForSession: async () => undefined,
				openDocumentFor: () => () => undefined,
			};
			setLspManager(manager as never);
			const input = makeInput({
				cwd,
				session: undefined,
				exec: makeExec(cwd, (m) => injected.push(m)),
			});
			expect(await deliverDiagnosticsAfterWrite(input)).toBeUndefined();
			await vi.advanceTimersByTimeAsync(ASYNC_TIMEOUT_MS + 1_000);
			expect(injected).toHaveLength(0);
		});
	});
});

describe("触发式诊断与版本门控（#131 实测反馈）", () => {
	it("edit 落盘后主动 pull 一次，结果即最终内容的诊断", async () => {
		await withTempDir("auto-diag-pull-", async (cwd) => {
			const hot = fakeSession(DIAGNOSTICS);
			hot.push();
			hot.installPull(DIAGNOSTICS);
			const report = await deliverDiagnosticsAfterWrite(makeInput({ cwd, session: hot.session }));
			// pull 的响应就是针对当前内容的那一次计算，直接返回。
			expect(report).toBeDefined();
			expect(report!.rows).toHaveLength(2);
		});
	});

	it("stale push 被忽略：版本不匹配的推送不算到达", async () => {
		await withTempDir("auto-diag-stale-", async (cwd) => {
			const inject = vi.fn();
			const late = fakeSession(DIAGNOSTICS);
			const input = makeInput({
				cwd,
				session: late.session,
				exec: makeExec(cwd, (m) => inject(m)),
			});
			// 过期推送（版本号小于当前文档版本）：落在 inline 窗口内，但必须被忽略。
			late.push({ version: 0 });
			const report = await deliverDiagnosticsAfterWrite(input);
			expect(report).toBeUndefined();
			// 未推版本号的服务器无法证明新鲜度，推了就收（现状语义不变）。
		});
	});
});
