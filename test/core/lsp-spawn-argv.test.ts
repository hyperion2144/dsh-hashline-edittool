/**
 * The Windows spawn rule, checked on the platform it can never be checked on.
 *
 * A `.cmd` shim cannot be executed by `spawn` (EINVAL) nor by the OS (batch, not
 * a PE image), so an npm-installed language server only starts when the launch
 * goes through `cmd.exe`. These tests pin the exact argv, because the failure
 * mode is a server that silently never starts on a machine nobody is sitting in
 * front of.
 *
 * Two earlier versions of this rule were wrong on Windows 11, both measured
 * there against this plugin's own launch:
 *
 *   1. `"command --args"` as ONE entry WITH outer quotes → the argument layer
 *      escaped the inner quotes as `\"`, cmd reads that as a backslash plus a
 *      quote toggle, and the whole line became one unrecognised command name.
 *   2. the same line as one entry WITHOUT quotes → the argument layer quoted the
 *      entry itself (it contains a space), so cmd still saw one token.
 *
 * What works is keeping the command and its arguments as SEPARATE entries: no
 * entry contains a space, nothing is quoted, and cmd parses the line itself.
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

	it("keeps the command and its arguments as SEPARATE entries", () => {
		// Measured working on Windows 11. Joining them into one entry is what broke
		// both earlier attempts: whatever quoting the argument layer adds, cmd ends
		// up looking for a program whose name contains a space.
		expect(platformSpawnArgv(["typescript-language-server", "--stdio"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"typescript-language-server",
			"--stdio",
		]);
	});

	it("launches npm.cmd through cmd.exe too", () => {
		expect(platformSpawnArgv(["npm.cmd", "install", "--prefix", "C:\\x", "y"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"npm.cmd",
			"install",
			"--prefix",
			"C:\\x",
			"y",
		]);
	});

	it("leaves a spaced argument intact for cmd's own quote handling", () => {
		// The argument layer quotes it (it contains a space), cmd reads double
		// quotes natively, and `/s` only strips when the FIRST character after /c
		// is a quote — which it is not here. Caret-escaping the space instead would
		// put a literal caret inside those quotes.
		const argv = platformSpawnArgv(["npm", "--prefix", "C:\\Program Files\\x"], "win32", "cmd.exe");
		expect(argv).toEqual(["cmd.exe", "/d", "/s", "/c", "npm", "--prefix", "C:\\Program Files\\x"]);
		expect(argv.join(" ")).not.toContain('"');
	});

	it("escapes the syntax characters that do not need quoting", () => {
		// No space means no quoting, so the caret survives into cmd's parser.
		expect(platformSpawnArgv(["npm", "--flag=a&b"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"npm",
			"--flag^=a^&b",
		]);
	});

	it("runs an absolute executable directly — no interpreter needed", () => {
		const argv = ["C:\\Program Files\\nodejs\\node.exe", "--version"];
		expect(platformSpawnArgv(argv, "win32", "cmd.exe")).toEqual([
			"C:\\Program Files\\nodejs\\node.exe",
			"--version",
		]);
	});

	it("escapes cmd syntax but never a space", () => {
		expect(escapeForCmd("a&b")).toBe("a^&b");
		expect(escapeForCmd("plain")).toBe("plain");
		expect(escapeForCmd("a b")).toBe("a b");
		// `%` has no escape on a /c line (expansion precedes caret handling) and no
		// language-server path needs one.
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
	// A server with no `args` launches BARE — rust-analyzer and clangd reject
	// `--stdio` as an unknown flag. The cmd.exe wrap still applies on Windows.
	const bare = {
		executable: "rust-analyzer",
		languages: ["rust"],
	} as unknown as DiscoveredServer;

	const flagged = {
		executable: "typescript-language-server",
		languages: ["typescript"],
		args: ["--stdio"],
	} as unknown as DiscoveredServer;

	it("launches a stdio-default server with no extra flag, on every platform", () => {
		expect(serverArgv(bare, "darwin")).toEqual(["rust-analyzer"]);
		expect(serverArgv(bare, "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "rust-analyzer"]);
	});

	it("carries a server's own flag through, on every platform", () => {
		expect(serverArgv(flagged, "darwin")).toEqual(["typescript-language-server", "--stdio"]);
		expect(serverArgv(flagged, "win32")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"typescript-language-server",
			"--stdio",
		]);
	});
});
