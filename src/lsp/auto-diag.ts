/**
 * Automatic diagnostics after a write — the delivery half of the LSP story.
 *
 * Until this module existed the chain dead-ended: an edit landed on disk, the
 * sync pipeline told the server (`didChange`), the server pushed
 * `publishDiagnostics` right back — and nobody was listening. The model only
 * learned its edit broke something by calling `lsp diagnostics` by hand.
 *
 * The delivery is keyed by how hot the server is, exactly as #130 decided:
 *
 * 1. **Inline** — a push arrives within {@link INLINE_WINDOW_MS} of the write,
 *    so it is attached to the tool result itself. The caller appends the
 *    returned section to its model text and its presentation meta.
 * 2. **Async** — the server is up but slower than the window (a cold start is
 *    2.6–3.1s), so the tool returns without diagnostics and a bounded
 *    background wait delivers them via `agent.inject()` at the model's NEXT
 *    NATURAL STEP. `agent.inject` is the platform primitive for exactly this:
 *    queue model-facing context without waking the driver; an idle model
 *    never sees it until its next turn, and cancellation or disposal may
 *    discard it — which is acceptable by design (#131: stale diagnostics are
 *    dropped, and the 10s budget already bounds how long we listen).
 * 3. **Skip** — no language, no manager, or no READY server. A write must not
 *    warm a server and must not wait on one that does not exist.
 *
 * Two invariants shape every branch. A diagnostic is POST-HOC feedback, never
 * a write gate: the write already succeeded and a slow or silent server must
 * not turn it into a failure. And the positions are `<anchor>:<line>` markers
 * allocated by the SAME allocator `read` uses, then SERVED and OBSERVED — an
 * unserved anchor is decorative, so serving is what makes "fix it at this
 * marker without re-reading" literally true.
 *
 * @module dsh-hashline-edittool/lsp/auto-diag
 */
import { pathToFileURL } from "node:url";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import { languageForPath } from "../ast/language.js";
import { isAutoDiagnosticsEnabled } from "../config.js";
import { splitLines } from "../utils.js";
import {
	anchorWidth,
	fmtHashlineRow,
	fmtMarker,
} from "../hashline/hash-assign.js";
import { execSessionKey, recordServed } from "../session-view.js";
import type { FileIO } from "../fs-bridge.js";
import { getLspManager } from "./manager.js";
import { anchorsFor } from "../hashline/session-anchors.js";
import type { LspSession } from "./session.js";

/**
 * How long a tool holds its result for an inline push. Measured on a real
 * typescript-language-server: a HOT server still pushes consistently past
 * 300ms (#131 field report), so the window is 800ms — inside the tail of the
 * human-perception band, and a server with nothing to say costs no more than
 * the window once per write.
 */
export const INLINE_WINDOW_MS = 800;

/** How long the background wait listens before giving up. A cold start is 2.6–3.1s; 10s is ~3× headroom. Past it, the model can still call `lsp diagnostics`. */
export const ASYNC_TIMEOUT_MS = 10_000;

/**
 * How long the trigger-style pull (`textDocument/diagnostic`) waits for its
 * one computation. The request rides the ordered connection after our
 * `didChange`, so the answer is always the current content's — exceeding
 * this means the server is slow, and the push fallback takes over.
 */
export const PULL_TIMEOUT_MS = 3_000;

/** Error + warning entries reported per write before the report is cut off. */
export const MAX_REPORTED_DIAGNOSTICS = 50;

/** The plugin identity on every injected message. */
const PLUGIN_NAME = "dsh-hashline-edittool";

/** One source line carrying its diagnostics BESIDE the text (never merged into it). */
export type DiagRow = {
	/** 1-based line number in the post-write file. */
	number: number;
	/** The line's anchor ("" when it could not be allocated). */
	hash: string;
	/** The line's verbatim text. */
	text: string;
	/** Labelled messages, one per diagnostic (`error: …` / `warning: …`). */
	messages: string[];
	/** The raw LSP severity codes beside the labels, so a card can count. */
	severities: number[];
};

/** One written file's report: error + warning only, capped, clean files absent. */
export interface FileDiagnostics {
	/** The path as the tool displays it. */
	path: string;
	absolutePath: string;
	/** The tool that wrote the file (edit / ast_edit / write / undo_last_edit). */
	toolName: string;
	rows: DiagRow[];
	/** Error + warning entries seen before the cap; ≥ rows' message count when truncated. */
	totalSeen: number;
	/** Whether entries were dropped at {@link MAX_REPORTED_DIAGNOSTICS}. */
	truncated: boolean;
}

/**
 * What a tool captures BEFORE it writes: how to reach this file's language
 * server, and — when one is already UP — the session plus the revision
 * baseline a later push is measured against.
 *
 * Two shapes:
 *
 * - `session` set: a server is READY. The write synced it (`didChange` via
 *   `notifyDocumentWritten`) and the delivery waits for the push inline.
 * - `session` undefined: the server is cold or still starting. The write
 *   synced nobody — `notifyDocumentWritten` skips a non-ready server — so
 *   the delivery takes the ASYNC path: wait for the session, tell it about
 *   the file (`didOpen`), then wait for the push. A cold start used to skip
 *   the whole feature because only a READY session qualified (#131 field
 *   report, BUG-1).
 */
export interface WriteDiagContext {
	/** Present when a server was READY at write time; undefined = cold start pending. */
	readonly session?: LspSession;
	readonly languageId: string;
	/** The workspace root advertised to the server when warming. */
	readonly workspaceRoot: string;
	readonly uri: string;
	/**
	 * The revision baseline for `waitForPush`. For a ready session it is the
	 * pre-write snapshot; for a pending cold start it is 0 and the REAL
	 * baseline is taken once the session arrives.
	 */
	readonly revisionBefore: number;
}

/**
 * Snapshot the delivery context for a file about to be written.
 *
 * Two outcomes. A READY session gives the inline path its baseline. Anything
 * less (cold, still starting) fires `manager.warm` — fire-and-forget; this is
 * the ONE place a write may bring a server up, and it exists because the
 * field report showed a cold start otherwise skipped diagnostics entirely —
 * and returns a PENDING context the background wait resolves later.
 *
 * The revision baseline is global per session, so a push for an unrelated
 * document can spend it — the worst case is one report read a moment early,
 * never a wrong file's diagnostics (they are keyed by URI).
 *
 * @param absolutePath - the file about to be written.
 * @param workspaceRoot - advertised to the server when warming (the session cwd).
 */
export function prepareWriteDiagnostics(absolutePath: string, workspaceRoot: string): WriteDiagContext | undefined {
	if (!isAutoDiagnosticsEnabled()) return undefined;
	const manager = getLspManager();
	if (manager === undefined) return undefined;
	const language = languageForPath(absolutePath);
	if (language === undefined) return undefined;
	const uri = pathToFileURL(absolutePath).href;
	const session = manager.readySessionFor(language.id);
	if (session !== undefined) {
		return {
			session,
			languageId: language.id,
			workspaceRoot,
			uri,
			revisionBefore: session.diagnosticsRevision,
		};
	}
	// Cold or starting: kick the warm and let the async path wait it out. A
	// slot that already exists (starting or failed) makes `warm` a no-op.
	manager.warm(language.id, workspaceRoot);
	return { languageId: language.id, workspaceRoot, uri, revisionBefore: 0 };
}

/** Everything {@link deliverDiagnosticsAfterWrite} needs once the write is on disk. */
export interface AfterWriteInput extends WriteDiagContext {
	readonly toolName: string;
	/** The file's post-write text — anchors and source rows come from it. */
	readonly text: string;
	readonly absolutePath: string;
	readonly displayPath: string;
	readonly io: FileIO;
	readonly exec: ToolRunContext;
}

/**
 * Deliver one write's diagnostics.
 *
 * AWAITS at most {@link INLINE_WINDOW_MS}: on a push inside the window the
 * report is collected, its anchors are served, and it is returned for the
 * caller to attach. On timeout the bounded background wait is started (it
 * injects via `agent.inject` when the push lands) and `undefined` is returned
 * — the tool result has already waited its share and must not wait more.
 * Never throws: diagnostics are post-hoc feedback, not a write gate.
 */
export async function deliverDiagnosticsAfterWrite(
	input: AfterWriteInput,
): Promise<FileDiagnostics | undefined> {
	try {
		// A cold start has nobody to wait on inline — the push cannot arrive
		// before a session exists — so the background path takes over at once.
		if (input.session === undefined) {
			startAsyncWait(input);
			return undefined;
		}
		// TRIGGER-STYLE FIRST (#131 field feedback): the edit is final, so we
		// ASK for diagnostics once and wait for that exact computation. The
		// request rides the same ordered connection after our `didChange`, so
		// the answer describes the post-edit content — no push timing races,
		// no stale intermediate snapshots, no repeated pushes to sift.
		const pulled = await input.session.pullDiagnostics(input.uri, PULL_TIMEOUT_MS);
		if (pulled !== undefined) {
			const report = collectReport(input, pulled.items);
			if (report === undefined) return undefined;
			await serveReport(input, report.rows);
			return report;
		}
		// FALLBACK (server has no pull): wait for the push stream, ignoring
		// pushes computed against older content.
		const arrived = await waitForFreshPush(
			input.session,
			input.uri,
			input.revisionBefore,
			INLINE_WINDOW_MS,
		);
		if (!arrived) {
			startAsyncWait(input);
			return undefined;
		}
		const report = collectReport(input);
		if (report === undefined) return undefined;
		await serveReport(input, report.rows);
		return report;
	} catch (error) {
		console.error(
			`dsh-hashline-edittool: automatic diagnostics failed for ${input.displayPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

/**
 * Poll for a push whose revision is past the baseline.
 *
 * `publishDiagnostics` is a push, not a request, so the only honest wait is a
 * bounded poll against the session's revision counter — the same instrument
 * the manual `lsp diagnostics` operation reads, at a much shorter budget.
 */
async function waitForPush(
	session: LspSession,
	revisionBefore: number,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (session.diagnosticsRevision === revisionBefore && Date.now() < deadline) {
		if (signal?.aborted) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return session.diagnosticsRevision !== revisionBefore;
}

/**
 * Wait for a push that is FRESH for `uri`: one computed against the document
 * version we last announced. Servers analyze asynchronously, so right after
 * a `didChange` they may still push the PREVIOUS content's results — those
 * are stale and are skipped (a new baseline is taken and the wait continues
 * within the same budget). A push without a version is accepted: freshness
 * cannot be proven, and refusing every unversioned push would drop servers
 * that never send versions.
 */
async function waitForFreshPush(
	session: LspSession,
	uri: string,
	revisionBefore: number,
	budgetMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	let baseline = revisionBefore;
	for (;;) {
		if (!(await waitForPush(session, baseline, Math.max(0, deadline - Date.now()), signal))) return false;
		const pushVersion = session.diagnosticsVersion(uri);
		const documentVersion = session.documentVersion(uri);
		if (pushVersion === undefined || documentVersion === undefined || pushVersion === documentVersion) return true;
		// Stale push: it spent the baseline, so re-baseline and keep waiting.
		baseline = session.diagnosticsRevision;
		if (Date.now() >= deadline || signal?.aborted) return false;
	}
}

/**
 * Read the session's latest push for the URI and shape the report.
 *
 * Severity filter first (error + warning only, per #130 Q5): an `information`
 * or `hint` never consumes the cap. `undefined` covers three different
 * silences and all three mean "report nothing": no push for this URI at all,
 * an empty push (the server looked and found nothing — clean, not silent),
 * or only severities this feature does not report.
 */
function collectReport(input: AfterWriteInput, pushedArg?: readonly unknown[]): FileDiagnostics | undefined {
	const pushed = pushedArg ?? input.session?.getDiagnostics(input.uri);
	if (pushed === undefined || pushed.length === 0) return undefined;
	const lines = splitLines(input.text);
	const anchors = anchorsFor(input.absolutePath, input.text);
	const byLine = new Map<number, { messages: string[]; severities: number[] }>();
	let totalSeen = 0;
	let truncated = false;
	for (const entry of pushed) {
		if (totalSeen >= MAX_REPORTED_DIAGNOSTICS) {
			truncated = true;
			break;
		}
		const d = entry as {
			message?: unknown;
			severity?: unknown;
			range?: { start?: { line?: unknown } };
		};
		const code = typeof d.severity === "number" ? d.severity : 0;
		if (code !== 1 && code !== 2) continue;
		const at = d.range?.start?.line;
		if (typeof at !== "number" || at < 0) continue;
		const label = code === 1 ? "error" : "warning";
		const message = typeof d.message === "string" ? d.message : JSON.stringify(entry);
		const line = at + 1;
		const bucket = byLine.get(line) ?? { messages: [], severities: [] };
		bucket.messages.push(`${label}: ${message}`);
		bucket.severities.push(code);
		byLine.set(line, bucket);
		totalSeen += 1;
	}
	if (byLine.size === 0) return undefined;
	const rows = [...byLine.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([number, bucket]) => ({
			number,
			hash: anchors[number - 1] ?? "",
			text: lines[number - 1] ?? "",
			messages: bucket.messages,
			severities: bucket.severities,
		}));
	return {
		path: input.displayPath,
		absolutePath: input.absolutePath,
		toolName: input.toolName,
		rows,
		totalSeen,
		truncated,
	};
}

/**
 * Serve and observe the reported rows, so their markers are directly editable.
 *
 * An anchor the session never saw is rejected by the served-state check, which
 * would make "fix it at this marker" a lie — the same reason `lsp diagnostics`
 * serves its rows. Failures are logged, never raised.
 */
async function serveReport(input: AfterWriteInput, rows: readonly DiagRow[]): Promise<void> {
	const served = rows
		.filter((row) => row.hash !== "")
		.map((row) => ({ position: row.number - 1, anchor: row.hash }));
	if (served.length === 0) return;
	await recordServed(execSessionKey(input.exec), input.absolutePath, served, splitLines(input.text).length);
	await input.io.emitObserved(input.absolutePath, input.exec, input.exec.signal);
}

/**
 * Start the bounded background wait for a slow push.
 *
 * Fire-and-forget by contract: the tool has returned and this runs beside the
 * session. On arrival the report is collected AND served (the anchors in the
 * injected text must be as writable as the inline ones), then handed to
 * `agent.inject` — the queue-without-waking primitive, so the model meets the
 * diagnostics on its next natural step and an idle model is never interrupted.
 */
function startAsyncWait(input: AfterWriteInput): void {
	const agent = input.exec.agent;
	if (agent === undefined) return;
	const signal = input.exec.signal;
	const startedAt = Date.now();
	void (async () => {
		try {
			let session = input.session;
			if (session === undefined) {
				// COLD START. Wait for the warm to finish — inside the SAME
				// budget, so a slow boot spends the wait and leaves nothing for
				// the push, which is the honest outcome of a 3s cold start.
				const manager = getLspManager();
				const remaining = Math.max(0, ASYNC_TIMEOUT_MS - (Date.now() - startedAt));
				session = (await manager?.waitForSession(input.languageId, input.workspaceRoot, remaining)) ?? undefined;
				if (session === undefined || signal.aborted) return;
				// The write synced NOBODY (the server was not up), and an LSP
				// server has no disk watcher — left alone it would never learn
				// the file changed. Tell it now: the fresh session has surely
				// never seen this document, so this is a `didOpen`.
				const openDocument = manager?.openDocumentFor(input.languageId, input.uri);
				openDocument?.(input.text);
			}
			const arrived = await waitForPush(
				session,
				session.diagnosticsRevision,
				ASYNC_TIMEOUT_MS - (Date.now() - startedAt),
				signal,
			);
			if (!arrived || signal.aborted) return;
			const report = collectReport({ ...input, session });
			if (report === undefined) return;
			await serveReport(input, report.rows);
			agent.inject(buildInjectedMessage(input, report));
		} catch {
			// A background delivery that fails stays silent: the write succeeded,
			// and the model can always ask `lsp diagnostics` itself.
		}
	})();
}

/**
 * The plugin-sourced message an async delivery injects.
 *
 * `form: "diagnostics"` is deliberately OUTSIDE the platform's `ContextForm`
 * union: an unknown form is the documented opaque-content default, which is
 * exactly the plain-text collapsed row #130 accepted as final (Q16 — a custom
 * card would have to hijack every context message's renderer). The cast is
 * local to this one field so a future union growth cannot silently re-style
 * this message.
 */
function buildInjectedMessage(input: AfterWriteInput, report: FileDiagnostics): UserMessage {
	return createUserMessage({
		content: [{ type: "text", text: formatInjectedText(input, report) }],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "diagnostics",
		} as never,
	});
}

/** The injected text: origin (file, tool, call id) first, anchored rows under it. */
function formatInjectedText(input: AfterWriteInput, report: FileDiagnostics): string {
	return [
		`[LSP diagnostics arrived late for ${report.path}]`,
		`written by ${report.toolName} (call ${String(input.exec.callId)}):`,
		renderRows(report),
	].join("\n");
}

/**
 * The model-facing section an INLINE delivery appends to its tool result.
 *
 * Rows render with the same primitives as every other hashline channel —
 * `fmtMarker` for the `<anchor>:<line>` gutter, the configured separator, one
 * `↳` per diagnostic under its line — so a marker pasted from this section
 * behaves exactly like one from a read.
 */
export function formatDiagnosticsSection(reports: readonly FileDiagnostics[]): string {
	if (reports.length === 0) return "";
	const parts: string[] = [];
	let errors = 0;
	let warnings = 0;
	for (const report of reports) {
		for (const row of report.rows) {
			for (const code of row.severities) {
				if (code === 1) errors += 1;
				else if (code === 2) warnings += 1;
			}
		}
	}
	const head =
		reports.length === 1
			? `LSP diagnostics — ${reports[0]!.path} (${errors} error(s), ${warnings} warning(s))`
			: `LSP diagnostics across ${reports.length} file(s) (${errors} error(s), ${warnings} warning(s))`;
	parts.push(head);
	for (const report of reports) {
		if (reports.length > 1) parts.push(`--- ${report.path} ---`);
		parts.push(renderRows(report));
		if (report.truncated) {
			parts.push(
				`… further diagnostics omitted (report capped at ${MAX_REPORTED_DIAGNOSTICS}); call \`lsp diagnostics\` for the full list.`,
			);
		}
	}
	return parts.join("\n");
}
/** The anchored rows of one report, `↳` messages indented under their line. */
function renderRows(report: FileDiagnostics): string {
	const markers = report.rows.map((row) => fmtMarker(row.hash, row.number));
	const width = Math.max(1, anchorWidth(markers));
	const indent = " ".repeat(2 + width + 2);
	const out: string[] = [];
	report.rows.forEach((row, index) => {
		out.push(`  ${fmtHashlineRow(markers[index] ?? row.hash, row.text, width)}`);
		for (const message of row.messages) out.push(`${indent}↳ ${message}`);
	});
	return out.join("\n");
}

/**
 * The meta channel an INLINE delivery persists for the web card: one entry
 * per written file, carrying the same rows the model text rendered. The
 * capsule renders from THIS, never from parsing the `↳` prose (ADR-0005).
 */
export type DiagMetaEntry = { path: string; rows: DiagRow[] };

export function diagnosticsMeta(reports: readonly FileDiagnostics[]): DiagMetaEntry[] {
	return reports.map(({ path, rows }) => ({ path, rows }));
}

/**
 * One JSON-mode row: severity as WORDS (a number means nothing to a reader),
 * the source text beside the messages.
 */
export type DiagJsonRow = {
	text: string;
	messages: string[];
	severities: string[];
};

/**
 * The JSON-mode projection (#131 field feedback): marker-KEYED, aligned with
 * the diff dict — `\"<anchor>:<line>\"` is the key (the same first token a
 * row is addressed by everywhere else), and the value is a dictionary of
 * `text` / `messages` / `severities`. No `hash` field, no bare `number`: the
 * anchor IS the identity and the line trails it inside the key, exactly as
 * the diff and read envelopes spell it.
 */
export type DiagJsonEntry = {
	path: string;
	rows: Record<string, DiagJsonRow>;
};

export function diagRowsToJson(rows: readonly DiagRow[]): Record<string, DiagJsonRow> {
	return Object.fromEntries(
		rows.map((row) => [
			// A row without an anchor falls back to its bare line number — the
			// same marker rule every other channel uses.
			row.hash === "" ? `${row.number}` : `${row.hash}:${row.number}`,
			{
				text: row.text,
				messages: row.messages,
				severities: row.severities.map((code) => (code === 1 ? "error" : code === 2 ? "warning" : "diagnostic")),
			},
		]),
	);
}

export function diagnosticsJson(reports: readonly FileDiagnostics[]): DiagJsonEntry[] {
	return reports.map(({ path, rows }) => ({ path, rows: diagRowsToJson(rows) }));
}
