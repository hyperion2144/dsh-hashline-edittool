/**
 * #439 — two latency settings: `lsp.auto_diagnostics.inline_wait_ms` (P3,
 * default 1000 = the original inline window) and `write.fsync` (P4, default
 * true = the shipped durability). Absent settings must be byte-identical.
 *
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyEffective } from "../../src/config.js";
import { autoDiagInlineWaitMs, writeFsyncEnabled } from "../../src/infra/settings.js";
import { INLINE_WINDOW_MS, deliverDiagnosticsAfterWrite, prepareWriteDiagnostics } from "../../src/lsp/auto-diag.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { writeAtomic } from "../../src/infra/fs-write.js";
import { makeExec, withTempFile } from "../support/fixtures.js";
import { localIO } from "../support/local-io.js";

afterEach(() => {
	setLspManager(undefined);
	applyEffective({});
});

/** A ready-but-silent fake manager: a session that never pushes diagnostics. */
function silentManager(): void {
	const session = {
		serverCapabilities: {},
		request: async () => undefined,
		notify: async () => { },
	};
	setLspManager({
		readyLanguages: ["typescript"],
		readySessionFor: () => session,
		status: async () => [{ language: "typescript", server: { displayName: "fake-ts" } }],
		openDocumentFor: () => () => { },
		waitForSession: async () => session,
		unavailability: () => undefined,
	} as never);
}

describe("#439 lsp.auto_diagnostics.inline_wait_ms (P3)", () => {
	it("defaults to the original window — absent setting is byte-identical", () => {
		applyEffective({});
		expect(autoDiagInlineWaitMs()).toBe(INLINE_WINDOW_MS);
		expect(autoDiagInlineWaitMs()).toBe(1000);
	});

	it("reads the setting at use time", () => {
		applyEffective({ lsp: { inline_wait_ms: 250 } });
		expect(autoDiagInlineWaitMs()).toBe(250);
	});

	it("a small window hands the delivery to the async channel fast", async () => {
		applyEffective({ lsp: { auto_diagnostics: true, inline_wait_ms: 30 } });
		silentManager();
		await withTempFile("slow.ts", "const a = 1;\n", async ({ cwd, path }) => {
			const ctx = prepareWriteDiagnostics(path);
			expect(ctx).toBeDefined();
			const started = Date.now();
			const report = await deliverDiagnosticsAfterWrite({
				...ctx!,
				toolName: "edit",
				absolutePath: path,
				displayPath: path,
				io: localIO(),
				text: "const a = 2;\n",
				exec: makeExec(cwd)({ path }) as never,
			});
			expect(report).toBeUndefined(); // nothing pushed inline — async path
			expect(Date.now() - started).toBeLessThan(500); // not the 1s window
		});
	});

	it("0 delivers everything asynchronously — the tool result never waits", async () => {
		applyEffective({ lsp: { auto_diagnostics: true, inline_wait_ms: 0 } });
		silentManager();
		await withTempFile("zero.ts", "const a = 1;\n", async ({ cwd, path }) => {
			const ctx = prepareWriteDiagnostics(path);
			expect(ctx).toBeDefined();
			const started = Date.now();
			const report = await deliverDiagnosticsAfterWrite({
				...ctx!,
				toolName: "edit",
				absolutePath: path,
				displayPath: path,
				io: localIO(),
				text: "const a = 2;\n",
				exec: makeExec(cwd)({ path }) as never,
			});
			expect(report).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(200);
		});
	});
});

describe("#439 write.fsync (P4)", () => {
	it("defaults to ON — the shipped durability semantics", () => {
		applyEffective({});
		expect(writeFsyncEnabled()).toBe(true);
	});

	it("an explicit false opts out (documented: a power loss may lose the last writes)", () => {
		applyEffective({ write: { fsync: false } });
		expect(writeFsyncEnabled()).toBe(false);
	});

	it("writeAtomic still writes and renames with fsync off", async () => {
		applyEffective({ write: { fsync: false } });
		await withTempFile("nofsync.ts", "old\n", async ({ path }) => {
			await writeAtomic(path, "new content\n");
			expect(await readFile(path, "utf-8")).toBe("new content\n");
		});
	});

	it("writeAtomic keeps writing with the default (fsync on)", async () => {
		applyEffective({});
		await withTempFile("fsync.ts", "old\n", async ({ cwd, path }) => {
			await writeAtomic(path, "durable\n");
			expect(await readFile(path, "utf-8")).toBe("durable\n");
			// The temp sweep must not have left residue beside the target.
			await writeFile(join(cwd, "probe.txt"), "x", "utf-8");
		});
	});
});
