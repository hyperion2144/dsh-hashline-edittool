/**
 * ripgrep pre-filter for the grep tool (#183).
 *
 * `grep` used to read EVERY candidate file into JS and run a per-line RegExp.
 * With this pre-filter, ripgrep (the same binary DSH's own search ships)
 * decides which files contain a match first, so files without hits are never
 * read at all — the dominant cost on large trees.
 *
 * Deliberately conservative by contract: the filter only NARROWS a file list
 * the caller already produced (identical include/exclude semantics are
 * preserved, because the caller's list is the input), and ANY failure — binary
 * missing, spawn error, non-zero exit, timeout, oversized output — returns
 * `undefined` so the caller simply keeps its full list and runs the JS engine
 * it has always run. grep never fails because ripgrep did.
 *
 * Line numbers are NOT taken from ripgrep: the caller needs file content for
 * anchors and context anyway, and its own matcher is the output contract.
 *
 * @module dsh-hashline-edittool/tools/grep-rg
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * Resolve the rg binary the same way DSH's own search does: the `@vscode/ripgrep`
 * package DSH ships (found via createRequire from this module, or from the
 * fs-search package), falling back to `rg` on PATH.
 *
 * @returns an absolute rg path, "rg" for PATH lookup, or undefined when unavailable.
 */
function resolveRg(): string | undefined {
	try {
		const req = createRequire(import.meta.url);
		// A declared dependency whose platform binary never materialized (install
		// scripts skipped, optional platform package absent) resolves to a path that
		// is NOT there — spawning it would fail once per chunk. So verify, and let
		// the PATH lookup below try instead: the same fallback DSH's own search
		// rides on.
		let shipped: string | undefined;
		try {
			shipped = req("@vscode/ripgrep")?.rgPath as string | undefined;
		} catch {
			// Not directly requirable (pnpm layout): ask the fs-search package,
			// which DSH ships for exactly this binary.
			shipped = (req("@deepseek-ai/dsh-tool-fs-search") as { rgPath?: string } | undefined)
				?.rgPath;
		}
		if (shipped !== undefined && existsSync(shipped)) return shipped;
		return "rg";
	} catch {
		return undefined;
	}
}

/** One rg invocation's outcome: an answer, a definitive "nothing matched", or a failure. */
export type RgOutcome = "matched" | "no-match" | "failed";

/**
 * Classify an `execFile` result from `rg --files-with-matches`.
 *
 * Exit 0 = matched; exit 1 = NOTHING matched — an ANSWER, not a failure.
 * Collapsing the two made the caller keep its whole candidate list and re-read the
 * tree with the JS engine, so a zero-hit grep — the very case this pre-filter exists
 * to make cheap — was the one that burned the read budget instead. Everything else
 * (ENOENT, timeout, exit 2 for a rejected pattern) stays a failure, and the caller
 * keeps its list.
 */
export function classifyRgExit(
	error: { code?: string | number | null } | null | undefined,
): RgOutcome {
	if (error === null || error === undefined) return "matched";
	return error.code === 1 ? "no-match" : "failed";
}

let rgResolved: string | undefined | null;

/**
 * Run `rg --files-with-matches` over an explicit file list.
 *
 * @param pattern - the grep pattern, passed to rg as-is (see the dialect note in
 *   the caller: rg-rejected patterns must fall back to the JS engine).
 * @param files - the candidate files (the caller's already-filtered list).
 * @param timeoutMs - per-invocation cap; a timeout yields undefined.
 * @returns the subset of `files` that contain a match (input order), or
 *   undefined when ripgrep is unavailable or the invocation failed for any
 *   reason — the caller then keeps the full list.
 */
export async function rgFilesWithMatches(
	pattern: string,
	files: string[],
	timeoutMs = 15_000,
): Promise<string[] | undefined> {
	if (files.length === 0) return undefined;
	if (rgResolved === null) return undefined;
	rgResolved ??= resolveRg();
	if (rgResolved === undefined) return undefined;
	const rg = rgResolved;

	// Chunked so argv never overflows on large trees; each chunk is an
	// independent `rg -l` over an explicit --file list.
	const out: string[] = [];
	const CHUNK = 400;
	const run = (chunk: string[]) =>
		new Promise<string | undefined>((resolve) => {
			execFile(
				rg,
				["--no-config", "--files-with-matches", "-e", pattern, ...chunk],
				{ timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
				(error, stdout) => resolve(classifyRgExit(error) === "failed" ? undefined : stdout),
			);
		});
	for (let i = 0; i < files.length; i += CHUNK) {
		const chunkOut = await run(files.slice(i, i + CHUNK));
		if (chunkOut === undefined) return undefined;
		out.push(...chunkOut.split("\n").filter((line) => line !== ""));
	}
	const hit = new Set(out);
	return files.filter((file) => hit.has(file));
}

/**
 * List the files under `root` the way ripgrep would SEARCH them: `.gitignore` and
 * `.ignore` rules applied, hidden entries skipped, `node_modules` excluded.
 *
 * This is the ignore-aware half of the walk — `infra/file-scan.ts` has no
 * ignore-file support by design — so a repo full of build output no longer puts
 * those files in front of the read budget at all. `--no-require-git` is deliberate
 * too: a `.gitignore` should mean the same thing in a directory that is not a
 * checkout yet.
 *
 * @param root - absolute directory to list.
 * @param signal - optional abort; an aborted run reports "unavailable" like any
 *   other failure, and the caller's own walk then re-checks the same signal.
 * @param timeoutMs - per-invocation cap; a timeout yields undefined.
 * @returns absolute paths, or undefined when ripgrep is unavailable or the
 *   invocation failed for any reason — the caller keeps the plugin's own walk.
 */
export async function rgFiles(
	root: string,
	signal?: AbortSignal,
	timeoutMs = 15_000,
): Promise<string[] | undefined> {
	if (rgResolved === null) return undefined;
	rgResolved ??= resolveRg();
	if (rgResolved === undefined) return undefined;
	const rg = rgResolved;
	const listed = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
		execFile(
			rg,
			[
				"--no-config",
				"--files",
				// A `.gitignore` should mean the same thing outside a checkout…
				"--no-require-git",
				// …and only the SEARCHED tree's rules apply: an ancestor's rule (the repo
				// that happens to contain the path) must not silently empty the list when
				// the caller named that path on purpose. Ignored directories such as
				// `.tmp/` are exactly where this bites.
				"--no-ignore-parent",
				"--glob",
				"!**/node_modules/**",
				".",
			],
			{ cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(signal ? { signal } : {}) },
			(error, stdout) => resolve({ ok: classifyRgExit(error) !== "failed", stdout }),
		);
	});
	if (!listed.ok) return undefined;
	return listed.stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => join(root, line));
}
