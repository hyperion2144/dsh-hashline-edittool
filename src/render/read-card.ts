/**
 * The read card's projection: the canonical read value, the model-facing read
 * text, the legacy-envelope strip, the language hint, and the soft validator
 * the card degrades on.
 *
 * Split out of `presentation-helpers` (the old five-tool grab-bag) so a read
 * card change lands in the file that owns the read card. Rendering comes from
 * `../hashline/hash-assign` (row/heading shapes) and `./edit-diff`
 * (formatRowMarker, for the JSON view's keys).
 *
 * @module dsh-hashline-edittool/render/read-card
 */
import { hashSep, hashlineHeader } from "../hashline/hash-assign.js";
import { formatRowMarker } from "./edit-diff.js";

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

/** Pure LF splitter (mirrors dsh-tool-fs's splitting). */
function splitLines(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

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
	// switch must be honored HERE too — rows render as `<anchor>:<line>:content`.
	const body = lineRenders
		.map(({ number, hash, text }) =>
			opts.lineNumbers !== false
				? `${hash}:${number}${hashSep()}${text}`
				: `${hash}${hashSep()}${text}`,
		)
		.join("\n");
	const modelText = `${hashlineHeader(opts.lineNumbers !== false)}\n${body}\n\n${footer}`;

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

/** Pure-JSON read view: `lines` is a dict {`<anchor>:<line>`: content} for the window. */
export function buildReadJson(
	content: string,
	hashes: readonly string[],
	offset: number,
	limit: number,
	path: string,
	lineNumbers = true,
): object {
	const allLines = splitLines(content);
	const totalLines = allLines.length;
	const start = Math.max(1, offset);
	const startIdx = start - 1;
	const endIdx = Math.min(startIdx + limit, totalLines);
	const lines: Record<string, string> = {};
	for (let i = startIdx; i < endIdx; i++) {
		const anchor = `${hashes[i] ?? ""}`;
		// The key carries its line number exactly as every other row does —
		// anchor first, its line trailing — so the JSON view and the text view
		// name a line IDENTICALLY and a key can be pasted straight into `edit`.
		const key = lineNumbers && anchor !== "" ? formatRowMarker(anchor, i + 1) : anchor;
		lines[key] = allLines[i] ?? "";
	}
	return {
		path,
		offset: start,
		totalLines,
		lines,
	};
}
