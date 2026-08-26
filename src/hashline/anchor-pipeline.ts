/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → boundaryDups splice → valEdit → verifyServed → resToSpan
 *
 * Detection (valEdit → boundaryDups[]) and correction (splice + second valEdit)
 * were split across resolve.ts / apply.ts with an implicit coupling.
 * This seam co-locates that invariant. Public surface is two functions:
 *   resEdit  — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + hashes + served verification)
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, boundaryDups helpers, warnUnicodeEsc, findNewEdge,
 * resAnchorFromMap, assertAligned, etc. They remain exported from resolve.ts
 * for backwards compat but are marked @internal and should be imported via this
 * module only.
 *
 * @module dsh-hashline-edittool/hashline/anchor-pipeline
 */

import { abortIf, splitLines, rejectUnknownFields, firstNonEmptyIndex, lastNonEmptyIndex, clipLine } from "../utils.js";
import {
  HASH_CLASS,
  HL_BARE_PREFIX_RE,
  HL_PREFIX_PLUS_RE,
  HL_PREFIX_MINUS_RE,
  HASH_SEP,
  ANCHOR_LEN,
  ALPH_RE,
  LINE_HASH_SEP,
  LINE_HASH_RE,
  HASHLINE_HEADER,
  STALE_CONTEXT_LINES,
  canon,
  lineHashesPure,
} from "./hash-assign.js";
import { recordServed, servedPositionsOf } from "../served-store.js";
import { fmtHashlineRow, anchorWidth } from "./hash-assign.js";
import { SERVED_ECHO_CAP } from "../constants.js";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants.js";

export type Anchor = { line: number; hash: string };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected "<line>${LINE_HASH_SEP}<hash>" (e.g. "12#aB3"), copied from the leftmost column of a read/grep/diff row.`;
	}

	if (trimmed.includes(":") || trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${clipLine(trimmed, 60)}". If you pasted a full read row, it must start with "<line>${LINE_HASH_SEP}<hash>${HASH_SEP}" (e.g. "12#aB3:"); or pass just the marker "12#aB3".`;
	}

	return `[E_BAD_REF] Invalid anchor "${clipLine(trimmed, 60)}". Expected "<line>${LINE_HASH_SEP}<hash>" (e.g. "12#aB3"), copied from the leftmost column of a read/grep/diff row.`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	const lineMatch = LINE_HASH_RE.exec(trimmed);
	if (lineMatch) {
		const lineStr = lineMatch[1]!;
		const line = Number.parseInt(lineStr, 10);
		if (!Number.isInteger(line) || line < 1) {
			throw new Error(diagRef(ref));
		}
		return { line, hash: lineMatch[2]! };
	}
	// Bare-hash form is rejected: line#hash is the only valid anchor because
	// the line number is what disambiguates positions with identical content
	// (e.g. several blank lines), and the hash alone can't tell us whether
	// the file drifted since the read.
	throw new Error(diagRef(ref));
}

export const parseHashRef = parseRef;

export function parseText(edit: string): string[] {
  if (typeof edit !== "string") {
    throw new Error(NEW_CONTENT_NOT_STRING_MSG);
  }
  const normalized = edit.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized === "") return [];
  if (/^\n+$/.test(normalized)) return new Array(normalized.length).fill("");
  return normalized.split("\n");
}


export type RAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
	content_lines: string[];
	hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
	context?: RAnchor;
}

export interface BDup {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	replacementLineIndex: number;
}

export interface AutoFix {
	kind: "trailing" | "leading" | "first-new-after" | "last-new-before";
	removedLine: string;
	removedLineIndex: number;
}

export interface NEdit {
	loc: string;
	currentContent: string;
}

export type HTEdit = {
	replacement_text: string;
	remove_from: string;
	remove_to: string;
};

function resAnchorFromMap(
	ref: Anchor,
	fileHashes: string[],
): RAnchor | HMismatch {
	// The anchor carries both the agent's claimed line AND the hash. The line
	// is what identifies the position; the hash is the drift detector. We
	// resolve at exactly the claimed line, never by hash lookup — even when
	// the same hash appears elsewhere, only the line#hash pair uniquely
	// identifies a row. (See parseRef: bare-hash anchors are rejected.)
	const claimed = ref.line;
	if (!Number.isInteger(claimed) || claimed < 1 || claimed > fileHashes.length) {
		return { ref, kind: "not_found" };
	}
	const actualHash = fileHashes[claimed - 1]!;
	if (actualHash !== ref.hash) {
		// The hash at the claimed line is different. Surface both: the agent's
		// hash and the actual hash at that line. `fmtMismatchWithServes`
		// uses `actualHash` (the resolved `RAnchor.hash`) to echo the fresh
		// marker; we carry the original ref so the agent can see what they
		// sent vs. what's actually there.
		return { ref, kind: "not_found" };
	}
	return {
		line: claimed,
		hash: ref.hash,
		hashMatched: true,
	};
}

function assertAligned(
	fileLines: string[],
	fileHashes: string[],
	ctx: string,
): void {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`${ctx}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
}

function fmtMismatchWithServes(
	mismatches: HMismatch[],
	fileLines: string[],
	fileHashes: string[],
	filePath?: string,
): { message: string; servedRows: ServedRow[] } {
	assertAligned(fileLines, fileHashes, "fmtMismatch");

	const out: string[] = [];
	const servedRows: ServedRow[] = [];
	const seen = new Set<number>();
	const pushRow = (ln: number) => {
		if (ln < 1 || ln > fileLines.length) return;
		const position = ln - 1;
		if (seen.has(position)) return;
		seen.add(position);
		servedRows.push({ position, hash: fileHashes[ln - 1]! });
	};
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

	const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
	if (notFound.length > 0) {
		out.push(
			`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read for fresh anchors.`,
		);
		// Echo windows: single-line edits carry the same anchor in both
		// remove_from and remove_to, and from/to that are BOTH stale and
		// adjacent produce nearly identical ±3 windows. Merge windows whose
		// centers are within 2*STALE_CONTEXT_LINES+1 of each other so the file
		// region is echoed once; the header above still reports every stale
		// anchor and the merged block lists every fresh marker.
		const centers = notFound.map((m) => {
			// Echo center: prefer the OTHER anchor's resolved position (when one
			// anchor resolved and the other didn't), fall back to the agent's
			// claimed line.
			const ctx = m.context ?? {
				line: m.ref.line,
				hash: fileHashes[m.ref.line - 1] ?? "?",
				hashMatched: false,
			};
			return { m, center: Math.max(1, Math.min(fileLines.length, ctx.line)) };
		});
		centers.sort((a, b) => a.center - b.center);
		const groups: typeof centers[] = [];
		for (const c of centers) {
			const last = groups[groups.length - 1];
			if (
				last &&
				c.center - last[last.length - 1]!.center <= 2 * STALE_CONTEXT_LINES + 1
			) {
				last.push(c);
			} else {
				groups.push([c]);
			}
		}
		for (const group of groups) {
			const from = Math.max(1, group[0]!.center - STALE_CONTEXT_LINES);
			const to = Math.min(
				fileLines.length,
				group[group.length - 1]!.center + STALE_CONTEXT_LINES,
			);
			const echoLines: string[] = [];
			for (let ln = from; ln <= to; ln++) {
				const marker = `${ln}${LINE_HASH_SEP}${fileHashes[ln - 1]}`;
				echoLines.push(`  ${marker}${HASH_SEP}${clipLine(fileLines[ln - 1] ?? "")}`);
				pushRow(ln);
			}
			const markers = group.map(
				(c) => `${c.m.ref.line}${LINE_HASH_SEP}${fileHashes[c.m.ref.line - 1] ?? "?"}`,
			);
			const hint =
				markers.length === 1
					? `reuse the fresh marker ${markers[0]}`
					: `reuse a fresh marker from: ${markers.join(", ")}`;
			out.push("");
			out.push(
				`  Echo of the line you tried (read-style, ±${STALE_CONTEXT_LINES} context):\n${HASHLINE_HEADER}\n${echoLines.join("\n")}\n\n  If this is the line you meant to edit, ${hint} without calling read.\n  If not, call read() to find the correct line.`,
			);
		}
	}
	if (ambiguous.length > 0) {
		if (out.length > 0) out.push("");
		out.push(
			`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}. Re-read for fresh anchors.`,
		);
		for (const m of ambiguous) {
			const sample = (m.candidates ?? []).slice(0, 5);
			const more =
				(m.candidates?.length ?? 0) > sample.length
					? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
					: "";
			const lines = sample
				.map((line) => {
					const content = clipLine(fileLines[line - 1] ?? "");
					pushRow(line);
					return `    ${line}${LINE_HASH_SEP}${fileHashes[line - 1]}${HASH_SEP}${content}`;
				})
				.join("\n");
			out.push(
				`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
			);
		}
	}

	return { message: out.join("\n"), servedRows };
}

const ITEM_KS = new Set(["replacement_text", "remove_from", "remove_to"]);

function assertItem(edit: Record<string, unknown>): void {
	rejectUnknownFields(
		edit,
		ITEM_KS,
		"Edit",
		"The edit takes only { replacement_text, remove_from, remove_to }.",
	);

	if ("remove_from" in edit && typeof edit.remove_from !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_from" must be a "<line>#<hash>" anchor string (e.g. "12#aB3"), copied from the leftmost column of a read/grep/diff row.`,
		);
	}
	if ("remove_to" in edit && typeof edit.remove_to !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_to" must be a "<line>#<hash>" anchor string (e.g. "12#aB3"), copied from the leftmost column of a read/grep/diff row.`,
		);
	}
	if (!("replacement_text" in edit)) {
		throw new Error(
			`[E_BAD_SHAPE] The edit requires a "replacement_text" field. Provide the replacement text (use "" to delete).`,
		);
	}
	if (typeof edit.replacement_text !== "string") {
		throw new Error(NEW_CONTENT_NOT_STRING_MSG);
	}
	if (
		typeof edit.remove_from !== "string" ||
		typeof edit.remove_to !== "string"
	) {
		throw new Error(
			`[E_BAD_SHAPE] The edit requires "remove_from" and "remove_to" "<line>#<hash>" anchor strings copied from read output.`,
		);
	}
}

// Accepts read/grep/diff output rows pasted into remove_from/remove_to:
//   "12#aB3:const x = 1;"  → anchor "12#aB3" (trailing content dropped)
//   "+12#aB3:..."          → anchor "12#aB3" (diff "+" dropped)
//   "-12#aB3:..."          → anchor "12#aB3" (diff "-" dropped)
// Group 1 = diff marker, group 2 = line number (optional), group 3 = hash.
const ANCHOR_ROW_RE = new RegExp(`^([+-]?)(?:(\\d+)#)?(${HASH_CLASS})\\s*[:│]`);

export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
	assertItem(edit as Record<string, unknown>);

	const editLines = parseText(edit.replacement_text);
	const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
		const trimmed = ref.trim();
		const match = trimmed.match(ANCHOR_ROW_RE);
		if (!match) return ref;
		if (!match[2]) {
			// A bare `hash│content` row cannot be salvaged: the design requires
			// line#hash (the line disambiguates positions whose content is
			// identical, e.g. blank lines). Show only a clipped hint, never the
			// whole pasted line/block (T5: terse notices, lean prompts).
			throw new Error(
				`[E_BAD_REF] anchor row lacks a line number — pass the marker "12${LINE_HASH_SEP}aB3" copied from the leftmost column, not "${clipLine(trimmed, 60)}".`
			);
		}
		const anchor = `${match[2]}${LINE_HASH_SEP}${match[3]!}`;
		const rest = trimmed.slice(match[0].length);
		if (!rest) return anchor; // "12#aB3│" → clean full row, nothing to strip
		let message: string;
		if (/[\r\n]/.test(rest)) {
			message = `[E_BAD_REF] remove_from/remove_to got a multi-line block; only the first row's anchor "${anchor}" was used, the rest was ignored.`;
		} else if (match[1] === "+") {
			message = `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
		} else if (match[1] === "-") {
			message = `[E_BAD_REF] stripped leading "-" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
		} else {
			message = `[E_BAD_REF] stripped trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
		}
		warnings?.push(message);
		return anchor;
	}) as [string, string];
	return {
		content_lines: editLines,
		hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])],
	};
}

function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
	if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
		warnings.push(
			"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
		);
	}
}

/** @internal — private to anchor-pipeline seam; do not import directly, use anchor-pipeline.ts */
function stripBarePrefixes(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	// Strip ONLY when the `line#hash:` prefix is a REAL file marker: the line
	// number is in range and that line's hash equals the prefix hash. Model
	// pasted read rows always satisfy this; file content that merely LOOKS
	// like `12#aB3:...` almost never does (the line's real hash would have to
	// equal the prefix by chance), so such content is kept verbatim.
	const stripped: { lineIndex: number }[] = [];
	const skipped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const match = line.match(HL_BARE_PREFIX_RE);
		if (!match) return line;
		const lineNum = Number.parseInt(match[1]!, 10) - 1;
		const hash = match[2]!;
		const isRealMarker =
			Number.isInteger(lineNum) &&
			lineNum >= 0 &&
			lineNum < fileHashes.length &&
			fileHashes[lineNum] === hash;
		if (!isRealMarker) {
			skipped.push(lineIndex);
			return line; // literal content — never corrupt it
		}
		stripped.push({ lineIndex });
		return line.slice(match[0].length);
	});
	if (stripped.length > 0) {
		const locations = stripped
			.map((s) => `replacement_text line ${s.lineIndex + 1}`)
			.join(", ");
		warnings.push(
			`[E_BARE_HASH_PREFIX] stripped "line#hash:" prefix from ${locations}.`,
		);
	}
	if (skipped.length > 0) {
		const locations = skipped.map((i) => `replacement_text line ${i + 1}`).join(", ");
		warnings.push(
			`[E_BARE_HASH_PREFIX] prefix on ${locations} does not match the file's hashes; kept verbatim as literal content.`,
		);
	}
	return { ...edit, content_lines: contentLines };
}

/** @internal — private to anchor-pipeline seam */
function stripDiffPrefixes(
	edit: HEdit,
	fileHashes: string[],
	warnings: string[],
): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const plus = line.match(HL_PREFIX_PLUS_RE);
		if (plus && isRealMarkerLine(plus[0], fileHashes)) {
			stripped.push(lineIndex);
			return line.slice(plus[0].length);
		}
		const minus = line.match(HL_PREFIX_MINUS_RE);
		if (minus && isRealMarkerLine(minus[0], fileHashes)) {
			stripped.push(lineIndex);
			return line.slice(minus[0].length);
		}
		return line;
	});
	if (stripped.length === 0) return edit;
	const locations = stripped
		.map((i) => `replacement_text line ${i + 1}`)
		.join(", ");
	warnings.push(
		`[E_INVALID_PATCH] stripped diff-preview marker from ${locations}.`,
	);
	return { ...edit, content_lines: contentLines };
}

/** @internal — private to anchor-pipeline seam */
function swapReversedRanges(
	edit: HEdit,
	warnings: string[],
): HEdit {
	// The line is the locator (deterministic hashes may repeat), so reversed
	// detection compares LINES directly — a hash-to-line lookup would be
	// ambiguous for duplicate content.
	const [startRef, endRef] = edit.hash_bounds;
	if (startRef.line <= endRef.line) {
		return edit;
	}
	warnings.push(
		`[E_BAD_OP] reversed remove_from/remove_to (${startRef.hash} after ${endRef.hash}); swapped.`
	);
	return { ...edit, hash_bounds: [endRef, startRef] as [Anchor, Anchor] };
}

function trailingDups(
	contentLines: string[],
	fileLines: string[],
	endLine: number,
): BDup[] {
	const start = lastNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(start + 1, fileLines.length - endLine);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start - k] !== fileLines[endLine + k]) break;
		dups.push({ kind: "trailing", replacementLineIndex: start - k });
	}
	return dups;
}

function leadingDups(
	contentLines: string[],
	fileLines: string[],
	startLine: number,
): BDup[] {
	const start = firstNonEmptyIndex(contentLines);
	if (start < 0) return [];
	const dups: BDup[] = [];
	const maxK = Math.min(contentLines.length - start, startLine - 1);
	for (let k = 0; k < maxK; k++) {
		if (contentLines[start + k] !== fileLines[startLine - 2 - k]) break;
		dups.push({ kind: "leading", replacementLineIndex: start + k });
	}
	return dups;
}

function sectionIsUnique(
	canonLines: string[],
	start: number,
	length: number,
): boolean {
	let count = 0;
	for (let i = 0; i + length <= canonLines.length; i++) {
		let k = 0;
		while (k < length && canonLines[i + k] === canonLines[start + k]) k++;
		if (k < length) continue;
		count++;
		if (count > 1) return false;
	}
	return true;
}

function firstNewAfterDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	endLine: number,
): BDup[] {
	const firstNew = findNewEdge(contentLines, rangeLines, false);
	if (!firstNew) return [];
	const maxK = Math.min(
		contentLines.length - firstNew.index,
		canonLines.length - endLine,
	);
	let runLen = 0;
	while (
		runLen < maxK &&
		canon(contentLines[firstNew.index + runLen]!) ===
			canonLines[endLine + runLen]!
	) {
		runLen++;
	}
	if (runLen === 0 || !sectionIsUnique(canonLines, endLine, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({
			kind: "first-new-after",
			replacementLineIndex: firstNew.index + k,
		});
	}
	return dups;
}

function lastNewBeforeDups(
	contentLines: string[],
	rangeLines: string[],
	canonLines: string[],
	startLine: number,
): BDup[] {
	const lastNew = findNewEdge(contentLines, rangeLines, true);
	if (!lastNew) return [];
	const maxK = Math.min(lastNew.index + 1, startLine - 1);
	let runLen = 0;
	while (
		runLen < maxK &&
		canon(contentLines[lastNew.index - runLen]!) ===
			canonLines[startLine - 2 - runLen]!
	) {
		runLen++;
	}
	if (runLen === 0) return [];
	const sectionStart = startLine - 1 - runLen;
	if (!sectionIsUnique(canonLines, sectionStart, runLen)) return [];
	const dups: BDup[] = [];
	for (let k = 0; k < runLen; k++) {
		dups.push({
			kind: "last-new-before",
			replacementLineIndex: lastNew.index - k,
		});
	}
	return dups;
}

function canonCounts(lines: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = canon(line);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** @internal — private to anchor-pipeline seam */
export function findNewEdge(
	contentLines: string[],
	rangeLines: string[],
	fromEnd: boolean,
): { index: number; line: string } | undefined {
	const multiset = canonCounts(rangeLines);
	const step = fromEnd ? -1 : 1;
	const start = fromEnd ? contentLines.length - 1 : 0;
	for (let i = start; i >= 0 && i < contentLines.length; i += step) {
		const line = contentLines[i]!;
		if (line.length === 0) continue;
		const key = canon(line);
		const count = multiset.get(key) ?? 0;
		if (count > 0) {
			multiset.set(key, count - 1);
		} else {
			return { index: i, line };
		}
	}
	return undefined;
}

/** @internal — private to anchor-pipeline seam: detection + boundaryDups belongs to AnchorPipeline ordering */
function valEdit(
	edit: HEdit,
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): {
	resolved: RHEdit | undefined;
	mismatches: HMismatch[];
	boundaryDups: BDup[];
} {
	assertAligned(fileLines, fileHashes, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryDups: BDup[] = [];

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, fileHashes);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);
	// Out-of-range check first: if either anchor points past EOF, we want
	// the hard "[E_RANGE_UNVERIFIED] ... out of range ... call read()" UX
	// rather than [E_STALE_ANCHOR]. The hash is irrelevant when the line
	// doesn't exist; the model must re-read to learn the file's size.
	const startRef = edit.hash_bounds[0];
	const endRef = edit.hash_bounds[1];
	const startOOB =
		startRef.line < 1 || startRef.line > fileLines.length;
	const endOOB = endRef.line < 1 || endRef.line > fileLines.length;
	const backwards = startRef.line > endRef.line;
	if (startOOB || endOOB || backwards) {
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED] — line ${startRef.line}..${endRef.line} is out of range ` +
				`(file has ${fileLines.length} line${fileLines.length === 1 ? "" : "s"}). ` +
				`Call read() to get the current line count and fresh anchors.`,
			servedRows: [],
		});
	}
	const startResolved = tryResolve(edit.hash_bounds[0]);
	const endResolved = tryResolve(edit.hash_bounds[1]);
	if (!startResolved || !endResolved) {
		// Single-anchor fail: the OTHER resolved anchor gives us a "context"
		// (a real line in the file) so the error UX can echo ±N around it.
		// We carry the resolved RAnchor so fmtMismatchWithServes can use its
		// line + hash to render the fresh marker.
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[0],
			);
			if (startMismatch && startMismatch.kind === "not_found")
				startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast(
				(m) => m.ref === edit.hash_bounds[1],
			);
			if (endMismatch && endMismatch.kind === "not_found")
				endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches, boundaryDups };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_bounds[0].line}#${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].line}#${edit.hash_bounds[1].hash}).`,
		);
	}
	const endLine = endResolved.line;
	const rangeLines = fileLines.slice(startResolved.line - 1, endLine);
	const canonLines = fileLines.map((line) => canon(line));
	boundaryDups.push(
		...trailingDups(edit.content_lines, fileLines, endLine),
		...leadingDups(edit.content_lines, fileLines, startResolved.line),
		...firstNewAfterDups(edit.content_lines, rangeLines, canonLines, endLine),
		...lastNewBeforeDups(
			edit.content_lines,
			rangeLines,
			canonLines,
			startResolved.line,
		),
	);

	return {
		resolved: {
			content_lines: edit.content_lines,
			hash_bounds: [startResolved, endResolved],
		},
		mismatches,
		boundaryDups,
	};
}

export { warnUnicodeEsc };


export type ServedCode =
	| "E_RANGE_STALE"
	| "E_RANGE_UNSERVED"
	| "E_RANGE_UNVERIFIED";

export interface ServedRow {
	position: number;
	hash: string;
}

export class ServedRejectionError extends Error {
	readonly code: ServedCode;
	readonly firstOffendingLine: number | undefined;
	readonly servedRows: ServedRow[];

	constructor(opts: {
		code: ServedCode;
		message: string;
		firstOffendingLine?: number;
		servedRows: ServedRow[];
	}) {
		super(opts.message);
		this.name = "ServedRejectionError";
		this.code = opts.code;
		this.firstOffendingLine = opts.firstOffendingLine;
		this.servedRows = opts.servedRows;
	}
}

export function isServedRejection(
	error: unknown,
): error is ServedRejectionError {
	return error instanceof ServedRejectionError;
}

export class AnchorMismatchError extends Error {
	readonly servedRows: ServedRow[];

	constructor(message: string, servedRows: ServedRow[]) {
		super(message);
		this.name = "AnchorMismatchError";
		this.servedRows = servedRows;
	}
}

export function isAnchorMismatch(error: unknown): error is AnchorMismatchError {
	return error instanceof AnchorMismatchError;
}

export function buildRangeEcho(
	startLine: number,
	endLine: number,
	fileHashes: string[],
): ServedRow[] {
	const total = endLine - startLine + 1;
	const shown = Math.min(total, SERVED_ECHO_CAP);
	const rows: ServedRow[] = [];
	for (let ln = startLine; ln < startLine + shown; ln++) {
		rows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
	}
	return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
	return rows
		.map((row) => `${row.position + 1}${LINE_HASH_SEP}${row.hash}${HASH_SEP}${fileLines[row.position] ?? ""}`)
		.join("\n");
}

function retryHint(): string {
	return "Retry the edit with remove_from/remove_to copied from these fresh rows (no read needed).";
}

function paginationHint(nextOffset: number, more: number): string {
	return `[... ${more} more lines — use read with offset=${nextOffset} to see the rest]`;
}

export function verifyServedRange(args: {
	served: (string | null)[];
	startHash: string;
	endHash: string;
	startLine: number;
	endLine: number;
	fileHashes: string[];
	fileLines: string[];
	filePath?: string;
}): void {
	const {
		served,
		startHash,
		endHash,
		startLine,
		endLine,
		fileHashes,
		fileLines,
		filePath,
	} = args;
	const where = filePath ? ` in ${filePath}` : "";

	// Hard out-of-range check: the agent's line is past EOF — there's no
	// meaningful "fresh marker" to reuse. Force a read.
	if (
		startLine < 1 ||
		startLine > fileLines.length ||
		endLine < 1 ||
		endLine > fileLines.length ||
		startLine > endLine
	) {
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED]${where ? ` ${where.trim()}` : ""} — line ${startLine}..${endLine} is out of range ` +
				`(file has ${fileLines.length} line${fileLines.length === 1 ? "" : "s"}). ` +
				`Call read() to get the current line count and fresh anchors.`,
			servedRows: [],
		});
	}

	// Strict line-by-line check at the agent's claimed positions. The hash's
	// only role here is to verify the line content hasn't drifted since the
	// read — we never fall back to "find any position with this hash", which
	// would silently override the agent's stated line. Each position in
	// served[] independently tracks its hash (line#hash is unique per row,
	// even when hashes repeat across rows).
	const currentLen = endLine - startLine + 1;
	const firstMismatch: number | undefined = (() => {
		for (let k = 0; k < currentLen; k++) {
			const position = startLine - 1 + k;
			const expectedHash =
				currentLen === 1
					? startHash
					: k === 0
						? startHash
						: k === currentLen - 1
							? endHash
							: fileHashes[position];
			const servedHash = served[position];
			if (servedHash === null) return position;
			if (servedHash !== expectedHash) return position;
		}
		return undefined;
	})();

	if (firstMismatch !== undefined) {
		const mismatchLine = firstMismatch + 1;
		const expectedHash = fileHashes[firstMismatch]!;
		const ctxFrom = Math.max(1, mismatchLine - STALE_CONTEXT_LINES);
		const ctxTo = Math.min(fileLines.length, mismatchLine + STALE_CONTEXT_LINES);
		const ctxEchoLines: string[] = [];
		const ctxServedRows: ServedRow[] = [];
		for (let ln = ctxFrom; ln <= ctxTo; ln++) {
			const marker = `${ln}${LINE_HASH_SEP}${fileHashes[ln - 1]}`;
			ctxEchoLines.push(`  ${marker}${HASH_SEP}${clipLine(fileLines[ln - 1] ?? "")}`);
			ctxServedRows.push({ position: ln - 1, hash: fileHashes[ln - 1]! });
		}
		const ctxEcho = `${HASHLINE_HEADER}\n${ctxEchoLines.join("\n")}`;
		const freshMarker = `${mismatchLine}${LINE_HASH_SEP}${expectedHash}`;
		const servedAtLine = served[firstMismatch];
		const staleMsg =
			servedAtLine === null
				? `line ${mismatchLine} was never served to the model`
				: `served mirror at line ${mismatchLine} is stale (has hash ${servedAtLine}, file has ${expectedHash})`;
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED]${where ? ` ${where.trim()}` : ""} — ${staleMsg}. ` +
				`This usually happens after a previous edit shifted lines below your read window. ` +
				`A full read() will re-sync, but if the line below is what you meant, you can reuse the fresh marker instead.\n` +
				`Echo of the line you tried (read-style, ±${STALE_CONTEXT_LINES} context):\n${ctxEcho}\n\n` +
				`If this is the line you meant, reuse the fresh marker ${freshMarker} without calling read.\n` +
				`If not, call read() to find the correct line.`,
			servedRows: ctxServedRows,
		});
	}
}

export interface ResolvedRange {
	startLine: number;
	endLine: number;
	startHash: string;
	endHash: string;
	delta: number;
}

export type ServeRecordPolicy = "live" | "preview";

export async function recordEchoServes(
	sessionKey: string,
	path: string,
	rows: ServedRow[],
	policy: ServeRecordPolicy,
	lineCount?: number,
): Promise<void> {
	if (policy !== "live") return;
	await recordServed(sessionKey, path, rows, lineCount);
}


type LIdx = {
	fileLines: string[];
	lineStarts: number[];
};

export function buildIdx(content: string): LIdx {
	const fileLines = splitLines(content);
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
	};
}

type RESpan = {
	kind: "replace";
	start: number;
	end: number;
	replacement: string;
};

type NoopSpan = {
	kind: "noop";
	loc: string;
	currentContent: string;
};
function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit. Use `write` if you need to clear the file.",
		);
	}
}

function resToSpan(
	edit: RHEdit,
	content: string,
	lineIndex: LIdx,
): RESpan | NoopSpan {
	const { fileLines, lineStarts } = lineIndex;

	const startLine = edit.hash_bounds[0].line;
	const endLine = edit.hash_bounds[1].line;
	const originalLines = fileLines.slice(startLine - 1, endLine);
	if (
		originalLines.length === edit.content_lines.length &&
		originalLines.every(
			(line, lineIndex) => line === edit.content_lines[lineIndex],
		)
	) {
		return {
			kind: "noop",
			loc: edit.hash_bounds[0].hash,
			currentContent: originalLines.join("\n"),
		};
	}

	if (edit.content_lines.length > 0) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
			replacement: edit.content_lines.join("\n"),
		};
	}

	if (startLine === 1 && endLine === fileLines.length) {
		return {
			kind: "replace",
			start: 0,
			end: content.length,
			replacement: "",
		};
	}

	if (endLine < fileLines.length) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine]!,
			replacement: "",
		};
	}

	if (content.endsWith("\n")) {
		return {
			kind: "replace",
			start: lineStarts[startLine - 1]!,
			end: content.length,
			replacement: "",
		};
	}

	const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined;
	return {
		kind: "replace",
		start:
			prevLine !== undefined && prevLine.length === 0
				? lineStarts[startLine - 1]!
				: Math.max(0, lineStarts[startLine - 1]! - 1),
		end: content.length,
		replacement: "",
	};
}

function assemble(
	content: string,
	span: RESpan,
	signal: AbortSignal | undefined,
): string {
	abortIf(signal);
	return (
		content.slice(0, span.start) + span.replacement + content.slice(span.end)
	);
}

export function applyEdit(
	content: string,
	edit: HEdit,
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
	served?: (string | null)[],
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	range: ResolvedRange;
	warnings?: string[];
	noopEdit?: NEdit;
	autoFixes?: AutoFix[];
} {
	abortIf(signal);

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? lineHashesPure(content);
	const warnings: string[] = [];

	const rangeFixed = swapReversedRanges(edit, warnings);
	const prefixFixed = stripDiffPrefixes(
		stripBarePrefixes(rangeFixed, fileHashes, warnings),
		fileHashes,
		warnings,
	);

	const {
		resolved: initialResolved,
		mismatches,
		boundaryDups,
	} = valEdit(prefixFixed, lineIndex.fileLines, fileHashes, warnings, signal);
	if (mismatches.length || !initialResolved) {
		const { message, servedRows } = fmtMismatchWithServes(
			mismatches,
			lineIndex.fileLines,
			fileHashes,
			filePath,
		);
		throw new AnchorMismatchError(message, servedRows);
	}

	warnUnicodeEsc(prefixFixed, warnings);

	let resolved = initialResolved;
	let autoFixes: AutoFix[] | undefined;
	if (boundaryDups.length > 0) {
		autoFixes = [];
		const correctedEdit: HEdit = {
			...prefixFixed,
			content_lines: [...prefixFixed.content_lines],
		};
		const seen = new Set<number>();
		const uniqueDups: BDup[] = [];
		for (const dup of boundaryDups) {
			if (seen.has(dup.replacementLineIndex)) continue;
			seen.add(dup.replacementLineIndex);
			uniqueDups.push(dup);
		}
		const dupsByIndex = uniqueDups.sort(
			(a, b) => b.replacementLineIndex - a.replacementLineIndex,
		);
		for (const dup of dupsByIndex) {
			const idx = dup.replacementLineIndex;
			if (idx < 0 || idx >= correctedEdit.content_lines.length) continue;
			const removed = correctedEdit.content_lines.splice(idx, 1)[0];
			autoFixes.push({
				kind: dup.kind,
				removedLine: removed,
				removedLineIndex: idx,
			});
		}
		const correctedResult = valEdit(
			correctedEdit,
			lineIndex.fileLines,
			fileHashes,
			warnings,
			signal,
		);
		if (correctedResult.mismatches.length || !correctedResult.resolved) {
			const { message, servedRows } = fmtMismatchWithServes(
				correctedResult.mismatches,
				lineIndex.fileLines,
				fileHashes,
				filePath,
			);
			throw new AnchorMismatchError(message, servedRows);
		}
		resolved = correctedResult.resolved;
	}

	if (served) {
		const startAnchor = resolved.hash_bounds[0];
		const endAnchor = resolved.hash_bounds[1];
		verifyServedRange({
			served,
			startHash: startAnchor.hash,
			endHash: endAnchor.hash,
			startLine: startAnchor.line,
			endLine: endAnchor.line,
			fileHashes,
			fileLines: lineIndex.fileLines,
			filePath,
		});
	}

	const spanResult = resToSpan(resolved, content, lineIndex);
	if (spanResult.kind === "noop") {
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
			range: resolvedRange(resolved),
			...(warnings.length ? { warnings } : {}),
			noopEdit: {
				loc: spanResult.loc,
				currentContent: spanResult.currentContent,
			},
		};
	}

	const result = assemble(content, spanResult, signal);
	assertNotEmpty(content, result);
	const changed = changedRange(content, result);

	return {
		content: result,
		firstChangedLine: changed?.firstChangedLine,
		lastChangedLine: changed?.lastChangedLine,
		range: resolvedRange(resolved),
		...(warnings.length ? { warnings } : {}),
		...(autoFixes ? { autoFixes } : {}),
	};
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
	const [start, end] = resolved.hash_bounds;
	return {
		startLine: start.line,
		endLine: end.line,
		startHash: start.hash,
		endHash: end.hash,
		delta:
			resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
	};
}

/**
 * Render `line#hash│content` rows for a slice of the file. `startLine` is the
 * 1-indexed absolute line number of `lines[0]`. Defaults to 1 — the common case
 * when the whole file is being formatted.
 */
export function fmtRegion(
	hashes: string[],
	lines: string[],
	startLine: number = 1,
): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	if (!Number.isInteger(startLine) || startLine < 1) {
		throw new Error(`fmtRegion: startLine (${startLine}) must be a positive integer.`);
	}
	const anchors = lines.map((_, index) => `${startLine + index}${LINE_HASH_SEP}${hashes[index]}`);
	const width = anchorWidth(anchors);
	return lines
		.map((line, index) => fmtHashlineRow("", anchors[index]!, line, width))
		.join("\n");
}

export function changedRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: splitLines(result).length,
		};
	}

	const originalLines = splitLines(original);
	const resultLines = splitLines(result);

	if (
		originalLines.length === resultLines.length &&
		originalLines.every((line, index) => line === resultLines[index])
	) {
		return null;
	}

	const minLen = Math.min(originalLines.length, resultLines.length);
	let first = 0;
	while (first < minLen && originalLines[first] === resultLines[first]) {
		first++;
	}
	let lastOrig = originalLines.length - 1;
	let lastRes = resultLines.length - 1;
	while (
		lastOrig >= first &&
		lastRes >= first &&
		originalLines[lastOrig] === resultLines[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}
	return {
		firstChangedLine: first + 1,
		lastChangedLine: Math.max(first, lastRes) + 1,
	};
}


/**
 * `+12#aB3:...` / `-12#aB3:...` (or `-12#   :` placeholder-hash rows) are
 * stripped only when the prefix is a real file marker; anything else stays
 * literal. The placeholder form (unknown old hash in a diff row the model
 * copied) is stripped when the line number exists, since such a prefix
 * cannot be legitimate file content.
 */
function isRealMarkerLine(prefix: string, fileHashes: string[]): boolean {
	const m = /^(?:[+-])(\d+)#([A-Za-z0-9]{3}| {3})\s*[:│]$/.exec(prefix);
	if (!m) return false;
	const lineNum = Number.parseInt(m[1]!, 10) - 1;
	if (!Number.isInteger(lineNum) || lineNum < 0 || lineNum >= fileHashes.length) {
		return false;
	}
	const hash = m[2]!;
	if (hash.trim() === "") return true; // placeholder: line exists is enough
	return fileHashes[lineNum] === hash;
}

