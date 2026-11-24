/**
 * #453 — the install command must be the BARE name `npm`, on every platform.
 *
 * The report: on Windows 11 with npm supplied by a Scoop-managed nvm, the
 * settings card's install button exited 1 with
 *
 *     'npm.cmd' 不是内部或外部命令，也不是可运行的程序或批处理文件。
 *
 * That machine has `npm.exe` on PATH (a shim) and the real `npm.cmd` in a
 * versioned directory that is NOT on PATH. The installer hard-coded the
 * extension, so `cmd.exe /d /s /c npm.cmd install …` asked cmd for a file that
 * does not exist — while `cmd /d /s /c npm install …` works, because cmd
 * resolves the bare name through PATHEXT and finds the `.exe`.
 *
 * The rule this pins is the one that makes both installs work: name the
 * PROGRAM, never one of its shims. `needsCommandShell` already sends a bare
 * name through `cmd.exe` (no extension, no separator), so nothing else has to
 * change — cmd does the lookup, and it is the only component that knows what
 * this machine actually installed.
 *
 * @module dsh-hashline-edittool/test/issue-453-lsp-npm-bare-name
 */
import { afterEach, describe, expect, it } from "vitest";
import { installCommandFor, installLspServer, type SpawnLike } from "../../src/lsp/install-server.js";
import { platformSpawnArgv } from "../../src/lsp/spawn-argv.js";

/** The argv the installer actually handed to the subprocess seam. */
interface Recorded {
	argv: readonly string[];
}

/**
 * A spawn seam that records its argv and reports success.
 *
 * The npm path then checks for the launcher it expects, which is absent here —
 * that is fine and deliberate: the argv is what this file is about, and the
 * outcome's own wording is pinned by `issue-375-host-text-wire`.
 *
 * @returns the seam and the list it appends to.
 */
function recordingSpawn(): { spawn: SpawnLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const spawn: SpawnLike = (spec) => {
		calls.push({ argv: spec.argv });
		return {
			pid: 4242,
			stdin: undefined,
			stdout: { on: () => undefined },
			stderr: { on: () => undefined },
			done: Promise.resolve({ exitCode: 0, signal: null }),
			terminate: () => {},
			waitForExit: async () => true,
		};
	};
	return { spawn, calls };
}

/**
 * Run `body` with `process.platform` reporting `platform` and `ComSpec` pinned.
 *
 * The installer reads the platform directly (it is the machine it runs on, not
 * a parameter), so the only way to exercise the Windows branch from a POSIX
 * runner is to stub the property. It is configurable on every Node this repo
 * supports, and it is restored in a `finally` so a throwing case cannot leak
 * the stub into the next file.
 *
 * `ComSpec` is pinned for the same reason `lsp-spawn-argv.test.ts` pins it: on
 * a real Windows box the variable holds an ABSOLUTE path
 * (`C:\Windows\system32\cmd.exe`), so an expectation written as the bare
 * `cmd.exe` passes on Linux and fails on the one platform this file exists to
 * describe. Measured on the Windows CI leg of PR #455.
 *
 * @param platform - the platform to report.
 * @param body - the assertions to run under it.
 */
async function withPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
	const originalPlatform = process.platform;
	const originalComspec = process.env.ComSpec;
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	process.env.ComSpec = "cmd.exe";
	try {
		await body();
	} finally {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		if (originalComspec === undefined) delete process.env.ComSpec;
		else process.env.ComSpec = originalComspec;
	}
}

/** The platform this runner really is, captured before any case stubs it. */
const REAL_PLATFORM = process.platform;

afterEach(() => {
	// Belt and braces: a case that throws before its own `finally` must not
	// leave the runner believing it is on Windows. Compared against the
	// runner's OWN platform, not against a literal — the Windows CI leg is
	// legitimately `win32` and a literal would fail every case there.
	expect(process.platform).toBe(REAL_PLATFORM);
});

describe("#453 — the npm install names the program, not a shim", () => {
	it("spawns the bare name on Windows, so cmd's PATHEXT finds npm.exe or npm.cmd", async () => {
		await withPlatform("win32", async () => {
			const { spawn, calls } = recordingSpawn();
			await installLspServer("typescript", spawn);

			expect(calls).toHaveLength(1);
			const argv = calls[0]!.argv;
			// The translation still goes through the interpreter — a bare name
			// has no extension, so `needsCommandShell` says yes.
			expect(argv.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
			// THE FIX: the program cmd is asked to resolve is `npm`, and cmd
			// picks `.exe` or `.cmd` from PATHEXT. Naming either one here is
			// what broke the Scoop/nvm machine.
			expect(argv[4]).toBe("npm");
			expect(argv).not.toContain("npm.cmd");
		});
	});

	it("spawns the bare name off Windows too, unchanged", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			await withPlatform(platform, async () => {
				const { spawn, calls } = recordingSpawn();
				await installLspServer("typescript", spawn);
				expect(calls[0]!.argv[0]).toBe("npm");
			});
		}
	});

	it("runs the command the catalog ANSWERS — the two spellings cannot disagree", async () => {
		// The invariant behind the bug: `installCommandFor` has always answered
		// `["npm"]` (a bare name), and the spawn path quietly substituted
		// `npm.cmd`. Neither function reaches the card — `canInstallServer` is
		// the only thing that does, as a boolean — so this pins an INTERNAL
		// agreement, not a user-visible one. It is still the invariant that
		// broke: the module said `npm` in one place and ran `npm.cmd` in another.
		for (const platform of ["darwin", "linux", "win32"] as const) {
			await withPlatform(platform, async () => {
				const answered = installCommandFor("typescript", platform);
				expect(answered).toEqual(["npm"]);

				const { spawn, calls } = recordingSpawn();
				await installLspServer("typescript", spawn);
				const spawned = calls[0]!.argv;
				// On Windows the command is the interpreter's argument; elsewhere
				// it is argv[0] itself.
				const command = platform === "win32" ? spawned[4] : spawned[0];
				expect(command).toBe(answered![0]);
			});
		}
	});

	it("keeps the rest of the argv intact — the prefix, the flags, the package", async () => {
		// The fix is one token. Everything else the install needs must survive
		// it, so the whole line is pinned rather than just the first element.
		await withPlatform("win32", async () => {
			const { spawn, calls } = recordingSpawn();
			await installLspServer("typescript", spawn);
			const argv = calls[0]!.argv;
			expect(argv.slice(5)).toEqual([
				"install",
				"--prefix",
				expect.stringContaining("servers"),
				"--no-audit",
				"--no-fund",
				// cmd's own escaping: the caret is consumed by the interpreter, so
				// npm still reads `--loglevel=error`. Pinned here because the
				// install's argv is the one place a stray caret would reach npm.
				"--loglevel^=error",
				"typescript-language-server",
			]);
		});
	});

	it("translates a bare npm through cmd.exe, which is what makes the lookup work", () => {
		// The other half of the claim, checked without the installer: the
		// translation a bare name gets is the interpreter, and the name is left
		// alone for cmd to resolve.
		expect(platformSpawnArgv(["npm", "install", "--prefix", "C:\\x", "y"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"npm",
			"install",
			"--prefix",
			"C:\\x",
			"y",
		]);
	});
});
