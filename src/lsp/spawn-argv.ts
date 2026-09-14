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
 * The fix is not `shell: true` on the child: Node builds that command line by
 * joining the arguments, so a path with a space silently becomes a different
 * command. What Windows actually needs is the command interpreter, invoked the
 * way a batch file is invoked:
 *
 *     cmd.exe /d /s /c <command> <args…>
 *
 * `/d` skips AutoRun (a user's registry hook must not run inside our server
 * launch) and `/s` makes cmd strip the pair of quotes its own argument layer
 * wrapped us in, leaving the line verbatim.
 *
 * WHY THE LINE CARRIES NO DOUBLE QUOTES. The subprocess seam ultimately calls
 * `CreateProcessW` with an application name and an argument LIST, and that layer
 * quotes arguments the Windows way: a `"` inside an argument becomes `\"`. cmd.exe
 * does not read `\"` as an escaped quote — it sees a backslash, then a quote that
 * toggles quoting — so a `/c` string containing quotes arrives mangled and cmd
 * reports the whole line as one unrecognised command name:
 *
 *     '"typescript-language-server --stdio"' is not recognized …
 *
 * (measured on Windows 11 against this plugin's own launch.) Escaping with `^`
 * avoids the argument layer entirely: cmd's parser consumes the caret before the
 * command sees the argument, so `C:\Program^ Files\x` arrives as the single
 * argument `C:\Program Files\x`. A line with no quotes at all is wrapped by the
 * argument layer in exactly the pair that `/s` strips — which is the shape that
 * launches a shim on a bare name.
 *
 * This module owns that translation in ONE place. It is platform-parameterised
 * rather than reading `process.platform` directly, because the rule is exactly
 * the kind of thing that is only ever exercised on the platform you are not
 * sitting in front of.
 *
 * @module dsh-hashline-edittool/lsp/spawn-argv
 */

/**
 * Characters cmd.exe would otherwise read as syntax, and separators it collapses.
 *
 * A caret in front of one of these makes cmd's parser emit it literally, so the
 * command receives the argument the caller meant. `%` is deliberately absent: it
 * is expanded before carets are processed, so no escape for it exists on a /c
 * line — and a language-server path never needs one.
 */
const CMD_METACHARACTERS = /([\s&()<>|^"!;,=])/g;

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
 * Caret-escaping, never quoting: a double quote in the `/c` string would be
 * mangled by the argument layer below us (see the module doc), and it is what
 * broke the first version of this file.
 *
 * @param part - the raw argument.
 * @returns the argument, with cmd's syntax characters escaped.
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
	const line = [command, ...rest].map(escapeForCmd).join(" ");
	// NO surrounding quotes: the argument layer adds the pair `/s` strips when the
	// line needs one, and adding our own produces the escaped-quote failure above.
	return [comspec, "/d", "/s", "/c", line];
}
