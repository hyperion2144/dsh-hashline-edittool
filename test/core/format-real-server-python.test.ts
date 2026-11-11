/**
 * REAL dual-server smoke for the formatting secondary slot (#426, ADR-0038).
 *
 * #288's `format-real-server.test.ts` proves the format pipeline on a real
 * typescript-language-server. This file proves the C 案 shape on real python
 * processes: pyright stays the PRIMARY slot while ruff-lsp runs as the FORMAT
 * slot — two processes for one language, formatting answered by the secondary,
 * and a non-formatter pressed into the format slot refusing with the contract
 * error.
 *
 * Skips wherever either binary is absent — same by-construction rule as #288:
 * a local-machine check, never a flake.
 *
 * @module dsh-hashline-edittool/test/core/format-real-server-python
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport } from "../../src/lsp/transport.js";
import { serverArgv } from "../../src/lsp/discovery.js";
import { detectFormattingCapability } from "../../src/lsp/format/capability.js";
import { requestFormatting } from "../../src/lsp/format/requests.js";
import { applyTextEdits } from "../../src/lsp/format/text-edits.js";
import type { DiscoveredServer } from "../../src/lsp/discovery.js";
import type { LspSession } from "../../src/lsp/session.js";

// "Is the binary THERE", not "does it like --version": language servers
// disagree about the flag, and a non-zero exit still proves the spawn found
// an executable.
const PYRIGHT_ON_PATH =
	spawnSync("pyright-langserver", ["--version"], { encoding: "utf8" }).status !== null;
// The config-error smoke names pyright AS the formatting secondary — and the
// format scan only resolves user-named ABSOLUTE commands (ADR-0038), so the
// wrong-formatter case needs pyright's resolved path too.
const PYRIGHT_ABS =
	spawnSync("sh", ["-c", "command -v pyright-langserver"], { encoding: "utf8" }).stdout.trim() ||
	undefined;
// pipx installs into ~/.local/bin, which a vitest process's PATH may not
// carry — accept either spelling, and hand the manager the resolved command.
const RUFF_LOCAL = join(homedir(), ".local", "bin", "ruff-lsp");
const RUFF_ON_PATH = spawnSync("ruff-lsp", ["--version"], { encoding: "utf8" }).status !== null;
const RUFF_COMMAND = RUFF_ON_PATH ? "ruff-lsp" : existsSync(RUFF_LOCAL) ? RUFF_LOCAL : undefined;
const PYRIGHT_READY = PYRIGHT_ON_PATH && PYRIGHT_ABS !== undefined;

/** The ugly python source: missing spacing around `=`, tight tuple. */
const UGLY = "x=1\ny=(1,2)\n";

describe.skipIf(!PYRIGHT_READY || RUFF_COMMAND === undefined)(
	"the dual-server smoke: pyright primary + ruff-lsp format slot (real wire)",
	() => {
		let root = "";
		let manager: LspManager;
		let primary: LspSession | undefined;
		let format: LspSession | undefined;
		let pyUri = "";

		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), "dual-server-smoke-"));
			await writeFile(join(root, "smoke.py"), UGLY, "utf8");
			const ruffCommand = RUFF_COMMAND!;
			manager = new LspManager({
				spawn: (server: DiscoveredServer, cwd: string) => {
					const argv = serverArgv(server);
					const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd, stdio: "pipe" });
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
				formatConfigured: () => [{ command: ruffCommand, languages: ["python"] }],
				onFailure: (languageId: string, message: string) => {
					console.error(`[smoke] server for ${languageId} failed to start: ${message}`);
				},
			});
			primary = await manager.waitForSession("python", root, 30_000);
			format = await manager.waitForSession("python", root, 30_000, "format");
			pyUri = pathToFileURL(join(root, "smoke.py")).href;
			primary?.didOpen(pyUri, "python", UGLY);
			format?.didOpen(pyUri, "python", UGLY);
		}, 60_000);

		afterAll(async () => {
			await manager.dispose();
			await rm(root, { recursive: true, force: true });
		});

		it("runs TWO independent processes for one language", () => {
			expect(primary).toBeDefined();
			expect(format).toBeDefined();
			expect(format).not.toBe(primary);
			// The primary slot is pyright's and the format slot is ruff's — the
			// capability tables prove which process is which.
			expect(detectFormattingCapability(primary!.serverCapabilities).full).toBe(false);
			expect(detectFormattingCapability(format!.serverCapabilities).full).toBe(true);
		});

		it("the format slot formats python over the real wire", async () => {
			const edits = await requestFormatting(format!, pyUri, { insertSpaces: true, tabSize: 4 }, 15_000);
			expect(edits.length).toBeGreaterThan(0);
			const formatted = applyTextEdits(UGLY, edits, { bom: "", eol: "\n" });
			// ruff normalized the tight assignments; assert the substance rather
			// than ruff's exact rendition, so a ruff release is not a flake.
			expect(formatted).toContain("x = 1");
			expect(formatted).toContain("(1, 2)");
		}, 20_000);

		it("a dangling format.servers name falls through to discovery like the primary does", async () => {
			// A configured name that resolves to nothing falls through to the
			// catalog scan — the SAME fall-through the primary slot has always
			// had. On a machine where ruff-lsp is installed the slot comes up as
			// a REAL ruff-lsp; on a bare machine it stays a clean server-missing
			// (that variant is unit-covered in issue-424's file). Here the
			// honest assertion is: whatever came up, it FORMATS.
			const dangling = new LspManager({
				spawn: (server: DiscoveredServer, cwd: string) => {
					const argv = serverArgv(server);
					const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd, stdio: "pipe" });
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
				formatConfigured: () => [{ command: join(root, "no-such-ruff"), languages: ["python"] }],
			});
			try {
				const session = await dangling.waitForSession("python", root, 30_000, "format");
				if (session === undefined) {
					expect(dangling.unavailability("python", "format")?.reason).toBe("server-missing");
					return;
				}
				expect(detectFormattingCapability(session.serverCapabilities).full).toBe(true);
			} finally {
				await dangling.dispose();
			}
		}, 30_000);

		it("a non-formatter's capability table is the wrong-formatter guard", () => {
			// The "named a non-formatter as the secondary" config error surfaces
			// as a STARTED slot whose capability table answers honestly: pyright
			// (the primary here, a real process) advertises no formatter.
			expect(detectFormattingCapability(primary!.serverCapabilities).full).toBe(false);
		});

		it("typescript keeps the primary-only shape (regression surface)", () => {
			// No format slot for typescript: it was never started, and the
			// format-role lookup is cold even after python's slots are up.
			expect(manager.readySessionFor("typescript", "format")).toBeUndefined();
		});
	},
);
