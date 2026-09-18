/**
 * Server discovery. The injected `isExecutable` is what makes this testable:
 * a CI machine's `PATH` is not a fixture, and a test that depended on it would
 * pass or fail by accident.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverServers, isExecutableFile, serverArgv, serverForLanguage } from "../../src/lsp/discovery.js";

/** An `isExecutable` that answers from a fixed set of paths. */
function fakeFs(...present: string[]) {
	const set = new Set(present);
	return async (path: string): Promise<boolean> => set.has(path);
}

describe("discovery order", () => {
	it("prefers the project's own bin over PATH", async () => {
		const project = "/repo";
		const projectBin = join(project, "node_modules", ".bin", "typescript-language-server");
		const globalBin = join("/usr/local/bin", "typescript-language-server");
		const servers = await discoverServers({
			projectRoot: project,
			pathDirs: ["/usr/local/bin"],
			isExecutable: fakeFs(projectBin, globalBin),
		});
		const tsserver = servers.find((s) => s.command === "typescript-language-server")!;
		// A repository that pins its own server should get THAT version, not
		// whatever is installed globally.
		expect(tsserver.origin).toBe("project");
		expect(tsserver.executable).toBe(projectBin);
	});

	it("falls back to PATH when the project has no bin", async () => {
		const globalBin = join("/usr/local/bin", "pyright-langserver");
		const servers = await discoverServers({
			projectRoot: "/repo",
			pathDirs: ["/usr/local/bin"],
			isExecutable: fakeFs(globalBin),
		});
		expect(servers.find((s) => s.command === "pyright-langserver")?.origin).toBe("path");
	});

	it("lets a configured executable outrank both", async () => {
		const configured = "/opt/custom/tsserver";
		const globalBin = join("/usr/local/bin", "typescript-language-server");
		const servers = await discoverServers({
			projectRoot: "/repo",
			pathDirs: ["/usr/local/bin"],
			configured: [{ command: configured, languages: ["typescript"] }],
			isExecutable: fakeFs(configured, globalBin),
		});
		const found = servers.filter((s) => s.languages.includes("typescript"));
		// Exactly one: the configured one wins and discovery does not add a
		// second copy of the same tool.
		expect(found).toHaveLength(1);
		expect(found[0]!.origin).toBe("configured");
	});

	it("returns nothing when nothing is installed", async () => {
		const servers = await discoverServers({ projectRoot: "/repo", pathDirs: ["/usr/local/bin"], isExecutable: fakeFs() });
		expect(servers).toEqual([]);
	});

	it("stops at the first hit per server", async () => {
		const first = join("/a", "typescript-language-server");
		const second = join("/b", "typescript-language-server");
		const servers = await discoverServers({
			pathDirs: ["/a", "/b"],
			isExecutable: fakeFs(first, second),
		});
		expect(servers.filter((s) => s.command === "typescript-language-server")).toHaveLength(1);
		expect(servers[0]!.executable).toBe(first);
	});
});

describe("windows suffixes", () => {
	it("tries the platform suffixes when the bare name is absent", async () => {
		const suffixed = join("C:\\tools", "typescript-language-server.cmd");
		const servers = await discoverServers({
			pathDirs: ["C:\\tools"],
			executableSuffixes: [".cmd", ".exe"],
			isExecutable: fakeFs(suffixed),
		});
		expect(servers[0]!.executable).toBe(suffixed);
	});

	});

/**
 * What counts as EXECUTABLE on Windows — the rule that decides which of npm's
 * three side-by-side shims a launch gets.
 *
 * `access(X_OK)` is a readability check there, so the extensionless `/bin/sh`
 * shim (installed next to the real one, and executable on POSIX) passed it and
 * won the candidate race; `CreateProcessW` then refused it and the working
 * `.cmd` was never reached. Tested against REAL files with the platform
 * injected, so the rule is exercised from macOS.
 */
describe("windows executability", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "lsp-exec-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("accepts the shims CreateProcessW can launch, and nothing else", async () => {
		const unixShim = join(dir, "typescript-language-server");
		const cmdShim = `${unixShim}.cmd`;
		const ps1Shim = `${unixShim}.ps1`;
		await writeFile(unixShim, '#!/bin/sh\nexec node cli.mjs "$@"\n', { mode: 0o755 });
		await writeFile(cmdShim, "@echo off\r\n");
		await writeFile(ps1Shim, "Write-Host\r\n");

		// On POSIX the extensionless shim IS the executable — which is exactly why
		// the Windows rule cannot be `access(X_OK)`.
		expect(await isExecutableFile(unixShim, "darwin")).toBe(true);

		expect(await isExecutableFile(cmdShim, "win32")).toBe(true);
		expect(await isExecutableFile(unixShim, "win32")).toBe(false);
		// PowerShell is not launchable by CreateProcessW either.
		expect(await isExecutableFile(ps1Shim, "win32")).toBe(false);
	});

	it("rejects a DIRECTORY that happens to carry an executable name", async () => {
		// A directory passes the X_OK check as well; a launch would fail the same way.
		const asDir = join(dir, "srv.cmd");
		await mkdir(asDir);
		expect(await isExecutableFile(asDir, "win32")).toBe(false);
	});
});

describe("serving a language", () => {
	it("maps the built-in languages to the servers that cover them", async () => {
		const tsserver = join("/usr/local/bin", "typescript-language-server");
		const pyright = join("/usr/local/bin", "pyright-langserver");
		const servers = await discoverServers({ pathDirs: ["/usr/local/bin"], isExecutable: fakeFs(tsserver, pyright) });
		expect(serverForLanguage(servers, "typescript")?.command).toBe("typescript-language-server");
		expect(serverForLanguage(servers, "tsx")?.command).toBe("typescript-language-server");
		expect(serverForLanguage(servers, "javascript")?.command).toBe("typescript-language-server");
		expect(serverForLanguage(servers, "python")?.command).toBe("pyright-langserver");
	});

	it("reports nothing for a language no server covers", async () => {
		const servers = await discoverServers({ pathDirs: ["/usr/local/bin"], isExecutable: fakeFs() });
		expect(serverForLanguage(servers, "python")).toBeUndefined();
	});

	it("launches pyright with its own --stdio", async () => {
		const servers = await discoverServers({
			pathDirs: ["/x"],
			isExecutable: fakeFs(join("/x", "pyright-langserver")),
		});
		expect(serverArgv(servers[0]!)).toEqual([join("/x", "pyright-langserver"), "--stdio"]);
	});

	it("launches rust-analyzer bare — it rejects `--stdio` (#135)", async () => {
		const servers = await discoverServers({
			pathDirs: ["/x"],
			isExecutable: fakeFs(join("/x", "rust-analyzer")),
		});
		expect(serverArgv(servers[0]!)).toEqual([join("/x", "rust-analyzer")]);
	});
});
