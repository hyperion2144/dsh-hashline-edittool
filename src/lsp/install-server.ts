/**
 * Installing a language server, for the ones where that is a single npm install.
 *
 * WHY THIS SPAWNS A PACKAGE MANAGER RATHER THAN DOWNLOADING A TARBALL. The grammar
 * installer fetches one file and verifies its hash, and that works because a
 * grammar IS one file. An npm-form language server is a program with a dependency
 * tree: the tarball for `typescript-language-server` does not contain the compiler
 * it drives, and installing the tarball alone would produce an executable that
 * fails on first use. Resolving that tree is what npm is for, so npm is what runs.
 *
 * WHERE IT INSTALLS, AND WHY NOT ELSEWHERE. `npm install --prefix <plugin dir>`
 * keeps the whole tree inside the plugin's own directory. The user's global prefix
 * is off limits — a settings card writing into `npm -g` would be this plugin
 * editing an environment it does not own — and installing per-project would
 * re-download the same server for every workspace.
 *
 * WHAT IT REFUSES. Servers that are NOT npm packages are refused by name and with
 * a reason, because the honest answer for `gopls` is "that one comes from
 * `go install`" rather than an install button that fails. Detection still finds
 * them wherever they are; this module simply does not pretend to provide them.
 *
 * @module dsh-hashline-edittool/lsp/install-server
 */
import { mkdir, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { KNOWN_SERVERS, type KnownServer } from "./discovery.js";
import { lspServersDir } from "../paths.js";
import type { SubprocessLike } from "./transport.js";

/** How a spawn is performed; structurally the platform's `subprocess.spawn`. */
export type SpawnLike = (spec: {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly stdio: { readonly stdin: "pipe"; readonly stdout: "pipe"; readonly stderr: "pipe" };
	readonly graceMs: number;
}) => SubprocessLike;

/** What an install attempt did. */
export interface LspInstallOutcome {
	readonly ok: boolean;
	readonly command: string;
	readonly message: string;
	/** Absolute path of the executable, when the install produced one. */
	readonly executable?: string;
}

/** The catalog entry that serves a language, if the catalog has one. */
export function serverEntryFor(languageId: string): KnownServer | undefined {
	return KNOWN_SERVERS.find((server) => server.languages.includes(languageId));
}

/**
 * Whether this language's server can be installed HERE — on this machine.
 *
 * `platform` says so per platform, so the answer is genuinely machine-dependent:
 * `jdtls` is offerable on macOS and not on Linux, and answering "yes" from a
 * static catalog would put a button on a row whose only outcome is a failure.
 *
 * @param languageId - the registry id.
 * @param platform - defaults to `process.platform`; injected so tests can ask
 *   about a platform they are not running on.
 * @returns the argv to run, or `undefined` when there is nothing to offer.
 */
export function installCommandFor(
	languageId: string,
	platform: NodeJS.Platform = process.platform,
): readonly string[] | undefined {
	const plan = serverEntryFor(languageId)?.install;
	if (plan === undefined) return undefined;
	if (plan.via === "argv") return plan.argv;
	if (plan.via === "platform") return plan.by[platform];
	// npm is the one that needs the plugin's prefix, so it is built later.
	return ["npm"];
}

/** Whether this language's server can be installed here at all. */
export function canInstallServer(
	languageId: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return installCommandFor(languageId, platform) !== undefined;
}

/**
 * Install the language server for a language, if it is one npm can provide.
 *
 * @param languageId - the registry id whose server to install.
 * @param spawn - the subprocess seam.
 * @param onOutput - called with output chunks as they arrive, for a progress line.
 * @returns what happened, including the executable path on success.
 */
export async function installLspServer(
	languageId: string,
	spawn: SpawnLike,
	onOutput?: (chunk: string) => void,
): Promise<LspInstallOutcome> {
	const entry = serverEntryFor(languageId);
	if (entry === undefined) {
		return {
			ok: false,
			command: "",
			message: `The catalog has no server for ${languageId}. A named server can still be set in the hashline settings.`,
		};
	}
	if (entry.install === undefined) {
		// The residue after every command-based installer is offered: a server that
		// arrives through a system package manager or a release zip. The refusal names
		// the executable, and the 指定服务器 field below the list takes one directly.
		return {
			ok: false,
			command: entry.command,
			message: `${entry.displayName} 没有可直接运行的安装命令（它来自系统包管理器或发布包）。装上后这个列表会自动找到它；也可以在下方的「指定服务器」里直接写命令。`,
		};
	}
	const prefix = lspServersDir();
	await mkdir(prefix, { recursive: true });
	// RESOLVE FOR THIS PLATFORM FIRST. `platform` entries carry a command per OS and
	// nothing for the ones they do not support, so an absent key is a refusal — the
	// same shape as an entry with no installer at all, and it must be caught BEFORE
	// the spawn rather than discovered by it.
	const plan = entry.install;
	const platformArgv = plan.via === "platform" ? plan.by[process.platform] : undefined;
	if (plan.via === "platform" && platformArgv === undefined) {
		return {
			ok: false,
			command: entry.command,
			message: `${entry.displayName} 在这个系统（${process.platform}）上没有内置安装命令。装上后这个列表会自动找到它；也可以在下方的「指定服务器」里直接写命令。`
		};
	}
	// THREE SHAPES, one pipeline. `npm` resolves a dependency tree into the plugin's
	// own prefix; the other two run a command the language's community publishes.
	// All of them are just a command, a cwd and an exit code.
	const argv =
		plan.via === "npm"
			? [
					process.platform === "win32" ? "npm.cmd" : "npm",
					"install",
					"--prefix",
					prefix,
					// An audit of a server we chose is noise, and npm's progress output is not
					// the progress we show.
					"--no-audit",
					"--no-fund",
					"--loglevel=error",
					plan.package,
				]
				: [...(plan.via === "argv" ? plan.argv : (platformArgv ?? []))];
	let handle: SubprocessLike;
	try {
		handle = spawn({
			argv,
			cwd: prefix,
			stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			graceMs: 5_000,
		});
	} catch (error) {
		return {
			ok: false,
			command: entry.command,
			message: `Could not run npm: ${error instanceof Error ? error.message : String(error)}. Is npm on PATH?`,
		};
	}
	const tail: string[] = [];
	const collect = (chunk: Buffer): void => {
		const text = chunk.toString("utf8");
		tail.push(text);
		if (tail.length > 40) tail.shift();
		onOutput?.(text);
	};
	handle.stdout?.on("data", collect);
	handle.stderr?.on("data", collect);
	const { exitCode } = await handle.done;
	if (exitCode !== 0) {
		return {
			ok: false,
			command: entry.command,
			message: `安装命令以 ${exitCode === null ? "未知状态" : exitCode} 退出：${tail.join("").trim().slice(-400)}`,
		};
	}
	// THE EXIT CODE IS NOT THE PROOF — and the proof is not the same check for both
	// methods, which is the bug the user hit.
	//
	// `npm install --prefix X` puts a launcher at `X/node_modules/.bin/<command>`;
	// that layout is npm's, and checking it is right. `go install` puts the binary in
	// GOPATH/bin, `rustup component add` puts it in the toolchain's bin, `opam` in its
	// own switch — NONE of them is the npm prefix, so checking there reported a
	// perfectly good install as broken and said so in a sentence about npm.
	//
	// For an argv install the only honest check is whether the server is now
	// FINDABLE, which is the question the user actually asked. It costs a re-scan
	// and it is the same predicate the card renders. If the toolchain put it somewhere
	// this plugin does not look, the install still succeeded and the row will say so:
	// the status list is the report, not this line.
	// The check that matches the METHOD, which is the whole of the fix.
	//
	// `npm install --prefix X` puts a launcher at `X/node_modules/.bin/<command>`:
	// that layout is npm's, and looking there is right for npm. Every OTHER entry
	// installs through its own toolchain — `go install` into GOPATH/bin, rustup into
	// the toolchain's bin, coursier and opam into theirs — and NONE of them is the npm
	// prefix. The old code looked there for all of them, so a perfectly good
	// `go install` came back as a failure described in a sentence about npm.
	//
	// For an argv install there is no path this plugin can assume, so it does not
	// pretend to have one: the command's exit status is what we know, and whether the
	// server became findable is the question the STATUS list answers on the next
	// read. That is the same predicate the card renders, which is the one the user
	// asked about.
	if (plan.via === "npm") {
		const executable = join(
			prefix,
			"node_modules",
			".bin",
			process.platform === "win32" ? `${entry.command}.cmd` : entry.command,
		);
		try {
			await access(executable, constants.X_OK);
		} catch {
			return {
				ok: false,
				command: entry.command,
				message: `npm 报成功，但 ${entry.command} 不在插件目录里。可能这个包的可执行文件叫别的名字。`
			};
		}
	}
	return {
		ok: true,
		command: entry.command,
		message:
			plan.via === "npm"
				? `${entry.displayName} 已装进插件自己的目录，从现在起优先于 PATH 被找到。`
				: `${entry.displayName} 的安装命令已成功完成。它装进了它自己工具链的目录——下面列表重读后就能看到它。`
	};
}
