/**
 * ripgrep as the grep tool's search ENGINE (#384).
 *
 * `grep` used to READ every candidate file and match it with a per-line
 * JavaScript RegExp. A pre-filter came later (`rg --files-with-matches`) and
 * narrowed the file LIST, but the matching itself still happened in JS — so
 * the answer came from a different engine than the one that decided which
 * files to read, and the two could disagree.
 *
 * ripgrep is the engine now. `rg --json` reports every hit as a structured
 * record — file, 1-based line number, line text — and this module parses those
 * records into {@link RgMatch}es. Everything above it (anchors, context, the
 * read budget, the spill file) stays the plugin's own contract.
 *
 * Three deliberate deviations from DSH's own grep tool:
 *
 * - `--no-config` comes FIRST: without it ripgrep reads the host's
 *   `RIPGREP_CONFIG_PATH` (or an `rg.conf` next to the binary), and that
 *   config may set `--pre` — an arbitrary preprocessor run against every
 *   file the search touches. A search must never execute the host's config.
 * - `--text` (`-a`): ripgrep's default binary handling stops at the first NUL
 *   byte and counts it as a line break, so every line number after it is off
 *   by one and the NUL-bearing line's own match is reported against the wrong
 *   line (#268). `--text` makes ripgrep search the file as text, so its line
 *   numbers agree with the plugin's own reader.
 * - the file list rides on the command line, so it is sliced by LENGTH, never
 *   by file count (#260) — see `infra/argv-limit`.
 *
 * A literal pattern is `--fixed-strings`, NEVER a `-F` prefix glued onto the
 * pattern: ripgrep reads `-Ffoo` as the TEXT `-Ffoo`, which matches nothing
 * and turns every literal search into a silent "No matches" (#384).
 *
 * @module dsh-hashline-edittool/tools/grep-rg
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ARGV_BUDGET, planArgvChunks } from "../infra/argv-limit.js";

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

/**
 * One hit reported by ripgrep: the file it sits in, and its 1-based line
 * number.
 *
 * The path is the text ripgrep reported and the line number is the one
 * ripgrep counted — which is why the search runs with `--text`: see the
 * module note on the NUL-byte line shift.
 */
export interface RgMatch {
	/** The file the hit is in, exactly as ripgrep reported it. */
	path: string;
	/** The 1-based line number of the hit. */
	line: number;
	/**
	 * The hit's line text, as ripgrep saw it (the trailing newline stripped).
	 *
	 * This is the search's SNAPSHOT of the line: the plugin serves the text it
	 * reads now, and compares it against this one to notice a file that
	 * changed after the search ran.
	 */
	text: string;
	/**
	 * The hit's character offset within its line, when ripgrep could say.
	 *
	 * It is what places a hit in the READ line space on a file whose line
	 * space ripgrep cannot reproduce (#147): the offset says which line of
	 * that space the hit is on.
	 */
	offset?: number;
}


/**
 * The text of a line ripgrep could not decode — it sends the bytes instead.
 * The official grep tool answers with the same placeholder.
 */
export const NOT_UTF8_LINE = "(line is not valid UTF-8)";
/**
 * What one ripgrep search produced.
 *
 * The distinction the caller lives on: "ripgrep answered, and the answer
 * is nothing" is an ANSWER (`ok` with an empty match list), while "ripgrep
 * could not answer" is a failure the caller may fall back from.
 */
export type RgSearchOutcome =
	/** ripgrep answered: `matches` may be empty (there was nothing to find). */
	| { kind: "ok"; matches: RgMatch[] }
	/** ripgrep could not run at all (the binary is missing or not executable). */
	| { kind: "unavailable" }
	/** ripgrep rejected the pattern (its regex engine does not accept it). */
	| { kind: "invalid-pattern"; message: string }
	/** ripgrep ran and failed (spawn error, timeout, oversized output). */
	| { kind: "failed"; message: string };

/** One ripgrep search: what to look for, and where. */
export interface RgSearchOptions {
	/** The pattern to search for. */
	pattern: string;
	/** Literal (fixed-string) pattern: `pattern` is not a regex. */
	literal: boolean;
	/** The candidate files, as an explicit list of paths. */
	files: readonly string[];
	/** The most hits to report per file (ripgrep `--max-count`); omitted = no cap. */
	limit?: number;
	/** An optional abort signal. */
	signal?: AbortSignal;
	/** The per-invocation timeout cap, in milliseconds. */
	timeoutMs?: number;
	/** Overrides the ripgrep executable path (for tests); resolved internally when omitted. */
	rgPath?: string;
}

let rgResolved: string | undefined | null;

/**
 * The ripgrep binary, resolved once per process.
 *
 * @returns the binary path, or undefined when ripgrep cannot be resolved at all.
 */
function rgBinary(): string | undefined {
	if (rgResolved === null) return undefined;
	rgResolved ??= resolveRg();
	return rgResolved;
}

/**
 * Whether an `rg --files` invocation produced a usable listing.
 *
 * Exit 1 means "nothing was listed", which is an answer for a listing too;
 * every other failure is a failure.
 */
function rgListedOk(error: { code?: string | number | null } | null | undefined): boolean {
	return error === null || error === undefined || error.code === 1;
}

/**
 * The flags every invocation carries, in the order the tool always uses.
 *
 * The pattern rides in `--regexp=<pattern>` and the files behind `--`, so a
 * value that starts with a dash can never be read as a flag. A literal
 * pattern is `--fixed-strings` — an independent flag, never a `-F` prefix
 * glued onto the pattern (#384).
 */
function fixedRgArgs(pattern: string, literal: boolean, limit?: number): string[] {
	return [
		// FIRST, and always: without it ripgrep reads the host's
		// RIPGREP_CONFIG_PATH (or an rg.conf next to the binary), and that config
		// may set `--pre` — an arbitrary preprocessor run against every file
		// the search touches.
		"--no-config",
		"--json",
		// Search binary files as text: without it ripgrep stops at the first NUL
		// byte and counts it as a line break, so every line number after it is
		// off by one (#268).
		"--text",
		...(limit !== undefined ? [`--max-count=${limit}`] : []),
		...rgPatternArgs(pattern, literal),
	];
}

/**
 * The flags that carry the PATTERN, in the order every invocation uses them.
 *
 * The pattern rides in `--regexp=<pattern>` and the files behind `--`, so a
 * value that starts with a dash can never be read as a flag. A literal
 * pattern is `--fixed-strings` — an independent flag, never a `-F` prefix
 * glued onto the pattern (#384). ONE builder, so the search and the counting
 * pass cannot drift apart on how the pattern reaches the engine.
 */
function rgPatternArgs(pattern: string, literal: boolean): string[] {
	return [...(literal ? ["--fixed-strings"] : []), `--regexp=${pattern}`, "--"];
}

/**
 * Build the complete argv of one search (the binary itself excluded).
 *
 * @param opts - the pattern, whether it is literal, the per-file cap and the
 *   files to search.
 * @returns the argv, in the order it is spawned.
 */
export function buildRgArgv(opts: {
	pattern: string;
	literal: boolean;
	limit?: number;
	files: readonly string[];
}): string[] {
	return [...fixedRgArgs(opts.pattern, opts.literal, opts.limit), ...opts.files];
}

/**
 * One ripgrep COUNT: how many lines of each file carry the pattern.
 *
 * The count is a pass of its OWN (#386): the search stops at the per-file cap
 * (`--max-count`), so the number of hits it collected is the cap, not the
 * file's hit count. A count that inherited the cap would report the cap and
 * call it the total — which is exactly what the tool used to answer.
 */
export interface RgCountOptions extends RgInvocationOptions {
	/** The pattern to search for. */
	pattern: string;
	/** Literal (fixed-string) pattern: `pattern` is not a regex. */
	literal: boolean;
	/** The candidate files, as an explicit list of paths. */
	files: readonly string[];
	/** Overrides the ripgrep executable path (for tests); resolved internally when omitted. */
	rgPath?: string;
}

/**
 * The flags a counting pass carries (the binary itself excluded).
 *
 * NO `--max-count`: the count is the number of matching lines, and a capped
 * count is the cap. `--with-filename` forces the path onto every line —
 * without it ripgrep prints a bare number when it is given ONE file, and the
 * count would have no file to belong to.
 *
 * The pattern rides in `--regexp=<pattern>` and the files behind `--`, exactly
 * as in the search: a literal pattern is the `--fixed-strings` FLAG, never a
 * `-F` prefix glued onto the pattern text (#384).
 */
function countRgArgs(pattern: string, literal: boolean): string[] {
	return [
		// FIRST, and always — see `fixedRgArgs` for why.
		"--no-config",
		"--text",
		"--count",
		"--with-filename",
		...rgPatternArgs(pattern, literal),
	];
}

/**
 * Build the complete argv of one counting pass (the binary itself excluded).
 *
 * @param opts - the pattern, whether it is literal, and the files to count.
 * @returns the argv, in the order it is spawned.
 */
export function buildRgCountArgv(opts: {
	pattern: string;
	literal: boolean;
	files: readonly string[];
}): string[] {
	return [...countRgArgs(opts.pattern, opts.literal), ...opts.files];
}

/** What one ripgrep process did, before any search result is derived from it. */
type RgProcess =
	| { kind: "exited"; code: number; stdout: string; stderr: string }
	| { kind: "spawn-error"; code: string | undefined; message: string }
	| { kind: "timeout"; message: string }
	| { kind: "output-too-large"; message: string };

/** The shape of the error `execFile` reports (a spawn error, an exit code, a kill). */
interface RgExecError {
	code?: string | number | undefined;
	killed?: boolean;
	message: string;
}

/**
 * The most stdout one invocation may produce before the search fails.
 *
 * A `--json` record per matching line, so a tree-wide search that matches
 * everywhere can be large; the ceiling is generous, and crossing it is a
 * FAILURE rather than a truncated answer — half an answer reads as a whole one.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The per-invocation timeout when the caller names none. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * ripgrep's own words for "I will not run this pattern".
 *
 * ripgrep rejects a pattern it cannot compile with exit code 2 — the same code
 * it uses for an unreadable path — so the stderr text is what separates "your
 * regex is wrong" (the caller's problem, worth reporting as such) from "the
 * search failed" (an environment problem).
 */
const PATTERN_ERROR = /regex parse error|error parsing glob/i;

/**
 * The knobs every ripgrep invocation shares — the search and the count
 * alike.
 */
interface RgInvocationOptions {
	/** An optional abort signal. */
	signal?: AbortSignal;
	/** The per-invocation timeout cap, in milliseconds. */
	timeoutMs?: number;
}

/**
 * Run one ripgrep process and hand back what it did.
 *
 * The spawn is wrapped so that a refusal the OS raises BEFORE a process exists
 * — an over-long command line (E2BIG / ENAMETOOLONG, #260), a binary that
 * cannot be executed — cannot escape: inside a promise executor such a throw
 * REJECTS the promise, and a rejected search is not an answer.
 */
function runRgProcess(
	rg: string,
	args: string[],
	opts: RgInvocationOptions,
): Promise<RgProcess> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise<RgProcess>((resolve) => {
		try {
			execFile(
				rg,
				args,
				{
					timeout: timeoutMs,
					maxBuffer: MAX_OUTPUT_BYTES,
					...(opts.signal ? { signal: opts.signal } : {}),
				},
				(error, stdout, stderr) => {
					if (error === null) {
						resolve({ kind: "exited", code: 0, stdout, stderr });
						return;
					}
					const failure = error as RgExecError;
					// The timeout kills the child: the callback reports the kill, not
					// an exit code.
					if (failure.killed === true) {
						resolve({ kind: "timeout", message: `ripgrep timed out after ${timeoutMs}ms` });
						return;
					}
					if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						resolve({
							kind: "output-too-large",
							message: `ripgrep produced more than ${MAX_OUTPUT_BYTES} bytes of output`,
						});
						return;
					}
					// A spawn error carries an errno STRING; an exit code is a number.
					if (typeof failure.code === "string") {
						resolve({ kind: "spawn-error", code: failure.code, message: failure.message });
						return;
					}
					resolve({
						kind: "exited",
						code: typeof failure.code === "number" ? failure.code : 2,
						stdout,
						stderr,
					});
				},
			);
		} catch (error) {
			const failure = error as RgExecError;
			resolve({
				kind: "spawn-error",
				code: typeof failure.code === "string" ? failure.code : undefined,
				message: failure.message,
			});
		}
	});
}

/** The first lines of a stderr, flattened into one readable line. */
function summarizeStderr(stderr: string): string {
	return stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(0, 3)
		.join(" ");
}

/**
 * Parse one `rg --json` stdout into its hits.
 *
 * Only `match` records are hits; `begin`, `end` and `summary` records are
 * progress. A record that cannot be read is a FAILURE, never a partial answer:
 * raw `rg --json` is an internal transport, so a broken record means the
 * transport broke.
 */
function parseRgMatches(
	stdout: string,
): { kind: "ok"; matches: RgMatch[] } | { kind: "failed"; message: string } {
	const matches: RgMatch[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch (error) {
			return {
				kind: "failed",
				message: `ripgrep produced a record that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (typeof record !== "object" || record === null) {
			return { kind: "failed", message: "ripgrep produced a record that is not an object" };
		}
		const typed = record as { type?: unknown; data?: unknown };
		if (typed.type !== "match") continue;
		const data = typed.data;
		if (typeof data !== "object" || data === null) {
			return { kind: "failed", message: "ripgrep produced a match record with no data" };
		}
		const { path, line_number: lineNumber, lines, submatches } = data as {
			path?: unknown;
			line_number?: unknown;
			lines?: unknown;
			submatches?: unknown;
		};
		const pathText =
			typeof path === "object" && path !== null ? (path as { text?: unknown }).text : undefined;
		if (typeof pathText !== "string") {
			return { kind: "failed", message: "ripgrep produced a match record with no path" };
		}
		if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber)) {
			return { kind: "failed", message: "ripgrep produced a match record with no line number" };
		}
		if (typeof lines !== "object" || lines === null) {
			return { kind: "failed", message: "ripgrep produced a match record with no line content" };
		}
		const lineContent = lines as { text?: unknown; bytes?: unknown };
		let text: string;
		if (typeof lineContent.text === "string") {
			text = lineContent.text.replace(/\r?\n$/, "");
		} else if (typeof lineContent.bytes === "string") {
			// A line that is not valid UTF-8: ripgrep sends its bytes, so the
			// text is unknowable and the placeholder says so.
			text = NOT_UTF8_LINE;
		} else {
			return {
				kind: "failed",
				message: "ripgrep produced a match record with neither line text nor bytes",
			};
		}
		const offset = submatchOffset(submatches, lineContent.text);
		matches.push({ path: pathText, line: lineNumber, text, ...(offset !== undefined ? { offset } : {}) });
	}
	return { kind: "ok", matches };
}


/**
 * The character offset of a byte offset inside one line.
 *
 * ripgrep counts BYTES; the plugin's text is decoded. The conversion walks
 * the line's characters until their byte lengths add up to the reported
 * offset — the offset of the hit inside the line ripgrep matched.
 *
 * The walk goes by CODE POINT, not by code unit: an astral character (an
 * emoji) is four bytes but two UTF-16 code units, and counting its halves
 * would overshoot the offset — the hit's seat would be lost, and the hit
 * with it.
 */
function charOffsetInLine(lineText: string, byteStart: number): number | undefined {
	let bytes = 0;
	let index = 0;
	for (const char of lineText) {
		if (bytes === byteStart) return index;
		bytes += Buffer.byteLength(char, "utf8");
		index += char.length;
	}
	return bytes === byteStart ? lineText.length : undefined;
}

/**
 * The hit's character offset within its line, from ripgrep's submatch.
 *
 * `undefined` when ripgrep reported no submatch (or a line it could not
 * decode) — the hit then cannot be placed inside its line, and the caller
 * places it by its line number alone.
 */
function submatchOffset(submatches: unknown, lineText: unknown): number | undefined {
	if (!Array.isArray(submatches) || submatches.length === 0) return undefined;
	if (typeof lineText !== "string") return undefined;
	const first = submatches[0] as { start?: unknown };
	if (typeof first.start !== "number") return undefined;
	return charOffsetInLine(lineText, first.start);
}
/**
 * Merge the hits of several invocations: grouped by file, ascending by line
 * number inside a file.
 *
 * A file belongs to exactly one invocation, so the merge never invents a hit;
 * it only puts the chunks back into one readable order.
 */
function mergeRgMatches(matches: readonly RgMatch[]): RgMatch[] {
	const byFile = new Map<string, Map<number, RgMatch>>();
	for (const match of matches) {
		let lines = byFile.get(match.path);
		if (lines === undefined) {
			lines = new Map<number, RgMatch>();
			byFile.set(match.path, lines);
		}
		// The first hit of a line wins: the same line reported twice carries the
		// same text and offset, and one row is one line.
		if (!lines.has(match.line)) lines.set(match.line, match);
	}
	const merged: RgMatch[] = [];
	for (const [path, lines] of byFile) {
		for (const line of [...lines.keys()].sort((a, b) => a - b)) merged.push(lines.get(line)!);
	}
	return merged;
}

/**
 * Turn what ripgrep did into the outcome the caller asked for.
 *
 * @param process - what the process did.
 * @returns the outcome, or the reason there is none.
 */
function classifyRgProcess(process: RgProcess): RgSearchOutcome {
	if (process.kind === "spawn-error") {
		// The binary is not there at all: nothing can be answered.
		if (process.code === "ENOENT") return { kind: "unavailable" };
		return { kind: "failed", message: `ripgrep could not be started: ${process.message}` };
	}
	if (process.kind === "timeout" || process.kind === "output-too-large") {
		return { kind: "failed", message: process.message };
	}
	const { code, stdout, stderr } = process;
	// Exit 0 = hits. Exit 1 = NOTHING hit, which is an ANSWER, not a failure:
	// collapsing the two is what made a zero-hit grep re-read the whole tree.
	if (code === 0) {
		const parsed = parseRgMatches(stdout);
		if (parsed.kind === "failed") return parsed;
		return { kind: "ok", matches: parsed.matches };
	}
	if (code === 1) return { kind: "ok", matches: [] };
	// Exit 2 is ripgrep's own error, and stderr says WHICH error it is.
	if (code === 2 && PATTERN_ERROR.test(stderr)) {
		return { kind: "invalid-pattern", message: summarizeStderr(stderr) };
	}
	const detail = summarizeStderr(stderr);
	return {
		kind: "failed",
		message: `ripgrep exited with code ${code}${detail === "" ? "" : `: ${detail}`}`,
	};
}

/**
 * Search with ripgrep and report every hit.
 *
 * The file list rides on the command line, so it is sliced by LENGTH, never by
 * file count (#260): every invocation's flags come off the budget first, and
 * each chunk is an independent ripgrep run whose hits are merged back
 * together.
 *
 * @param opts - the pattern, the files, and the per-invocation limits.
 * @returns the hits, or the reason there are none to report.
 */
export async function rgSearchMatches(opts: RgSearchOptions): Promise<RgSearchOutcome> {
	if (opts.files.length === 0) return { kind: "ok", matches: [] };
	const rg = opts.rgPath ?? rgBinary();
	if (rg === undefined) return { kind: "unavailable" };
	const fixed = fixedRgArgs(opts.pattern, opts.literal, opts.limit);
	const chunks = planArgvChunks([rg, ...fixed], opts.files, ARGV_BUDGET);
	if (chunks === undefined) {
		// No slicing of this list can be spawned: a single path wider than the
		// whole budget, or flags that spend it alone. Abstaining beats handing
		// the OS a command line it must refuse.
		return {
			kind: "failed",
			message: "the file list does not fit any command line ripgrep could be given",
		};
	}
	const collected: RgMatch[] = [];
	for (const chunk of chunks) {
		const outcome = classifyRgProcess(await runRgProcess(rg, [...fixed, ...chunk], opts));
		// A failed chunk is the whole search: a partial answer would read as a
		// complete one.
		if (outcome.kind !== "ok") return outcome;
		collected.push(...outcome.matches);
	}
	return { kind: "ok", matches: mergeRgMatches(collected) };
}

/**
 * Parse one `rg --count` stdout into the count of each file.
 *
 * The lines are `path:count`. The path may itself contain a colon (a Windows
 * drive), so the COUNT is what follows the LAST one — the file's name is
 * never guessed.
 */
function parseRgCounts(stdout: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		const at = line.lastIndexOf(":");
		if (at <= 0) continue;
		const count = Number(line.slice(at + 1));
		if (!Number.isInteger(count)) continue;
		counts.set(line.slice(0, at), count);
	}
	return counts;
}

/**
 * Count the matching lines of each file — the TRUE hit count (#386).
 *
 * The search stops at the per-file cap, so the number of hits it collected
 * is the cap and not the file's hit count. This pass has no cap of its own:
 * it counts every matching line of every file it is given.
 *
 * A count that cannot be made is NO count: the map comes back empty (or
 * partial), and the caller falls back to what the search collected. A count
 * is a fact about the file, never a guess.
 *
 * @param opts - the pattern, the files to count, and the per-invocation limits.
 * @returns the count of each file that carries hits.
 */
export async function rgCountMatchingLines(opts: RgCountOptions): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (opts.files.length === 0) return counts;
	const rg = opts.rgPath ?? rgBinary();
	if (rg === undefined) return counts;
	const fixed = countRgArgs(opts.pattern, opts.literal);
	const chunks = planArgvChunks([rg, ...fixed], opts.files, ARGV_BUDGET);
	if (chunks === undefined) return counts;
	for (const chunk of chunks) {
		const process = await runRgProcess(rg, [...fixed, ...chunk], opts);
		// Exit 0 = hits, exit 1 = nothing matched (an answer); anything else is
		// a failure, and a failure is no count at all.
		if (process.kind !== "exited" || (process.code !== 0 && process.code !== 1)) {
			return counts;
		}
		for (const [path, count] of parseRgCounts(process.stdout)) counts.set(path, count);
	}
	return counts;
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
	const rg = rgBinary();
	if (rg === undefined) return undefined;
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
			{ cwd: root, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, ...(signal ? { signal } : {}) },
			(error, stdout) => resolve({ ok: rgListedOk(error), stdout }),
		);
	});
	if (!listed.ok) return undefined;
	return listed.stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => join(root, line));
}
