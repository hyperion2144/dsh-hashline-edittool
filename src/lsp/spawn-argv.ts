/**
 * Windows cannot execute a `.cmd`/`.bat` shim directly.
 *
 * Every language server this plugin launches is installed the npm way, and npm
 * puts a shell shim on PATH next to the real script: `typescript-language-server`
 * is `typescript-language-server.cmd` on Windows, `npm` is `npm.cmd`. Node
 * refuses to spawn those with `shell: false` — `spawn` reports `EINVAL`, which
 * reaches the caller as "the language server did not start" with no clue why —
 * and the shim's own contents are batch, not a PE image, so there is nothing to
 * execute either.
 *
 * What Windows needs is the command interpreter, invoked the way a batch file is
 * invoked:
 *
 *     cmd.exe /d /s /c <command> <args…>
 *
 * `/d` skips AutoRun (a user's registry hook must not run inside our server
 * launch); `/s` is what makes cmd strip the ONE pair of quotes its own argument
 * layer may wrap the line in, leaving the rest verbatim.
 *
 * WHY THE COMMAND AND ITS ARGUMENTS STAY SEPARATE ARGUMENTS. The subprocess seam
 * ends in a `CreateProcessW` whose command line is built by quoting each argv
 * entry on its own (`quoteArg` → `buildCommandLine`). A single entry holding the
 * whole line — `"typescript-language-server --stdio"` — therefore arrives at cmd
 * as exactly that, quotes included: cmd's `/s` strips the pair, hands the result
 * to its parser, and the parser sees ONE token, so it looks for a program whose
 * NAME contains a space:
 *
 *     '"typescript-language-server --stdio"' is not recognized …
 *
 * (measured on Windows 11 against this plugin's own launch.) With the command
 * and its arguments as separate entries no entry contains a space, nothing gets
 * quoted, and cmd parses the line itself — which is the whole job.
 *
 * The same property fixes the harder case: an argument that DOES contain a space
 * is quoted by that layer, and cmd understands double quotes natively, so
 * `--prefix "C:\Program Files\x"` stays one argument — cmd only strips quotes
 * when the FIRST character after `/c` is one (the quoted-program case, where a
 * server binary sits under a spaced directory, remains unreachable through this
 * seam and would need `windowsVerbatimArguments`).
 *
 * Non-space cmd syntax characters are caret-escaped instead of quoted, since
 * escaping keeps the entry quotable-free and cmd consumes the caret before the
 * command sees the argument.
 *
 * This module owns that translation in ONE place. It is platform-parameterised
 * rather than reading `process.platform` directly, because the rule is exactly
 * the kind of thing that is only ever exercised on the platform you are not
 * sitting in front of.
 *
 * @module dsh-hashline-edittool/lsp/spawn-argv
 */

/**
 * cmd syntax characters escaped with a caret, EXCEPT whitespace.
 *
 * A space is deliberately not escaped here: escaping it would make the entry
 * `C:\Program^ Files\x`, which the argument layer still quotes (it contains a
 * space), and inside cmd's quotes the caret is a literal character — the path
 * would arrive with a caret in it. Left alone, the space is quoted by that layer
 * and cmd reads the quotes natively.
 *
 * `%` is absent for a different reason: it is expanded before carets are
 * processed, so no escape for it exists on a /c line — and no language-server
 * path needs one.
 */
const CMD_METACHARACTERS = /([&()<>|^"!;,=])/g;

/**
 * Whether a command must be launched through `cmd.exe` on Windows.
 *
 * A `.cmd`/`.bat` shim is the direct case. A BARE NAME (`npm`, a configured
 * server command) is the other: it is resolved by PATH/PATHEXT when a shell does
 * the lookup, and it is precisely the name that resolves to a shim. An absolute
 * path to an executable is left alone — it needs no interpreter.
 *
 * @param command - the command to launch (`argv[0]`).
 * @returns true when `cmd.exe` must launch it.
 */
export function needsCommandShell(command: string): boolean {
	const lower = command.toLowerCase();
	if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return true;
	// A path: the caller named a file, and Windows launches a file directly.
	if (lower.includes("/") || lower.includes("\\")) return false;
	// A bare name with an explicit extension is a file too (`node.exe`).
	return !/\.[a-z0-9]+$/.test(lower);
}

/**
 * Escape one argument for a `cmd.exe /c` line.
 *
 * @param part - the raw argument.
 * @returns the argument, with cmd's syntax characters (not spaces) escaped.
 */
export function escapeForCmd(part: string): string {
	return part.replace(CMD_METACHARACTERS, "^$1");
}

/**
 * Translate an argv for the platform it will be spawned on.
 *
 * @param argv - the command and its arguments, as the POSIX world spells them.
 * @param platform - the target platform; defaults to the running one.
 * @param comspec - the command interpreter to use; defaults to `ComSpec`/`cmd.exe`.
 * @returns argv to spawn on that platform.
 */
export function platformSpawnArgv(
	argv: readonly string[],
	platform: NodeJS.Platform = process.platform,
	comspec: string = process.env.ComSpec ?? "cmd.exe",
): string[] {
	const [command, ...rest] = argv;
	if (platform !== "win32" || command === undefined) return [...argv];
	if (!needsCommandShell(command)) return [...argv];
	// The command and its arguments remain SEPARATE entries — see the module doc:
	// joining them makes the argument layer quote the whole line, and cmd then
	// reads the quoted string as one program name.
	return [comspec, "/d", "/s", "/c", command, ...rest.map(escapeForCmd)];
}
