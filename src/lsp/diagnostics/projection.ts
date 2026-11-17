/**
 * Diagnostic projection — ONE implementation of "a diagnostics push becomes
 * rows beside their source lines", with the differences between callers
 * declared as POLICY, never re-implemented (ADR-0039, #429).
 *
 * The write path (auto-diagnostics) declares: severities {1,2} only, capped,
 * entries pre-split against the suppression ledger before they arrive here.
 * The manual `lsp diagnostics` query declares: every severity, uncapped, no
 * ledger. The ROW itself — one per source line, the verbatim text beside
 * structured messages — is built here once, so both channels render the same
 * shape and a fix to one is a fix to both.
 *
 * @module dsh-hashline-edittool/diagnostics/projection
 */

import { diagnosticLabel } from "./identity.js";
import { anchorForInWorkspace } from "../../domain/session/session-view.js";

/** One diagnostics-push entry, normalized to the fields the projection reads. */
export interface DiagnosticEntry {
	/** The protocol severity number (0 = unknown, 1 = error, 2 = warning, …). */
	readonly severity: number;
	/** The server's own source handle ("" when absent). */
	readonly source: string;
	/** The server's own rule/code handle ("" when absent). */
	readonly code: string;
	/** The message, verbatim; a non-string entry degrades to its JSON. */
	readonly message: string;
	/** 1-based line the diagnostic sits on. */
	readonly line: number;
	/** The protocol label (`error: …`), as the model text renders it. */
	readonly label: string;
}

/**
 * The caller-declared parameters of one projection (ADR-0039). Differences
 * between the write path and the manual query are DECLARED here — a policy
 * fact a reader can see, not drift hidden in a second implementation.
 */
export interface DiagnosticPolicy {
	/** Protocol severity numbers to report; absent = every severity. */
	readonly severities?: readonly number[];
	/** Maximum entries the projection reports; absent = uncapped. */
	readonly cap?: number;
}

/** One source line's diagnostics: parallel arrays beside the verbatim text. */
export interface DiagnosticLineBucket {
	messages: string[];
	severities: number[];
	sources: string[];
	codes: string[];
}

/** What projecting a list of entries produced. */
export interface DiagnosticProjection {
	/** One bucket per reported line, keyed by 1-based line number. */
	readonly byLine: Map<number, DiagnosticLineBucket>;
	/** Entries taken before the cap cut. */
	readonly totalSeen: number;
	/** Whether the cap cut entries. */
	readonly truncated: boolean;
}

/**
 * Normalize a raw push to the entries this projection reports: the policy's
 * severity set, on a line the protocol actually named.
 */
export function normalizeDiagnosticEntries(
	pushed: readonly unknown[],
	policy: DiagnosticPolicy,
): DiagnosticEntry[] {
	const entries: DiagnosticEntry[] = [];
	for (const entry of pushed) {
		const d = entry as {
			message?: unknown;
			severity?: unknown;
			source?: unknown;
			code?: unknown;
			range?: { start?: { line?: unknown } };
		};
		const severity = typeof d.severity === "number" ? d.severity : 0;
		if (policy.severities !== undefined && !policy.severities.includes(severity)) continue;
		const at = d.range?.start?.line;
		if (typeof at !== "number" || at < 0) continue;
		const source = typeof d.source === "string" ? d.source : "";
		const code = typeof d.code === "string" || typeof d.code === "number" ? String(d.code) : "";
		const message = typeof d.message === "string" ? d.message : JSON.stringify(entry);
		entries.push({
			severity,
			source,
			code,
			message,
			line: at + 1,
			label: diagnosticLabel(severity, source, code, message),
		});
	}
	return entries;
}

/**
 * Bucket the entries one per line. The cap counts ENTRIES (a line with three
 * diagnostics spends three), exactly as the write path always counted.
 */
export function projectDiagnosticLines(
	entries: readonly DiagnosticEntry[],
	policy: DiagnosticPolicy,
): DiagnosticProjection {
	const byLine = new Map<number, DiagnosticLineBucket>();
	let totalSeen = 0;
	let truncated = false;
	for (const entry of entries) {
		if (policy.cap !== undefined && totalSeen >= policy.cap) {
			truncated = true;
			break;
		}
		const bucket = byLine.get(entry.line) ?? { messages: [], severities: [], sources: [], codes: [] };
		bucket.messages.push(entry.label);
		bucket.severities.push(entry.severity);
		bucket.sources.push(entry.source);
		bucket.codes.push(entry.code);
		byLine.set(entry.line, bucket);
		totalSeen += 1;
	}
	return { byLine, totalSeen, truncated };
}

/** One source line carrying its diagnostics BESIDE the text (never merged into it). */
export type DiagnosticRow = {
	/** 1-based line number in the file. */
	number: number;
	/** The line's anchor ("" when it could not be allocated). */
	hash: string;
	/** The line's verbatim text — what `served` vouches for. */
	text: string;
	messages: string[];
	severities: number[];
	sources: string[];
	codes: string[];
};

/** Assemble the rows, in line order, from the buckets and the minted anchors. */
export function diagnosticRowsFromBuckets(
	byLine: ReadonlyMap<number, DiagnosticLineBucket>,
	lines: readonly string[],
	anchors: readonly string[],
): DiagnosticRow[] {
	return [...byLine.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([number, bucket]) => ({
			number,
			hash: anchors[number - 1] ?? "",
			text: lines[number - 1] ?? "",
			messages: bucket.messages,
			severities: bucket.severities,
			sources: bucket.sources,
			codes: bucket.codes,
		}));
}

/**
 * Mint anchors for exactly the reported lines (LAZY, #169) through the one
 * allocation entry point. The callers sit inside a `withWorkspace` scope
 * already; entering it again here is idempotent and means this call site
 * cannot be the one that forgets to (#223).
 */
export async function mintDiagnosticAnchors(opts: {
	cwd: string;
	absolutePath: string;
	content: string;
	lines: readonly number[];
	sessionKey: string;
}): Promise<string[]> {
	const sorted = [...opts.lines].sort((a, b) => a - b);
	const allocated = await anchorForInWorkspace({
		cwd: opts.cwd,
		absolutePath: opts.absolutePath,
		content: opts.content,
		lines: sorted,
		sessionKey: opts.sessionKey,
	});
	const anchors = new Array<string>(sorted.length).fill("");
	for (let k = 0; k < sorted.length; k++) anchors[k] = allocated[k] ?? "";
	return anchors;
}
