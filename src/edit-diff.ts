import * as Diff from "diff";
import { lineHashesPure, LINE_HASH_SEP, hashSep, contextLinesCfg } from "./hashline/index.js";
import type { ServedRow } from "./hashline/served.js";
import { canon, contentChecksum } from "./hashline/hash-assign.js";

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
 * Render one diff row. `prefix` is the diff marker (`+`/`-`/space); the second
 * column is the anchor (variable-length Base62, or a space-filled placeholder
 * when unknown — the original anchor is preferred via `oldHash`). With
 * `lineNumbers` the anchor is prefixed `<line>:<anchor>` (informational only).
 */
function fmtDiffLine(
	prefix: " " | "+" | "-",
	line: string,
	hash: string | undefined,
	lineNumber: number,
	oldHash: string | undefined = undefined,
	lineNumbers = false,
): string {
	const anchor = oldHash ?? hash ?? " ".repeat(4);
	const marker = lineNumbers ? `${lineNumber}:${anchor}` : anchor;
	if (prefix === "-" && oldHash !== undefined) {
		return `${prefix}${marker}${hashSep()}${line}`;
	}
	return `${prefix}${marker}${hashSep()}${line}`;
}

const ELLIPSIS_MARKER: unique symbol = Symbol("ellipsis");
const isEllipsisMarker = (line: string | symbol): line is symbol =>
	line === ELLIPSIS_MARKER;

export interface DiffRow {
	prefix: "+" | "-" | " ";
	line: string;
	hash: string | undefined;
	lineNumber: number;
	oldHash?: string;
}

export function genDiff(
	oldContent: string,
	newContent: string,
	contextLines = contextLinesCfg(),
	newContentHashes?: string[],
	oldContentHashes?: string[],
	lineNumbers = false,
): {
	diff: string;
	rows: Array<{ kind: "+" | "-" | " "; anchor: string; content: string }>;
	firstChangedLine: number | undefined;
	servedRows: ServedRow[];
} {
	const effectiveNewHashes = newContentHashes ?? lineHashesPure(newContent);

	const parts = Diff.diffLines(oldContent, newContent);
	const output: (DiffRow | string)[] = [];
	const servedRows: ServedRow[] = [];
	let newLineNum = 1;
	let oldLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();
		const displayLines = raw;

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (let k = 0; k < displayLines.length; k++) {
				if (part.added) {
					const hash = effectiveNewHashes[newLineNum - 1];
					output.push({ prefix: "+", line: displayLines[k]!, hash, lineNumber: newLineNum });
					if (hash !== undefined) {
					servedRows.push({ position: newLineNum - 1, anchor: hash, contentKey: contentChecksum(canon(displayLines[k]!)) });
					}
					newLineNum++;
				} else {
					const oldHash = oldContentHashes?.[oldLineNum - 1];
					output.push({ prefix: "-", line: displayLines[k]!, hash: undefined, lineNumber: oldLineNum, oldHash });
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange =
			i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
		if (lastWasChange || nextPartIsChange) {
			let linesToShow: (string | symbol)[] = displayLines;
			let skipStart = 0;
			let skipMiddle = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, displayLines.length - contextLines);
				linesToShow = displayLines.slice(skipStart);
			} else if (nextPartIsChange && displayLines.length > contextLines * 2) {
				const tail = displayLines.slice(-contextLines);
				linesToShow = [
					...displayLines.slice(0, contextLines),
					ELLIPSIS_MARKER,
					...tail,
				];
				skipMiddle = displayLines.length - contextLines * 2;
			} else if (linesToShow.length > contextLines) {
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(" ...");
				newLineNum += skipStart;
				oldLineNum += skipStart;
			}
			for (const line of linesToShow) {
				if (isEllipsisMarker(line)) {
					output.push(" ...");
					newLineNum += skipMiddle;
					oldLineNum += skipMiddle;
					continue;
				}
				const hash = effectiveNewHashes[newLineNum - 1];
				output.push({ prefix: " ", line, hash, lineNumber: newLineNum });
				if (hash !== undefined) {
servedRows.push({ position: newLineNum - 1, anchor: hash, contentKey: contentChecksum(canon(line)) });
				}
				newLineNum++;
				oldLineNum++;
			}
		} else {
			newLineNum += displayLines.length;
			oldLineNum += displayLines.length;
		}
		lastWasChange = false;
	}

	// Right-align the anchor column across the whole diff block so the left
	// marker is a stable visual column (copy boundary for the model). Built
	// from the structured fields — anchored on the LIVE shape (anchor length /
	// separator), no regex parsing of rendered rows.
	const markerFor = (row: DiffRow): string =>
		lineNumbers
			? `${row.lineNumber}:${row.oldHash ?? row.hash ?? " ".repeat(4)}`
			: `${row.oldHash ?? row.hash ?? " ".repeat(4)}`;
	let anchorWidth = 0;
	const rows: Array<{ kind: "+" | "-" | " "; anchor: string; content: string }> = [];
	for (const row of output) {
		if (typeof row === "string") continue;
		const anchor = markerFor(row);
		if (anchor.length > anchorWidth) anchorWidth = anchor.length;
		rows.push({ kind: row.prefix, anchor, content: row.line });
	}
	const aligned = output.map((row) => {
		if (typeof row === "string") return row; // " ..." ellipsis rows etc.
		const anchor = markerFor(row);
		return `${row.prefix}${anchor.padStart(anchorWidth)}${hashSep()}${row.line}`;
	});
	return { diff: aligned.join("\n"), rows, firstChangedLine, servedRows };
}
