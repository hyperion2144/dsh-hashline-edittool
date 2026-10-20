// The line diff is BOUNDED (#190): jsdiff's `diffLines` allocates ~8× the
// file's bytes over the whole text, and `edit` renders a diff on every call.
// `diffLinesBounded` reuses the alignment machinery #182 already hardened.
import { diffLinesBounded, type LineDiffPart } from "./line-diff.js";

/**
 * Normalise a producer's parts into the seam's shape.
 *
 * jsdiff's `Change` types `count` as optional and its flags as booleans; the
 * bounded producer types them exactly. One place to reconcile, so the seam's
 * contract is a single line rather than a cast at every call site.
 *
 * @param parts - the producer's output.
 * @returns the same blocks with `count` always set.
 */
function normalizeDiffParts(
	parts: ReadonlyArray<{ value: string; count?: number; added?: boolean; removed?: boolean }>,
): LineDiffPart[] {
	return parts.map((part) => ({
		value: part.value,
		count: part.count ?? 0,
		...(part.added ? { added: true as const } : {}),
		...(part.removed ? { removed: true as const } : {}),
	}));
}
// All four of these are `hash-assign`'s — the hashline barrel re-exported them,
// and going through it made this pure renderer pull the whole layer (and, via
// the barrel's grep re-export, the whole tool layer) into the graph.
import {
	lineHashesPure,
	LINE_HASH_SEP,
	hashSep,
	contextLinesCfg,
	canon,
	contentChecksum,
} from "../hashline/hash-assign.js";
import { lineNumbersEnabled } from "../infra/settings.js";
// A row the echo will serve. Type-only: the row SHAPE belongs to the resolve
// engine, and importing it from the `hashline/served` shim (which re-exports
// that engine) is what made this module part of the barrel cycle.
import type { ServedRow } from "../hashline/anchor-pipeline.js";
import { splitLines } from "../infra/utils.js";

import { currentScopeLabelAt, type ScopeLabelAt } from "./scope-registry.js";
export type LineEnding = "\r\n" | "\n" | "\r";

export function detectEnding(content: string): LineEnding {
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) {
		return content.indexOf("\r") >= 0 ? "\r" : "\n";
	}
	const crlfIdx = content.indexOf("\r\n");
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: LineEnding): string {
	if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
	if (ending === "\r") return text.replace(/\n/g, "\r");
	return text;
}

export function stripBOM(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

/**
 * THE row marker — anchor first, its line trailing as a weak hint.
 *
 * This formula used to be written five times across three files (and a sixth,
 * dead copy lived here with an if/else whose branches returned the same
 * expression). Every row a caller can paste into `edit` is composed HERE;
 * `diffDictFrom` and `buildReadJson` prefix or key it, but never re-spell it.
 *
 * @param anchor - the variable-length Base62 anchor (or a space-filled placeholder).
 * @param lineNumber - the 1-based line, when the caller wants the hint carried.
 * @param lineNumbers - false drops the `:line` part, matching text rows.
 */
export function formatRowMarker(anchor: string, lineNumber: number, lineNumbers = lineNumbersEnabled()): string {
	return lineNumbers ? `${anchor}:${lineNumber}` : anchor;
}



export interface DiffRow {
	prefix: "+" | "-" | " ";
	line: string;
	hash: string | undefined;
	lineNumber: number;
	oldHash?: string;
}

/**
 * The original-file span one hunk covered — `HunkShift` satisfies this structurally,
 * so the render layer needs no import from the domain to be handed one.
 */
export interface ChangedOriginalRange {
	originalStartLine: number;
	originalEndLine: number;
}

/**
 * ONE hunk of a unified diff: the lines it covers on each side of the edit,
 * the header line that names them, and the rows it holds.
 *
 * The ranges follow the git convention: they COUNT the context lines, and
 * they come from the diff's own line counters — never parsed back out of the
 * rendered text (a wrong range sends the model's next edit to the wrong
 * place, and the header is the only place the range is stated).
 */
export interface DiffBlock {
	/** The block's header line, e.g. `@@ -194,7 +194,7 @@ myersRange()`. */
	header: string;
	/** The block's first line in the PRE-edit file (1-based). */
	oldStart: number;
	/** How many pre-edit lines the block covers (context lines included). */
	oldCount: number;
	/** The block's first line in the POST-edit file (1-based). */
	newStart: number;
	/** How many post-edit lines the block covers (context lines included). */
	newCount: number;
	/** The enclosing named symbol, when one was detected. Information only. */
	scope?: string;
	/** Every distinct named symbol the block's changes fall into, in order. */
	scopes?: readonly string[];
	/** The block's rows: `+` added, `-` removed, ` ` unchanged. */
	rows: DiffRow[];
}

/** A row while it is being built: BOTH sides' line numbers are known. */
interface WorkRow {
	prefix: "+" | "-" | " ";
	line: string;
	/** The post-edit anchor (`+` and unchanged rows). */
	hash: string | undefined;
	/** The pre-edit anchor (`-` rows). */
	oldHash?: string;
	/** The post-edit line number, for the rows the new file has. */
	newLine: number | undefined;
	/** The pre-edit line number, for the rows the old file had. */
	oldLine: number | undefined;
	/** The post-edit position a removed row leaves behind: the place in the new
	 * file where the old one had text. A removed row has no post-edit line of
	 * its own, but the scope of the place it came from is still worth naming. */
	removedAt?: number;
}

/** A block while it is being built. */
interface WorkBlock {
	rows: WorkRow[];
	/** The pre-edit counter where the block started (a block with no pre-edit line). */
	oldBase: number;
	/** The post-edit counter where the block started (a block with no post-edit line). */
	newBase: number;
}

/**
 * The knobs `genDiff` accepts beyond the content itself.
 *
 * They used to be three trailing positional parameters, which every call site
 * had to pad with `undefined` to reach the one it wanted — the reason the file
 * path could not be added at all. One object says what each slot is.
 */
export interface GenDiffOptions {
	/**
	 * The file this diff belongs to. It picks the scope detector's language the
	 * way git picks a pattern table by file name, so a Python or Go file can
	 * still get a named scope in its block header.
	 */
	path?: string;
	/**
	 * The original-file ranges this render's hunks covered, ascending. Their lines
	 * are the pool a `-` row's attribution is drawn from; omitted (a whole-file
	 * `write` / `undo` diff) leaves the text walk in charge.
	 */
	changedRanges?: readonly ChangedOriginalRange[];
	/**
	 * The scope lookup a block header's name comes from. Defaults to the
	 * registered detector (see `./scope-registry`); a build without one has no
	 * scope names, which is a legal shape — the name is information, never a
	 * correctness input.
	 */
	scopeLabelAt?: ScopeLabelAt;
	/**
	 * The line-diff producer. Production callers pass nothing; the tests pass the
	 * reference producer to check the bounded one field-for-field.
	 */
	partsFor?: (oldText: string, newText: string) => LineDiffPart[];
}
export function genDiff(
	oldContent: string,
	newContent: string,
	contextLines = contextLinesCfg(),
	newContentHashes?: string[],
	oldContentHashes?: string[],
	lineNumbers = lineNumbersEnabled(),
	options: GenDiffOptions = {},
): {
	diff: string;
	rows: Array<{ kind: "+" | "-" | " "; anchor: string; content: string; lineNumber: number; hash: string }>;
	/** The diff's blocks — the unified-diff hunks, with their ranges. */
	blocks: DiffBlock[];
	firstChangedLine: number | undefined;
	servedRows: ServedRow[];
} {
	const effectiveNewHashes = newContentHashes ?? lineHashesPure(newContent);
	const { path, changedRanges, scopeLabelAt = currentScopeLabelAt(), partsFor } = options;


	// `partsFor` exists so the bounded producer can be checked field-for-field
	// against jsdiff's: the reference implementation stays in the tests, not in
	// the shipped path. Production callers pass nothing.
	const parts =
		partsFor === undefined
			? diffLinesBounded(oldContent, newContent)
			: partsFor(oldContent, newContent);
	const servedRows: ServedRow[] = [];
	let newLineNum = 1;
	let oldLineNum = 1;
	let firstChangedLine: number | undefined;
	// Which `-` row is which LINE is not something the text can answer when two
	// lines are identical: a head-first alignment calls the LATER twin removed,
	// while the engine spliced the range's own line out and released its anchor
	// (ADR-0006/0009 keep the surviving twin's). So when the caller hands us the
	// ranges its hunks covered, a removal row takes the earliest line in them still
	// unclaimed that carries its content; a row no range matches keeps the walk's
	// own number — and a whole-file `write`/`undo` diff, which has no hunks, passes
	// nothing and is unchanged. The caller hands over `replacedOriginalRanges`, so an
	// `ins` anchor line (kept, never removed) is not in the pool at all.
	const claimed = new Set<number>();
	const oldLines =
		changedRanges !== undefined && changedRanges.length > 0
			? splitLines(oldContent)
			: undefined;
	const attributedRemovedLine = (content: string, walked: number): number => {
		if (oldLines === undefined || changedRanges === undefined) return walked;
		for (const range of changedRanges) {
			for (let line = range.originalStartLine; line <= range.originalEndLine; line++) {
				if (!claimed.has(line) && oldLines[line - 1] === content) {
					claimed.add(line);
					return line;
				}
			}
		}
		return walked;
	};

	// The BLOCK under construction, the finished ones, and the block the next
	// change will open (a context run may head a block that starts later).
	let block: WorkBlock | undefined;
	const finished: WorkBlock[] = [];
	let pending: WorkBlock | undefined;

	const isChange = (part: LineDiffPart): boolean => part.added === true || part.removed === true;

	/** A block that starts at the current position of both counters. */
	const startBlock = (): WorkBlock => ({
		rows: [],
		oldBase: oldLineNum,
		newBase: newLineNum,
	});

	/** Append the unchanged lines `[from, to)` of a context run to a block. */
	const appendContext = (
		target: WorkBlock,
		lines: readonly string[],
		from: number,
		to: number,
		newBase: number,
		oldBase: number,
	): void => {
		for (let k = from; k < to; k++) {
			const content = lines[k]!;
			const newLine = newBase + k;
			const oldLine = oldBase + k;
			const hash = effectiveNewHashes[newLine - 1];
			target.rows.push({ prefix: " ", line: content, hash, newLine, oldLine });
			if (hash !== undefined) {
				servedRows.push({ position: newLine - 1, anchor: hash, contentKey: contentChecksum(canon(content)) });
			}
		}
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();
		const displayLines = raw;

		if (isChange(part)) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			// The change either continues the block under construction or opens
			// the one the pending context heads.
			const target = block ?? pending ?? startBlock();
			if (block === undefined) {
				block = target;
				pending = undefined;
			}
			for (const content of displayLines) {
				if (part.added === true) {
					const hash = effectiveNewHashes[newLineNum - 1];
					target.rows.push({ prefix: "+", line: content, hash, newLine: newLineNum, oldLine: undefined });
					if (hash !== undefined) {
						servedRows.push({ position: newLineNum - 1, anchor: hash, contentKey: contentChecksum(canon(content)) });
					}
					newLineNum++;
				} else {
					const lineNumber = attributedRemovedLine(content, oldLineNum);
					target.rows.push({
						prefix: "-",
						line: content,
						hash: undefined,
						oldHash: oldContentHashes?.[lineNumber - 1],
						newLine: undefined,
						oldLine: lineNumber,
						removedAt: Math.max(1, newLineNum - 1),
					});
					oldLineNum++;
				}
			}
			continue;
		}

		// A context run: how much of it is shown depends on its neighbours.
		const leftIsChange = i > 0 && isChange(parts[i - 1]!);
		const rightIsChange = i < parts.length - 1 && isChange(parts[i + 1]!);
		const length = displayLines.length;
		const newBase = newLineNum;
		const oldBase = oldLineNum;
		newLineNum += length;
		oldLineNum += length;

		// `head` closes the block under construction, `tail` opens the next one.
		let headFrom = 0;
		let headTo = 0;
		let tailFrom = 0;
		let tailTo = 0;
		if (leftIsChange && rightIsChange) {
			if (length <= contextLines * 2) {
				// The gap is narrow enough: the whole run belongs to this block.
				headFrom = 0;
				headTo = length;
			} else {
				// git's compact rule: a gap wider than `2 × context_lines` splits the
				// diff — the head closes this block, the tail opens the next one.
				headFrom = 0;
				headTo = contextLines;
				tailFrom = Math.max(0, length - contextLines);
				tailTo = length;
			}
		} else if (leftIsChange) {
			headFrom = 0;
			headTo = Math.min(contextLines, length);
		} else if (rightIsChange) {
			tailFrom = Math.max(0, length - contextLines);
			tailTo = length;
		}

		if (headTo > headFrom && block !== undefined) {
			appendContext(block, displayLines, headFrom, headTo, newBase, oldBase);
		}
		if (tailTo > tailFrom) {
			if (leftIsChange && rightIsChange && block !== undefined) {
				finished.push(block);
				block = undefined;
			}
			const next = startBlock();
			appendContext(next, displayLines, tailFrom, tailTo, newBase, oldBase);
			pending = next;
		}
	}
	if (block !== undefined) finished.push(block);

	// The BLOCKS, in order. Their ranges come from the walk's own counters — a
	// header that claims the wrong range sends the model's next edit to the
	// wrong place, and the header is the only place the range is stated.
	const blocks: DiffBlock[] = finished.map((b) => {
		const oldSide = b.rows.filter((row) => row.oldLine !== undefined);
		const newSide = b.rows.filter((row) => row.newLine !== undefined);
		const oldStart = oldSide.length > 0 ? oldSide[0]!.oldLine! : Math.max(0, b.oldBase - 1);
		const oldCount = oldSide.length;
		const newStart = newSide.length > 0 ? newSide[0]!.newLine! : Math.max(0, b.newBase - 1);
		const newCount = newSide.length;
		// The scope names are looked up in the POST-edit text, at EVERY changed
		// line: a symbol the edit removed is not a scope, and a block that spans
		// two functions names both — one name per distinct symbol, in the order
		// the changes appear.
		const scopes: string[] = [];
		for (const row of b.rows) {
			if (row.prefix === " ") continue;
			const at = row.prefix === "+" ? row.newLine : row.removedAt;
			if (at === undefined) continue;
			const label = scopeLabelAt(newContent, at, path);
			if (label === undefined || label === "") continue;
			if (!scopes.includes(label)) scopes.push(label);
		}
		const scope = scopes.length === 0 ? undefined : scopes.join(" / ");
		const header =
			`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` +
			(scope === undefined || scope === "" ? "" : ` ${scope}`);
		return {
			header,
			oldStart,
			oldCount,
			newStart,
			newCount,
			...(scope === undefined ? {} : { scope, scopes }),
			rows: b.rows.map((row) => ({
				prefix: row.prefix,
				line: row.line,
				hash: row.hash,
				lineNumber: row.prefix === "-" ? row.oldLine! : row.newLine!,
				...(row.oldHash === undefined ? {} : { oldHash: row.oldHash }),
			})),
		};
	});

	// The flat row list the structured channels consume (the JSON diff dict, the
	// card's gutter) — the same rows, in the same order as the blocks.
	const rows: Array<{
		kind: "+" | "-" | " ";
		anchor: string;
		content: string;
		lineNumber: number;
		hash: string;
	}> = [];
	for (const b of blocks) {
		for (const row of b.rows) {
			rows.push({
				kind: row.prefix,
				anchor: rowMarker(row, lineNumbers),
				content: row.line,
				lineNumber: row.lineNumber,
				// 纯 hash（不含行号前缀）—— json diff 的 key 构造需要它与行号分开拼接，
				// 否则 lineNumbers 开启时 anchor 已含 "<line>:" 会出现双行号（issue #69）。
				hash: row.oldHash ?? row.hash ?? "",
			});
		}
	}

	return { diff: renderDiffLines(blocks, lineNumbers).join("\n"), rows, blocks, firstChangedLine, servedRows };
}

/**
 * One row's MARKER — the anchor, with its line number when the user's switch
 * is on, plus the `~` that marks a pre-edit anchor as dead.
 *
 * The ANCHOR comes first and its line number trails it, so the token a caller
 * copies first is the one that identifies the line.
 *
 * @param row - the row to mark.
 * @param lineNumbers - whether the line number trails the anchor.
 * @returns the marker, without the row's prefix.
 */
function rowMarker(row: DiffRow, lineNumbers: boolean): string {
	const anchor = row.prefix === "-" ? row.oldHash : row.hash;
	if (anchor === undefined) {
		// A row with no anchor at all — a removed line whose pre-edit hash the
		// caller did not supply — keeps the placeholder column.
		return formatRowMarker(" ".repeat(4), row.lineNumber, lineNumbers);
	}
	// A `-` row names a line that no longer exists: its anchor is STALE, and the
	// `~` makes it unmistakably not a Base62 marker — a model that copies it gets a
	// clean `[E_BAD_REF]` instead of a rescued-then-stale anchor.
	return formatRowMarker(row.prefix === "-" ? `~${anchor}` : anchor, row.lineNumber, lineNumbers);
}

/**
 * The rendered lines of a diff: every block's header, then the block's rows.
 *
 * The anchor column is right-aligned across the WHOLE diff, so the marker a
 * reader copies always starts at the same column. Built from the structured
 * fields — anchored on the LIVE shape (anchor length / separator), no regex
 * parsing of rendered rows.
 *
 * @param blocks - the diff's blocks, in order.
 * @param lineNumbers - whether the line number trails the anchor.
 * @returns the lines, headers included.
 */
export function renderDiffLines(
	blocks: readonly DiffBlock[],
	lineNumbers = lineNumbersEnabled(),
): string[] {
	let width = 0;
	for (const block of blocks) {
		for (const row of block.rows) {
			const marker = rowMarker(row, lineNumbers);
			if (marker.length > width) width = marker.length;
		}
	}
	const lines: string[] = [];
	for (const block of blocks) {
		lines.push(block.header);
		for (const row of block.rows) {
			const marker = rowMarker(row, lineNumbers);
			lines.push(`${row.prefix}${marker.padStart(width)}${hashSep()}${row.line}`);
		}
	}
	return lines;
}
