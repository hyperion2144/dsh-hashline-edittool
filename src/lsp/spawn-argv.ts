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
 * joining the arguments, so a path with a space (`C:\Program Files\…`) or a
 * quote silently becomes a different command. What Windows actually needs is the
 * command interpreter, invoked the way a batch file is invoked:
 *
 *     cmd.exe /d /s /c "<command> <quoted args…>"
 *
 * `/d` skips AutoRun (a user's registry hook must not run inside our server
 * launch), `/s` makes the `/c` string verbatim so cmd does not re-parse the
 * quotes it strips, and the outer pair is consumed by cmd itself.
 *
 * This module owns that translation in ONE place. It is platform-parameterised
 * rather than reading `process.platform` directly, because the rule is exactly
 * the kind of thing that is only ever exercised on the platform you are not
 * sitting in front of.
 *
 * @module dsh-hashline-edittool/lsp/spawn-argv
 */

/** Characters cmd.exe treats as syntax, so an argument carrying one must be quoted. */
const CMD_METACHARACTERS = /[\s"&()[\]{}^=;!'+,`~|<>]/;

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
 * Quote one argument for a `cmd.exe /c` command line.
 *
 * @param part - the raw argument.
 * @returns the argument, quoted when cmd would otherwise read it as syntax.
 */
export function quoteForCmd(part: string): string {
	if (part !== "" && !CMD_METACHARACTERS.test(part)) return part;
	// Inside a quoted cmd argument an embedded quote is doubled, not escaped.
	return `"${part.replace(/"/g, '""')}"`;
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
	const line = [command, ...rest].map(quoteForCmd).join(" ");
	return [comspec, "/d", "/s", "/c", `"${line}"`];
}
