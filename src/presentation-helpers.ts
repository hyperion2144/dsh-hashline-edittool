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
	opts: { maxLineBytes?: number; maxBytes?: number; lang?: string } = {},
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

	const body = lineRenders
		.map(({ number, hash, text }) => `${number}${LINE_HASH_SEP}${hash}${hashSep()}${text}`)
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

/** Regex that strips the `ANCHOR:FILELINE` header for the read-card `content` fallback. */
const READ_BODY_RE = new RegExp(
	`^${hashlineHeader().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\n([\\s\\S]*)$`,
);

export function extractReadBody(modelText: string): string | undefined {
	const m = READ_BODY_RE.exec(modelText);
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

/** One matched line inside a file group. `line` is the pre-rendered `<line>#hash>content` row. */
export type GrepMatch = {
	/** 1-based line number within the file. */
	lineNumber: number;
	/** Pre-rendered `<line>#hash>content` row (consumed directly by the model text). */
	line: string;
} & { [key: string]: unknown };

/** One file's grouped matches for the grep card. */
export type GrepFileMatches = {
	path: string;
	matches: GrepMatch[];
} & { [key: string]: unknown };

/** The hashline grep tool's persisted presentation projection. */
export type GrepPresentation = {
	files: GrepFileMatches[];
	truncated: boolean;
	total: number;
} & { [key: string]: unknown };

export function grepPresentationFromMeta(meta: unknown): GrepPresentation | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const v = meta as Record<string, unknown>;
	if (!Array.isArray(v.files)) return undefined;
	for (const f of v.files) {
		if (typeof f !== "object" || f === null || Array.isArray(f)) return undefined;
		const file = f as { path?: unknown; matches?: unknown };
		if (typeof file.path !== "string") return undefined;
		if (!Array.isArray(file.matches)) return undefined;
		for (const m of file.matches) {
			if (typeof m !== "object" || m === null || Array.isArray(m)) return undefined;
			const match = m as { lineNumber?: unknown; line?: unknown };
			if (
				typeof match.lineNumber !== "number" ||
				!Number.isInteger(match.lineNumber) ||
				match.lineNumber < 1 ||
				typeof match.line !== "string"
			) {
				return undefined;
			}
		}
	}
	if (typeof v.truncated !== "boolean") return undefined;
	if (typeof v.total !== "number" || !Number.isInteger(v.total) || v.total < 0) return undefined;
	return v as unknown as GrepPresentation;
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
	const idx = ref.indexOf(LINE_HASH_SEP);
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
		const anchor = `${i + 1}${LINE_HASH_SEP}${hashes[i] ?? ""}`;
		lines[anchor] = allLines[i] ?? "";
	}
	return {
		path,
		offset: start,
		totalLines,
		lines,
	};
}

