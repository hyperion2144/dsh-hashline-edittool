/**
 * ripgrep as the grep tool's search ENGINE (#384) and the pipeline's bounds (#414).
 *
 * One `rg --json` invocation produces every row: `grep` no longer enumerates
 * candidate files, no longer slices the file list onto repeated command lines,
 * and no longer has a second engine to fall back to. ripgrep walks the path
 * itself, with its own default ignore semantics — so a build directory that a
 * parent `.gitignore` excludes is never walked at all.
 *
 * The bounds live here, not in the caller:
 *
 * - `RAW_OUTPUT_MAX_BYTES` (20 MB) — the whole search's stdout. Crossing it is
 *   a loud failure (`narrow pattern, path, or include and retry`), never a
 *   partial parse and never a different engine.
 * - `GREP_MAX_LINE_BYTES` (2000) — one row's preview is cut at the boundary and
 *   marked. A cut row is NOT anchorable: its text is no longer the line's text.
 * - `GREP_MAX_MATCHES` (250) — how many hits a response shows inline. The
 *   search itself is bounded by the raw cap; the caller spills the rest.
 *
 * Deliberate details kept from the engine alignment:
 *
 * - `--no-config` comes FIRST: without it ripgrep reads the host's
 *   `RIPGREP_CONFIG_PATH` (or an `rg.conf` next to the binary), and that config
 *   may set `--pre` — an arbitrary preprocessor run against every file.
 * - a literal pattern is `--fixed-strings`, NEVER a `-F` prefix glued onto the
 *   pattern text (#384).
 * - no `--text` (#414): binary hits are reported as byte records and stop at
 *   the binary boundary, instead of every NUL becoming a "line".
 *
 * @module dsh-hashline-edittool/tools/grep-rg
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/** The whole search's stdout ceiling; crossing it fails the search. */
export const RAW_OUTPUT_MAX_BYTES = 20_000_000;

/** One row's preview ceiling (UTF-8 bytes), matching the official grep tool. */
export const GREP_MAX_LINE_BYTES = 2000;

/** How many hits a response shows inline before it spills the rest. */
export const GREP_MAX_MATCHES = 250;

/** The per-invocation timeout when the caller names none. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How a cut preview announces itself. */
const TRUNCATION_MARKER = " (line truncated)";

/** The text of a line ripgrep could not decode — it sends the bytes instead. */
export const NOT_UTF8_LINE = "(line is not valid UTF-8)";

/**
 * Resolve the rg binary the same way DSH's own search does: the
 * `@vscode/ripgrep` package DSH ships (found via createRequire from this
 * module, or from the fs-search package), falling back to `rg` on PATH.
 *
 * @returns an absolute rg path, "rg" for PATH lookup, or undefined when unavailable.
 */
function resolveRg(): string | undefined {
	try {
		const req = createRequire(import.meta.url);
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

let rgResolved: string | undefined | null;

/** The ripgrep binary, resolved once per process. */
function rgBinary(): string | undefined {
	if (rgResolved === null) return undefined;
	rgResolved ??= resolveRg();
	return rgResolved;
}

/**
 * One row ripgrep reported: a hit (`match`) or a surrounding line (`context`).
 *
 * `text` is the row's preview — the line as ripgrep saw it, with a CRLF's
 * trailing CR and the newline removed, cut at `GREP_MAX_LINE_BYTES` when it is
 * longer. `truncated` says a cut happened (the row is then not anchorable);
 * `undecodable` says ripgrep could only send bytes (same consequence).
 */
export interface RgRow {
	/** The file the row is in, exactly as ripgrep reported it. */
	path: string;
	/** The 1-based line number of the row. */
	line: number;
	/** The row's preview text. */
	text: string;
	/** Whether the preview was cut at `GREP_MAX_LINE_BYTES`. */
	truncated: boolean;
	/** Whether the line was not valid UTF-8 (ripgrep sent `lines.bytes`). */
	undecodable: boolean;
	/** Whether this row is a HIT (a `match` record) or context around one. */
	match: boolean;
}

/** What one ripgrep search produced. */
export type GrepOutcome =
	/** ripgrep answered: the rows may be empty (there was nothing to find). */
	| { kind: "ok"; rows: RgRow[] }
	/** ripgrep could not run at all (the binary is missing or not executable). */
	| { kind: "unavailable" }
	/** ripgrep rejected the pattern (its regex engine does not accept it). */
	| { kind: "invalid-pattern"; message: string }
	/** The search's raw output crossed the ceiling. */
	| { kind: "overflow"; message: string }
	/** ripgrep ran and failed (spawn error, timeout, non-zero exit). */
	| { kind: "failed"; message: string };

/** One search: what to look for, and where. */
export interface GrepSearchOptions {
	/** The pattern to search for. */
	pattern: string;
	/** Literal (fixed-string) pattern: `pattern` is not a regex. */
	literal: boolean;
	/** The path ripgrep walks — a file or a directory. */
	path: string;
	/** An optional include glob (`--glob=`). */
	include?: string;
	/** How many context lines ripgrep reports around each hit. */
	context: number;
	/**
	 * Re-run with ripgrep's ancestor-ignore rules disabled.
	 *
	 * This is the "you named an ignored directory on purpose" fallback (#414
	 * Q3): the DEFAULT search always honours `.gitignore`/`.ignore` files above
	 * the path; this shape is used only when that search found nothing.
	 */
	ignoreAncestors?: boolean;
	/**
	 * Search ignored files too (`grep_respect_gitignore: false`).
	 *
	 * The DEFAULT search honours the tree's ignore files; this is the explicit
	 * "look where ripgrep would not" switch the setting maps onto.
	 */
	ignoreIgnore?: boolean;
	/** An optional abort signal. */
	signal?: AbortSignal;
	/** The per-invocation timeout cap, in milliseconds. */
	timeoutMs?: number;
}

/** What one ripgrep process did, before any row is derived from it. */
type RgProcess =
	| { kind: "exited"; code: number; stdout: string; stderr: string }
	| { kind: "spawn-error"; code: string | undefined; message: string }
	| { kind: "timeout"; message: string }
	| { kind: "overflow"; message: string };

/** The shape of the error `execFile` reports (a spawn error, an exit code, a kill). */
interface RgExecError {
	code?: string | number | undefined;
	killed?: boolean;
	message: string;
}

/**
 * Run one ripgrep process and hand back what it did.
 *
 * The spawn is wrapped so that a refusal the OS raises BEFORE a process exists
 * — a binary that cannot be executed — cannot escape: inside a promise
 * executor such a throw REJECTS the promise, and a rejected search is not an
 * answer.
 */
function runRgProcess(
	rg: string,
	args: string[],
	opts: GrepSearchOptions,
): Promise<RgProcess> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return new Promise<RgProcess>((resolve) => {
		try {
			execFile(
				rg,
				args,
				{
					timeout: timeoutMs,
					maxBuffer: RAW_OUTPUT_MAX_BYTES,
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
							kind: "overflow",
							message: `the search produced more than ${RAW_OUTPUT_MAX_BYTES} bytes of raw output; narrow pattern, path, or include and retry`,
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

/** ripgrep's own words for "I will not run this pattern". */
const PATTERN_ERROR = /regex parse error|error parsing glob/i;

/**
 * Cut one preview at `maxBytes` without splitting a UTF-8 sequence.
 *
 * @param text - the line as ripgrep reported it.
 * @returns the preview and whether it was cut.
 */
export function previewLine(text: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= GREP_MAX_LINE_BYTES) return { text, truncated: false };
	let bytes = 0;
	let out = "";
	for (const char of text) {
		const width = Buffer.byteLength(char, "utf8");
		if (bytes + width > GREP_MAX_LINE_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8")) break;
		bytes += width;
		out += char;
	}
	return { text: out + TRUNCATION_MARKER, truncated: true };
}

/** One `rg --json` data record, as far as this module reads it. */
interface RgRecordData {
	path?: unknown;
	line_number?: unknown;
	lines?: unknown;
}

/**
 * Parse one `rg --json` stdout into its rows.
 *
 * `match` rows are hits; `context` rows are the lines `--context` asked for.
 * `begin`, `end` and `summary` records are progress. A record that cannot be
 * read is a FAILURE, never a partial answer: raw `rg --json` is an internal
 * transport, so a broken record means the transport broke.
 */
function parseRgRecords(
	stdout: string,
): { kind: "ok"; rows: RgRow[] } | { kind: "failed"; message: string } {
	const rows: RgRow[] = [];
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
		if (typed.type !== "match" && typed.type !== "context") continue;
		const data = typed.data;
		if (typeof data !== "object" || data === null) {
			return { kind: "failed", message: "ripgrep produced a row record with no data" };
		}
		const { path, line_number: lineNumber, lines } = data as RgRecordData;
		const pathText =
			typeof path === "object" && path !== null ? (path as { text?: unknown }).text : undefined;
		if (typeof pathText !== "string") {
			return { kind: "failed", message: "ripgrep produced a row record with no path" };
		}
		if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber)) {
			return { kind: "failed", message: "ripgrep produced a row record with no line number" };
		}
		if (typeof lines !== "object" || lines === null) {
			return { kind: "failed", message: "ripgrep produced a row record with no line content" };
		}
		const lineContent = lines as { text?: unknown; bytes?: unknown };
		let text: string;
		let undecodable = false;
		if (typeof lineContent.text === "string") {
			// CRLF: ripgrep's line text ends "\r\n"; the read line space (ADR-0035)
			// keeps the CR inside the line, so only the newline goes.
			text = lineContent.text.replace(/\r?\n$/, "");
		} else if (typeof lineContent.bytes === "string") {
			// A line that is not valid UTF-8: the text is unknowable, and the
			// placeholder says so. Such a row is never anchorable.
			text = NOT_UTF8_LINE;
			undecodable = true;
		} else {
			return {
				kind: "failed",
				message: "ripgrep produced a row record with neither line text nor bytes",
			};
		}
		const preview = undecodable ? { text, truncated: false } : previewLine(text);
		rows.push({
			path: pathText,
			line: lineNumber,
			text: preview.text,
			truncated: preview.truncated,
			undecodable,
			match: typed.type === "match",
		});
	}
	return { kind: "ok", rows };
}

/** The flags that carry the PATTERN, in the order every invocation uses them. */
function rgPatternArgs(pattern: string, literal: boolean): string[] {
	return [...(literal ? ["--fixed-strings"] : []), `--regexp=${pattern}`, "--"];
}

/**
 * Build the complete argv of one search (the binary itself excluded).
 *
 * ONE shape: the path is the last element, ripgrep walks it, and every bound is
 * a flag on this single invocation (#414).
 */
export function buildGrepArgv(opts: GrepSearchOptions): string[] {
	return [
		"--no-config",
		"--json",
		// The "named an ignored directory on purpose" fallback only (#414 Q3).
		...(opts.ignoreAncestors === true ? ["--no-ignore-parent", "--no-require-git"] : []),
		...(opts.ignoreIgnore === true ? ["--no-ignore"] : []),
		...(opts.context > 0 ? [`--context=${opts.context}`] : []),
		...(opts.include !== undefined ? [`--glob=${opts.include}`] : []),
		...rgPatternArgs(opts.pattern, opts.literal),
		opts.path,
	];
}

/**
 * Turn what ripgrep did into the outcome the caller asked for.
 *
 * A failure is a FAILURE (#414): there is no second engine to fall back to, and
 * a partial answer would read as a complete one.
 */
function classify(process: RgProcess): GrepOutcome {
	if (process.kind === "spawn-error") {
		if (process.code === "ENOENT") return { kind: "unavailable" };
		return { kind: "failed", message: `ripgrep could not be started: ${process.message}` };
	}
	if (process.kind === "timeout") return { kind: "failed", message: process.message };
	if (process.kind === "overflow") return { kind: "overflow", message: process.message };
	const { code, stdout, stderr } = process;
	// Exit 0 = rows. Exit 1 = NOTHING hit, which is an ANSWER, not a failure.
	if (code === 0 || code === 1) {
		const parsed = parseRgRecords(stdout);
		if (parsed.kind === "failed") return { kind: "failed", message: parsed.message };
		return { kind: "ok", rows: parsed.rows };
	}
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
 * Run ONE ripgrep search over `opts.path`.
 *
 * @param opts - the pattern, the path, the include glob and the context size.
 * @returns the rows, or the reason there are none to report.
 */
export async function runGrep(opts: GrepSearchOptions): Promise<GrepOutcome> {
	const rg = rgBinary();
	if (rg === undefined) return { kind: "unavailable" };
	return classify(await runRgProcess(rg, buildGrepArgv(opts), opts));
}
