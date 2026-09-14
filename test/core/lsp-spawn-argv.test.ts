/**
 * The Windows spawn rule, checked on the platform it can never be checked on.
 *
 * A `.cmd` shim cannot be executed by `spawn` (EINVAL) nor by the OS (batch, not
 * a PE image), so an npm-installed language server only starts when the launch
 * goes through `cmd.exe`. These tests pin the exact command line, because the
 * failure mode is a server that silently never starts on a machine nobody is
 * sitting in front of.
 *
 * The FIRST version of this rule wrapped the line in double quotes. On Windows
 * 11 that produced `'"typescript-language-server --stdio"' is not recognized`:
 * the argument layer escapes an inner `"` as `\"`, and cmd.exe reads that as a
 * backslash plus a quote toggle, not as an escaped quote. So these tests also pin
 * the ABSENCE of quotes — that is the regression, not a style preference.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { escapeForCmd, needsCommandShell, platformSpawnArgv } from "../../src/lsp/spawn-argv.js";
import { serverArgv } from "../../src/lsp/discovery.js";
import type { DiscoveredServer } from "../../src/lsp/discovery.js";

describe("platformSpawnArgv", () => {
	it("leaves the argv alone off Windows", () => {
		expect(platformSpawnArgv(["typescript-language-server", "--stdio"], "darwin")).toEqual([
			"typescript-language-server",
			"--stdio",
		]);
		expect(platformSpawnArgv(["npm", "install", "x"], "linux")).toEqual(["npm", "install", "x"]);
	});

	it("launches a bare name through cmd.exe on Windows, without quoting it", () => {
		// Measured working on Windows 11: no quotes anywhere, so the argument layer
		// wraps the line in the pair `/s` strips and cmd resolves the shim itself.
		expect(platformSpawnArgv(["typescript-language-server", "--stdio"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"typescript-language-server --stdio",
		]);
	});

	it("launches npm.cmd through cmd.exe too", () => {
		expect(platformSpawnArgv(["npm.cmd", "install", "--prefix", "C:\\x", "y"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"npm.cmd install --prefix C:\\x y",
		]);
	});

	it("never emits a double quote on the /c line", () => {
		// The invariant behind the Windows failure: an inner quote cannot survive
		// the argument layer, so a spaced path is caret-escaped instead.
		const argv = platformSpawnArgv(
			["npm", "--prefix", "C:\\Program Files\\x", "--flag=a&b"],
			"win32",
			"cmd.exe",
		);
		expect(argv.join(" ")).not.toContain('"');
		expect(argv[4]).toBe("npm --prefix C:\\Program^ Files\\x --flag^=a^&b");
	});

	it("runs an absolute executable directly — no interpreter needed", () => {
		const argv = ["C:\\Program Files\\nodejs\\node.exe", "--version"];
		expect(platformSpawnArgv(argv, "win32", "cmd.exe")).toEqual([
			"C:\\Program Files\\nodejs\\node.exe",
			"--version",
		]);
	});

	it("escapes what cmd would read as syntax", () => {
		expect(escapeForCmd("a&b")).toBe("a^&b");
		expect(escapeForCmd("a b")).toBe("a^ b");
		expect(escapeForCmd("plain")).toBe("plain");
		// `%` has no escape on a /c line (expansion happens before caret handling)
		// and no language-server path needs one.
		expect(escapeForCmd("100%")).toBe("100%");
	});
});

describe("needsCommandShell", () => {
	it("separates shims from files", () => {
		expect(needsCommandShell("npm")).toBe(true);
		expect(needsCommandShell("npm.cmd")).toBe(true);
		expect(needsCommandShell("server.BAT")).toBe(true);
		expect(needsCommandShell("node.exe")).toBe(false);
		expect(needsCommandShell("C:\\tools\\srv.cmd")).toBe(true);
		expect(needsCommandShell("C:\\tools\\node.exe")).toBe(false);
	});
});

describe("serverArgv", () => {
	const server = {
		executable: "typescript-language-server",
		languages: ["typescript"],
	} as unknown as DiscoveredServer;

	it("carries the stdio default on every platform", () => {
		expect(serverArgv(server, "darwin")).toEqual(["typescript-language-server", "--stdio"]);
		expect(serverArgv(server, "win32")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"typescript-language-server --stdio",
		]);
	});
});
