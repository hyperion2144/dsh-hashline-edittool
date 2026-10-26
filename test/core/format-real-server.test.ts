/**
 * REAL language-server smoke for the format pipeline (#275).
 *
 * The 38 fake-manager tests prove the PLUGIN's half (eligibility, sections,
 * wiring, fallbacks). This file proves the SERVER's half on a machine that
 * actually has one: a genuine `typescript-language-server` process is spawned
 * through the same discovery → manager → transport path the plugin uses, and
 * the format requests ride the real wire.
 *
 * Skips wherever the server is absent — CI has no TLS, so this is a local
 * machine check by construction, never a flake.
 *
 * @module dsh-hashline-edittool/test/core/format-real-server
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport } from "../../src/lsp/transport.js";
import { serverArgv } from "../../src/lsp/discovery.js";
import { detectFormattingCapability } from "../../src/lsp/format/capability.js";
import { requestFormatting, requestRangeFormatting } from "../../src/lsp/format/requests.js";
import { applyTextEdits } from "../../src/lsp/format/text-edits.js";
import { inferIndentOptions } from "../../src/lsp/format/indent.js";
import type { LspSession } from "../../src/lsp/session.js";
import type { DiscoveredServer } from "../../src/lsp/discovery.js";

const TLS_ON_PATH =
	spawnSync("typescript-language-server", ["--version"], { encoding: "utf8" }).status === 0;

/** The deliberately ugly source: wrong indent width, tight operators. */
const UGLY = "export function add(a: number, b: number): number {\n\t\treturn a+b;\n}\n";
const PRETTY = "export function add(a: number, b: number): number {\n    return a + b;\n}\n";

describe.skipIf(!TLS_ON_PATH)("the format pipeline against a REAL typescript-language-server", () => {
	let root = "";
	let manager: LspManager;
	let session: LspSession | undefined;
	let uri = "";

	beforeAll(async () => {
		// TLS 6.x refuses to initialize unless the workspace can resolve the
		// `typescript` package — so the smoke file lives in THIS repo's root,
		// where node_modules/typescript is a devDependency, not in /tmp.
		root = process.cwd();
		await writeFile(join(root, ".format-smoke.ts"), UGLY, "utf8");
		manager = new LspManager({
			// A real node child process, bridged into the transport the plugin
			// builds from the harness's subprocess seam — same wire format.
			spawn: (server: DiscoveredServer, cwd: string) => {
				const child = nodeSpawn(serverArgv(server)[0]!, serverArgv(server).slice(1), { cwd, stdio: "pipe" });
				const handle = {
					pid: child.pid ?? -1,
					stdin: child.stdin,
					stdout: child.stdout,
					stderr: child.stderr,
					done: new Promise<{ exitCode: number | null }>((resolve) => {
						child.on("exit", (code) => resolve({ exitCode: code }));
					}),
					terminate: () => void child.kill(),
				};
				return { transport: subprocessTransport(handle as never) };
			},
			projectRoot: root,
			onFailure: (languageId: string, message: string) => {
				console.error(`[smoke] server for ${languageId} failed to start: ${message}`);
			},
		});
		manager.warm("typescript", root);
		session = await manager.waitForSession("typescript", root, 30_000);
		uri = pathToFileURL(join(root, ".format-smoke.ts")).href;
		// The production pipeline syncs (open-or-change) BEFORE requesting —
		// the wire just proved why: an unopened document gets no edits.
		session!.didOpen(uri, "typescript", UGLY);
	}, 60_000);

	afterAll(async () => {
		await manager.dispose();
		await rm(join(root, ".format-smoke.ts"), { force: true });
		await rm(join(root, ".format-smoke-4.ts"), { force: true });
		await rm(join(root, ".format-smoke-336.ts"), { force: true });
	});

	it("discovers a full-document formatting provider in the real capabilities", () => {
		expect(session).toBeDefined();
		const capability = detectFormattingCapability(session!.serverCapabilities);
		expect(capability.full).toBe(true);
		// R1: TLS is one of the two known servers with range support.
		expect(capability.range).toBe(true);
	});

	it("formats the whole document over the real wire", async () => {
		const edits = await requestFormatting(session!, uri, { insertSpaces: true, tabSize: 4 }, 15_000);
		expect(edits.length).toBeGreaterThan(0);
		const formatted = applyTextEdits(UGLY, edits, { bom: "", eol: "\n" });
		// The formatter did the two things the ugly source asked for: the
		// 2-tab indent normalized to the requested width, the tight `a+b`
		// spaced out. Exact-text so a TLS formatting regression is loud.
		expect(formatted).toBe(PRETTY);
	}, 20_000);

	it("formats a range over the real wire (TLS is a range-capable server)", async () => {
		const edits = await requestRangeFormatting(
			session!,
			uri,
			{ start: { line: 1, character: 0 }, end: { line: 1, character: 20 } },
			{ insertSpaces: true, tabSize: 4 },
			15_000,
		);
		expect(edits.length).toBeGreaterThan(0);
		const formatted = applyTextEdits(UGLY, edits, { bom: "", eol: "\n" });
		expect(formatted).toContain("return a + b;");
	}, 20_000);

	it("leaves an already-4-space file untouched over the real wire (#336)", async () => {
		const four = [
			"export class Foo {",
			"    bar(y: number): number {",
			"        if (y > 0) {",
			"            return y * 2;",
			"        }",
			"        return y;",
			"    }",
			"",
			"    baz(): void {",
			"        console.log(1);",
			"    }",
			"}",
			"",
		].join("\n");
		// #336: the file is already 4-space, so the inferred options must
		// describe it and the formatter must leave every line alone.
		expect(inferIndentOptions(four)).toEqual({ insertSpaces: true, tabSize: 4 });
		const fourUri = pathToFileURL(join(root, ".format-smoke-4.ts")).href;
		await writeFile(join(root, ".format-smoke-4.ts"), four, "utf8");
		session!.didOpen(fourUri, "typescript", four);
		const options = inferIndentOptions(four);
		const whole = await requestFormatting(session!, fourUri, options, 15_000);
		expect(applyTextEdits(four, whole, { bom: "", eol: "\n" })).toBe(four);
		const ranged = await requestRangeFormatting(
			session!,
			fourUri,
			{ start: { line: 1, character: 0 }, end: { line: 7, character: 0 } },
			options,
			15_000,
		);
		expect(applyTextEdits(four, ranged, { bom: "", eol: "\n" })).toBe(four);
	}, 30_000);

	it("repairs a 2-space line in a 4-space file, not the whole file (#336 review)", async () => {
		const damaged = [
			"function compute(): number {",
			"    let total = 0;",
			"    for (let i = 0; i < 10; i++) {",
			"  total += i;",
			"    }",
			"    return total;",
			"}",
			"",
		].join("\n");
		// The review matrix: one hand-edited 2-space line must not turn the
		// file into 2-space.
		const options = inferIndentOptions(damaged);
		expect(options).toEqual({ insertSpaces: true, tabSize: 4 });
		const damagedUri = pathToFileURL(join(root, ".format-smoke-336.ts")).href;
		await writeFile(join(root, ".format-smoke-336.ts"), damaged, "utf8");
		session!.didOpen(damagedUri, "typescript", damaged);
		const repaired = damaged.replace("  total += i;", "        total += i;");
		const ranged = await requestRangeFormatting(
			session!,
			damagedUri,
			{ start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
			options,
			15_000,
		);
		expect(applyTextEdits(damaged, ranged, { bom: "", eol: "\n" })).toBe(repaired);
		const whole = await requestFormatting(session!, damagedUri, options, 15_000);
		expect(applyTextEdits(damaged, whole, { bom: "", eol: "\n" })).toBe(repaired);
	}, 30_000);
});
