/**
 * The `grep` scan's memory budget (issue #167).
 *
 * A whole-tree grep reads every visited file, and for each one it also holds a
 * line-`hashes` array, a model-text section, card rows and recorded serve rows.
 * Every one of those grows with the file it came from, and **nothing bounded
 * the sum**: a large tree read until the host heap was gone and the process
 * died, which the desktop app then restarted.
 *
 * This module owns the arithmetic of that ceiling and nothing else — it is
 * pure, synchronous and IO-free (sizes and byte counts are handed in), so the
 * policy is testable without touching a filesystem. The caller keeps its own
 * decision of *what* to do with a refusal; here a file is only ever
 * admitted, skipped, or declared the end of the scan.
 *
 * @module dsh-hashline-edittool/read-budget
 */
import { GREP_MAX_FILE_BYTES, GREP_MAX_TOTAL_BYTES } from "./constants.js";

/** The ceilings one `grep` call runs under. */
export interface ReadBudgetLimits {
	/** Largest single file the scan will read, in bytes. */
	readonly maxFileBytes: number;
	/** Total bytes the whole scan may read, in bytes. */
	readonly maxTotalBytes: number;
}

/** Defaults, from the shipped constants. Resolved per call so tests can stub them. */
export function defaultLimits(): ReadBudgetLimits {
	return { maxFileBytes: GREP_MAX_FILE_BYTES, maxTotalBytes: GREP_MAX_TOTAL_BYTES };
}

/** Why a candidate file was not read. */
export type SkipReason =
	/** `stat` failed, or reported a non-regular file — it cannot be read. */
	| "unreadable"
	/** The file alone exceeds `maxFileBytes`. */
	| "too-large"
	/** The remaining `maxTotalBytes` allowance is smaller than the file. */
	| "budget";

/** A refusal from {@link ReadBudget.admit}. */
export interface SkipDecision {
	readonly ok: false;
	readonly reason: SkipReason;
	/** The file's byte length when it is known (0 for a failed `stat`). */
	readonly bytes: number;
}

/** An admitted file: the scan may read exactly `bytes` from it. */
export interface AdmitDecision {
	readonly ok: true;
	readonly bytes: number;
}

export type AdmitResult = AdmitDecision | SkipDecision;

/** What a finished scan has to report. */
export interface BudgetUsage {
	/** Bytes actually read. */
	readonly bytesRead: number;
	/** Files read. */
	readonly filesRead: number;
	/** Files refused by a ceiling (not counting unreadable ones). */
	readonly filesOmitted: number;
	/** The scan stopped early: a file did not fit in the total allowance. */
	readonly exhausted: boolean;
}

/**
 * A running tally of what a scan has read, enforcing both ceilings.
 *
 * Usage is strictly increasing: {@link ReadBudget.admit} is the only way to
 * reserve bytes, and {@link ReadBudget.release} is the only way to give an
 * unused reservation back. A caller that reserves and then fails to read must
 * release, or it leaks allowance.
 */
export interface ReadBudget {
	/** Can `bytes` be read? Reserves them when the answer is yes. */
	admit(bytes: number): AdmitResult;
	/** Give back `bytes` of an unused reservation. No-op when `bytes` <= 0. */
	release(bytes: number): void;
	/** Bytes reserved so far. */
	readonly bytesRead: number;
	/** The allowance not yet reserved. Never negative. */
	readonly remainingBytes: number;
	/** The tally for a report line. */
	usage(): BudgetUsage;
}

/**
 * Build a budget over the given ceilings.
 *
 * A non-finite, zero or negative ceiling is treated as unlimited for that
 * dimension — the tool always passes real constants, and a caller that
 * deliberately disables a ceiling should not have to invent a huge number.
 *
 * @param limits - the ceilings; omitted fields fall back to the shipped defaults.
 * @returns the budget.
 */
export function makeReadBudget(limits: Partial<ReadBudgetLimits> = {}): ReadBudget {
	const resolved = { ...defaultLimits(), ...limits };
	const maxFileBytes =
		Number.isFinite(resolved.maxFileBytes) && resolved.maxFileBytes > 0
			? resolved.maxFileBytes
			: Number.POSITIVE_INFINITY;
	const maxTotalBytes =
		Number.isFinite(resolved.maxTotalBytes) && resolved.maxTotalBytes > 0
			? resolved.maxTotalBytes
			: Number.POSITIVE_INFINITY;

	let bytesRead = 0;
	let filesRead = 0;
	let filesOmitted = 0;
	let exhausted = false;

	return {
		admit(bytes: number): AdmitResult {
			if (bytes > maxFileBytes) {
				filesOmitted += 1;
				return { ok: false, reason: "too-large", bytes };
			}
			if (bytesRead + bytes > maxTotalBytes) {
				// The scan is over: continuing would skip this file and then refuse
				// every remaining one, so the caller stops instead.
				filesOmitted += 1;
				exhausted = true;
				return { ok: false, reason: "budget", bytes };
			}
			bytesRead += bytes;
			filesRead += 1;
			return { ok: true, bytes };
		},
		release(bytes: number): void {
			// Clamped: a release larger than what was reserved must never leave a
			// negative total, which would silently enlarge the allowance.
			if (bytes > 0) bytesRead = Math.max(0, bytesRead - bytes);
		},
		get bytesRead(): number {
			return bytesRead;
		},
		get remainingBytes(): number {
			return Number.isFinite(maxTotalBytes)
				? Math.max(0, maxTotalBytes - bytesRead)
				: Number.POSITIVE_INFINITY;
		},
		usage(): BudgetUsage {
			return { bytesRead, filesRead, filesOmitted, exhausted };
		},
	};
}

/**
 * The longest prefix of `text` that fits in `maxBytes` of UTF-8, never ending
 * on a lone high surrogate (which would decode to U+FFFD and corrupt the row).
 *
 * @param text - the text to trim.
 * @param maxBytes - the byte ceiling.
 * @returns the prefix; empty when there is no room at all.
 */
function trimToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	if (head.length > 0 && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
	return head;
}

/**
 * Serialized-size ceiling for `grep`'s model-facing text.
 *
 * Unlike the card-side cap, which drops trailing file groups, this keeps the
 * head of the report and appends one truncation line: the model needs to know
 * that the list is incomplete, and a marker it can read is worth more than a
 * silently shortened list.
 *
 * @param text - the assembled model text.
 * @param maxBytes - the serialized byte ceiling.
 * @returns the text, unchanged when it fits; otherwise a head plus a notice.
 */
export function capModelText(text: string, maxBytes: number): string {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text;
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const noticeText =
		"\n\n[grep output truncated — the result list is incomplete; " +
		"narrow the search with `path`, `include` or a more specific `pattern`.]";
	const noticeBytes = Buffer.byteLength(noticeText, "utf8");
	// The notice is a fixed cost. When the ceiling cannot even hold it, the
	// notice IS the output: honouring `maxBytes` beats explaining the truncation.
	if (maxBytes <= noticeBytes) return trimToBytes(noticeText, maxBytes);
	const room = Math.max(0, maxBytes - noticeBytes);
	return trimToBytes(text, room) + noticeText;
}
