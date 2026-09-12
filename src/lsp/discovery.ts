/**
 * Finding a language server on this machine.
 *
 * Discovery only — nothing here downloads anything. The one-click install path
 * (spec §8.2) is a separate, curated action; this module answers "what is
 * already here", which is the question the backend chooser asks on every call.
 *
 * Three locations, in the order a developer would expect them to win:
 *
 * 1. **The project's own bins** (`node_modules/.bin`) — a repository that
 *    pins `typescript-language-server` should get *that* version, not whatever
 *    happens to be global.
 * 2. **`PATH`** — the global install.
 * 3. **Explicit configuration** — the user said so; it outranks everything and
 *    is handled by the caller passing it in.
 *
 * Everything is injected (`pathDirs`, `projectRoot`, `isExecutable`) so the
 * search order is testable without a machine that happens to have the right
 * tools installed — which is exactly the kind of environment a test runner is.
 *
 * @module dsh-hashline-edittool/lsp/discovery
 */
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { lspServersDir } from "../paths.js";

/** A server this plugin knows how to talk to. */
export interface KnownServer {
	/** The executable's basename, as it appears in a bin directory. */
	readonly command: string;
	/** The language ids it serves (registry ids). */
	readonly languages: readonly string[];
	/** What to say when it is missing. */
	readonly displayName: string;
	/**
	 * Extra argv after the executable, when the server does not default to
	 * stdio.
	 *
	 * Absent means `--stdio`, which is what the two original entries take. It
	 * exists because the flags are NOT uniform: `gopls` wants `serve`, and
	 * `bash-language-server` wants `start` — passing `--stdio` to those is a
	 * usage error that would look like a protocol bug.
	 */
	readonly args?: readonly string[];
	/**
	 * How to install it, when there is a way to.
	 *
	 * THE EARLIER VERSION OF THIS FIELD WAS `package?: string` AND IT WAS TOO
	 * NARROW. It recorded the npm package and nothing else, so eight of the fifteen
	 * entries had no install path at all — the card offered a button for seven
	 * languages and told the rest to figure it out, which is a strange thing for a
	 * panel called 语言服务器 to do. `gopls` is one `go install` away, `rust-analyzer`
	 * is one `rustup component add`; the toolchain may be absent, but that is a
	 * question the COMMAND answers, and its answer is legible. Refusing on the
	 * user's behalf was the plugin deciding it knew better.
	 *
	 * AND IT IS PLATFORM-AWARE, WHICH THE FIRST VERSION OF THIS FIELD WAS NOT.
	 *
	 * `brew install jdtls` was written here as though Homebrew were the world. On
	 * Linux and Windows that command does not exist, so the card would have offered
	 * a button that could only fail — the same mistake as refusing on the user's
	 * behalf, made in the other direction. The three shapes split cleanly:
	 *
	 *   `npm`         runs wherever npm runs, so it needs no platform key.
	 *   `argv`        a command that exists on EVERY platform it is offered on —
	 *                 `go install`, `rustup`, `ghcup`, `opam` are all like this.
	 *   `platform`    a command that exists on SOME platforms, keyed by
	 *                 `process.platform`. A missing key means NOT INSTALLABLE
	 *                 there, and the row says so rather than failing on click.
	 */
	readonly install?:
		| { readonly via: "npm"; readonly package: string }
		| { readonly via: "argv"; readonly argv: readonly string[] }
		| {
				readonly via: "platform";
				/** Keyed by `process.platform`; a missing key means "not here". */
				readonly by: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>>;
		  };
}

/**
 * The servers discovery looks for.
 *
 * Deliberately short: these two cover every built-in language, and a longer
 * list would mostly add entries nobody has installed.
 */
export const KNOWN_SERVERS: readonly KnownServer[] = [
	//
	// One entry per language the CATALOG ships, not just the packaged ones.
	//
	// The two original entries left every extension language without a known
	// server, which meant "prefer LSP" degraded to "no LSP" everywhere except
	// TypeScript and Python — a rule that only applies where someone already
	// installed a server is not a rule. These are the servers each language's own
	// community publishes, and discovery still only FINDS them: nothing here
	// installs anything.
	//
	// `args` is absent where the server defaults to stdio, which is most of them,
	// and present where it does not: an extra flag is cheaper than a usage error
	// that reads as a protocol bug.
	//
	// NOT verified against the real binaries — these are the published entry
	// points. Where a name is wrong, the status surface already reports "not
	// found" with the command beside it, which is the point of reporting rather
	// than refusing.
	//
	// JULIA IS DELIBERATELY ABSENT. Its server is not a command but a script —
	// `julia --startup-file=no -e 'using LanguageServer; …'` — with arguments that
	// depend on the project and change between releases. An entry here would be a
	// command that fails on most machines, which is worse than a language the
	// status surface reports as having no server: the first looks like a broken
	// plugin, the second is a fact the user can act on.
	{
		command: "typescript-language-server",
		languages: ["typescript", "tsx", "javascript"],
		displayName: "TypeScript Language Server",
		install: { via: "npm", package: "typescript-language-server" },
	},
	{
		command: "pyright-langserver",
		languages: ["python"],
		displayName: "Pyright",
		// The package is NOT the command: `npm i pyright-langserver` finds nothing.
		install: { via: "npm", package: "pyright" },
	},
	// FROM HERE DOWN, the non-npm installers. Each is one command against a toolchain
	// the user either has or does not — and if they do not, the command SAYS so, which
	// is a better answer than this plugin deciding on their behalf that it cannot be
	// done.
	{
		command: "gopls",
		languages: ["go"],
		displayName: "gopls",
		args: ["serve"],
		install: { via: "argv", argv: ["go", "install", "golang.org/x/tools/gopls@latest"] },
	},
	{
		command: "rust-analyzer",
		languages: ["rust"],
		displayName: "rust-analyzer",
		install: { via: "argv", argv: ["rustup", "component", "add", "rust-analyzer"] },
	},
	// clangd is the one that stays excluded, and the reason is the SIZE: its formula is
	// `llvm` (23.1.1, a gigabyte of compiler infrastructure). Installing that from a
	// settings card is not a convenience, it is a surprise. It is still found wherever
	// it already is.
	{ command: "clangd", languages: ["c", "cpp"], displayName: "clangd" },
	// THE REST ARRIVE THROUGH HOMEBREW, AND THAT IS NOT A DIFFERENT KIND OF THING.
	//
	// An earlier revision of this file refused them all with "comes from a system
	// package manager" — a line drawn too wide. `brew install jdtls` is one command
	// against a toolchain the user either has or does not, exactly like `go install`
	// and `rustup component add`, and the command reports its own absence legibly.
	// Refusing on the user's behalf was the plugin deciding it knew better.
	//
	// Homebrew and not a release tarball because these three all HAVE formulas, and
	// a formula knows how to place a self-contained tool; a tarball would need this
	// plugin to learn each project's layout.
	{
		command: "jdtls",
		languages: ["java"],
		displayName: "Eclipse JDT Language Server",
		// macOS only. Keyed so the other platforms get the TRUTH — no button — rather
		// than a command their OS does not have.
		install: { via: "platform", by: { darwin: ["brew", "install", "jdtls"] } },
	},
	{
		command: "csharp-ls",
		languages: ["c-sharp"],
		displayName: "csharp-ls",
		install: { via: "npm", package: "csharp-ls" },
	},
	{
		command: "intelephense",
		languages: ["php"],
		displayName: "Intelephense",
		args: ["--stdio"],
		install: { via: "npm", package: "intelephense" },
	},
	{
		command: "metals",
		languages: ["scala"],
		displayName: "Metals",
		install: { via: "argv", argv: ["cs", "install", "metals"] },
	},
	{
		command: "bash-language-server",
		languages: ["bash"],
		displayName: "Bash Language Server",
		args: ["start"],
		install: { via: "npm", package: "bash-language-server" },
	},
	{
		command: "haskell-language-server-wrapper",
		languages: ["haskell"],
		displayName: "Haskell Language Server",
		args: ["--lsp"],
		// ghcup is cross-platform, so this is a plain argv and not a platform map.
		install: { via: "argv", argv: ["ghcup", "install", "hls"] },
	},
	{
		command: "ocamllsp",
		languages: ["ocaml"],
		displayName: "ocamllsp",
		install: { via: "argv", argv: ["opam", "install", "ocaml-lsp-server"] },
	},
	{
		command: "solargraph",
		languages: ["ruby"],
		displayName: "Solargraph",
		args: ["stdio"],
		install: { via: "npm", package: "solargraph" },
	},
	{
		command: "elixir-ls",
		languages: ["elixir"],
		displayName: "ElixirLS",
		install: { via: "platform", by: { darwin: ["brew", "install", "elixir-ls"] } },
	},
	{
		command: "svelteserver",
		languages: ["svelte"],
		displayName: "Svelte Language Server",
		args: ["--stdio"],
		install: { via: "npm", package: "svelte-language-server" },
	},
];

/** Where a server was found. */
export type ServerOrigin = "project" | "path" | "configured" | "installed";

/** One discovered server. */
export interface DiscoveredServer {
	readonly command: string;
	/** Absolute path to the executable. */
	readonly executable: string;
	/** The language ids this instance can serve. */
	readonly languages: readonly string[];
	readonly displayName: string;
	readonly origin: ServerOrigin;
	/** The argv after the executable; absent means `--stdio`. */
	readonly args?: readonly string[];
}

/** What discovery needs to know about the machine. */
export interface DiscoveryOptions {
	/** The project root whose `node_modules/.bin` is searched first. */
	readonly projectRoot?: string;
	/** `PATH` split into directories; defaults to the process's. */
	readonly pathDirs?: readonly string[];
	/** Executables the caller named explicitly; these outrank discovery. */
	readonly configured?: readonly { readonly command: string; readonly languages: readonly string[] }[];
	/** Injectable so tests do not depend on the host's filesystem layout. */
	readonly isExecutable?: (path: string) => Promise<boolean>;
	/** Windows needs `.cmd`/`.exe` suffixes; injected for the same reason. */
	readonly executableSuffixes?: readonly string[];
}

/** Default executable check: exists and is executable. */
async function defaultIsExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The candidate file names for one command, given the platform's suffixes. */
function candidateNames(command: string, suffixes: readonly string[]): string[] {
	return [command, ...suffixes.map((suffix) => `${command}${suffix}`)];
}

/**
 * Find the language servers available on this machine.
 *
 * @param options - injected environment; all fields are optional.
 * @returns one entry per (command, location) that resolved, project bins first.
 */
export async function discoverServers(options: DiscoveryOptions = {}): Promise<DiscoveredServer[]> {
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const suffixes =
		options.executableSuffixes ??
		(process.platform === "win32" ? [".cmd", ".exe", ".bat"] : []);
	const pathDirs = options.pathDirs ?? (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);

	const out: DiscoveredServer[] = [];
	/**
	 * Languages a configured entry already covers.
	 *
	 * De-duplicating by command NAME would not work: a configured entry carries
	 * an absolute path while a known server carries a basename, so the two
	 * never compare equal and the same tool would be discovered twice. The
	 * meaningful question is "is this language already spoken for", and the
	 * answer is yes as soon as the user names a server for it.
	 */
	const coveredByConfig = new Set<string>();

	// Configured first: the user naming a server settles the question.
	for (const entry of options.configured ?? []) {
		const resolved = isAbsolute(entry.command) ? entry.command : undefined;
		if (resolved === undefined) continue;
		if (!(await isExecutable(resolved))) continue;
		for (const language of entry.languages) coveredByConfig.add(language);
		out.push({
			command: entry.command,
			executable: resolved,
			languages: entry.languages,
			displayName: entry.command,
			origin: "configured",
		});
	}

	// The plugin's OWN install prefix, and the reason it exists: a server the user
	// installed from the card is a deliberate act, so it outranks whatever PATH
	// happens to hold — but ranks below a PROJECT-local pin, which is the more
	// specific intent of the two.
	const installedBins = [join(lspServersDir(), "node_modules", ".bin")];
	/**
	 * Where the TOOLCHAINS put what they install.
	 *
	 * This is the other half of the same bug, and it is the one that made an install
	 * look like it did nothing. `go install` writes to GOPATH/bin — on this machine
	 * `/Users/mutou/go/bin`, which is NOT on PATH and never was. So `gopls` was
	 * installed, the command exited 0, the card said success, and the row still read
	 * 未找到 because discovery had no reason to look there.
	 *
	 * The four below are the DEFAULT locations of the four toolchains the catalog can
	 * drive. A user who has moved one is not helped by this, and is not harmed:
	 * these are searched in addition to PATH, never instead of it.
	 *
	 * `rustup` is the exception worth noting — `~/.cargo/bin` is usually already on
	 * PATH, so listing it is redundant on most machines and free on all of them.
	 */
	const home = homedir();
	const toolchainBins = [
		join(home, "go", "bin"), // go install ($GOPATH/bin, the default GOPATH)
		join(home, ".cargo", "bin"), // rustup / cargo install
		// coursier, whose macOS path differs from its Linux one.
		join(home, ".local", "share", "coursier", "bin"),
		join(home, "Library", "Application Support", "Coursier", "bin"),
		join(home, ".opam", "default", "bin"), // opam install
	];
	const projectBins =
		options.projectRoot === undefined ? [] : [join(options.projectRoot, "node_modules", ".bin")];

	for (const server of KNOWN_SERVERS) {
		if (server.languages.some((language) => coveredByConfig.has(language))) continue;
		const locations: Array<{ dir: string; origin: ServerOrigin }> = [
			...projectBins.map((dir) => ({ dir, origin: "project" as const })),
			...installedBins.map((dir) => ({ dir, origin: "installed" as const })),
			...toolchainBins.map((dir) => ({ dir, origin: "path" as const })),
			...pathDirs.map((dir) => ({ dir, origin: "path" as const })),
		];
		for (const location of locations) {
			let found: string | undefined;
			for (const name of candidateNames(server.command, suffixes)) {
				const candidate = join(location.dir, name);
				if (await isExecutable(candidate)) {
					found = candidate;
					break;
				}
			}
			if (found === undefined) continue;
			// First hit wins and the search moves to the next server: a project
			// bin beats a global one, and two copies of the same tool would only
			// fight over the same workspace.
			out.push({
				command: server.command,
				executable: found,
				languages: server.languages,
				displayName: server.displayName,
				origin: location.origin,
				...(server.args === undefined ? {} : { args: server.args }),
			});
			break;
		}
	}
	return out;
}

/** The server that would serve a language, if any was found. */
export function serverForLanguage(
	servers: readonly DiscoveredServer[],
	languageId: string,
): DiscoveredServer | undefined {
	return servers.find((server) => server.languages.includes(languageId));
}

/** The argv a discovered server is launched with. */
export function serverArgv(server: DiscoveredServer): string[] {
	// Servers that default to stdio take no flag; the ones that do not carry
	// their own. `--stdio` used to be hardcoded, which was right for exactly the
	// two entries the list had.
	return [server.executable, ...(server.args ?? ["--stdio"])];
}
