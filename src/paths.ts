import { homedir } from "node:os";
import {
	isAbsolute,
	resolve as resolvePath,
	join,
	dirname,
	parse,
	sep,
} from "node:path";
import { lstat, readlink } from "node:fs/promises";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { errCode } from "./utils.js";

/**
 * On-disk home for dsh-hashline-edittool state. All stores live under the
 * shared DeepSeek Harness home
 * (`$DSH_HOME/plugins/dsh-hashline-edittool`,
 * default `~/.dsh/plugins/dsh-hashline-edittool`),
 * keyed by a human-navigable directory derived from the workspace cwd —
 * the same `projectKey` convention used by dsh-session-persistence-jsonl.
 * A caller without a workspace (tests, previews, startup) writes directly
 * under the plugin base directory.
 * @param cwd - the workspace root, or undefined for the shared-home fallback.
 */

/**
 * Build the readable directory key for a project path, following the same
 * convention as dsh-session-persistence-jsonl: filesystem separators and
 * drive separators become `-` (consecutive runs collapsed), unsafe code units
 * use `~XXXX` hex escape. The key is bounded for filesystem component limits.
 * Separator replacement is intentionally lossy — human-navigable, not injective.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
function projectKey(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export function configDir(cwd?: string): string {
	const base = join(resolveDshHome(), "plugins", "dsh-hashline-edittool");
	return cwd !== undefined ? join(base, projectKey(resolvePath(cwd))) : base;
}

export function hashStorePath(cwd?: string): string {
	return join(configDir(cwd), "hash-store.sqlite");
}

export function legacyHashStorePath(cwd?: string): string {
	return join(configDir(cwd), "hash-store.json");
}

export function hashStoreDir(cwd?: string): string {
	return dirname(hashStorePath(cwd));
}

function homeBase(): string {
	const envHome = process.env.HOME;
	return envHome && envHome.length > 0 ? envHome : homedir();
}

function expand(filePath: string): string {
	const home = homeBase();
	if (filePath === "~") return home;
	if (filePath.startsWith("~/")) return home + filePath.slice(1);
	return filePath;
}

export function toCwd(filePath: string, cwd: string): string {
	const expanded = expand(filePath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/**
 * Canonicalize a path, resolving every symlink component to its target
 * (loop-guarded, ELOOP on cycles). Non-existent final components resolve
 * lexically — the canonical form of a not-yet-created file. The hashline
 * tools key their state by canonical absolute paths, so the same file reached
 * through different symlink spellings lands on the same store rows.
 * @param path - the path to canonicalize (absolute or relative).
 */
export async function resolveTarget(path: string): Promise<string> {
	const absolutePath = resolvePath(path);
	const { root } = parse(absolutePath);
	const parts = absolutePath
		.slice(root.length)
		.split(sep)
		.filter((part) => part.length > 0);
	const visitedSymlinks = new Set<string>();

	async function resParts(
		currentPath: string,
		remainingParts: string[],
	): Promise<string> {
		if (remainingParts.length === 0) {
			return currentPath;
		}

		const [nextPart, ...tail] = remainingParts;
		const candidatePath = join(currentPath, nextPart);

		try {
			const candidateStats = await lstat(candidatePath);
			if (!candidateStats.isSymbolicLink()) {
				return resParts(candidatePath, tail);
			}

			if (visitedSymlinks.has(candidatePath)) {
				const error = new Error(
					`Too many symbolic links while resolving ${path}`,
				) as NodeJS.ErrnoException;
				error.code = "ELOOP";
				throw error;
			}
			visitedSymlinks.add(candidatePath);

			const linkTargetPath = resolvePath(
				dirname(candidatePath),
				await readlink(candidatePath),
			);
			const targetParts = linkTargetPath
				.slice(parse(linkTargetPath).root.length)
				.split(sep)
				.filter((part) => part.length > 0);
			return resParts(parse(linkTargetPath).root, [
				...targetParts,
				...tail,
			]);
		} catch (error: unknown) {
			if (errCode(error) === "ENOENT") {
				return join(candidatePath, ...tail);
			}
			throw error;
		}
	}

	return resParts(root, parts);
}
