/**
 * Pure card-model derivation for the hashline read/edit tool views.
 *
 * The row/summary derivation and the official card fallbacks mirror the dsh
 * 0.1.2 shipped `dsh-client-ui-tool` models (toolRowModel, readCardModel,
 * diffCardModel) so a hashline call that carries no hashline data degrades
 * EXACTLY like the shipped card. The hashline extensions:
 *
 * - read: when the persisted meta carries valid `hashlines`, each gutter cell
 *   renders `<line>:<anchor>` instead of the bare line number (ReadBlock
 *   draws its gutter cell verbatim, so the precomposed string is safe).
 * - edit: `meta.diffs` (hashline's `{path, oldText, newText}[]`, already
 *   aligned with the web narrowDiffs contract) is tried BEFORE the
 *   argument-derived intended diff — hashline's `path`/`edits[]` argument
 *   contract can never satisfy the shipped `intendedDiff`, which is why the
 *   shipped edit card falls back to generic for hashline calls.
 * - edit anchor hints: the anchors the model addressed the edit with are read
 *   back from the call's own `edits[].anchor_start` arguments.
 */

import type {
	DiffCardProps,
	DiffRowGroup,
	DiffRowMeta,
	FileDiff,
	GrepCardModel,
	GrepFileRowGroup,
	GrepRowMeta,
	GrepSegment,
	ReadCardProps,
	ReadMetaHashline,
	ReadMetaLine,
	ReadPresentation,
	ToolCallBlock,
	ToolRowModel,
} from "./types.js";

//#region shared call helpers (mirror of dsh-client-ui-tool models)

/** Parsed `{name, args}` of the paired call head, or null when unavailable. */
export interface ParsedToolCall {
	name: string;
	args: Record<string, unknown>;
}

function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(argsRaw);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Parse the call head paired with one immutable Tool block (WeakMap-cached). */
const parsedCalls = new WeakMap<ToolCallBlock, ParsedToolCall | null>();
export function parsedToolCall(block: ToolCallBlock): ParsedToolCall | null {
	const cached = parsedCalls.get(block);
	if (cached !== undefined || parsedCalls.has(block)) return cached ?? null;
	const call = "kind" in block ? block.call : block;
	if (call === null) {
		parsedCalls.set(block, null);
		return null;
	}
	const value = parseArgs(call.argsRaw);
	if (value === undefined) {
		parsedCalls.set(block, null);
		return null;
	}
	const parsed: ParsedToolCall = { name: call.name, args: value };
	parsedCalls.set(block, parsed);
	return parsed;
}

/** Flatten a settled result's content blocks to display text. */
export function resultText(block: ToolCallBlock): string {
	if (!("kind" in block)) return "";
	const parts: string[] = [];
	for (const block_ of block.content) {
		if (block_.type === "text") parts.push(block_.text ?? "");
		else parts.push(JSON.stringify(block_, null, 2));
	}
	if (parts.length === 0 && block.error !== undefined) {
		parts.push(`${block.error.name}: ${block.error.code}`);
	}
	return parts.join("\n");
}

//#endregion
//#region display path helpers (mirror of dsh-util-workspace-path browser face)

function isWindowsStylePath(value: string): boolean {
	return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}

function abbreviateHomePath(path: string, home: string | undefined): string {
	if (home === undefined || home === "") return path;
	if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
	const root = home.replace(/\/+$/, "");
	if (root === "" || root === "/") return path;
	if (path.replace(/\/+$/, "") === root) return "~";
	if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
	return path;
}

function relativizeToCwd(text: string, cwd: string | undefined): string {
	if (cwd === undefined || cwd === "") return text;
	const root = cwd.replace(/[/\\]+$/, "");
	if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1);
	return text;
}

//#endregion
//#region row model (mirror of shipped toolRowModel, read/edit variants only)

function firstLine(text: string): string {
	const nl = text.indexOf("\n");
	return nl === -1 ? text : text.slice(0, nl);
}

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return undefined;
}

const VARIANT_TITLE_KEYS: Record<string, string> = {
	read: "tool.title.read",
	grep: "tool.title.grep",
	edit: "tool.title.edit",
	write: "tool.title.write",
};

const SUMMARY_KEYS: Record<string, string[]> = {
	read: ["path", "file_path", "url"],
	// Mirrors the shipped search row: the pattern is the grep summary.
	grep: ["query", "pattern", "url"],
	edit: ["path", "file_path"],
	write: ["file_path", "path"],
};

const FILE_PATH_KEYS = ["path", "file_path"];
/** Collect unique non-empty `path` values from `edits[].path` (issue #81).
 * Returns the deduplicated paths in first-seen order, or an empty array when
 * the args have no `edits` array or none carry a string `path`.
 */
function collectEditPaths(args: Record<string, unknown>): string[] {
	const edits = args.edits;
	if (!Array.isArray(edits)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const edit of edits) {
		if (typeof edit !== "object" || edit === null) continue;
		const path = (edit as Record<string, unknown>).path;
		if (typeof path !== "string" || path === "" || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}


function deriveSummary(variant: string, argsRaw: string): string {
	const args = parseArgs(argsRaw);
	if (args === undefined) return firstLine(argsRaw);
	const picked = pickString(args, SUMMARY_KEYS[variant] ?? []);
	if (picked !== undefined) return firstLine(picked);
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value !== "") return firstLine(value);
	}
	return firstLine(argsRaw);
}

function deriveFilePath(variant: string, argsRaw: string): string | undefined {
	if (variant !== "read" && variant !== "edit" && variant !== "write") return undefined;
	const args = parseArgs(argsRaw);
	if (args === undefined) return undefined;
	const picked = pickString(args, FILE_PATH_KEYS);
	if (picked !== undefined) return firstLine(picked);
	// issue #81: edit with no top-level path — use per-item path when exactly one file.
	if (variant === "edit") {
		const editPaths = collectEditPaths(args);
		if (editPaths.length === 1) return firstLine(editPaths[0]!);
	}
	return undefined;
}

/**
 * Derive the full row model from a frozen call slice.
 * @param toolName - wire tool name ("read" or "edit" here).
 * @param block - running or settled Tool block.
 * @param cwd - session workspace root; workspace-rooted summaries display relative to it.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 */
export function toolRowModel(
	toolName: string,
	block: ToolCallBlock,
	cwd: string | undefined,
	home: string | undefined,
): ToolRowModel {
	const variant =
		toolName === "edit" ? "edit" : toolName === "write" ? "write" : toolName === "grep" ? "grep" : "read";
	const done = "kind" in block;
	const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? "";
	const state = !done
		? "running"
		: block.error?.code === "interrupted"
			? "stopped"
			: block.isError
				? "error"
				: "ok";
	let base: string;
	if (argsRaw === "") {
		base = block.callId;
	} else {
		base = abbreviateHomePath(relativizeToCwd(deriveSummary(variant, argsRaw), cwd), home);
		// issue #81: edit with no top-level path — relativize each per-item path individually.
		if (variant === "edit") {
			const args = parseArgs(argsRaw);
			if (args !== undefined && pickString(args, SUMMARY_KEYS.edit) === undefined) {
				const editPaths = collectEditPaths(args);
				if (editPaths.length > 0) {
					base = editPaths
						.map((p) => abbreviateHomePath(relativizeToCwd(firstLine(p), cwd), home))
						.join(", ");
				}
			}
		}
	}
	const output = done ? resultText(block) || null : null;
	const errorSummary = state === "error" && output !== null ? firstLine(output) : null;
	return {
		variant,
		titleKey: VARIANT_TITLE_KEYS[variant] ?? "tool.title.generic",
		summary: base,
		filePath: deriveFilePath(variant, argsRaw),
		bodyRaw: argsRaw === "" ? null : argsRaw,
		output,
		errorSummary,
		state,
	};
}

//#endregion

//#region read card (mirror of shipped readCardModel + hashline gutter)

function validReadCall(block: ToolCallBlock): boolean {
	const call = parsedToolCall(block);
	if (call?.name !== "read") return false;
	const { file_path: path, offset, limit } = call.args;
	if (typeof path !== "string" || path.trim() === "") return false;
	if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1)) return false;
	if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return false;
	return true;
}

function isMetaLine(line: unknown): line is ReadMetaLine {
	if (typeof line !== "object" || line === null || Array.isArray(line)) return false;
	const { number, text } = line as Record<string, unknown>;
	return typeof number === "number" && Number.isInteger(number) && typeof text === "string";
}

function isMetaHashline(line: unknown): line is ReadMetaHashline {
	if (!isMetaLine(line)) return false;
	return typeof (line as unknown as Record<string, unknown>).hash === "string";
}

/**
 * Soft-validate the persisted read meta, mirroring the shipped readMeta plus
 * hashline's optional parallel `hashlines` array.
 */
export function readPresentationMeta(meta: unknown): ReadPresentation | null {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const value = meta as Record<string, unknown>;
	const { path, offset, totalLines, lang } = value;
	if (typeof path !== "string") return null;
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) return null;
	if (typeof totalLines !== "number" || !Number.isInteger(totalLines) || totalLines < 0) return null;
	if (!Array.isArray(value.lines) || !value.lines.every(isMetaLine)) return null;
	if (value.hashlines !== undefined) {
		if (!Array.isArray(value.hashlines) || !value.hashlines.every(isMetaHashline)) return null;
	}
	if (lang !== undefined && typeof lang !== "string") return null;
	const lines = value.lines as ReadMetaLine[];
	let previous = offset - 1;
	for (const { number } of lines) {
		if (number <= previous || number > totalLines) return null;
		previous = number;
	}
	return {
		path,
		offset,
		lines,
		totalLines,
		...(value.hashlines !== undefined ? { hashlines: value.hashlines as ReadMetaHashline[] } : {}),
		...(lang !== undefined ? { lang: lang as string } : {}),
	};
}

/**
 * Derive the settled read card. Requires the official contract (root, settled,
 * non-error call, valid `read` arguments and valid presentationMeta) and
 * renders the hashline gutter (`<line>:<anchor>`) whenever the meta carries
 * valid hashlines; an empty hash falls back to the bare number for that row.
 *
 * Unlike the shipped readCardModel there is NO envelope requirement: since
 * issue #71 the main plugin no longer wraps read results in the dsh
 * `<path>/<type>/<content>` envelope, so the card derives from the persisted
 * meta alone. Enveloped pre-0.4.2 history still renders — the envelope is
 * simply never required.
 * @param block - running or settled Tool block.
 * @param cwd - session workspace root for relative summaries.
 * @param home - host account home for `~` abbreviation.
 * @returns the read-card props, or null for the generic path.
 */
export function readCardModel(
	block: ToolCallBlock,
	cwd: string | undefined,
	home: string | undefined,
): ReadCardProps | null {
	if (block.parentCallId !== undefined || !("kind" in block) || block.isError) return null;
	if (!validReadCall(block)) return null;
	const meta = readPresentationMeta(block.meta);
	if (meta === null) return null;
	const hashByNumber = new Map<number, string>();
	for (const line of meta.hashlines ?? []) hashByNumber.set(line.number, line.hash);
	return {
		label: abbreviateHomePath(relativizeToCwd(meta.path, cwd), home),
		lines: meta.lines.map(({ number, text: lineText }) => {
			const hash = hashByNumber.get(number);
			return hash !== undefined && hash !== "" ? { number: `${number}:${hash}`, text: lineText } : { number, text: lineText };
		}),
		totalLines: meta.totalLines,
		...(meta.lang !== undefined ? { lang: meta.lang } : {}),
	};
}

//#endregion
//#region edit card (mirror of shipped diffCardModel, applied-diffs first)

/**
 * Narrow opaque result metadata's `diffs` to well-formed hunks (web narrowDiffs).
 * @param diffs - the metadata field to validate.
 */
export function narrowDiffs(diffs: unknown): FileDiff[] | null {
	if (!Array.isArray(diffs) || diffs.length === 0) return null;
	const out: FileDiff[] = [];
	for (const hunk of diffs) {
		if (typeof hunk !== "object" || hunk === null) return null;
		const { path, oldText, newText } = hunk as Record<string, unknown>;
		if (typeof path !== "string") return null;
		if (oldText !== null && typeof oldText !== "string") return null;
		if (typeof newText !== "string") return null;
		out.push({ path, oldText, newText });
	}
	return out;
}

/** Validate the optional escalation pair shared by shell and file-mutation tools. */
function validEscalationFields(args: Record<string, unknown>): boolean {
	const { permission, justification } = args as Record<string, unknown>;
	if (permission === undefined && justification === undefined) return true;
	if (permission !== "workspace-write" && permission !== "danger-full-access") return false;
	return typeof justification === "string" && justification.trim() !== "";
}

/**
 * Argument-derived whole-file diff for the first-party write/edit tools
 * (standard `file_path`/`old_string`/`new_string` contract). Hashline edits
 * (`path` + `edits[]`) can never satisfy this — by design they settle through
 * the applied-diffs path instead.
 */
export function intendedDiff(block: ToolCallBlock): { tool: "write" | "edit"; diff: FileDiff } | null {
	const parsed = parsedToolCall(block);
	if (parsed === null) return null;
	const { file_path: path } = parsed.args;
	if (typeof path !== "string" || path.trim() === "") return null;
	if (!validEscalationFields(parsed.args)) return null;
	if (parsed.name === "write") {
		const content = parsed.args.content;
		return typeof content === "string" ? { tool: "write", diff: { path, oldText: null, newText: content } } : null;
	}
	if (parsed.name !== "edit") return null;
	const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args as Record<string, unknown>;
	if (typeof oldText !== "string" || typeof newText !== "string") return null;
	if (replaceAll !== undefined && typeof replaceAll !== "boolean") return null;
	return { tool: "edit", diff: { path, oldText: oldText === "" ? null : oldText, newText } };
}

function appliedDiffs(meta: unknown): FileDiff[] | null | "empty" {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const diffs = (meta as Record<string, unknown>).diffs;
	if (!Array.isArray(diffs)) return null;
	if (diffs.length === 0) return "empty";
	return narrowDiffs(diffs);
}

/**
 * Derive running or settled diff-card props for edit calls. Applied diffs
 * (hashline's persisted meta) take priority; the argument-derived intended
 * diff stays the running-state and write/create fallback, matching the
 * shipped card's presentation for non-hashline data.
 * @param block - running or settled Tool block.
 * @returns the diff-card props, or null for the generic path.
 */
export function diffCardModel(block: ToolCallBlock): DiffCard | null {
	if (block.parentCallId !== undefined) return null;
	if (!("kind" in block)) {
		const intended = intendedDiff(block);
		return intended === null ? null : { path: intended.diff.path, diffs: [intended.diff] };
	}
	if (block.isError) return null;
	const applied = appliedDiffs(block.meta);
	if (applied !== null && applied !== "empty") {
		const rows = metaDiffRows(block.meta);
		const rowGroups = metaDiffRowGroups(block.meta);
		return { path: applied[0]?.path ?? "", diffs: applied, ...(rows !== null ? { rows } : {}), ...(rowGroups !== null ? { rowGroups } : {}) };
	}
	const intended = intendedDiff(block);
	if (intended === null) return null;
	return intended.tool === "write" ? { path: intended.diff.path, diffs: [intended.diff] } : null;
}

//#endregion

//#region write card (native parity + hashline gutter rows)

/**
 * Derive the write card: prefers the hashline structured rows (which carry the
 * per-line `行号:锚点` gutter facts) over the coarse hunks, so a write renders
 * exactly like the edit card. Running calls and rows-less writes fall back to
 * the built-in intended diff (oldText null -> newText = the requested content).
 * @param block - running or settled Tool block.
 * @returns the diff-card props, or null for the generic path.
 */
export function writeCardModel(block: ToolCallBlock): DiffCard | null {
	if (block.parentCallId !== undefined) return null;
	if (!("kind" in block)) {
		const intended = intendedDiff(block);
		return intended !== null && intended.tool === "write"
			? { path: intended.diff.path, diffs: [intended.diff] }
			: null;
	}
	if (block.isError) return null;
	const rows = metaDiffRows(block.meta);
	const applied = appliedDiffs(block.meta);
	const metaPath = readMetaPath(block.meta);
	if (rows !== null) {
		const diffs = applied !== null && applied !== "empty" ? applied : [];
		return { path: metaPath ?? diffs[0]?.path ?? "", diffs, rows };
	}
	if (applied !== null && applied !== "empty") {
		return { path: metaPath ?? applied[0]?.path ?? "", diffs: applied };
	}
	const intended = intendedDiff(block);
	return intended !== null && intended.tool === "write"
		? { path: intended.diff.path, diffs: [intended.diff] }
		: null;
}

/** The persisted meta's `path` when it is a non-empty string. */
function readMetaPath(meta: unknown): string | undefined {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
	const path = (meta as Record<string, unknown>).path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

//#endregion

//#region diff rows meta (rendering channel, issue #71)

/**
 * Soft-validate the persisted diff rows meta: per-row kind, line number,
 * anchor, and text. This is the RENDERING channel — persisted in
 * presentationMeta by the main plugin's genDiff projection, never parsed
 * from the model-facing text (which may change shape at any time).
 */
export function metaDiffRows(meta: unknown): DiffRowMeta[] | null {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const value = meta as Record<string, unknown>;
	const rows = value.diffRows;
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const out: DiffRowMeta[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) return null;
		const r = row as Record<string, unknown>;
		if (r.kind !== "+" && r.kind !== "-" && r.kind !== " ") return null;
		if (typeof r.lineNumber !== "number" || !Number.isInteger(r.lineNumber) || r.lineNumber < 1) return null;
		if (typeof r.hash !== "string" || typeof r.text !== "string") return null;
		out.push({ kind: r.kind, lineNumber: r.lineNumber, hash: r.hash, text: r.text });
	}
	return out;
}

/**
 * Soft-validate the persisted per-file diff row groups (issue #82: multi-file
 * tab rendering). Each group has a `path` and a `rows` array validated the same
 * way as `metaDiffRows`.
 */
export function metaDiffRowGroups(meta: unknown): DiffRowGroup[] | null {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const value = meta as Record<string, unknown>;
	const groups = value.diffRowGroups;
	if (!Array.isArray(groups) || groups.length === 0) return null;
	const out: DiffRowGroup[] = [];
	for (const group of groups) {
		if (typeof group !== "object" || group === null) return null;
		const g = group as Record<string, unknown>;
		if (typeof g.path !== "string") return null;
		if (!Array.isArray(g.rows) || g.rows.length === 0) return null;
		const rows: DiffRowMeta[] = [];
		for (const row of g.rows) {
			if (typeof row !== "object" || row === null) return null;
			const r = row as Record<string, unknown>;
			if (r.kind !== "+" && r.kind !== "-" && r.kind !== " ") return null;
			if (typeof r.lineNumber !== "number" || !Number.isInteger(r.lineNumber) || r.lineNumber < 1) return null;
			if (typeof r.hash !== "string" || typeof r.text !== "string") return null;
			rows.push({ kind: r.kind, lineNumber: r.lineNumber, hash: r.hash, text: r.text });
		}
		out.push({ path: g.path, rows });
	}
	return out;
}

/** A derived diff card: structured rows (gutter) and/or the official hunks. */
export interface DiffCard {
	path: string;
	diffs: FileDiff[];
	/** Structured rows with per-line `行号:锚点` gutter facts, when persisted (single-file). */
	rows?: readonly DiffRowMeta[] | undefined;
	/** Per-file row groups for multi-file tab rendering (issue #82). */
	rowGroups?: readonly DiffRowGroup[] | undefined;
}

/**
 * The anchors a hashline edit was addressed with, read back from the call's
 * own `edits[].anchor_start` arguments. These are presentation hints only —
 * an unparseable call yields no hints, never a card failure.
 * @param argsRaw - the paired call head's raw argument JSON.
 * @param cap - maximum anchors returned before an ellipsis marker.
 * @returns anchor strings (`12:a3f`), or an empty array when none apply.
 */
export function editAnchorHints(argsRaw: string, cap = 3): string[] {
	const args = parseArgs(argsRaw);
	if (args === undefined) return [];
	const edits = args.edits;
	if (!Array.isArray(edits)) return [];
	const hints: string[] = [];
	for (const edit of edits) {
		if (typeof edit !== "object" || edit === null) continue;
		const anchor = (edit as Record<string, unknown>).anchor_start;
		if (typeof anchor !== "string" || anchor.trim() === "") continue;
		// Normalise a `12:a3f` / `12#a3f` spelling to the displayed `12:a3f`.
		const normalized = anchor.includes(":") ? anchor : anchor.replace("#", ":");
		hints.push(normalized);
		if (hints.length > cap) break;
	}
	if (hints.length > cap) return [...hints.slice(0, cap), "…"];
	return hints;
}

//#endregion

//#region grep card (ADR-0005: rows + match flag + highlight spans)

/**
 * Soft-validate the persisted grep meta. Mirrors the host's
 * `grepPresentationFromMeta`: any deviation returns null, which is the card's
 * tier-1 degradation (the generic body renders instead).
 */
export function grepPresentationMeta(meta: unknown): GrepCardModel | null {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const value = meta as Record<string, unknown>;
	if (!Array.isArray(value.files)) return null;
	const files: GrepFileRowGroup[] = [];
	for (const entry of value.files) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
		const file = entry as Record<string, unknown>;
		if (typeof file.path !== "string") return null;
		if (!Array.isArray(file.rows)) return null;
		const rows: GrepRowMeta[] = [];
		for (const candidate of file.rows) {
			const row = grepRowMeta(candidate);
			if (row === null) return null;
			rows.push(row);
		}
		files.push({ path: file.path, rows });
	}
	if (typeof value.truncated !== "boolean") return null;
	if (typeof value.total !== "number" || !Number.isInteger(value.total) || value.total < 0) return null;
	return { files, truncated: value.truncated, total: value.total };
}

/** One validated card row, or null when the payload is not usable. */
function grepRowMeta(candidate: unknown): GrepRowMeta | null {
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
	const row = candidate as Record<string, unknown>;
	if (typeof row.number !== "number" || !Number.isInteger(row.number) || row.number < 1) return null;
	if (typeof row.hash !== "string" || typeof row.text !== "string") return null;
	if (row.match !== undefined && row.match !== true) return null;
	let spans: [number, number][] | undefined;
	if (row.spans !== undefined) {
		if (!Array.isArray(row.spans)) return null;
		spans = [];
		for (const span of row.spans) {
			if (!Array.isArray(span) || span.length !== 2) return null;
			const [start, end] = span as [unknown, unknown];
			if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return null;
			if (typeof end !== "number" || !Number.isInteger(end) || end <= start) return null;
			spans.push([start, end]);
		}
	}
	return {
		number: row.number,
		hash: row.hash,
		text: row.text,
		...(row.match === true ? { match: true as const } : {}),
		...(spans !== undefined ? { spans } : {}),
	};
}

/**
 * Derive the settled grep card. Requires the official contract (root, settled,
 * non-error call of the `grep` tool, valid presentationMeta); a payload without
 * `rows` (a pre-0.4.4 session log) returns null so the generic body renders.
 * @param block - running or settled Tool block.
 * @returns the card model, or null for the generic path.
 */
export function grepCardModel(block: ToolCallBlock): GrepCardModel | null {
	if (block.parentCallId !== undefined || !("kind" in block) || block.isError) return null;
	if (parsedToolCall(block)?.name !== "grep") return null;
	return grepPresentationMeta(block.meta);
}

/**
 * Split one row's text into renderable segments at its highlight spans.
 *
 * Pure and defensive: offsets are clamped to the text, overlaps are skipped
 * (the scan is non-overlapping, but a hand-edited or older payload may not be)
 * and the concatenated segments always reproduce the input EXACTLY — the card
 * highlights text, it never rewrites it.
 * @param text - the row's verbatim text.
 * @param spans - `[start, end)` offsets, ascending and non-overlapping.
 * @returns segments in order; a single unhit segment when there is nothing to mark.
 */
export function highlightSegments(
	text: string,
	spans: readonly (readonly [number, number])[] | undefined,
): GrepSegment[] {
	if (spans === undefined || spans.length === 0) return text === "" ? [] : [{ text, hit: false }];
	const out: GrepSegment[] = [];
	// Adjacent same-kind slices merge into one segment, so an overlapping or
	// abutting payload paints ONE mark instead of a visibly seamed pair.
	const push = (text: string, hit: boolean): void => {
		if (text === "") return;
		const last = out[out.length - 1];
		if (last !== undefined && last.hit === hit) {
			last.text += text;
			return;
		}
		out.push({ text, hit });
	};
	let cursor = 0;
	for (const span of spans) {
		const start = Math.min(Math.max(span[0], cursor), text.length);
		const end = Math.min(Math.max(span[1], start), text.length);
		if (end <= start) continue;
		push(text.slice(cursor, start), false);
		push(text.slice(start, end), true);
		cursor = end;
	}
	push(text.slice(cursor), false);
	return out;
}

/**
 * The counts the card's footer reports: `shown` counts the match rows across
 * the WHOLE result (not just the active tab), because `files` is the whole
 * result's file count too.
 * @param model - the derived card model.
 * @returns `shown` (match rows), `total` (found matches) and `files` (groups).
 */
export function grepResultCounts(model: GrepCardModel): { shown: number; total: number; files: number } {
	let shown = 0;
	for (const file of model.files) {
		for (const row of file.rows) {
			if (row.match === true) shown += 1;
		}
	}
	return { shown, total: model.total, files: model.files.length };
}

/**
 * The card's gutter cell for one row: the served `<line>:<anchor>`, falling
 * back to the bare line number when the anchor is unknown.
 * @param row - a validated card row.
 * @returns the gutter text.
 */
export function grepGutterLabel(row: GrepRowMeta): string {
	return row.hash !== "" ? `${row.number}:${row.hash}` : `${row.number}`;
}

//#endregion
