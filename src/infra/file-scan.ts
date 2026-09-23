/**
 * The shared workspace file walk.
 *
 * `grep` and the reference scan must agree on **which files exist**, or the
 * same repository answers two different questions depending on which tool
 * asked. The semantics live here once and both callers import them:
 *
 * - the whole tree from the root, recursively;
 * - **hidden entries and `node_modules` skipped** (not `.gitignore`-aware —
 *   there is no ignore-file support, deliberately);
 * - **symlinks never followed** (loop-safe);
 * - unreadable directories skipped silently.
 *
 * The include-glob rule is ripgrep-shaped: a pattern **without** `/` matches
 * the basename at any depth; with `/` it matches the root-relative path.
 *
 * @module dsh-hashline-edittool/file-scan
 */
import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { abortIf } from "./utils.js";

/** Recursive file gather: whole tree, skipping hidden entries and node_modules. */
export async function gatherFiles(
	root: string,
	_opts: unknown,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		abortIf(signal);
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			continue; // unreadable dir — skip silently
		}
		for (const name of entries) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const p = join(dir, name);
			let st;
			try {
				st = await lstat(p);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) continue; // no symlink recursion (loop-safe)
			if (st.isDirectory()) {
				stack.push(p);
			} else if (st.isFile()) {
				out.push(p);
			}
		}
	}
	return out;
}

/**
 * Host-style include glob: a pattern without "/" matches the basename at ANY
 * depth (like ripgrep --glob); with "/" it matches the root-relative path.
 *
 * The comparison happens in ONE space: minimatch is a POSIX-glob matcher, so
 * a Windows `relPath` (`a\\one.ts`) is converted to `a/one.ts` FIRST. Without
 * that, the basename split below found no `/` and handed minimatch the whole
 * `a\\one.ts`, where `*` cannot cross the (normalised) separator — the include
 * filter then matched NOTHING below the root, silently, on Windows.
 */
export function matchInclude(pattern: string, relPath: string): boolean {
	const posix = relPath.replaceAll("\\", "/");
	if (!pattern.includes("/")) {
		const name = posix.split("/").pop() ?? posix;
		return minimatch(name, pattern, { dot: true });
	}
	return minimatch(posix, pattern, { dot: true });
}
