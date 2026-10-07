/**
 * The shared read-and-serve operation — now a thin wrapper over FileView.
 *
 * FileView owns normalize → hash → render → truncate → served selection.
 * This module only adds the persistence seam: recordServed + clearDriftReported
 * + UTF-8 rewrite note. Used by the `read` tool and by the write auto-read
 * hook, so the model is always shown fresh anchors the same way.
 * @module dsh-hashline-edittool/read-and-serve
 */

import { abortIf } from "./infra/utils.js";
import { readView } from "./domain/session/file-view.js";
import { clearDriftReported, withWorkspace } from "./domain/session/session-view.js";
import { probeLines } from "./domain/session/anchor-entry.js";
import type { FileIO } from "./infra/fs-bridge.js";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { ServedRow } from "./hashline/anchor-pipeline.js";

/** Appended when the file had non-UTF-8 bytes; editing rewrites it as UTF-8. */
export const UTF8_REWRITE_NOTE =
	"[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]";

export interface ReadAndServeOptions {
	/** The session whose served rows these lines belong to. */
	sessionKey: string;
	signal?: AbortSignal;
	/** Pagination for the rendered preview (undefined = from the start). */
	offset?: number;
	limit?: number;
	/** ADR-0013: per-response char budget for the returned window. */
	maxChars?: number;
	/** The user's line-number switch (#244): a row marker becomes `<anchor>:<line>` when on. */
	lineNumbers?: boolean;
	/**
	 * The calling execution. Serving rows IS observing the file, so the dsh
	 * observation policy has to hear about it — otherwise the rows a caller
	 * just read are servable but not WRITABLE (`[E_NOT_OBSERVED]` on the next
	 * edit), which makes serving decorative.
	 */
	exec?: ToolExecution;
}

export interface ReadAndServeResult {
	/** The model-facing read text, including the UTF-8 note when applicable. */
	text: string;
	/** The rows recorded as served (empty when nothing was shown). */
	served: ServedRow[];
	hadUtf8DecodeErrors: boolean;
	absolutePath: string;
	/**
	 * Per-line hashes for the WHOLE file (not just the window) — let the
	 * `read` tool build its structured value (lines / hashlines / totalLines)
	 * from the same source. Consumers that only need the model text can
	 * ignore this. Returns `undefined` when the file did not normalize to
	 * a known number of lines.
	 */
	hashes?: string[];
	/** The LF-normalized full file content (the basis for hashing + lines). */
	normalized?: string;
	/** ADR-0013: next offset when the window was char-budget-truncated. */
	nextOffset?: number;
	/** #212: absolute line of the last served row — the tool layer's render bound. */
	shownEnd?: number;
}

/**
 * Perform one read-and-serve: normalize the file at `rawPath`, render its
 * hashline preview, record the shown rows as served for the session, and clear
 * the reported-drift marks (a fresh read resets them). The returned text
 * carries the UTF-8 rewrite note when the file had decode errors.
 *
 * Records the shown rows as served AND emits `fs/observed` for the file when an
 * exec context was supplied: a caller that can see the lines can also write
 * with them, and the observation is what makes that true.
 */
export async function readAndServe(
	io: FileIO,
	rawPath: string,
	cwd: string,
	options: ReadAndServeOptions,
): Promise<ReadAndServeResult> {
	const { sessionKey, signal } = options;
	abortIf(signal);
	const view = await readView(io, rawPath, cwd, {
		offset: options.offset,
		limit: options.limit,
		lineNumbers: options.lineNumbers,
		maxChars: options.maxChars,
		// #223: the session the renderer mints its window for. Without it the
		// renderer cannot serve what it shows, and this seam would have to keep a
		// second recording path.
		sessionKey,
		signal,
	});
	if (view.served.length > 0) {
		// #223: the mint AND the served record now commit together, inside the
		// renderer's call to the one entry point — see `fmtReadPreview`, which
		// mints the window it is about to show and serves it in the same
		// transaction. So this seam does NOT re-record: doing that would record
		// the same rows a second time.
		//
		// What it does instead is CHECK. The model must be shown the anchors it can
		// actually use, and the window the renderer minted is the one it rendered;
		// if those ever disagreed the model would be handed one anchor and served
		// another — silently, which is the #187/#212 class. `probeLines` is the
		// read-only half of the entry point, so the check cannot itself record.
		//
		// A plain `Error`, deliberately WITHOUT an `[E_...]` token: this is an
		// internal invariant, not a model-facing outcome, and the contract freezes
		// the error-code set ("错误码集合一字不改").
		const rows = view.served.filter((r) => r.anchor !== undefined && r.anchor !== null);
		if (rows.length > 0) {
			// Inside the workspace scope: `probeLines` reads the session's served set,
			// and the store is resolved from the cwd — probing outside the scope reads
			// the SHARED fallback store, where these rows are not (the same trap #171
			// documented for writes).
			const probe = await withWorkspace(cwd, () =>
				probeLines({
					path: view.absolutePath,
					content: view.normalized,
					refs: rows.map((r) => ({ anchor: r.anchor as string, line: r.position + 1 })),
					sessionKey,
				}),
			);
			if (!probe.ok) {
				throw new Error(
					`anchor/serve divergence in ${view.absolutePath}: the rendered rows are not usable (${probe.reason}). Row(s): ${probe.rows
						.map((r) => `${r.line} given "${r.given}" current "${r.current}"`)
						.join(", ")}. The rendered text and the served record disagree, so the row would be unusable; refusing to publish it.`
				);
			}
		}
		// The rows are served, so the session has SEEN this file: tell the dsh
		// observation policy, or the very rows just handed over cannot be
		// edited with until an explicit read re-observes the file.
		if (options.exec !== undefined) {
			await io.emitObserved(view.absolutePath, options.exec, signal);
		}
	}
	await clearDriftReported(sessionKey, view.absolutePath);
	const text = view.hadUtf8DecodeErrors
		? `${view.text}\n\n${UTF8_REWRITE_NOTE}`
		: view.text;
	return {
		text,
		served: view.served,
		hadUtf8DecodeErrors: view.hadUtf8DecodeErrors,
		absolutePath: view.absolutePath,
		hashes: view.hashes,
		normalized: view.normalized,
		...(view.nextOffset !== undefined ? { nextOffset: view.nextOffset } : {}),
		...(view.shownEnd !== undefined ? { shownEnd: view.shownEnd } : {}),
	};
}
