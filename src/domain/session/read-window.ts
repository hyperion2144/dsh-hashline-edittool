/**
 * Read cursors and the read window (#245, ADR-0014).
 *
 * `read`'s `offset` / `limit` accept an anchor as well as a line number, and a
 * read ends in ONE window sentence whatever its exit was. Both vocabularies
 * live here so the tool layer (the single assembly point) and the two renderers
 * that format served rows (`render/read-card`, `domain/session/file-view`)
 * spell them identically.
 *
 * The cursor anchors are checked against the served ledger through the same
 * read-only probe `edit` uses, and the refusals reuse `edit`'s codes: a dead
 * anchor is `E_STALE`, a served anomaly is `E_RANGE_UNVERIFIED`. Line numbers
 * in row markers stay hints — a cursor takes bare anchors.
 *
 * @module dsh-hashline-edittool/domain/session/read-window
 */
import { LINE_HASH_RE, hashRe, lineAnchorRe } from "../../hashline/hash-assign.js";
import type { ProbeReason } from "./anchor-entry.js";

/** A cursor field after parsing: absent, a line number, or an anchor to resolve. */
export type ReadCursor =
	| { readonly kind: "none" }
	| { readonly kind: "line"; readonly line: number }
	| { readonly kind: "anchor"; readonly anchor: string };

/** Which cursor field a refusal is about. */
export type ReadCursorName = "offset" | "limit";

/**
 * The sentence an empty file's read ends with: its synthetic row carries no text
 * of its own, so this IS the row's content (#212 / #245).
 */
export const EMPTY_FILE_NOTE = "[File is empty. Use edit to insert content.]";
/** The lines one `read` call actually served, as 1-based file line numbers. */
export interface ReadWindow {
	/** First line served. */
	readonly start: number;
	/** Last line served. */
	readonly end: number;
	/** The file's length in lines, with the empty file counted as one line. */
	readonly totalLines: number;
}

const DIGITS_RE = /^\d+$/;

/**
 * Parse one cursor field.
 *
 * A number stays a line number (a non-positive or fractional one is rejected).
 * A string is an anchor — unless it is visibly a line number wearing an
 * anchor's clothes (`line#hash`, `anchor:line`, `line:anchor`, or bare digits),
 * which is the one mistake worth naming precisely: the row marker's line half
 * is a hint, never part of the anchor.
 *
 * @param value - the raw field.
 * @param name - `offset` or `limit`, for the message.
 * @returns the parsed cursor.
 */
export function parseReadCursor(value: unknown, name: ReadCursorName): ReadCursor {
	if (value === undefined || value === null) return { kind: "none" };
	if (typeof value === "number") {
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
		}
		return { kind: "line", line: value };
	}
	if (typeof value !== "string") {
		throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a line number or an anchor.`);
	}
	const text = value.trim();
	if (LINE_HASH_RE.test(text) || lineAnchorRe().test(text) || DIGITS_RE.test(text)) {
		throw new Error(
			`[E_BAD_REF] Read request field "${name}" takes a bare anchor, not "${text}": the line number in a row marker is a hint, not part of the anchor. Re-read that line to get its anchor.`,
		);
	}
	if (hashRe().test(text)) return { kind: "anchor", anchor: text };
	throw new Error(
		`[E_BAD_SHAPE] Read request field "${name}" must be a line number or an anchor; got "${text}".`,
	);
}

/**
 * The window a served set forms, in file line numbers.
 * @param served - the served rows, in file order.
 * @param totalLines - the file's length in lines.
 * @returns the window, or `undefined` when nothing was served (the only exit
 * that carries no window).
 */
export function readWindowOf(
	served: readonly { readonly position: number }[],
	totalLines: number,
): ReadWindow | undefined {
	if (served.length === 0) return undefined;
	const total = Math.max(1, totalLines);
	const start = served[0]!.position + 1;
	const end = served[served.length - 1]!.position + 1;
	return { start, end: Math.min(end, total), totalLines: total };
}

/**
 * The one sentence that ends a text-mode read.
 * @param window - what the call served.
 * @param options - the resume token (body truncation) and the anchor of the
 * window's LAST line (the continuation cursor).
 * @returns the sentence, without a trailing newline.
 */
export function formatWindowSummary(
	window: ReadWindow,
	options: {
		readonly resumeToken?: string | undefined;
		readonly nextAnchor?: string | undefined;
	} = {},
): string {
	const { start, end, totalLines } = window;
	if (options.resumeToken !== undefined) {
		const omitted = Math.max(0, totalLines - end);
		return `[Lines ${start}-${end} of ${totalLines}. Omitted ${omitted} lines. Use read {resume: "${options.resumeToken}"} to continue.]`;
	}
	if (end < totalLines) {
		const anchor = options.nextAnchor ?? "";
		return anchor !== ""
			? `[Lines ${start}-${end} of ${totalLines}. Use offset="${anchor}" to continue.]`
			: `[Lines ${start}-${end} of ${totalLines}. Use offset=${end} to continue.]`;
	}
	return `[Lines ${start}-${end} of ${totalLines}. End of file.]`;
}

/**
 * The sentence of a read that served no line at all.
 * @param offset - the offset that was asked for.
 * @param totalLines - the file's length in lines.
 * @param empty - true for an empty file, whose advice is `edit`, not `offset=1`.
 * @returns the sentence, without a trailing newline.
 */
export function formatNoLinesSummary(offset: number, totalLines: number, empty = false): string {
	if (empty) {
		return `[No lines read. Offset ${offset} is beyond end of file (the file is empty). Use edit to insert content.]`;
	}
	return `[No lines read. Offset ${offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start.]`;
}

/**
 * The refusal a cursor anchor earns, in `edit`'s vocabulary.
 * @param reason - which probe condition failed.
 * @param anchor - the anchor that failed.
 * @param path - the file it was used against.
 * @param name - the field it was used in.
 * @returns the error to throw; `read` adds no echo of its own.
 */
export function cursorRejection(
	reason: ProbeReason,
	anchor: string,
	path: string,
	name: ReadCursorName,
): Error {
	if (reason === "not-live") {
		return new Error(
			`[E_STALE] The anchor "${anchor}" for read's ${name} is not live in ${path}: that line was rewritten or removed after it was served. Re-read for fresh anchors.`,
		);
	}
	const why =
		reason === "line-changed"
			? "its content changed after it was served"
			: reason === "line-moved"
				? "it moved out of the served range"
				: "it was never served in this session";
	return new Error(
		`[E_RANGE_UNVERIFIED] The anchor "${anchor}" for read's ${name} is not usable in ${path} (${why}). Re-read for fresh anchors.`,
	);
}

/**
 * The refusal of a window whose end point precedes its start.
 * @param startLine - the resolved offset.
 * @param endLine - the line the limit anchor named.
 * @returns the error to throw.
 */
export function invertedWindowError(startLine: number, endLine: number): Error {
	return new Error(
		`[E_BAD_SHAPE] Read request window ends before it starts: offset is line ${startLine} but limit names line ${endLine}. Pass a limit at or after the offset line.`,
	);
}

/**
 * The refusal of a request carrying both a resume token and a cursor.
 * @returns the error to throw.
 */
export function resumeConflictError(): Error {
	return new Error(
		"[E_RESUME_CONFLICT] Read request carries both a resume token and offset/limit. The token already names the window: pass one or the other, never both.",
	);
}
