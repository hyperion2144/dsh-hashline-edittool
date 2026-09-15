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
	lineHashesPure,
} from "../hashline/hash-assign.js";
import { execSessionKey, recordServed } from "../session-view.js";
import type { FileIO } from "../fs-bridge.js";
import { getLspManager } from "./manager.js";
import type { LspSession } from "./session.js";

/** How long a tool holds its result for an inline push. Hot servers push in <50ms; 300ms is 6× headroom under the human-perception threshold (#130). */
export const INLINE_WINDOW_MS = 300;

/** How long the background wait listens before giving up. A cold start is 2.6–3.1s; 10s is ~3× headroom. Past it, the model can still call `lsp diagnostics`. */
export const ASYNC_TIMEOUT_MS = 10_000;

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
 * What a tool captures BEFORE it writes: the session that is up for this
 * file's language and the revision baseline a later push is measured against.
 * `undefined` means the whole feature is off for this write — disabled by
 * settings, no manager, no language, or no READY server — and every later
 * step must skip without waiting.
 */
export interface WriteDiagContext {
	readonly session: LspSession;
	readonly uri: string;
	readonly revisionBefore: number;
}

/**
 * Snapshot the delivery context for a file about to be written.
 *
 * `readySessionFor` deliberately NEVER warms: a write starts no server. The
 * revision baseline is global per session, so a push for an unrelated document
 * can spend the baseline — the worst case is one report read a moment early,
 * never a wrong file's diagnostics (they are keyed by URI).
 */
export function prepareWriteDiagnostics(absolutePath: string): WriteDiagContext | undefined {
	if (!isAutoDiagnosticsEnabled()) return undefined;
	const manager = getLspManager();
	if (manager === undefined) return undefined;
	const language = languageForPath(absolutePath);
	if (language === undefined) return undefined;
	const session = manager.readySessionFor(language.id);
	if (session === undefined) return undefined;
	return {
		session,
		uri: pathToFileURL(absolutePath).href,
		revisionBefore: session.diagnosticsRevision,
	};
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
		const arrived = await waitForPush(input.session, input.revisionBefore, INLINE_WINDOW_MS);
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
 * Read the session's latest push for the URI and shape the report.
 *
 * Severity filter first (error + warning only, per #130 Q5): an `information`
 * or `hint` never consumes the cap. `undefined` covers three different
 * silences and all three mean "report nothing": no push for this URI at all,
 * an empty push (the server looked and found nothing — clean, not silent),
 * or only severities this feature does not report.
 */
function collectReport(input: AfterWriteInput): FileDiagnostics | undefined {
	const pushed = input.session.getDiagnostics(input.uri);
	if (pushed === undefined || pushed.length === 0) return undefined;
	const lines = splitLines(input.text);
	const anchors = lineHashesPure(input.text);
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
	void (async () => {
		try {
			const arrived = await waitForPush(
				input.session,
				input.revisionBefore,
				ASYNC_TIMEOUT_MS,
				signal,
			);
			if (!arrived || signal.aborted) return;
			const report = collectReport(input);
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
