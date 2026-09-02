/**
 * AnchorPipeline — deep module owning the anchor autofix chain.
 *
 * Single ordering invariant (private):
 *   swapReversed → stripBare → stripDiff → valEdit → verifyServed → resToSpan
 *
 * boundary-dup detection (valEdit → boundaryDups[]) emits an [E_PASTE_DUP]
 * warning only since issue #66/B7: the tool never mutates the model's
 * replacement content beyond stripping anchor prefixes — fidelity over
 * cleverness. The old silent splice desynced anchor bookkeeping (#66/B4).
 * This seam co-locates that invariant. Public surface is two functions:
 *   resEdit   — pre-validation (tool-layer, no file state)
 *   applyEdit — full pipeline (file + anchors + served verification)
 *
 * v2.0 dynamic-hashline contract (docs/dynamic-hashline-spec.md): variable-length
 * Base62 anchors (shortest-first, layered); the line number is OUT of the anchor.
 * `line:anchor` is a weak input hint, not authoritative. Line numbers may appear
 * in rendered output as an optional column (per-call, default off). The served
 * mirror tracks `(anchor, contentKey)` per row; verifyServedRange validates both
 * layers when servedContent is supplied.
 *
 * Private to this seam (not re-exported): stripBarePrefixes, stripDiffPrefixes,
 * swapReversedRanges, valEdit, boundaryDups helpers, warnUnicodeEsc, findNewEdge,
 * resAnchorFromMap, assertAligned, pickFallbackCenter, isRealMarkerLine.
 *
 * @module dsh-hashline-edittool/hashline/anchor-pipeline
 */
import {
	abortIf,
	splitLines,
	rejectUnknownFields,
	firstNonEmptyIndex,
	lastNonEmptyIndex,
	clipLine,
} from "../utils.js";
import {
	canon,
	contentChecksum,
	hashSep,
	hashlineHeader,
	fmtHashlineRow,
	anchorWidth,
	hashRe,
	lineAnchorRe,
	hlRowAnchorRe,
	contextLinesCfg,
	lineHashesPure,
} from "./hash-assign.js";
import { recordServed } from "../served-store.js";
import { SERVED_ECHO_CAP } from "../constants.js";
import { NEW_CONTENT_NOT_STRING_MSG } from "../constants.js";

/**
 * Anchor — the parsed form of a single remove_from / remove_to token.
 *
 * `anchor` is the variable-length Base62 marker (unique per file row when
 * allocated by the v2.0 allocator). `line` is OPTIONAL: present only when the
 * model supplied a `line:anchor` hint. The hint is informational only — the
 * authoritative row position is the one assigned by the allocator, recovered
 * by indexOf(fileAnchors, anchor).
 */
export type Anchor = { anchor: string; line?: number };

function diagRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a variable-length Base62 marker (e.g. "aB3"), copied from the leftmost column of a read/grep/diff row.`;
	}

	// Legacy `line#hash` form: explicit diagnostic to call out the schema change.
	if (trimmed.includes("#")) {
		return `[E_BAD_REF] Invalid anchor "${clipLine(trimmed, 60)}". The legacy line#hash form is no longer supported — anchors are variable-length Base62 (e.g. "aB3"), copied from the leftmost column; do not use the line#hash form.`;
	}
	if (trimmed.includes("│")) {
		return `[E_BAD_REF] Invalid anchor "${clipLine(trimmed, 60)}". Legacy pipe-separated rows are not supported; copy just the marker (e.g. "aB3") from the leftmost column.`;
	}

	return `[E_BAD_REF] Invalid anchor "${clipLine(trimmed, 60)}". Expected a variable-length Base62 marker (e.g. "aB3"), copied from the leftmost column of a read/grep/diff row.`;
}

function parseRef(ref: string): Anchor {
	const trimmed = ref.trim();

	const lineMatch = lineAnchorRe().exec(trimmed);
	if (lineMatch) {
		const lineStr = lineMatch[1]!;
		const line = Number.parseInt(lineStr, 10);
		if (!Number.isInteger(line) || line < 1) {
			throw new Error(diagRef(ref));
		}
		return { anchor: lineMatch[2]!, line };
	}

	const bareMatch = hashRe().exec(trimmed);
	if (bareMatch) {
		return { anchor: bareMatch[0]! };
	}

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
	anchor: string;
	line: number;
	hashMatched: boolean;
	/** Set when the agent supplied a `line:anchor` hint that didn't match the
	 *  resolved position. Weak hint only — the resolved line is authoritative. */
	lineHintMismatch?: boolean;
};

export type HEdit = { content_lines: string[]; hash_bounds: [Anchor, Anchor] };
export type RHEdit = {
	content_lines: string[];
	hash_bounds: [RAnchor, RAnchor];
};

interface HMismatch {
	ref: Anchor;
	kind: "not_found";
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

/**
 * Resolve `ref.anchor` against the per-line anchor array (fileAnchors[i] is the
 * unique anchor for line i+1). Anchors are globally unique per file (the v2.0
 * allocator guarantees this), so indexOf is unambiguous. Returns not_found
 * when the anchor is not currently allocated (slot freed, never existed, or
 * the agent mistyped it).
 *
 * If `ref.line` is set (line:anchor input form), it's recorded as
 * lineHintMismatch when it disagrees with the resolved position; the resolved
 * line is still used for downstream logic. The mismatch is informational — it
 * never rejects.
 */
function resAnchorFromMap(
	ref: Anchor,
	fileAnchors: string[],
): RAnchor | HMismatch {
	const idx = fileAnchors.indexOf(ref.anchor);
	if (idx < 0) {
		return { ref, kind: "not_found" };
	}
	const line = idx + 1;
	const lineHintMismatch = ref.line !== undefined && ref.line !== line;
	return {
		anchor: ref.anchor,
		line,
		hashMatched: true,
		...(lineHintMismatch ? { lineHintMismatch: true } : {}),
	};
}

function assertAligned(
	fileLines: string[],
	fileAnchors: string[],
	ctx: string,
): void {
	if (fileAnchors.length !== fileLines.length) {
		throw new Error(
			`${ctx}: fileAnchors.length (${fileAnchors.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
}

function fmtMismatchWithServes(
	mismatches: HMismatch[],
	fileLines: string[],
	fileAnchors: string[],
	filePath?: string,
): { message: string; servedRows: ServedRow[] } {
	assertAligned(fileLines, fileAnchors, "fmtMismatch");

	const out: string[] = [];
	const servedRows: ServedRow[] = [];
	const seen = new Set<number>();
	const pushRow = (ln: number) => {
		if (ln < 1 || ln > fileLines.length) return;
		const position = ln - 1;
		if (seen.has(position)) return;
		seen.add(position);
		const line = fileLines[position] ?? "";
		servedRows.push({
			position,
			anchor: fileAnchors[position]!,
			contentKey: contentChecksum(canon(line)),
		});
	};
	const notFound = mismatches.filter((m) => m.kind === "not_found");

	const refList = notFound.map((m) => `"${m.ref.anchor}"`).join(", ");
	if (notFound.length > 0) {
		out.push(
			`[E_STALE] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}${filePath ? ` in ${filePath}` : ""}: ${refList}. Re-read for fresh anchors.`,
		);
		// Echo windows: single-line edits carry the same anchor in both
		// remove_from and remove_to, and from/to that are BOTH stale and
		// adjacent produce nearly identical ±3 windows. Merge windows whose
		// centers are within 2*contextLinesCfg()+1 of each other so the file
		// region is echoed once; the header above still reports every stale
		// anchor and the merged block lists every fresh marker.
		const centers = notFound.map((m) => {
			// Echo center: prefer the OTHER anchor's resolved position (when
			// one anchor resolved and the other didn't), fall back to a
			// sensible line derived from the hint if any, else line 1.
			const ctx = m.context ?? pickFallbackCenter(m.ref, fileAnchors);
			return { m, center: Math.max(1, Math.min(fileLines.length, ctx.line)) };
		});
		centers.sort((a, b) => a.center - b.center);
		const groups: typeof centers[] = [];
		for (const c of centers) {
			const last = groups[groups.length - 1];
			if (
				last &&
				c.center - last[last.length - 1]!.center <= 2 * contextLinesCfg() + 1
			) {
				last.push(c);
			} else {
				groups.push([c]);
			}
		}
		for (const group of groups) {
			const from = Math.max(1, group[0]!.center - contextLinesCfg());
			const to = Math.min(
				fileLines.length,
				group[group.length - 1]!.center + contextLinesCfg(),
			);
			const echoLines: string[] = [];
			for (let ln = from; ln <= to; ln++) {
				const marker = `${fileAnchors[ln - 1]}`;
				echoLines.push(
					`  ${marker}${hashSep()}${clipLine(fileLines[ln - 1] ?? "")}`,
				);
				pushRow(ln);
			}
			const markers = group.map((c) => {
				const centerLine = c.center;
				return `${fileAnchors[centerLine - 1] ?? "?"}`;
			});
			const hint =
				markers.length === 1
					? `reuse the fresh marker ${markers[0]}`
					: `reuse a fresh marker from: ${markers.join(", ")}`;
			out.push("");
			out.push(
				`  Echo of the line you tried (read-style, ±${contextLinesCfg()} context):\n${hashlineHeader()}\n${echoLines.join("\n")}\n\n  If this is the line you meant to edit, ${hint} without calling read.\n  If not, call read() to find the correct line.`,
			);
		}
	}

	return { message: out.join("\n"), servedRows };
}

function pickFallbackCenter(ref: Anchor, fileAnchors: string[]): RAnchor {
	if (
		ref.line !== undefined &&
		ref.line >= 1 &&
		ref.line <= fileAnchors.length
	) {
		return {
			anchor: fileAnchors[ref.line - 1]!,
			line: ref.line,
			hashMatched: false,
		};
	}
	return {
		anchor: fileAnchors[0] ?? "?",
		line: 1,
		hashMatched: false,
	};
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
			`[E_BAD_SHAPE] Field "remove_from" must be an anchor string (variable-length Base62, e.g. "aB3c"), copied from the leftmost column of a read/grep/diff row.`,
		);
	}
	if ("remove_to" in edit && typeof edit.remove_to !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] Field "remove_to" must be an anchor string (variable-length Base62, e.g. "aB3c"), copied from the leftmost column of a read/grep/diff row.`,
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
			`[E_BAD_SHAPE] The edit requires "remove_from" and "remove_to" anchor strings copied from read output.`,
		);
	}
}

/**
 * Accepts read/grep/diff output rows pasted into remove_from/remove_to:
 *   "12:aB3:const x = 1;" → anchor "aB3" (line hint dropped, trailing content dropped)
 *   "+12:aB3:..."         → anchor "aB3" (diff "+" dropped)
 *   "-12:aB3:..."         → anchor "aB3" (diff "-" dropped)
 *   "aB3:..."             → anchor "aB3" (bare anchor, trailing content dropped)
 * Group 1 = diff marker, group 2 = line number (optional), group 3 = anchor.
 */
export function resEdit(edit: HTEdit, warnings?: string[]): HEdit {
	assertItem(edit as Record<string, unknown>);

	const editLines = parseText(edit.replacement_text);
	const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
		const trimmed = ref.trim();
		// Already a valid reference form (bare anchor or `<line>:<anchor>` hint) —
		// keep it verbatim so the line hint survives to parseHashRef. The row
		// regex below would greedily eat `4:lA` as anchor "4" + separator ":".
		if (hashRe().test(trimmed) || lineAnchorRe().test(trimmed)) return trimmed;
		const match = trimmed.match(hlRowAnchorRe());
		if (!match) return ref;
		const linePart = match[2] !== undefined ? `${match[2]}:` : "";
		const anchor = match[3]!;
		const rest = trimmed.slice(match[0].length);
		if (rest) {
			// issue #66/B2: any pasted row prefix (diff marker / line hint / anchor
			// + separator + content) is stripped UNCONDITIONALLY, with a warning.
			// The v2.0-era isRealMarker check (line number in range AND that
			// line's current anchor equals the prefix anchor) almost never held
			// for rows pasted from a post-edit diff (fresh anchors) — such rows
			// landed verbatim in the file, polluting it with anchor junk.
			let message: string;
			if (/\r\n?|\n/.test(rest)) {
				message = `[E_BAD_REF] remove_from/remove_to got a multi-line block; only the first row's anchor "${anchor}" was used, the rest was ignored.`;
			} else if (match[1] === "+") {
				message = `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "${linePart}${anchor}" (from "${clipLine(trimmed, 60)}").`;
			} else if (match[1] === "-") {
				message = `[E_BAD_REF] stripped leading "-" marker and trailing content — using "${linePart}${anchor}" (from "${clipLine(trimmed, 60)}").`;
			} else {
				message = `[E_BAD_REF] stripped trailing content — using "${linePart}${anchor}" (from "${clipLine(trimmed, 60)}").`;
			}
			warnings?.push(message);
		}
		return `${linePart}${anchor}`;
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
	fileAnchors: string[],
	warnings: string[],
): HEdit {
	// issue #66/B2: pasted anchor-prefix rows in the replacement content are
	// stripped (prefix = [line?]:anchor<sep>). The old isRealMarker check (line
	// number in range AND that line's CURRENT anchor equals the prefix anchor)
	// almost never held for rows pasted from a post-edit diff (fresh anchors),
	// so anchor junk landed verbatim in files. The strip condition is anchor
	// EXISTENCE: the prefix anchor must be an anchor currently allocated in
	// this file — always true for rows pasted from this file's read/diff
	// output, and astronomically unlikely for literal content like "sep:".
	// (Anchor-existence, not unconditional stripping, keeps the fidelity
	// constraint: the tool must not rewrite literal content it cannot verify.)
	const stripped: { lineIndex: number }[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const m = hlRowAnchorRe().exec(line);
		if (!m) return line;
		if (m[1] !== '') return line; // diff-marked rows handled by stripDiffPrefixes
		const prefixAnchor = m[3]!;
		if (!fileAnchors.includes(prefixAnchor)) return line;
		stripped.push({ lineIndex });
		return line.slice(m[0].length);
	});
	if (stripped.length > 0) {
		const locations = stripped
			.map((s) => `replacement_text line ${s.lineIndex + 1}`)
			.join(', ');
		warnings.push(
			`[E_BARE_HASH_PREFIX] stripped anchor prefix from ${locations}. If these lines are literal content, re-send without the anchor prefixes.`,
		);
	}
	return { ...edit, content_lines: contentLines };
}

/** @internal — private to anchor-pipeline seam */
function stripDiffPrefixes(
	edit: HEdit,
	fileAnchors: string[],
	warnings: string[],
): HEdit {
	const stripped: number[] = [];
	const contentLines = edit.content_lines.map((line, lineIndex) => {
		const m = hlRowAnchorRe().exec(line);
		if (!m) return line;
		if (m[1] === "") return line; // no diff marker, handled by stripBarePrefixes
		if (!isRealMarkerLine(m[0], fileAnchors)) return line;
		stripped.push(lineIndex);
		return line.slice(m[0].length);
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
	// Reversed detection compares the resolved LINE NUMBERS. Anchors are
	// unique per line, so line-to-line comparison is unambiguous. For bare
	// anchors with no line hint, the swap is meaningless — both bounds
	// resolve to the same line and the edit is a no-op or single-line edit.
	const [startRef, endRef] = edit.hash_bounds;
	const startLine = startRef.line ?? Number.NaN;
	const endLine = endRef.line ?? Number.NaN;
	if (!(startLine > endLine)) {
		return edit;
	}
	warnings.push(
		`[E_BAD_OP] reversed remove_from/remove_to (${startRef.anchor} after ${endRef.anchor}); swapped.`,
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
	fileAnchors: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): {
	resolved: RHEdit | undefined;
	mismatches: HMismatch[];
	boundaryDups: BDup[];
} {
	assertAligned(fileLines, fileAnchors, "valEdit");
	const mismatches: HMismatch[] = [];
	const boundaryDups: BDup[] = [];

	const tryResolve = (ref: Anchor): RAnchor | undefined => {
		const result = resAnchorFromMap(ref, fileAnchors);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	abortIf(signal);

	const startRef = edit.hash_bounds[0];
	const endRef = edit.hash_bounds[1];
	const startResolved = tryResolve(startRef);
	const endResolved = tryResolve(endRef);
	// #59/#66: a disagreeing `<line>:<anchor>` hint is informational — surface
	// it as a warning (the resolved anchor position always wins).
	for (const [ref, r] of [
		[startRef, startResolved],
		[endRef, endResolved],
	] as const) {
		if (r?.lineHintMismatch) {
			warnings.push(
				`[E_LINE_HINT] line hint ${ref.line} does not match anchor ${r.anchor} (resolved to line ${r.line}); anchor is authoritative, edit proceeds.`,
			);
		}
	}

	// Out-of-range check uses the resolved line (authoritative) when available,
	// otherwise the hint line. A BARE anchor that failed to resolve has NO line
	// claim at all — fall through to the mismatch renderer below (which emits
	// [E_STALE] with the ±context echo + fresh markers) instead of leaking the
	// -1 sentinel into an "out of range" message. The gate therefore only fires
	// when there is a REAL line claim (a resolved line, or an explicit
	// <line>:<anchor> hint) that exceeds the file.
	const startClaimedLine = startResolved?.line ?? startRef.line ?? -1;
	const endClaimedLine = endResolved?.line ?? endRef.line ?? -1;
	const hasLineClaim = (ref: Anchor, resolved: RAnchor | undefined): boolean =>
		resolved !== undefined || ref.line !== undefined;
	const startOOB =
		hasLineClaim(startRef, startResolved) &&
		(startClaimedLine < 1 || startClaimedLine > fileLines.length);
	const endOOB =
		hasLineClaim(endRef, endResolved) &&
		(endClaimedLine < 1 || endClaimedLine > fileLines.length);
	const backwards =
		startResolved !== undefined &&
		endResolved !== undefined &&
		startResolved.line > endResolved.line;
	if (startOOB || endOOB || backwards) {
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED] — line ${startClaimedLine}..${endClaimedLine} is out of range ` +
				`(file has ${fileLines.length} line${fileLines.length === 1 ? "" : "s"}). ` +
				`Call read() to get the current line count and fresh anchors.`,
			servedRows: [],
		});
	}
	if (!startResolved || !endResolved) {
		// Single-anchor fail: the OTHER resolved anchor gives us a "context"
		// (a real line in the file) so the error UX can echo ±N around it.
		// We carry the resolved RAnchor so fmtMismatchWithServes can use its
		// line + anchor to render the fresh marker.
		if (!startResolved && endResolved) {
			const startMismatch = mismatches.findLast(
				(m) => m.ref === startRef,
			);
			if (startMismatch) startMismatch.context = endResolved;
		} else if (startResolved && !endResolved) {
			const endMismatch = mismatches.findLast((m) => m.ref === endRef);
			if (endMismatch) endMismatch.context = startResolved;
		}
		return { resolved: undefined, mismatches, boundaryDups };
	}
	if (startResolved.line > endResolved.line) {
		throw new Error(
			`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${startRef.anchor} and ${endRef.anchor}).`,
		);
	}
	const endLine = endResolved.line;
	const startLine = startResolved.line;
	const rangeLines = fileLines.slice(startLine - 1, endLine);
	const canonLines = fileLines.map((line) => canon(line));
	boundaryDups.push(
		...trailingDups(edit.content_lines, fileLines, endLine),
		...leadingDups(edit.content_lines, fileLines, startLine),
		...firstNewAfterDups(edit.content_lines, rangeLines, canonLines, endLine),
		...lastNewBeforeDups(
			edit.content_lines,
			rangeLines,
			canonLines,
			startLine,
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
	anchor: string;
	/** contentChecksum(canon(line)) at serve time — used by verifyServedRange
	 *  to detect content drift between read and edit. */
	contentKey: string;
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
	fileAnchors: string[],
	fileLines: string[],
): ServedRow[] {
	const total = endLine - startLine + 1;
	const shown = Math.min(total, SERVED_ECHO_CAP);
	const rows: ServedRow[] = [];
	for (let ln = startLine; ln < startLine + shown; ln++) {
		const position = ln - 1;
		const line = fileLines[position] ?? "";
		rows.push({
			position,
			anchor: fileAnchors[position]!,
			contentKey: contentChecksum(canon(line)),
		});
	}
	return rows;
}

export function fmtServedRows(rows: ServedRow[], fileLines: string[]): string {
	return rows
		.map((row) => `${row.anchor}${hashSep()}${fileLines[row.position] ?? ""}`)
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
	/** Optional contentKey mirror (contentChecksum(canon(line))) — when provided,
	 *  per-row content drift is also rejected (E_RANGE_UNVERIFIED). */
	servedContent?: (string | null)[];
	startAnchor: string;
	endAnchor: string;
	startLine: number;
	endLine: number;
	fileAnchors: string[];
	fileLines: string[];
	filePath?: string;
}): void {
	const {
		served,
		servedContent,
		startAnchor,
		endAnchor,
		startLine,
		endLine,
		fileAnchors,
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

	// Strict line-by-line check at the agent's claimed positions. The anchor
	// verifies the row hasn't drifted since the read (the allocator guarantees
	// uniqueness, so we never fall back to "find any position with this
	// anchor", which would silently override the agent's intent). Each
	// position in served[] independently tracks its anchor (anchors are
	// unique per row, even when content repeats).
	const currentLen = endLine - startLine + 1;
	const firstMismatch: number | undefined = (() => {
		for (let k = 0; k < currentLen; k++) {
			const position = startLine - 1 + k;
			const expectedAnchor =
				currentLen === 1
					? startAnchor
					: k === 0
						? startAnchor
						: k === currentLen - 1
							? endAnchor
							: fileAnchors[position];
			const servedAnchor = served[position];
			if (servedAnchor === null) return position;
			if (servedAnchor !== expectedAnchor) return position;
			if (servedContent) {
				const expectedContentKey = contentChecksum(
					canon(fileLines[position]!),
				);
				const servedContentKey = servedContent[position];
				if (
					servedContentKey === null ||
					servedContentKey !== expectedContentKey
				) {
					return position;
				}
			}
		}
		return undefined;
	})();

	if (firstMismatch !== undefined) {
		const mismatchLine = firstMismatch + 1;
		const expectedAnchor = fileAnchors[firstMismatch]!;
		const ctxFrom = Math.max(1, mismatchLine - contextLinesCfg());
		const ctxTo = Math.min(
			fileLines.length,
			mismatchLine + contextLinesCfg(),
		);
		const ctxEchoLines: string[] = [];
		const ctxServedRows: ServedRow[] = [];
		for (let ln = ctxFrom; ln <= ctxTo; ln++) {
			const marker = `${fileAnchors[ln - 1]}`;
			ctxEchoLines.push(
				`  ${marker}${hashSep()}${clipLine(fileLines[ln - 1] ?? "")}`,
			);
			ctxServedRows.push({
				position: ln - 1,
				anchor: fileAnchors[ln - 1]!,
				contentKey: contentChecksum(canon(fileLines[ln - 1] ?? "")),
			});
		}
		const ctxEcho = `${hashlineHeader()}\n${ctxEchoLines.join("\n")}`;
		const freshMarker = `${expectedAnchor}`;
		const servedAtLine = served[firstMismatch];
		const servedContentAtLine = servedContent?.[firstMismatch] ?? null;
		let staleMsg: string;
		let contentLocations: string | undefined;
		if (servedAtLine === null) {
			staleMsg = `line ${mismatchLine} was never served to the model`;
		} else {
			staleMsg = `served mirror at line ${mismatchLine} is stale (served anchor ${servedAtLine}, file now has ${expectedAnchor})`;
			// Content-mismatch portion: locate where the served content currently
			// appears in the file. Empty list = the served content has been deleted.
			if (servedContent && servedContentAtLine !== null) {
				const target = servedContentAtLine;
				const linesWithServedContent: number[] = [];
				for (let i = 0; i < fileLines.length; i++) {
					if (contentChecksum(canon(fileLines[i]!)) === target) {
						linesWithServedContent.push(i + 1);
					}
				}
				if (linesWithServedContent.length > 0) {
					contentLocations = `The served content currently appears at lines: ${linesWithServedContent.join(", ")}`;
				} else {
					contentLocations = `The served content no longer appears in the file.`;
				}
			}
		}
		throw new ServedRejectionError({
			code: "E_RANGE_UNVERIFIED",
			message:
				`[E_RANGE_UNVERIFIED]${where ? ` ${where.trim()}` : ""} — ${staleMsg}. ` +
				`This usually happens after a previous edit shifted lines below your read window. ` +
				`A full read() will re-sync, but if the line below is what you meant, you can reuse the fresh marker instead.\n` +
				`Echo of the line you tried (read-style, ±${contextLinesCfg()} context):\n${ctxEcho}\n\n` +
				`If this is the line you meant, reuse the fresh marker ${freshMarker} without calling read.\n` +
				(contentLocations ? `${contentLocations}\n` : "") +
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
await recordServed(sessionKey, path, rows.map((r) => ({ position: r.position, anchor: r.anchor })), lineCount);
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
			loc: edit.hash_bounds[0].anchor,
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
	precomputedAnchors?: string[],
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
	const fileAnchors = precomputedAnchors ?? lineHashesPure(content);
	const warnings: string[] = [];

	const rangeFixed = swapReversedRanges(edit, warnings);
	const prefixFixed = stripDiffPrefixes(
		stripBarePrefixes(rangeFixed, fileAnchors, warnings),
		fileAnchors,
		warnings,
	);

	const {
		resolved: initialResolved,
		mismatches,
		boundaryDups,
	} = valEdit(
		prefixFixed,
		lineIndex.fileLines,
		fileAnchors,
		warnings,
		signal,
	);
	if (mismatches.length || !initialResolved) {
		const { message, servedRows } = fmtMismatchWithServes(
			mismatches,
			lineIndex.fileLines,
			fileAnchors,
			filePath,
		);
		throw new AnchorMismatchError(message, servedRows);
	}

	warnUnicodeEsc(prefixFixed, warnings);

	let resolved = initialResolved;
	// Issue #66/B7: pasted-dup detection is now WARNING-ONLY. The previous
	// behavior silently spliced the duplicated replacement lines out — a
	// legitimate replacement (e.g. line "C" → "B" next to an existing "B")
	// turned into a deletion with zero warning, silently losing data and
	// desyncing the incremental anchor bookkeeping (issue #66/B4). The common
	// accidental cause (pasted read/diff rows) is now handled upstream by the
	// unconditional anchor-prefix strip in resEdit, so the detection only
	// remains here as an observability warning; content is NEVER mutated.
	if (boundaryDups.length > 0) {
		const kinds = new Set(boundaryDups.map((d) => d.kind));
		warnings.push(
			`[E_PASTE_DUP] ${boundaryDups.length} replacement line(s) exactly match adjacent file lines (${[...kinds].join(", ")}); kept verbatim. If you pasted read/diff rows, re-send WITHOUT the anchor prefixes.`,
		);
	}

	if (served) {
		const startAnchor = resolved.hash_bounds[0];
		const endAnchor = resolved.hash_bounds[1];
		verifyServedRange({
			served,
			startAnchor: startAnchor.anchor,
			endAnchor: endAnchor.anchor,
			startLine: startAnchor.line,
			endLine: endAnchor.line,
			fileAnchors,
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
		// (autoFixes removed with issue #66/B7 — dup handling is warning-only now)

	};
}

function resolvedRange(resolved: RHEdit): ResolvedRange {
	const [start, end] = resolved.hash_bounds;
	return {
		startLine: start.line,
		endLine: end.line,
		startHash: start.anchor,
		endHash: end.anchor,
		delta:
			resolved.content_lines.length - (Math.abs(end.line - start.line) + 1),
	};
}

/**
 * Render `anchor:content` rows for a slice of the file. `startLine` is the
 * 1-indexed absolute line number of `lines[0]`. Defaults to 1 — the common case
 * when the whole file is being formatted. With `opts.lineNumbers`, each row is
 * rendered as `line:anchor:content` so the column carries line context.
 */
export function fmtRegion(
	anchors: string[],
	lines: string[],
	startLine: number = 1,
	opts?: { lineNumbers?: boolean },
): string {
	if (anchors.length !== lines.length) {
		throw new Error(
			`fmtRegion: anchors.length (${anchors.length}) must match lines.length (${lines.length}).`,
		);
	}
	if (!Number.isInteger(startLine) || startLine < 1) {
		throw new Error(
			`fmtRegion: startLine (${startLine}) must be a positive integer.`,
		);
	}
	const lineNumbers = opts?.lineNumbers === true;
	const markers = lines.map((_, index) =>
		lineNumbers
			? `${startLine + index}${hashSep()}${anchors[index]}`
			: anchors[index]!,
	);
	const width = anchorWidth(markers);
	return lines
		.map((line, index) => fmtHashlineRow("", markers[index]!, line, width))
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
 * `+12:aB3:...` / `-12:aB3:...` are stripped only when the prefix is a real
 * file marker; anything else stays literal. (Bare-anchor rows without a line
 * number cannot be verified — they're treated as literal content.)
 */
function isRealMarkerLine(prefix: string, fileAnchors: string[]): boolean {
	const m = /^([+-])?(\d+):([A-Za-z0-9]{1,8})\s*[:│]$/.exec(prefix);
	if (!m) return false;
	const lineNum = Number.parseInt(m[2]!, 10) - 1;
	if (
		!Number.isInteger(lineNum) ||
		lineNum < 0 ||
		lineNum >= fileAnchors.length
	) {
		return false;
	}
	return fileAnchors[lineNum] === m[3]!;
}