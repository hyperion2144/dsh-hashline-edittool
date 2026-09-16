/**
 * The grep card's projection: the row shape, the highlight-span computation,
 * the serialized-meta cap, and the soft validator the card degrades on.
 *
 * Split out of `presentation-helpers` (the old five-tool grab-bag) so a grep
 * card change lands in the file that owns the grep card. Self-contained: no
 * imports from the other card modules.
 *
 * @module dsh-hashline-edittool/render/grep-card
 */

/** One inclusive-exclusive `[start, end)` range of a highlighted occurrence. */
export type MatchSpan = [number, number];

/**
 * One card row for a single file: the line's identity (number + served anchor),
 * its verbatim text, and the highlight spans of every pattern occurrence in it.
 *
 * `match` is present (true) ONLY on the rows the model's match list contains —
 * a zero-width pattern (e.g. `^`, `b*`) matches a line yet produces no spans, so
 * `spans.length > 0` is NOT a substitute for `match`. Rows that merely echo
 * context never carry it.
 */
export type GrepRow = {
	/** 1-based line number within the file. */
	number: number;
	/** The served hashline anchor for this line (empty string when unavailable). */
	hash: string;
	/** The line's full text, verbatim — the card never truncates a row. */
	text: string;
	/** Present on the capped match rows only; absent on pure context rows. */
	match?: true;
	/** Highlight ranges for this line; absent when the line has none. */
	spans?: MatchSpan[];
} & { [key: string]: unknown };

/** One file's card rows (match rows + echoed context rows) in file order. */
export type GrepFileRows = {
	path: string;
	rows: GrepRow[];
} & { [key: string]: unknown };

/** The hashline grep tool's persisted presentation projection. */
export type GrepPresentation = {
	files: GrepFileRows[];
	truncated: boolean;
	total: number;
} & { [key: string]: unknown };

/**
 * Serialized-meta budget, mirroring the shipped search tools
 * (`@deepseek-ai/dsh-tool-fs-search`'s `SEARCH_META_MAX_BYTES`).
 */
export const GREP_META_MAX_BYTES = 64 * 1024;

/** Serialized UTF-8 byte length of a candidate meta payload. */
function metaBytes(meta: unknown): number {
	return Buffer.byteLength(JSON.stringify(meta), "utf8");
}

/**
 * Every occurrence of `pattern` in `text`, as `[start, end)` JS string indices
 * (UTF-16 code units, so the card can slice the text directly).
 *
 * The semantics mirror the tool's own matching contract exactly:
 * - literal mode (`regex: false`) scans non-overlapping occurrences;
 * - regex mode highlights the WHOLE match (never a capture group) and skips
 *   zero-width matches — there is no character to mark, and advancing past them
 *   is what keeps the scan finite;
 * - case sensitivity follows the matcher (the tool has no `-i` switch).
 *
 * Pure: no IO, no regex compilation cache, safe to call per row.
 * @param text - the full line text to scan.
 * @param pattern - the grep pattern string.
 * @param regex - true when `pattern` is a JavaScript-flavre regex.
 * @returns the spans, ascending and non-overlapping; empty when nothing is markable.
 */
export function matchSpans(text: string, pattern: string, regex: boolean): MatchSpan[] {
	if (text.length === 0 || pattern.length === 0) return [];
	const spans: MatchSpan[] = [];
	if (!regex) {
		let from = 0;
		for (;;) {
			const at = text.indexOf(pattern, from);
			if (at === -1) break;
			spans.push([at, at + pattern.length]);
			from = at + pattern.length;
		}
		return spans;
	}
	let compiled: RegExp;
	try {
		// A fresh global clone: `exec` iteration never mutates a shared regex,
		// and `g` changes iteration only (never the matching semantics).
		compiled = new RegExp(pattern, "g");
	} catch {
		return [];
	}
	for (;;) {
		const found = compiled.exec(text);
		if (found === null) break;
		const matched = found[0];
		if (matched.length === 0) {
			// Zero-width: nothing to mark. A global regex leaves `lastIndex` at the
			// match start for an empty match, so step one code unit to stay finite.
			if (found.index + 1 > text.length) break;
			compiled.lastIndex = found.index + 1;
			continue;
		}
		spans.push([found.index, found.index + matched.length]);
		if (compiled.lastIndex <= found.index) compiled.lastIndex = found.index + matched.length;
	}
	return spans;
}

/**
 * Bound the card projection to a serialized byte budget by dropping TRAILING
 * file groups (mirrors the shipped `capMetaBytes`): `total` keeps counting what
 * the search found, `truncated` reports the loss, and a single oversized group is
 * kept rather than emptying a card that has a real result.
 *
 * The returned meta is a new object; the input is never mutated.
 * @param meta - the uncapped projection.
 * @param maxBytes - the serialized budget (defaults to {@link GREP_META_MAX_BYTES}).
 * @returns the capped projection.
 */
export function capGrepMeta(
	meta: GrepPresentation,
	maxBytes: number = GREP_META_MAX_BYTES,
): GrepPresentation {
	if (metaBytes(meta) <= maxBytes) return meta;
	const files = [...meta.files];
	while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxBytes) files.pop();
	return { ...meta, files, truncated: true };
}

/**
 * Soft-validate the persisted grep meta. Any deviation returns `undefined`, which
 * is how the card distinguishes its three degradation tiers: absent/malformed
 * meta (older sessions) renders the generic body, `rows` without `spans` renders
 * the card unhighlighted, and `spans` render the highlights.
 *
 * A zero-match result (`files: []`) is valid — an empty card, not an absent one.
 */
export function grepPresentationFromMeta(meta: unknown): GrepPresentation | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const v = meta as Record<string, unknown>;
	if (!Array.isArray(v.files)) return undefined;
	for (const f of v.files) {
		if (typeof f !== "object" || f === null || Array.isArray(f)) return undefined;
		const file = f as { path?: unknown; rows?: unknown };
		if (typeof file.path !== "string") return undefined;
		if (!Array.isArray(file.rows)) return undefined;
		for (const row of file.rows) {
			if (!isGrepRow(row)) return undefined;
		}
	}
	if (typeof v.truncated !== "boolean") return undefined;
	if (typeof v.total !== "number" || !Number.isInteger(v.total) || v.total < 0) return undefined;
	return v as unknown as GrepPresentation;
}

/** One persisted card row: line identity + verbatim text + optional highlight spans. */
function isGrepRow(row: unknown): boolean {
	if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
	const { number, hash, text, match, spans } = row as Record<string, unknown>;
	if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return false;
	if (typeof hash !== "string") return false;
	if (typeof text !== "string") return false;
	if (match !== undefined && match !== true) return false;
	if (spans !== undefined) {
		if (!Array.isArray(spans)) return false;
		for (const span of spans) {
			if (!Array.isArray(span) || span.length !== 2) return false;
			const [start, end] = span as [unknown, unknown];
			if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return false;
			if (typeof end !== "number" || !Number.isInteger(end) || end <= start) return false;
		}
	}
	return true;
}
