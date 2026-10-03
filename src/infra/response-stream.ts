/**
 * Streaming segmented responses — the shared infrastructure behind ADR-0013.
 *
 * Three concerns, one module:
 *  1. **Budget** — the per-response char budget (UTF-16 code units, i.e. JS
 *     `string.length`), resolved from the settings snapshot and re-clamped.
 *  2. **Segment assembly** — take whole rows up to the budget (a line is never
 *     cut; rows assumed individually ≤ budget are pointer-ized upstream).
 *  3. **Spill + resume** — the not-returned rows of an oversized result go to
 *     a session spill file; the response carries an opaque resume token
 *     (random handle + sidecar JSON binding session, consumer tool, spill
 *     file, cursor and version stamps). Reads validate the consumer and the
 *     session; spill dirs are swept lazily (TTL) and removed on process exit.
 *
 * This module never touches workspace files — tools hand in rows and stamps.
 * @module dsh-hashline-edittool/infra/response-stream
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESUME_TTL_MS, RESPONSE_BUDGET_MAX, RESPONSE_BUDGET_MIN } from "./constants.js";
import { responseBudget } from "./settings.js";

/** UTF-16 code units of `s` — the budget's unit, matching the host's estimator. */
export function codeUnits(s: string): number {
	return s.length;
}

/** The effective per-response budget in code units (settings-driven, clamped). */
export function responseBudgetChars(): number {
	return responseBudget();
}

/** One spilled row. `path`/`line` name the real file row where applicable. */
export interface SegmentRow {
	content: string;
	path?: string;
	line?: number;
	/** Report-segment rows keep their diff prefix (`+`/`-`/` `); plain rows omit it. */
	kind?: "add" | "del" | "ctx" | "row";
}

/**
 * Take whole rows up to `budgetChars`. Rows are assumed individually ≤ budget
 * (a row that big is pointer-ized by the caller per #205); if one slips
 * through it is included alone so the walk always makes progress.
 */
export function takeRowsWithinBudget<T>(
	rows: T[],
	budgetChars: number,
	sizeOf: (row: T) => number,
): { included: T[]; overflow: T[]; used: number } {
	const included: T[] = [];
	let used = 0;
	let index = 0;
	while (index < rows.length) {
		const size = sizeOf(rows[index]!);
		if (used + size > budgetChars && included.length > 0) break;
		included.push(rows[index]!);
		used += size;
		index += 1;
	}
	return { included, overflow: rows.slice(index), used };
}

// --- spill store ---

const SPILL_ROOT = join(tmpdir(), "dsh-hashline");
const exitRegistered = new Set<string>();

function sessionDir(sessionKey: string): string {
	return join(SPILL_ROOT, createHash("sha256").update(sessionKey).digest("hex").slice(0, 12));
}

function newToken(): string {
	return `rs-${randomBytes(16).toString("hex")}`;
}

function isWellFormedToken(token: string): boolean {
	return /^rs-[0-9a-f]{32}$/.test(token);
}

/** Sidecar state: everything a resume needs besides the token itself. */
export interface ResumeSidecar {
	sessionKey: string;
	producer: string;
	consumer: string;
	kind: string;
	/** Spill data file name inside the session dir. */
	file: string;
	cursor: number;
	total: number;
	/** Kind-specific payload (e.g. `{ path, nextOffset }` for file windows). */
	meta: Record<string, unknown>;
	stamps: Array<{ path: string; version?: string; mtimeMs?: number; size?: number }>;
	createdAt: number;
}

export function resumeError(code: "E_RESUME_GONE" | "E_RESUME_BAD" | "E_RESUME_TOOL", message: string): Error {
	return new Error(`[${code}] ${message}`);
}

function registerExitCleanup(dir: string): void {
	if (exitRegistered.has(dir)) return;
	exitRegistered.add(dir);
	process.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort — the lazy TTL sweep is the backstop
		}
	});
}

/** Remove spill session dirs older than the TTL; prune expired sidecars in `dir`. */
async function sweepLazy(dir: string): Promise<void> {
	try {
		const now = Date.now();
		for (const entry of await readdir(SPILL_ROOT)) {
			const child = join(SPILL_ROOT, entry);
			if (child === dir) continue;
			const info = await stat(child).catch(() => undefined);
			if (info !== undefined && now - info.mtimeMs > RESUME_TTL_MS) {
				await rm(child, { recursive: true, force: true }).catch(() => undefined);
			}
		}
		for (const entry of await readdir(dir)) {
			if (!entry.endsWith(".res.json")) continue;
			const info = await stat(join(dir, entry)).catch(() => undefined);
			if (info !== undefined && now - info.mtimeMs > RESUME_TTL_MS) {
				const base = entry.slice(0, -".res.json".length);
				await rm(join(dir, entry), { force: true }).catch(() => undefined);
				await rm(join(dir, `${base}.rows.json`), { force: true }).catch(() => undefined);
			}
		}
	} catch {
		// sweeping is best effort; the process-exit cleanup covers the common case
	}
}

export interface CreateResumeOptions {
	sessionKey: string;
	/** The tool that produced the overflow. */
	producer: string;
	/** The tool allowed to consume the token (mutating tools' reports → "read"). */
	consumer: string;
	kind: string;
	rows: SegmentRow[];
	meta?: Record<string, unknown>;
	stamps?: ResumeSidecar["stamps"];
}

/** Persist an overflow's rows and mint its resume token. */
export async function createResume(
	opts: CreateResumeOptions,
): Promise<{ token: string; total: number }> {
	const dir = sessionDir(opts.sessionKey);
	await mkdir(dir, { recursive: true });
	registerExitCleanup(dir);
	await sweepLazy(dir);
	const token = newToken();
	const file = `${token}.rows.json`;
	await writeFile(join(dir, file), JSON.stringify({ rows: opts.rows }), "utf-8");
	const sidecar: ResumeSidecar = {
		sessionKey: opts.sessionKey,
		producer: opts.producer,
		consumer: opts.consumer,
		kind: opts.kind,
		file,
		cursor: 0,
		total: opts.rows.length,
		meta: opts.meta ?? {},
		stamps: opts.stamps ?? [],
		createdAt: Date.now(),
	};
	await writeFile(join(dir, `${token}.res.json`), JSON.stringify(sidecar), "utf-8");
	return { token, total: sidecar.total };
}

/** Load and validate a sidecar: session must match, consumer must match. */
export async function loadResume(
	sessionKey: string,
	token: string,
	consumer: string,
): Promise<ResumeSidecar> {
	if (!isWellFormedToken(token)) {
		throw resumeError("E_RESUME_BAD", `Resume token is malformed: ${JSON.stringify(token.slice(0, 24))}.`);
	}
	const path = join(sessionDir(sessionKey), `${token}.res.json`);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		throw resumeError(
			"E_RESUME_GONE",
			"Resume token is expired or its spill was cleaned up. Re-run the original tool call.",
		);
	}
	let sidecar: ResumeSidecar;
	try {
		sidecar = JSON.parse(raw) as ResumeSidecar;
	} catch {
		throw resumeError("E_RESUME_BAD", "Resume token's spill state is corrupt.");
	}
	if (sidecar.sessionKey !== sessionKey) {
		throw resumeError("E_RESUME_BAD", "Resume token belongs to a different session.");
	}
	if (sidecar.consumer !== consumer) {
		throw resumeError(
			"E_RESUME_TOOL",
			`Resume token must be consumed with the ${sidecar.consumer} tool, not ${consumer}.`,
		);
	}
	return sidecar;
}

/** Read up to `count` rows from a spill, starting at its cursor. */
export async function readSpillRows(sidecar: ResumeSidecar, count: number): Promise<SegmentRow[]> {
	const path = join(sessionDir(sidecar.sessionKey), sidecar.file);
	const data = JSON.parse(await readFile(path, "utf-8")) as { rows: SegmentRow[] };
	return data.rows.slice(sidecar.cursor, sidecar.cursor + count);
}

/** Persist a new cursor position on the sidecar. */
export async function advanceResume(sessionKey: string, token: string, cursor: number): Promise<void> {
	const path = join(sessionDir(sessionKey), `${token}.res.json`);
	const sidecar = JSON.parse(await readFile(path, "utf-8")) as ResumeSidecar;
	sidecar.cursor = cursor;
	await writeFile(path, JSON.stringify(sidecar), "utf-8");
}

/**
 * Consume the next text chunk of a continuation (used by read's report/text
 * resumes and by tools continuing their own text spills). Rows are plain
 * content — anchors, where they exist, are already embedded and served.
 */
export async function takeTextContinuation(
	sessionKey: string,
	token: string,
	consumer: string,
	count: number,
): Promise<{ lines: string[]; done: boolean; remaining: number }> {
	const sidecar = await loadResume(sessionKey, token, consumer);
	const rows = await readSpillRows(sidecar, count);
	const cursor = sidecar.cursor + rows.length;
	await advanceResume(sessionKey, token, cursor);
	return {
		lines: rows.map((row) => row.content),
		done: cursor >= sidecar.total,
		remaining: Math.max(0, sidecar.total - cursor),
	};
}

/** True when the two stamps disagree on every field they share. */
export function stampChanged(
	a: { version?: string; mtimeMs?: number; size?: number } | undefined,
	b: { version?: string; mtimeMs?: number; size?: number } | undefined,
): boolean {
	if (a === undefined || b === undefined) return false;
	if (a.version !== undefined && b.version !== undefined) return a.version !== b.version;
	if (a.mtimeMs !== undefined && b.mtimeMs !== undefined && a.size !== undefined && b.size !== undefined) {
		return a.mtimeMs !== b.mtimeMs || a.size !== b.size;
	}
	return false;
}

/** Best-effort stat of a spill dir — used by tests and diagnostics. */

/**
 * Split an oversized text model response: the head stays inline, the tail
 * spills to a resume file. Lines are never cut. Returns the model text with
 * the continuation footer appended, plus the continuation field.
 */
export async function spillModelTextOverflow(opts: {
	sessionKey: string;
	producer: string;
	consumer: string;
	kind?: string;
	modelText: string;
	budgetChars: number;
}): Promise<{ modelText: string; continuation?: { resume: string; remaining: number } }> {
	if (codeUnits(opts.modelText) <= opts.budgetChars) return { modelText: opts.modelText };
	const lines = opts.modelText.split("\n");
	const { included, overflow } = takeRowsWithinBudget(lines, opts.budgetChars, codeUnits);
	const { token } = await createResume({
		sessionKey: opts.sessionKey,
		producer: opts.producer,
		consumer: opts.consumer,
		kind: opts.kind ?? "text-continuation",
		rows: overflow.map((content) => ({ content })),
	});
	const omittedChars = overflow.reduce((acc, line) => acc + codeUnits(line), 0);
	return {
		modelText: `${included.join("\n")}\n\n(Omitted ${overflow.length} lines (~${omittedChars} chars). Use ${opts.consumer} {resume: "${token}"} to continue.)`,
		continuation: { resume: token, remaining: omittedChars },
	};
}
export async function spillDirInfo(sessionKey: string): Promise<string | undefined> {
	const dir = sessionDir(sessionKey);
	try {
		await readdir(dir);
		return dir;
	} catch {
		return undefined;
	}
}
