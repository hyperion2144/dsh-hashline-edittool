/**
 * Turning a navigation answer into rows a human (and an `edit`) can use.
 *
 * A location is a `file:` URI plus a range; three things have to happen before
 * it is worth showing:
 *
 * 1. the URI must become a path the reader recognizes — workspace-relative
 *    when it is inside the provider's canonical workspace root, an absolute
 *    path when it is outside, the URI untouched when it is not a file;
 * 2. the windows and positions are the PROTOCOL's (zero-based UTF-16), while
 *    everything this plugin prints is one-based — converted exactly once, here;
 * 3. the whole rendering is bounded, and the notice that it was bounded is
 *    counted inside the bound.
 *
 * Pure: no I/O, no session, no anchors. The caller owns reading a file when it
 * wants an anchor for a row.
 *
 * @module dsh-hashline-edittool/render/lsp-locations
 */

import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** A location as a server sent it: a document URI and a range to place. */
export interface WireLocation {
	readonly uri: string;
	readonly range: unknown;
}

/** One location, resolved into the shapes this plugin prints. */
export interface ResolvedLocation {
	/** The target document URI, verbatim. */
	readonly uri: string;
	/** The path to SHOW: workspace-relative inside, absolute outside, URI as-is otherwise. */
	readonly displayPath: string;
	/** The local file path, when the URI resolved to one that can be read. */
	readonly absolutePath?: string;
	/** One-based line. */
	readonly line: number;
	/** One-based UTF-16 column. */
	readonly character: number;
}

/** One file's worth of resolved locations, in answer order. */
export interface LocationGroup {
	readonly displayPath: string;
	readonly absolutePath?: string;
	readonly entries: readonly { readonly line: number; readonly character: number }[];
}

/** Default cap on shown locations before an omission notice (matches the seam's own budget). */
export const DEFAULT_MAX_LOCATIONS = 100;

/** Default cap on the complete rendered answer, notice included. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000;

/**
 * Normalize the several shapes a server answers "where" with.
 *
 * `Location` carries `uri` + `range`; `LocationLink` carries `targetUri` +
 * `targetSelectionRange` (or `targetRange`). Which one arrives depends on the
 * server and on the operation, so both are read rather than one assumed.
 *
 * @param raw - the request answer, whatever it is.
 * @returns the locations it contains, in order; empty for `null`/garbage.
 */
export function normalizeLocationList(raw: unknown): WireLocation[] {
	if (raw === null || raw === undefined) return [];
	const entries = Array.isArray(raw) ? raw : [raw];
	const out: WireLocation[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			uri?: unknown;
			targetUri?: unknown;
			range?: unknown;
			targetSelectionRange?: unknown;
			targetRange?: unknown;
		};
		const uri =
			typeof record.uri === "string"
				? record.uri
				: typeof record.targetUri === "string"
					? record.targetUri
					: undefined;
		if (uri === undefined) continue;
		out.push({ uri, range: record.range ?? record.targetSelectionRange ?? record.targetRange });
	}
	return out;
}

/**
 * Resolve a batch of wire locations into display paths and one-based positions.
 *
 * A location whose range carries no usable start is DROPPED rather than drawn
 * at line 1: a row pointing at the wrong place is worse than no row.
 *
 * @param locations - the normalized locations.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns one resolved location per usable input, in order.
 */
export function resolveLocations(
	locations: readonly WireLocation[],
	workspaceUri: string,
): ResolvedLocation[] {
	const out: ResolvedLocation[] = [];
	for (const location of locations) {
		const start = rangeStart(location.range);
		if (start === undefined) continue;
		const absolutePath = fileUriToPath(location.uri);
		out.push({
			uri: location.uri,
			displayPath: renderUri(location.uri, workspaceUri),
			...(absolutePath === undefined ? {} : { absolutePath }),
			line: start.line + 1,
			character: start.character + 1,
		});
	}
	return out;
}

/** Group resolved locations by their display path, preserving first-seen order. */
export function groupLocations(locations: readonly ResolvedLocation[]): LocationGroup[] {
	const byPath = new Map<string, { absolutePath?: string; entries: { line: number; character: number }[] }>();
	for (const location of locations) {
		const group = byPath.get(location.displayPath) ?? {
			...(location.absolutePath === undefined ? {} : { absolutePath: location.absolutePath }),
			entries: [],
		};
		group.entries.push({ line: location.line, character: location.character });
		byPath.set(location.displayPath, group);
	}
	return [...byPath.entries()].map(([displayPath, group]) => ({
		displayPath,
		...(group.absolutePath === undefined ? {} : { absolutePath: group.absolutePath }),
		entries: group.entries,
	}));
}

/** The zero-based start of a range, when the payload has one. */
function rangeStart(range: unknown): { line: number; character: number } | undefined {
	if (typeof range !== "object" || range === null) return undefined;
	const start = (range as { start?: unknown }).start;
	if (typeof start !== "object" || start === null) return undefined;
	const { line, character } = start as { line?: unknown; character?: unknown };
	if (typeof line !== "number" || !Number.isInteger(line) || line < 0) return undefined;
	const column = typeof character === "number" && Number.isInteger(character) && character >= 0 ? character : 0;
	return { line, character: column };
}

/**
 * The local path a `file:` URI names, or `undefined` when it names none.
 *
 * Containment is NOT judged here: a path outside the workspace is still a real
 * path, and the caller decides what it may do with it.
 *
 * @param uri - a document URI.
 * @returns the decoded path, or `undefined` for a non-file or malformed URI.
 */
export function fileUriToPath(uri: string): string | undefined {
	if (!uri.startsWith("file:")) return undefined;
	try {
		const path = fileURLToPath(uri, { windows: windowsWorld(uri) });
		return path.includes("\0") ? undefined : path;
	} catch {
		return undefined;
	}
}

/**
 * Whether two document URIs name the SAME file.
 *
 * THE SPELLINGS DIFFER even for one file: a server may percent-encode the
 * drive colon and lower-case the drive letter (`file:///d%3A/x.ts`) while the
 * host builds `file:///D:/x.ts`. Both decode to the same path except for the
 * drive letter's case — and on Windows a path IS case-insensitive, so the
 * comparison has to fold it. `pathToFileURL(fileURLToPath(uri))` does NOT:
 * Node preserves the original case, so the round trip keeps the difference.
 *
 * Outside the Windows world the comparison stays EXACT: on a case-sensitive
 * filesystem `a.ts` and `A.ts` are two files, and folding would merge them.
 *
 * @param left - one document URI.
 * @param right - the other one.
 * @returns true when both name the same file.
 */
export function sameDocumentUri(left: string, right: string): boolean {
	const leftPath = fileUriToPath(left);
	const rightPath = fileUriToPath(right);
	// A URI that names no local file is compared as itself: there is nothing to
	// decode, and two different opaque URIs are two different documents.
	if (leftPath === undefined || rightPath === undefined) return left === right;
	// The world is the URI's own: a `file:` URI does not carry its OS.
	if (!windowsWorld(left) || !windowsWorld(right)) return leftPath === rightPath;
	// Windows compares paths case-insensitively — Node's own `win32.relative`
	// does the same, so the folded form is the platform's own notion of equality.
	return win32.normalize(leftPath).toLowerCase() === win32.normalize(rightPath).toLowerCase();
}

/**
 * Render a location URI without applying the HOST's path rules.
 *
 * A valid `file:` URI inside the provider's canonical workspace becomes a
 * workspace-relative path; one outside it becomes an absolute path derived
 * from the URI. Malformed and non-`file:` URIs stay verbatim — inventing a
 * path for something that is not one is how a card points at a file that does
 * not exist.
 *
 * @param uri - the target URI from the server.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns the display path or the verbatim URI.
 */
export function renderUri(uri: string, workspaceUri: string): string {
	if (!uri.startsWith("file:")) return uri;
	let target: URL;
	let workspace: URL;
	try {
		target = new URL(uri);
		workspace = new URL(workspaceUri);
	} catch {
		return uri;
	}
	if (workspace.protocol !== "file:") return uri;
	const workspaceWindows = windowsWorld(workspaceUri);
	const targetWindows = workspaceWindows && windowsWorld(uri);
	const workspacePath = pathOf(workspace, workspaceWindows);
	const targetPath = pathOf(target, targetWindows);
	if (workspacePath === undefined || targetPath === undefined) return uri;
	if (workspaceWindows !== targetWindows) return targetPath;
	const path = workspaceWindows ? win32 : posix;
	const relative = path.relative(workspacePath, targetPath);
	const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
	const rendered = relative === "" ? "." : outside ? targetPath : relative;
	return workspaceWindows ? rendered.replaceAll("\\", "/") : rendered;
}

/**
 * Whether a `file:` URI belongs to the Windows execution world.
 *
 * A `file:` URI does not carry its world's OS, so a leading `/X:` segment is
 * read as a drive letter — the same convention the platform provider uses.
 */
function windowsWorld(uri: string): boolean {
	try {
		const url = new URL(uri);
		return url.hostname.length > 0 || /^\/[a-z](?::|%3A)/iu.test(url.pathname);
	} catch {
		return false;
	}
}

/** Decode one URL for its execution world, containing malformed failures. */
function pathOf(url: URL, windows: boolean): string | undefined {
	try {
		const path = fileURLToPath(url, { windows });
		return path.includes("\0") ? undefined : path;
	} catch {
		return undefined;
	}
}

/**
 * Bound a fully rendered answer, keeping the truncation notice inside the bound.
 *
 * @param text - the rendered text.
 * @param maxChars - the complete cap, notice included.
 * @param label - the word the notice calls what was cut ("locations", "hover").
 * @returns the text, cut and marked when it was over.
 */
export function boundText(text: string, maxChars: number, label: string): string {
	if (text.length <= maxChars) return text;
	const notice = `\n… ${label} truncated (limit ${maxChars} characters).`;
	if (notice.length >= maxChars) return notice.slice(0, maxChars);
	return `${text.slice(0, maxChars - notice.length)}${notice}`;
}

/**
 * Normalize the several shapes a server answers "what" with into hover text.
 *
 * `MarkupContent`, a plain string, and the legacy `MarkedString[]` (a list of
 * strings and `{ language, value }`) all reduce to text, because the seam's
 * hover carries content, not a protocol shape.
 *
 * @param raw - the `textDocument/hover` answer.
 * @returns the text, or `null` when there is nothing to show.
 */
export function hoverContents(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string") return raw.length === 0 ? null : raw;
	if (typeof raw !== "object") return null;
	const contents = (raw as { contents?: unknown }).contents;
	if (typeof contents === "string") return contents.length === 0 ? null : contents;
	if (typeof contents === "object" && contents !== null && !Array.isArray(contents)) {
		const value = (contents as { value?: unknown }).value;
		if (typeof value === "string") return value.length === 0 ? null : value;
		return null;
	}
	if (Array.isArray(contents)) {
		const parts: string[] = [];
		for (const part of contents) {
			if (typeof part === "string") {
				if (part.length > 0) parts.push(part);
				continue;
			}
			const value = (part as { value?: unknown } | null)?.value;
			if (typeof value === "string" && value.length > 0) parts.push(value);
		}
		return parts.length === 0 ? null : parts.join("\n\n");
	}
	return null;
}
