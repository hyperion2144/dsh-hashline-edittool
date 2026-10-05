/**
 * FileView — deep module owning "what the model sees".
 *
 * Single seam for normalize → hash → render → truncate → served-row
 * selection. Previously split across file-reader, read-render, truncate,
 * file-kind, validation — each shallow (interface≈implementation). Now one
 * file owns the invariant; deleting it would scatter complexity (deep).
 *
 * Private helpers inlined from file-reader (normFromText/fileSnap),
 * read-render (fmtReadPreview), truncate (truncateHead), file-kind
 * (loadFileKindAndText), validation (valKind/valAccess).
 * Old files are shims re-exporting from this seam for compat.
 *
 * Two surfaces:
 *  - `preview` (pure, no IO) — tested without filesystem
 *  - `readView` (IO) — read + normalize + render + truncate + hashes
 *
 * @module dsh-hashline-edittool/file-view
 */

import { constants } from "node:fs";
import { open as fsOpen, stat as fsStat } from "fs/promises";
import { access as fsAccess } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { SNIFF_BYTES, MAX_READ_LINE_BYTES } from "../../infra/constants.js";
import { fmtRegion, hashSep } from "../../hashline/index.js";
import { anchorsFor } from "./anchor-state.js";
import { anchorForInWorkspace, workspaceCwd } from "./session-view.js";
import { fmtMarker, hashlineHeader, canon, contentChecksum } from "../../hashline/hash-assign.js";
import { splitLines, abortIf, errCode } from "../../infra/utils.js";
import { lineNumbersEnabled } from "../../infra/settings.js";
import { EMPTY_FILE_NOTE, formatNoLinesSummary } from "./read-window.js";
import { detectEnding, toLF, stripBOM, type LineEnding } from "../../render/edit-diff.js";
import { resolveTarget, toCwd } from "../../infra/paths.js";
import type { FileIO } from "../../infra/fs-bridge.js";
import type { ServedRow } from "../../hashline/anchor-pipeline.js";
import type { HashStore } from "./hash-store.js";
import { loadHashStore } from "./hash-store.js";

// The default read window is the per-response char budget (ADR-0013); the
// retired DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES pair is gone (#205/#210).

// --- Truncate (from truncate.ts, private to this seam) ---

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const totalBytes = Buffer.byteLength(content, 'utf-8');
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }
  const firstLineBytes = Buffer.byteLength(lines[0] ?? '', 'utf-8');
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: 'lines' | 'bytes' = 'lines';
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, 'utf-8') + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = 'lines';
  }
  const outputContent = outputLinesArr.join('\n');
  const finalOutputBytes = Buffer.byteLength(outputContent, 'utf-8');
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

// --- File kind (from file-kind.ts, private) ---

const IMG_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const TEXT_TYPES = new Set<string>([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
]);

function detectTextBom(sample: Uint8Array): string | undefined {
  if (
    sample.length >= 4 &&
    sample[0] === 0xff &&
    sample[1] === 0xfe &&
    sample[2] === 0x00 &&
    sample[3] === 0x00
  ) return "UTF-32LE";
  if (
    sample.length >= 4 &&
    sample[0] === 0x00 &&
    sample[1] === 0x00 &&
    sample[2] === 0xfe &&
    sample[3] === 0xff
  ) return "UTF-32BE";
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "UTF-16LE";
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "UTF-16BE";
  return undefined;
}

function isTextType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
}

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text"; text: string; hadUtf8DecodeErrors?: true }
  | { kind: "binary"; description: string };

export interface LoadFileOptions {
  maxLines?: number;
  displayPath?: string;
}

export async function loadFileKindAndText(
  filePath: string,
  options?: LoadFileOptions,
): Promise<LFile> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "binary",
      description: "unsupported file type",
    };
  }
  // ADR-0013: the size gate is gone — files of any size are read in full and
  // delivered in segments. Binary detection below still applies.
  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      SNIFF_BYTES,
      0,
    );
    if (bytesRead === 0) {
      return { kind: "text", text: "" };
    }
    const sample = buffer.subarray(0, bytesRead);
    const textBom = detectTextBom(sample);
    if (textBom) {
      return {
        kind: "binary",
        description: `${textBom} encoded text`,
      };
    }
    const detectedMimeType = (await fileTypeFromBuffer(sample))?.mime;
    if (
      detectedMimeType !== undefined &&
      !isTextType(detectedMimeType)
    ) {
      if (IMG_TYPES.has(detectedMimeType)) {
        return { kind: "image", mimeType: detectedMimeType };
      }
      return {
        kind: "binary",
        description: detectedMimeType,
      };
    }
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    let hadUtf8DecodeErrors = false;
    let newlineCount = 0;
    const parts: string[] = [];
    function decodeChunk(chunk: Uint8Array, stream: boolean): string {
      const decoded = decoder.decode(chunk, { stream });
      if (!hadUtf8DecodeErrors && decoded.includes("\uFFFD")) {
        hadUtf8DecodeErrors = true;
      }
      return decoded;
    }
    parts.push(decodeChunk(sample, true));
    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(
        buffer,
        0,
        SNIFF_BYTES,
        position,
      );
      if (chunkBytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, chunkBytesRead);
      parts.push(decodeChunk(chunk, true));
      position += chunkBytesRead;
    }
    parts.push(decodeChunk(new Uint8Array(0), false));
    return {
      kind: "text",
      text: parts.join(""),
      ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
    };
  } finally {
    await fileHandle.close();
  }
}

// --- Validation (from validation.ts, private) ---

export async function valAccess(
  absolutePath: string,
  path: string,
  accessMode: number = constants.R_OK,
): Promise<void> {
  try {
    await fsAccess(absolutePath, accessMode);
  } catch (error: unknown) {
    const code = errCode(error);
    if (code === "ENOENT") {
      throw new Error(`[E_NOT_FOUND] File not found: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      const accessLabel = accessMode & constants.W_OK ? "not writable" : "not readable";
      throw new Error(`[E_ACCESS] File is ${accessLabel}: ${path}`);
    }
    if (code === "ELOOP") {
      throw new Error(`[E_ACCESS] Too many symbolic links while resolving: ${path}`);
    }
    throw new Error(`[E_ACCESS] Cannot access file: ${path}`);
  }
}

export function valKind(file: LFile, path: string): asserts file is { kind: "text"; text: string; hadUtf8DecodeErrors?: true } {
  if (file.kind === "directory") {
    throw new Error(`[E_NOT_TEXT] Path is a directory: ${path}. Use ls to inspect directories.`);
  }
  if (file.kind === "binary") {
    throw new Error(`[E_NOT_TEXT] Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`);
  }
  if (file.kind === "image") {
    throw new Error(`[E_NOT_TEXT] Path is an image file: ${path}. Hashline edit only supports text files.`);
  }
}

// --- File reader (from file-reader.ts, private) ---

export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: LineEnding;
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

export type SnapInfo = {
  snapshotId: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
};

function fmtSnapId(
  canonicalPath: string,
  info: { ino: number; mtimeMs: number; ctimeMs: number; size: number },
): string {
  return `v2|${canonicalPath}|${info.ino}|${info.mtimeMs}|${info.ctimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  const stats = await fsStat(canonicalPath);
  return {
    snapshotId: fmtSnapId(canonicalPath, stats),
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
  };
}

export interface ReadNormOptions {
  signal?: AbortSignal;
  accessMode?: number;
  preloadedFile?: LFile;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
}

export async function normFromText(input: {
  absolutePath: string;
  rawText: string;
  displayPath: string;
  signal?: AbortSignal;
  maxLines?: number;
  store?: HashStore;
  noPersist?: boolean;
  hadUtf8DecodeErrors?: boolean;
}): Promise<NormFile> {
  const { absolutePath, displayPath, signal } = input;
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(input.rawText);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);
  // LAZY (#169): the VIEW only — allocation happens in the window renderer
  // for EXACTLY the rows the model sees (persisted == served == visible).
  const fileHashes = anchorsFor(absolutePath, normalized);
  return {
    absolutePath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: input.hadUtf8DecodeErrors === true,
  };
}

export async function readNormFile(
  path: string,
  cwd: string,
  options?: ReadNormOptions,
): Promise<NormFile> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  const signal = options?.signal;
  const accessMode = options?.accessMode ?? constants.R_OK;
  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);
  abortIf(signal);
  const file =
    options?.preloadedFile ??
    (await loadFileKindAndText(resolvedPath, {
      maxLines: options?.maxLines,
      displayPath: path,
    }));
  valKind(file, path);
  return normFromText({
    absolutePath: resolvedPath,
    rawText: file.text,
    displayPath: path,
    signal,
    maxLines: options?.maxLines,
    store: options?.store,
    noPersist: options?.noPersist,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors,
  });
}

// --- Read render (from read-render.ts, private) ---

/**
 * Split a hashline block into its header line and the row body. Returns the
 * header text unchanged and the rows without it (so callers can pass the rows
 * to a line-budget truncation without the header counting against the cap).
 */
function splitHashlineBlock(formatted: string): {
  headerLine: string;
  rowsOnly: string;
} {
  const newline = formatted.indexOf("\n");
  if (newline < 0) {
    return { headerLine: formatted, rowsOnly: "" };
  }
  const headerLine = formatted.slice(0, newline);
  return { headerLine, rowsOnly: formatted.slice(newline + 1) };
}

function normPosInt(
  value: number | undefined,
  name: 'offset' | 'limit',
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`,
    );
  }
  return value;
}


export async function fmtReadPreview(
  text: string,
	options: {
		offset?: number;
		limit?: number;
		/** ADR-0013: char budget for the returned window (whole-line assembly). */
		maxChars?: number;
		/** The user's line-number switch (#244): a row marker becomes `<anchor>:<line>` when on. */
		lineNumbers?: boolean;
		/**
		 * The session this read serves (#223). The renderer mints its own window,
		 * and serving is per-session — this is what lets that mint go through the
		 * one entry point instead of a second allocation path.
		 */
		sessionKey?: string;
		/**
		 * The workspace root for that mint. Passed explicitly because the
		 * renderer is also reachable with NO ambient scope (see the callers that
		 * have no `withWorkspace` body) — and minting into the wrong store is
		 * silent, which is the failure class this refactor exists to remove.
		 */
		cwd?: string;
	},
  precomputedHashes?: string[],
  path?: string,
  maxLineBytes = MAX_READ_LINE_BYTES,
  maxTruncLines = Number.MAX_SAFE_INTEGER,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  /**
   * Absolute 1-indexed line of the LAST SERVED row — the render bound the tool
   * layer must rebuild from (#212). Independent of `nextOffset`, which exists
   * only when the char BUDGET cut the window (it mints the resume token):
   * deriving the window from `nextOffset` made every limit-cut fall back to
   * EOF and rebuild rows that were never served.
   */
  shownEnd?: number;
  served: ServedRow[];
  /** The window's anchors, patched in place (#169) — callers rebuild rows from it. */
  hashes: string[];
}> {
  // #245: one splitter for the whole tool — an empty file is ONE line, so the
  // window summary, the JSON view and the text view agree on `totalLines`.
  const allLines = splitLines(text);
  const totalLines = allLines.length;
  const startLine = normPosInt(options.offset, 'offset') ?? 1;
  if (text.length === 0) {
    if (startLine === 1) {
      const allHashes = precomputedHashes ?? (path ? anchorsFor(path, text) : []);
      // LAZY (#169): the one visible row of an empty file IS the serve.
      let emptyLineHash = allHashes[0] ?? "";
      if (path) {
        // #223: through the ONE entry point — it mints AND records served in the
        // same transaction, so the single visible row of an empty file cannot be
        // shown-but-unserved.
        const [allocated] = await anchorForInWorkspace({
          cwd: options.cwd ?? workspaceCwd() ?? "",
          absolutePath: path,
          content: text,
          lines: [1],
          sessionKey: options.sessionKey ?? "",
        });
        if (allocated !== undefined && allocated !== "") emptyLineHash = allocated;
      }
      return {
		text: `${hashlineHeader(false)}\n${emptyLineHash}${hashSep()}\n${EMPTY_FILE_NOTE}`,
		hashes: allHashes,
		shownEnd: 1,
		served: [{ position: 0, anchor: emptyLineHash, contentKey: contentChecksum(canon("")) }],
      };
    }
    return {
      text: formatNoLinesSummary(startLine, 0, true),
      hashes: [],
      served: [],
    };
  }
  if (startLine > totalLines) {
    return {
      text: formatNoLinesSummary(startLine, totalLines),
      hashes: [],
      served: [],
    };
  }
  const limit = normPosInt(options.limit, 'limit');
  let endIdx = limit
    ? Math.min(startLine - 1 + limit, totalLines)
    : totalLines;
  let selected = allLines.slice(startLine - 1, endIdx);
  const allHashes = precomputedHashes ?? (path ? anchorsFor(path, text) : []);
  let budgetCut = false;
  const originalCount = endIdx - startLine + 1;
  // ADR-0013: the char budget is the segment bound — walk whole rows (a line
  // is never cut), est. +24 chars/row for marker+separator overhead, and cut
  // BEFORE allocation so persisted == served == visible holds exactly.
  if (options.maxChars !== undefined) {
    let acc = 0;
    let count = 0;
    for (const line of selected) {
      const cost = line.length + 24;
      if (acc + cost > options.maxChars && count > 0) break;
      acc += cost;
      count += 1;
    }
    selected = selected.slice(0, count);
    endIdx = startLine - 1 + count;
    budgetCut = count < originalCount;
  }
		// Track whether the CHAR BUDGET (not limit) actually cut rows — this is
		// the only condition that mints a resume token downstream.
  // LAZY (#169): allocate for EXACTLY the window rows this read serves —
  // persisted rows == served rows == visible rows, never the whole file.
	if (path && precomputedHashes === undefined) {
		const windowLines = Array.from(
			{ length: endIdx - startLine + 1 },
			(_, i) => startLine + i,
		);
		// #223: mints AND records served in one transaction, through the entry
		// point. The renderer is the right caller — it is the only one that knows
		// the window (the char budget and the per-row byte cap decide it) — but it
		// must not keep an allocation path of its own.
		const allocated = await anchorForInWorkspace({
			cwd: options.cwd ?? workspaceCwd() ?? "",
			absolutePath: path,
			content: text,
			lines: windowLines,
			sessionKey: options.sessionKey ?? "",
		});
		for (let i = 0; i < allocated.length; i++) {
			allHashes[startLine - 1 + i] = allocated[i]!;
		}
	}
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
		const formatted = `${hashlineHeader(options.lineNumbers ?? lineNumbersEnabled())}\n${fmtRegion(selectedHashes, selected, startLine, { lineNumbers: (options.lineNumbers ?? lineNumbersEnabled()) })}`;
  const maxBytes = maxLineBytes;
  const rowSizes = selected.map((line, index) => ({
    lineNumber: startLine + index,
    bytes: Buffer.byteLength(
      // The SAME marker `fmtRegion` renders (`fmtMarker`), not the pre-0.5
      // `line#hash` spelling: the two are one character apart TODAY, so the
      // limit math happened to hold — and would drift silently the moment the
      // marker changed shape.
      `${fmtMarker(selectedHashes[index] ?? "", startLine + index)}${hashSep()}${line}`,
      'utf-8',
    ),
  }));
  if (rowSizes.some((row) => row.bytes > maxBytes)) {
    const oversized = rowSizes.filter((row) => row.bytes > maxBytes);
    const rows = rowSizes.map((row, index) =>
      row.bytes > maxBytes
        ? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
        : fmtRegion([selectedHashes[index]!], [selected[index]!], row.lineNumber, { lineNumbers: (options.lineNumbers ?? lineNumbersEnabled()) }),
    );
    const skippedTruncation = truncateHead(rows.join('\n'), {
      maxBytes,
      maxLines: maxTruncLines,
    });
    const shownRowCount =
      skippedTruncation.content === ''
        ? 0
        : skippedTruncation.content.split('\n').length;
    const lastShownLine =
      shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
    const lineLabel =
      oversized.length === 1
        ? `Line ${oversized[0]!.lineNumber}`
        : `Lines ${oversized.map((row) => row.lineNumber).join(', ')}`;
    const verb = oversized.length === 1 ? 'exceeds' : 'exceed';
    const addresses = oversized.map((row) => `${row.lineNumber}p`).join(';');
    const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
    let preview = skippedTruncation.content;
    let nextOffset: number | undefined;
    if (
      shownRowCount > 0 &&
      (skippedTruncation.truncated || lastShownLine < totalLines)
    ) {
      nextOffset = lastShownLine + 1;
      preview = `${hashlineHeader(options.lineNumbers ?? lineNumbersEnabled())}\n${preview}`;
    }
    if (oversized.length > 0) {
      // #245: the page hint belongs to the tool layer now, but the bash
      // fallback for the lines this preview could not carry is content.
      preview = `${preview}\n\n${warning}`;
    }
    const served: ServedRow[] = [];
    for (let index = 0; index < shownRowCount; index++) {
      if (rowSizes[index]!.bytes <= maxBytes) {
        served.push({
          position: startLine - 1 + index,
          anchor: selectedHashes[index]!,
          contentKey: contentChecksum(canon(selected[index]!)),
        });
      }
    }
    return {
      text: preview,
      truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
      ...(budgetCut && nextOffset !== undefined ? { nextOffset } : {}),
      // The last SERVED row is the render bound (#212): oversized rows are
      // shown as notices, not content, so they are not served and must not be
      // rebuilt into the presentation either.
      ...(served.length > 0 ? { shownEnd: served[served.length - 1]!.position + 1 } : {}),
      hashes: allHashes,
      served,
    };
  }
  // Strip the hashline header before byte/line truncation so it doesn't count
  // against the line budget; re-attach it afterwards.
  const { headerLine, rowsOnly } = splitHashlineBlock(formatted);
  const truncation = truncateHead(rowsOnly, {
    maxBytes,
    maxLines: maxTruncLines,
  });
  let preview = `${headerLine}\n${truncation.content}`;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    // #245: the page hint is gone — the tool layer ends every read with ONE
    // window sentence (and mints the resume token when the budget cut it).
    nextOffset = startLine + truncation.outputLines;
  } else if (endIdx < totalLines) {
    // A user `limit` cut sets the render bound WITHOUT minting a token.
    nextOffset = endIdx + 1;
  }
  const served: ServedRow[] = [];
  for (let index = 0; index < truncation.outputLines; index++) {
    served.push({
      position: startLine - 1 + index,
      anchor: selectedHashes[index]!,
      contentKey: contentChecksum(canon(selected[index]!)),
    });
  }
  return {
    text: preview,
    truncation: truncation.truncated ? truncation : undefined,
    ...(budgetCut && nextOffset !== undefined ? { nextOffset } : {}),
    // LAZY (#169): the PATCHED array — the presentation layer rebuilds the
    // model text from it, so it must carry the window's real anchors.
    hashes: allHashes,
    // The last SERVED row is the render bound (#212): a limit-cut sets it
    // WITHOUT minting a resume token (`nextOffset` stays budget-only).
    ...(served.length > 0 ? { shownEnd: served[served.length - 1]!.position + 1 } : {}),
    served,
  };
}

// --- FileView public surface (unchanged) ---

export interface FileView {
  text: string;
  hashes: string[];
  served: ServedRow[];
  absolutePath: string;
  truncation?: TruncationResult;
  nextOffset?: number;
  /** #212 — absolute line of the last served row; the tool layer's render bound. */
  shownEnd?: number;
  hadUtf8DecodeErrors: boolean;
  bom: string;
  originalEnding: LineEnding;
  normalized: string;
}

export interface PreviewOpts {
	/** The user's line-number switch (#244): a read/diff marker becomes `<anchor>:<line>` when on. */
	/** ADR-0013: per-response char budget for the returned window. */
	maxChars?: number;
	lineNumbers?: boolean;
	offset?: number;
	limit?: number;
}

export interface ReadViewOpts extends PreviewOpts {
  signal?: AbortSignal;
  /**
   * The session this read serves (#223). It lives HERE and not on
   * `PreviewOpts` on purpose: minting and serving are what a READ does, not
   * what rendering a preview does — a caller that only renders (the write
   * shadow's diff, tests) has no session and needs none.
   */
  sessionKey?: string;
}

export async function preview(
  content: string,
  hashes: string[],
  opts: PreviewOpts = {},
  absolutePath?: string,
): Promise<{
  text: string;
  served: ServedRow[];
  truncation?: TruncationResult;
  nextOffset?: number;
}> {
  return fmtReadPreview(content, opts, hashes, absolutePath);
}

export async function readView(
  io: FileIO,
  path: string,
  cwd: string,
  opts: ReadViewOpts = {},
): Promise<FileView> {
  const { signal } = opts;
  const absolutePath = await io.resolve(path, cwd, signal);
  // LAZY (#169): the renderer below allocates anchors for the rows it serves,
  // and the anchor port writes ONLY to an already-open store — so open this
  // workspace's store first. Without this a read that is the session's first
  // tool call renders anchors that were never persisted (#171 probe).
  await loadHashStore(cwd);
  const rawText = await io.readText(absolutePath, signal);
  const { normalized, fileHashes, hadUtf8DecodeErrors, bom, originalEnding } =
    await normFromText({
      absolutePath,
      rawText,
      displayPath: path,
      signal,
    });
	const r = await fmtReadPreview(
		normalized,
			{ offset: opts.offset, limit: opts.limit, lineNumbers: opts.lineNumbers ?? lineNumbersEnabled(), maxChars: opts.maxChars, sessionKey: opts.sessionKey, cwd }, // issue #66/B5: lineNumbers never reached the renderer; maxChars is the ADR-0013 budget; #223: sessionKey is what lets the renderer mint through the one entry point
			undefined, // LAZY (#169): the renderer fetches the view and allocates the window itself; a provided precomputed array means REAL hashes (write shadow) and is never re-allocated
		absolutePath,
	);
  return {
    text: r.text,
    // LAZY (#169): the PATCHED window anchors — the tool layer rebuilds the model
    // text from this array, so it must be the one allocation wrote into.
    hashes: r.hashes,
    served: r.served,
    absolutePath,
    truncation: r.truncation,
    nextOffset: r.nextOffset,
    shownEnd: r.shownEnd,
    hadUtf8DecodeErrors,
    bom,
    originalEnding,
    normalized,
  };
}
