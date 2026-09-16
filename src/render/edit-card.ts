/**
 * The edit card's projection: hunk diffs for the diff card, the structured
 * diff-row rendering channel, their soft validators, and the row-marker parse.
 *
 * Split out of `presentation-helpers` (the old five-tool grab-bag) so an edit
 * card change lands in the file that owns the edit card. Rendering itself comes
 * from `./edit-diff` — this module projects and validates what `genDiff`
 * produces.
 *
 * @module dsh-hashline-edittool/render/edit-card
 */
import { structuredPatch } from "diff";
import { contextLinesCfg } from "../hashline/hash-assign.js";
import { genDiff, formatRowMarker } from "./edit-diff.js";

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

/**
 * The JSON-mode diff dictionary: `{"<anchor>:<line>": content}` with `+`/`-`
 * prefixes on changed rows, exactly the keys the edit tool's json envelope
 * uses. ONE implementation, so `edit` and `ast_edit` cannot name a row
 * differently.
 *
 * @param before - the pre-edit content.
 * @param after - the post-edit content.
 * @param afterHashes - anchors for `after` (allocated when omitted).
 * @param beforeHashes - anchors for `before` (allocated when omitted).
 * @returns the keyed diff rows.
 */
export function diffDictFrom(
	before: string,
	after: string,
	afterHashes?: readonly string[],
	beforeHashes?: readonly string[],
): Record<string, string> {
	const { rows } = genDiff(
		before,
		after,
		contextLinesCfg(),
		afterHashes === undefined ? undefined : [...afterHashes],
		beforeHashes === undefined ? undefined : [...beforeHashes],
		true,
	);
	const dict: Record<string, string> = {};
	for (const row of rows) {
		const marker = formatRowMarker(row.hash, row.lineNumber);
		dict[row.kind === "-" ? `-${marker}` : row.kind === "+" ? `+${marker}` : marker] = row.content;
	}
	return dict;
}
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

/** Parse the line number from a marker, in EITHER order (`<anchor>:<line>` or legacy `<line>:<anchor>`). */
export function parseLineFromHash(ref: string): number | undefined {
	if (typeof ref !== "string") return undefined;
	const idx = ref.indexOf(":");
	if (idx <= 0) return undefined;
	// The CURRENT order puts the line AFTER the anchor, so the trailing half
	// is tried first — a leading number means the legacy spelling.
	const head = ref.slice(0, idx);
	const num = /^\d+$/.test(head) ? head : ref.slice(idx + 1).replace(/[:|].*$/, "");
	const n = Number.parseInt(num, 10);
	return Number.isInteger(n) && n >= 1 ? n : undefined;
}
