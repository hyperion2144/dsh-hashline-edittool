/**
 * The Windows spawn rule, checked on the platform it can never be checked on.
 *
 * A `.cmd` shim cannot be executed by `spawn` (EINVAL) nor by the OS (batch, not
 * a PE image), so an npm-installed language server only starts when the launch
 * goes through `cmd.exe`. These tests pin the exact command line, because the
 * failure mode is a server that silently never starts on a machine nobody is
 * sitting in front of.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { needsCommandShell, platformSpawnArgv, quoteForCmd } from "../../src/lsp/spawn-argv.js";
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

	it("launches a bare name through cmd.exe on Windows", () => {
		// The case that failed: npm's shim is `typescript-language-server.cmd`,
		// and a bare name is exactly what PATH/PATHEXT resolves to a shim.
		expect(platformSpawnArgv(["typescript-language-server", "--stdio"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			'"typescript-language-server --stdio"',
		]);
	});

	it("launches npm.cmd through cmd.exe too", () => {
		expect(
			platformSpawnArgv(["npm.cmd", "install", "--prefix", "C:\\x", "y"], "win32", "cmd.exe"),
		).toEqual(["cmd.exe", "/d", "/s", "/c", '"npm.cmd install --prefix C:\\x y"']);
	});

	it("runs an absolute executable directly — no interpreter needed", () => {
		const argv = ["C:\\Program Files\\nodejs\\node.exe", "--version"];
		expect(platformSpawnArgv(argv, "win32", "cmd.exe")).toEqual([
			"C:\\Program Files\\nodejs\\node.exe",
			"--version",
		]);
	});

	it("quotes an argument cmd would otherwise read as syntax", () => {
		// A path with a space, and one with cmd metacharacters: both must survive
		// as ONE argument, which a joined shell string silently loses.
		expect(platformSpawnArgv(["npm", "--prefix", "C:\\Program Files\\x"], "win32", "cmd.exe")).toEqual([
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			'"npm --prefix "C:\\Program Files\\x""',
		]);
		expect(quoteForCmd("a&b")).toBe('"a&b"');
		expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
		expect(quoteForCmd("")).toBe('""');
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
			'"typescript-language-server --stdio"',
		]);
	});
});
