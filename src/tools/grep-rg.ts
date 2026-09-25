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
		try {
			return req("@vscode/ripgrep")?.rgPath as string | undefined;
		} catch {
			// Not directly requirable (pnpm layout): ask the fs-search package,
			// which DSH ships for exactly this binary.
			const search = req("@deepseek-ai/dsh-tool-fs-search") as
				| { rgPath?: string }
				| undefined;
			if (search?.rgPath) return search.rgPath;
			return "rg";
		}
	} catch {
		return undefined;
	}
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
				(error, stdout) => resolve(error === undefined ? stdout : undefined),
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
