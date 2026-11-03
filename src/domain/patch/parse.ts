/**
 * The Grammar A′ parser — the reading half of the patch domain.
 *
 * A patch is a sequence of file sections. Every content line is `+`-prefixed,
 * so a header is the only thing that may appear un-prefixed; there is no
 * envelope and no old-content line. The section headers are `file`, `new`,
 * `move` and `remove`; a `file` or `move` section carries anchor hunks
 * (`replace`, `insert`, `delete`).
 *
 * The reading rules this module implements:
 *
 * - A content line starts with `+` in the FIRST column; everything after the
 *   `+` is kept verbatim and a bare `+` is an empty line.
 * - A header line is trimmed around its keyword, and the payload after the
 *   keyword is trimmed too. Keywords are lowercase — `File` is not a header.
 * - A hunk's content ends at the next hunk header, the next section header
 *   or the end of the input. A blank line between blocks is cosmetic.
 * - Anchors are the contract's variable-length Base62 markers; the weak
 *   `line:anchor` form is accepted and the line number is dropped.
 * - Anything else is a syntax refusal, reported as
 *   `Invalid patch at line <n>: <reason>` with the offending input line.
 *
 * @module dsh-hashline-edittool/patch/parse
 */

import { PatchParseError } from "./types.js";
import type {
	PatchHunk,
	PatchHunkKind,
	PatchSection,
	PatchSectionKind,
} from "./types.js";

/** The anchor shape: variable-length Base62, at least two characters. */
const ANCHOR_PATTERN = /^[0-9A-Za-z]{2,}$/;

/** The weak `line:anchor` form — the line number is a hint and is dropped. */
const WEAK_ANCHOR_PATTERN = /^\d+:([0-9A-Za-z]{2,})$/;

/** The section keywords, in the order the spec lists them. */
const SECTION_KINDS: readonly PatchSectionKind[] = ["file", "new", "move", "remove"];

/** The hunk keywords, in the order the spec lists them. */
const HUNK_KINDS: readonly PatchHunkKind[] = ["replace", "insert", "delete"];

/** A header line split into its keyword and its payload. */
interface Header {
	keyword: string;
	payload: string;
}

/** A section header, before it becomes a section. */
interface SectionHeader {
	kind: PatchSectionKind;
	path: string;
	destination?: string;
}

/** A hunk header, before it becomes a hunk. */
interface HunkHeader {
	kind: PatchHunkKind;
	anchorStart: string;
	anchorEnd?: string;
}

/** A section under construction — the hunk list and the `new` text fill in later. */
interface SectionBuilder {
	kind: PatchSectionKind;
	lineNumber: number;
	path: string;
	destination?: string;
	hunks: PatchHunk[];
	contentLines: string[];
}

/** Whether a keyword opens a section. */
function isSectionKind(keyword: string): keyword is PatchSectionKind {
	return (SECTION_KINDS as readonly string[]).includes(keyword);
}

/** Whether a keyword opens a hunk. */
function isHunkKind(keyword: string): keyword is PatchHunkKind {
	return (HUNK_KINDS as readonly string[]).includes(keyword);
}

/** Split the input into lines; the line number of a line is its index plus one. */
function splitLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

/**
 * Split a header line into its keyword and its payload.
 *
 * The keyword is the first whitespace-delimited token; the payload is
 * everything after it, trimmed. The keyword keeps its spelling — an
 * uppercase one is an unknown header, not a section.
 */
function readHeader(line: string): Header {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
	if (!match) return { keyword: line.trim(), payload: "" };
	return { keyword: match[1], payload: (match[2] ?? "").trim() };
}

/**
 * Read one anchor.
 *
 * The plain form is variable-length Base62. The weak `line:anchor` form is
 * accepted as a line hint and the line number is dropped, so both spellings
 * of the same anchor resolve to the same marker.
 */
function readAnchor(spec: string, lineNumber: number): string {
	const trimmed = spec.trim();
	if (trimmed === "") throw new PatchParseError(lineNumber, "missing anchor");
	const weak = WEAK_ANCHOR_PATTERN.exec(trimmed);
	if (weak) return weak[1];
	if (ANCHOR_PATTERN.test(trimmed)) return trimmed;
	throw new PatchParseError(lineNumber, `invalid anchor \`${trimmed}\``);
}

/**
 * Read a hunk header: `replace <a>`, `replace <a>..<b>`, `insert <a>`,
 * `delete <a>`, `delete <a>..<b>`.
 */
function readHunkHeader(payload: string, kind: PatchHunkKind, lineNumber: number): HunkHeader {
	const rangeAt = payload.indexOf("..");
	if (rangeAt < 0) return { kind, anchorStart: readAnchor(payload, lineNumber) };
	if (kind === "insert") {
		throw new PatchParseError(lineNumber, "`insert` does not take a range");
	}
	const anchorStart = readAnchor(payload.slice(0, rangeAt), lineNumber);
	const anchorEnd = readAnchor(payload.slice(rangeAt + 2), lineNumber);
	return { kind, anchorStart, anchorEnd };
}

/**
 * Read a section header: `file <path>`, `new <path>`, `move <from> -> <to>`,
 * `remove <path>`.
 */
function readSectionHeader(
	payload: string,
	kind: PatchSectionKind,
	lineNumber: number,
): SectionHeader {
	if (kind === "move") {
		const arrow = payload.lastIndexOf("->");
		if (arrow < 0) {
			throw new PatchParseError(lineNumber, "`move` needs `<from> -> <to>`");
		}
		const from = payload.slice(0, arrow).trim();
		const to = payload.slice(arrow + 2).trim();
		if (from === "" || to === "") {
			throw new PatchParseError(lineNumber, "`move` needs a non-empty source and destination");
		}
		return { kind, path: from, destination: to };
	}
	if (payload === "") throw new PatchParseError(lineNumber, `\`${kind}\` needs a path`);
	return { kind, path: payload };
}

/**
 * The scanner: one line at a time, one section and one hunk open at a time.
 *
 * The open hunk is what a `+` line fills; it is closed — and validated —
 * when the next hunk header, the next section header or the end of the input
 * arrives. A blank line never closes it: a blank line between blocks is
 * cosmetic.
 */
class PatchScanner {
	private readonly builders: SectionBuilder[] = [];
	private builder: SectionBuilder | null = null;
	private openHunk: PatchHunk | null = null;

	/** Read every line, close whatever is still open, and hand back the sections. */
	scan(lines: string[]): PatchSection[] {
		for (let index = 0; index < lines.length; index++) {
			this.readLine(lines[index], index + 1);
		}
		this.closeHunk();
		return this.builders.map(materialize);
	}

	/** Route one input line to the content reader or to a header. */
	private readLine(raw: string, lineNumber: number): void {
		if (raw.startsWith("+")) {
			this.readContent(raw.slice(1), lineNumber);
			return;
		}
		const text = raw.trim();
		if (text === "") return;
		const { keyword, payload } = readHeader(text);
		if (isSectionKind(keyword)) {
			this.openSection(payload, keyword, lineNumber);
			return;
		}
		if (isHunkKind(keyword)) {
			this.openHunkHeader(payload, keyword, lineNumber);
			return;
		}
		if (keyword.startsWith("+")) {
			throw new PatchParseError(
				lineNumber,
				"a content line must start with `+` in the first column",
			);
		}
		throw new PatchParseError(lineNumber, `unknown header \`${keyword}\``);
	}

	/** Take one content line, without its `+`, into the section that owns it. */
	private readContent(text: string, lineNumber: number): void {
		const builder = this.builder;
		if (!builder) {
			throw new PatchParseError(lineNumber, "content line before any section header");
		}
		if (builder.kind === "new") {
			builder.contentLines.push(text);
			return;
		}
		if (builder.kind === "remove") {
			throw new PatchParseError(lineNumber, "`remove` section cannot carry content lines");
		}
		const hunk = this.openHunk;
		if (!hunk) {
			throw new PatchParseError(lineNumber, "content line before any hunk header");
		}
		if (hunk.kind === "delete") {
			throw new PatchParseError(lineNumber, "`delete` hunk cannot carry content lines");
		}
		hunk.lines.push(text);
	}

	/** Close the open hunk, validate it and start a new section. */
	private openSection(payload: string, kind: PatchSectionKind, lineNumber: number): void {
		this.closeHunk();
		const header = readSectionHeader(payload, kind, lineNumber);
		const builder: SectionBuilder = {
			kind: header.kind,
			lineNumber,
			path: header.path,
			hunks: [],
			contentLines: [],
		};
		if (header.destination !== undefined) builder.destination = header.destination;
		this.builders.push(builder);
		this.builder = builder;
	}

	/** Close the open hunk, validate it and start a new hunk. */
	private openHunkHeader(payload: string, kind: PatchHunkKind, lineNumber: number): void {
		const builder = this.builder;
		if (!builder) {
			throw new PatchParseError(lineNumber, "hunk header before any section header");
		}
		if (builder.kind === "new") {
			throw new PatchParseError(lineNumber, "`new` section cannot carry hunks");
		}
		if (builder.kind === "remove") {
			throw new PatchParseError(lineNumber, "`remove` section cannot carry hunks");
		}
		this.closeHunk();
		const header = readHunkHeader(payload, kind, lineNumber);
		const hunk: PatchHunk = {
			lineNumber,
			kind: header.kind,
			anchorStart: header.anchorStart,
			lines: [],
		};
		if (header.anchorEnd !== undefined) hunk.anchorEnd = header.anchorEnd;
		builder.hunks.push(hunk);
		this.openHunk = hunk;
	}

	/**
	 * Close the open hunk and check that it carries what its kind needs:
	 * a `replace` or an `insert` needs at least one content line (a bare `+`
	 * counts), a `delete` needs none.
	 */
	private closeHunk(): void {
		const hunk = this.openHunk;
		if (!hunk) return;
		this.openHunk = null;
		if (hunk.kind === "delete") return;
		if (hunk.lines.length === 0) {
			throw new PatchParseError(
				hunk.lineNumber,
				`\`${hunk.kind}\` hunk needs at least one content line`,
			);
		}
	}
}

/** Turn a builder into the section the caller sees. */
function materialize(builder: SectionBuilder): PatchSection {
	const section: PatchSection = {
		kind: builder.kind,
		lineNumber: builder.lineNumber,
		path: builder.path,
		hunks: builder.hunks,
	};
	if (builder.destination !== undefined) section.destination = builder.destination;
	if (builder.kind === "new") {
		section.content = builder.contentLines.map((line) => `${line}\n`).join("");
	}
	return section;
}

/**
 * Parse a patch body into its file sections.
 *
 * A body that is blank throughout is not a patch and yields no sections. Any
 * other body either parses or is refused with a `PatchParseError` carrying
 * the offending input line.
 */
export function parsePatch(text: string): PatchSection[] {
	const lines = splitLines(text);
	if (lines.every((line) => line.trim() === "")) return [];
	return new PatchScanner().scan(lines);
}
