/**
 * Pure presentation helpers for the hashline tools' `output.render` /
 * `output.presentationMeta` / `presentResult` / `presentCall` chain.
 *
 * Mirrors the pattern in `@deepseek-ai/dsh-tool-fs` (the official built-in
 * fs tools, which is the authoritative reference for the
 * `presentationMeta` / `presentResult` contract):
 *   - the canonical value is a structured object (path / lines / totalLines
 *     for read; before / after for write/edit; files / truncated / total for
 *     grep),
 *   - `output.render(args, value)` projects the model-facing text from the
 *     structured value and returns one or more `ContentBlock`s (we use a
 *     single `code` block so the `:` separator in the row format does not
 *     trigger markdown table parsing),
 *   - `output.presentationMeta(args, value)` derives the card projection
 *     persisted in the session log; `presentResult(args, result)` reads
 *     `result.meta` to build the typed `ToolResultView` (with soft
 *     validation that returns `undefined` on any violation, so UIs degrade
 *     gracefully on replay with older logged calls).
 *
 * No IO, no cordis, no plugin-context state — these are pure functions that
 * can be unit-tested without a harness. Tool bodies do the IO; this module
 * only shapes the data the harness + the web see.
 *
 * @module dsh-hashline-edittool/presentation-helpers
 */

import { structuredPatch } from "diff";
import { LINE_HASH_SEP, hashSep, hashlineHeader } from "./hashline/hash-assign.js";

/** Extension → syntax-highlighting language hint (mirrored from dsh-tool-fs; extended for the hashline corpus). */
const LANG_BY_EXTENSION: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	mjs: "js",
	cjs: "js",
	jsx: "jsx",
	json: "json",
	jsonc: "json",
	py: "py",
	rb: "rb",
	go: "go",
	rs: "rs",
	java: "java",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	cxx: "cpp",
	cs: "cs",
	kt: "kotlin",
	swift: "swift",
	php: "php",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	ini: "ini",
	md: "md",
	markdown: "md",
	mdx: "mdx",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	sql: "sql",
	xml: "xml",
	lua: "lua",
};

/** Derive a syntax-highlighting language hint from a read path's file extension. */
export function langFromPath(path: string): string | undefined {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const base = path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const ext = base.slice(dot + 1).toLowerCase();
	return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined;
}

// ============================================================================
// Read
// ============================================================================

/** One read-window row, hash-agnostic (used by UIs that don't know about hashline). */
export type ReadFileLine = {
	/** 1-based line number in the source file. */
	number: number;
	/** Line text without the trailing newline, already truncated to the per-line byte cap. */
	text: string;
} & { [key: string]: unknown };

/** One read-window row, with the hashline anchor (line#hash + content). */
export type ReadHashlineLine = {
	number: number;
	hash: string;
	text: string;
} & { [key: string]: unknown };

/** The hashline read tool's canonical value (returned from `execute`). */
export type ReadValue = {
	path: string;
	offset: number;
	totalLines: number;
	lines: ReadFileLine[];
	hashlines: ReadHashlineLine[];
	truncatedByBytes?: boolean;
} & { [key: string]: unknown };

/** The hashline read tool's persisted presentation projection. */
export type ReadPresentation = {
	path: string;
	offset: number;
	lines: ReadFileLine[];
	totalLines: number;
	hashlines?: ReadHashlineLine[];
	lang?: string;
} & { [key: string]: unknown };

/** One line of the read window text, pre-rendered. */
type ReadLineRender = {
	number: number;
	hash: string;
	text: string;
} & { [key: string]: unknown };

/**
 * Build the read canonical value and the model-facing text in one pass.
 * Pure: does not read the filesystem; the tool body calls this with the
 * already-loaded content + hashes.
 */
export function buildReadPresentation(
	content: string,
	hashes: readonly string[],
	offset: number,
	limit: number,
	path: string,
	opts: {
		maxLineBytes?: number;
		maxBytes?: number;
		lang?: string;
		/** issue #66/B5: render row markers as <line>:<anchor> when on. */
		lineNumbers?: boolean;
	} = {},
): ReadValue & { modelText: string } {
	const allLines = splitLines(content);
	const totalLines = allLines.length;
	const start = Math.max(1, offset);
	const startIdx = start - 1;
	const endIdx = Math.min(startIdx + limit, totalLines);
	const lines = allLines.slice(startIdx, endIdx);
	const hashesSlice = hashes.slice(startIdx, endIdx);

	// Per-line byte truncation (mirrors dsh-tool-fs: the read window's
	// per-line cap drops a single oversize line down to the cap and
	// surfaces a "exceeds N bytes" marker elsewhere — we keep the cap
	// silent here, the model sees the truncated text, the UI sees the
	// full text via the persisted meta).
	const maxLineBytes = opts.maxLineBytes;
	const lineRenders: ReadLineRender[] = lines.map((text, i) => {
		let truncated = text;
		let truncatedByBytes = false;
		if (maxLineBytes !== undefined) {
			const bytes = Buffer.byteLength(text, "utf-8");
			if (bytes > maxLineBytes) {
				truncated = text.slice(0, Math.max(0, maxLineBytes));
				truncatedByBytes = true;
			}
		}
		return { number: start + i, hash: hashesSlice[i] ?? "", text: truncated };
	});

	const hasMore = endIdx < totalLines;
	const endLine = start + lineRenders.length - 1;
	let footer: string;
	if (hasMore) {
		footer = `[Showing lines ${start}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`;
	} else if (start > totalLines) {
		footer = `[Offset ${start} is beyond end of file (${totalLines} lines total).]`;
	} else {
		footer = `[End of file - total ${totalLines} lines.]`;
	}

	// issue #66/B5: the tool-layer presentation rebuilds the model text from
	// the structured value (not from readAndServe's text), so the line_numbers
	// switch must be honored HERE too — rows render as <line>:<anchor>:content.
	const body = lineRenders
		.map(({ number, hash, text }) =>
			opts.lineNumbers !== false
				? `${number}:${hash}${hashSep()}${text}`
				: `${hash}${hashSep()}${text}`,
		)
		.join("\n");
	const modelText = `${hashlineHeader()}\n${body}\n\n${footer}`;

	return {
		path,
		offset: start,
		totalLines,
		lines: lineRenders.map(({ number, text }) => ({ number, text })),
		hashlines: lineRenders,
		truncatedByBytes: lineRenders.some((l) =>
			lines[lineRenders.indexOf(l)] !== l.text,
		),
		modelText,
	};
}

/**
 * Legacy artifact of the dsh 0.1.2 web read card (issue #69 direction A).
 * Since issue #71 direction B, read results are NOT enveloped anymore — the
 * bundled client plugin renders the card from presentationMeta alone. The
 * regex survives only so {@link extractReadBody} can still strip the envelope
 * from PRE-0.4.2 session history when a legacy card projection asks for the
 * body.
 */
export const DSH_READ_ENVELOPE_RE =
	/^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u;


/**
 * Build the `ANCHOR:FILELINE` header-strip regex at CALL time. The compiled
 * header depends on configuration that may settle after this module loads —
 * a module-load-time RegExp captured a stale shape and silently never
 * matched (found by the issue #71 direction-B tests).
 */
function readBodyRe(): RegExp {
	return new RegExp(`^${hashlineHeader().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*)$`);
}

/**
 * Strip the read transport wrapper and return the body shown to the model.
 * Prefers the legacy dsh read envelope (pre-0.4.2 session history); falls
 * back to the `ANCHOR:FILELINE` header strip for current model texts.
 */
export function extractReadBody(modelText: string): string | undefined {
	const envelope = DSH_READ_ENVELOPE_RE.exec(modelText);
	if (envelope !== null) return envelope[1];
	const m = readBodyRe().exec(modelText);
	return m?.[1];
}

/** Soft-validate the persisted read meta. Returns the validated shape, or `undefined`. */
export function readMetaFromMeta(meta: unknown): ReadPresentation | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const v = meta as Record<string, unknown>;
	if (typeof v.path !== "string") return undefined;
	if (typeof v.offset !== "number" || !Number.isInteger(v.offset) || v.offset < 1) return undefined;
	if (typeof v.totalLines !== "number" || !Number.isInteger(v.totalLines) || v.totalLines < 0) return undefined;
	if (!Array.isArray(v.lines)) return undefined;
	if (v.lines.some((line) => !isFileTextLine(line))) return undefined;
	if (v.hashlines !== undefined) {
		if (!Array.isArray(v.hashlines)) return undefined;
		if (v.hashlines.some((line) => !isFileHashlineLine(line))) return undefined;
	}
	if (v.lang !== undefined && typeof v.lang !== "string") return undefined;
	let previous = v.offset - 1;
	for (const { number } of v.lines as ReadFileLine[]) {
		if (number <= previous || number > v.totalLines) return undefined;
		previous = number;
	}
	return {
		path: v.path,
		offset: v.offset,
		lines: v.lines as ReadFileLine[],
		totalLines: v.totalLines,
		hashlines: v.hashlines as ReadHashlineLine[] | undefined,
		lang: v.lang as string | undefined,
	} as ReadPresentation;
}

function isFileTextLine(v: unknown): boolean {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const { number, text } = v as { number?: unknown; text?: unknown };
	return (
		typeof number === "number" &&
		Number.isInteger(number) &&
		number >= 1 &&
		typeof text === "string"
	);
}

function isFileHashlineLine(v: unknown): boolean {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const { number, hash, text } = v as { number?: unknown; hash?: unknown; text?: unknown };
	return (
		typeof number === "number" &&
		Number.isInteger(number) &&
		number >= 1 &&
		typeof hash === "string" &&
		typeof text === "string"
	);
}

// ============================================================================
// Diff (edit / batch_edit / undo_last_edit)
// ============================================================================

/** One applied hunk: prior and new content for the same range, with 3 lines of context on each side. */
export type FileDiff = {
	path: string;
	/** Prior content of the range, or `null` for a new-file create / an overwrite. */
	oldText: string | null;
	/** Content after the change. */
	newText: string;
} & { [key: string]: unknown };

/** One applied hunk between `before` and `after`, with `context: 3` lines on each side. */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
	const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
	const diffs: FileDiff[] = [];
	for (const hunk of patch.hunks) {
		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (const line of hunk.lines) {
			if (line.startsWith("\\")) continue;
			const text = line.slice(1);
			if (line.startsWith("-")) oldLines.push(text);
			else if (line.startsWith("+")) newLines.push(text);
			else {
				oldLines.push(text);
				newLines.push(text);
			}
		}
		diffs.push({
			path,
			oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
			newText: newLines.join("\n"),
		});
	}
	return diffs;
}

/**
 * One rendered diff row with its gutter facts — the RENDERING channel for the
 * web diff card (issue #71). Persisted in presentationMeta; never derived
 * from the model-facing text, which may change shape at any time.
 */
export type EditDiffRow = {
	/** `+` added, `-` removed, ` ` context. */
	kind: "+" | "-" | " ";
	/** `+` / context: the post-edit line number. `-`: the pre-edit line number. */
	lineNumber: number;
	/** `+` / context: the served post-edit anchor. `-`: the stale pre-edit anchor. Empty when unknown. */
	hash: string;
	text: string;
};

/** Project genDiff's structured rows into the persisted meta shape. */
export function diffRowsFromGenDiff(
	rows: ReadonlyArray<{ kind: "+" | "-" | " "; content: string; lineNumber: number; hash: string }>,
): EditDiffRow[] {
	return rows.map((row) => ({
		kind: row.kind,
		lineNumber: row.lineNumber,
		hash: row.hash ?? "",
		text: row.content,
	}));
}

/** Soft-validate the persisted diff rows meta. Returns the validated shape, or `undefined`. */
export function diffRowsFromMeta(meta: unknown): EditDiffRow[] | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const v = meta as { diffRows?: unknown };
	if (!Array.isArray(v.diffRows) || v.diffRows.length === 0) return undefined;
	if (
		!v.diffRows.every((row) => {
			if (typeof row !== "object" || row === null) return false;
			const r = row as { kind?: unknown; lineNumber?: unknown; hash?: unknown; text?: unknown };
			return (
				(r.kind === "+" || r.kind === "-" || r.kind === " ") &&
				typeof r.lineNumber === "number" &&
				Number.isInteger(r.lineNumber) &&
				r.lineNumber >= 1 &&
				typeof r.hash === "string" &&
				typeof r.text === "string"
			);
		})
	) {
		return undefined;
	}
	return v.diffRows as EditDiffRow[];
}
/** Soft-validate the persisted diffs meta. Returns the validated shape, or `undefined`. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const v = meta as { diffs?: unknown };
	if (!Array.isArray(v.diffs) || v.diffs.length === 0) return undefined;
	if (!v.diffs.every(isFileDiff)) return undefined;
	return v.diffs as FileDiff[];
}

function isFileDiff(v: unknown): boolean {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const { path, oldText, newText } = v as { path?: unknown; oldText?: unknown; newText?: unknown };
	return (
		typeof path === "string" &&
		(oldText === null || typeof oldText === "string") &&
		typeof newText === "string"
	);
}

// ============================================================================
// Grep
// ============================================================================

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

// ============================================================================
// Utilities
// ============================================================================

/** Pure LF splitter (mirrors dsh-tool-fs's splitting). */
function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Parse the leading `<line>#<hash>` from a `remove_from` / `remove_to` argument. */
export function parseLineFromHash(ref: string): number | undefined {
	if (typeof ref !== "string") return undefined;
	const idx = ref.indexOf(":");
	if (idx <= 0) return undefined;
	const n = Number.parseInt(ref.slice(0, idx), 10);
	return Number.isInteger(n) && n >= 1 ? n : undefined;
}


/** Pure-JSON read view: `lines` is a dict {anchor: content} for the window. */
export function buildReadJson(
	content: string,
	hashes: readonly string[],
	offset: number,
	limit: number,
	path: string,
): object {
	const allLines = splitLines(content);
	const totalLines = allLines.length;
	const start = Math.max(1, offset);
	const startIdx = start - 1;
	const endIdx = Math.min(startIdx + limit, totalLines);
	const lines: Record<string, string> = {};
	for (let i = startIdx; i < endIdx; i++) {
		const anchor = `${hashes[i] ?? ""}`;
		lines[anchor] = allLines[i] ?? "";
	}
	return {
		path,
		offset: start,
		totalLines,
		lines,
	};
}

