/**
 * The manual `format` transaction (map #275 / G1 contract): read the file,
 * ask its language server to format it — the whole document, or a range whose
 * two bounds are served anchors — and land the result as ONE undo-able write.
 *
 * The discipline is `edit`'s, not the auto pass's:
 *
 * - A manual call is EXPLICIT, so a missing server or formatter is an ERROR
 *   (`[E_LSP_NO_SERVER]` / `[E_FORMAT_UNSUPPORTED]`), never the auto pass's
 *   polite silence.
 * - The server may cold-start (`waitForSession`, 15 s) and the request
 *   budget is the manual 10 s, not the auto pass's 2 s.
 * - One undo entry covers the whole call; a failed write pops it back.
 * - A manual format NEVER triggers the auto diagnostics push (G1).
 * - Changed rows earn anchors only through provenance: a final row is
 *   eligible when the pre-call lines it descends from were served (canon
 *   hashes — a pure re-indent legitimately keeps the old anchor's identity).
 *   Eligible rows are minted AND served, so the model's next edit against
 *   the rows it just watched change does not stale.
 *
 * @module dsh-hashline-edittool/domain/format/manual-format
 */
import { pathToFileURL } from "node:url";
import { languageForPath } from "../../ast/language.js";
import { getLspManager, LspManager } from "../../lsp/manager.js";
import { E_LSP_NO_SERVER } from "../../lsp/provider.js";
import {
	applyTextEdits,
	detectFormattingCapability,
	E_FORMAT_UNSUPPORTED,
	FormatUnsupportedError,
	requestFormatting,
	requestRangeFormatting,
	resolveIndentOptions,
} from "../../lsp/format/index.js";
import { notifyDocumentWritten, syncDocumentContent } from "../../lsp/sync.js";
import { restoreEndings } from "../../render/edit-diff.js";
import { anchorRefOf } from "../../hashline/declaration.js";
import { lineHashesPure } from "../../hashline/hash-assign.js";
import { splitLines } from "../../infra/utils.js";
import { formatFallbackFullFile, isEditorconfigEnabled } from "../../infra/settings.js";
import { normFromText } from "../session/file-view.js";
import { loadServed } from "../session/served.js";
import { recordServedTruncated } from "../session/session-view.js";
import { saveUndo } from "../edit/undo-edit.js";
import { verifyServedRange } from "../../hashline/anchor-pipeline.js";
import { buildServedRowsFromDiff } from "../edit/served-rows.js";
import { buildFormatSection, formatterChangedLines } from "./format-section.js";
import { lineMapFromTextEdits } from "./provenance.js";
import type { FormatMode, FormatSection } from "./types.js";
import type { FileIO } from "../../infra/fs-bridge.js";

/** The manual request budget (G1): ten seconds, distinct from the auto 2 s. */
export const MANUAL_FORMAT_TIMEOUT_MS = 10_000;

export interface ManualFormatInput {
	io: FileIO;
	absolutePath: string;
	displayPath: string;
	cwd: string;
	sessionKey: string;
	signal?: AbortSignal;
	/** The calling execution — the write's observation policy needs it. */
	exec: Parameters<FileIO["writeText"]>[3];
	sandboxPolicy: Parameters<FileIO["writeText"]>[4];
	/**
	 * Raw bound references (`anchor` or `<line>:<anchor>`), resolved and
	 * served-verified here against the file as read. Omit for the whole file.
	 */
	range?: { startRef: string; endRef: string };
}

export interface ManualFormatOutcome {
	status: "formatted" | "noop";
	server: string;
	mode: FormatMode;
	/** Ranges requested (1); 0 on a noop, per the ticket's output contract. */
	requested: number;
	/** TextEdits applied; 0 on a noop. */
	applied: number;
	section: FormatSection;
	/** Normalized (LF, BOM-less) content before the format. */
	modelContent: string;
	/** Normalized content after (=== `modelContent` on noop). */
	finalContent: string;
	/** The disk form written (BOM + endings restored); unchanged on noop. */
	diskContent: string;
	changedLines: number;
}

/**
 * Resolve one bound reference to a line. An exact anchor must name exactly
 * one line unless a `<line>:<anchor>` hint disambiguates it.
 */
function resolveBound(
	ref: string,
	fileHashes: readonly string[],
	label: string,
): { line: number; anchor: string } {

	const { anchor, hint } = anchorRefOf(ref);
	const matches: number[] = [];
	fileHashes.forEach((hash, index) => {
		if (hash === anchor) matches.push(index + 1);
	});
	if (matches.length === 0) {
		throw new Error(
			`[E_RANGE_UNVERIFIED] the anchor "${anchor}" for format's ${label} was never served in this session (or its line changed). ` +
				`Re-read for fresh anchors.`,
		);
	}
	if (matches.length > 1 && (hint === undefined || !matches.includes(hint))) {
		throw new Error(
			`[E_RANGE_UNVERIFIED] the anchor "${anchor}" is live on several lines (${matches.join(", ")}) — ` +
				`pass it as <line>:<anchor>.`,
		);
	}
	return { line: hint !== undefined && matches.includes(hint) ? hint : matches[0]!, anchor };
}

/**
 * Run the manual format for one file. Throws on every refusal (no server, no
 * formatter, unserved bounds, a failed write) — the tool layer surfaces them
 * through the standard error result.
 */
export async function runManualFormat(input: ManualFormatInput): Promise<ManualFormatOutcome> {
	const language = languageForPath(input.absolutePath);
	if (language === undefined) {
		throw new Error(
			`${E_LSP_NO_SERVER} no language is registered for ${input.displayPath}, so no server can format it.`,
		);
	}
	const manager = getLspManager();
	if (manager === undefined) {
		throw new Error(`${E_LSP_NO_SERVER} the language-server client is not enabled in this deployment.`);
	}
	// Read BEFORE the server wait: an unreadable file must fail fast, and the
	// format is defined against the text on disk, not the server's (possibly
	// stale) document.
	const { text: rawText } = await input.io.readTextTolerant(input.absolutePath, input.signal);
	const { normalized, bom, originalEnding, fileHashes } = await normFromText({
		absolutePath: input.absolutePath,
		rawText,
		displayPath: input.displayPath,
		signal: input.signal,
	});
	const modelLines = splitLines(normalized);
	const served = await loadServed(input.sessionKey, input.absolutePath);

	// Verify the range against the file AS READ, before paying for a possible
	// cold start — a dead anchor must not cost the model fifteen seconds.
	let range: { startLine: number; endLine: number } | undefined;
	if (input.range !== undefined) {
		const start = resolveBound(input.range.startRef, fileHashes, "range.start");
		const end = resolveBound(input.range.endRef, fileHashes, "range.end");
		verifyServedRange({
			served,
			startAnchor: start.anchor,
			endAnchor: end.anchor,
			startLine: start.line,
			endLine: end.line,
			fileAnchors: fileHashes,
			fileLines: modelLines,
			filePath: input.displayPath,
			statePath: input.absolutePath,
			content: normalized,
		});
		range = { startLine: start.line, endLine: end.line };
	}

	// G1: a manual call may cold-start the server.
	const session = await manager.waitForSession(language.id, input.cwd, LspManager.START_TIMEOUT_MS);
	if (session === undefined) {
		const why = manager.unavailability(language.id);
		throw new Error(
			`${E_LSP_NO_SERVER} no server is usable for ${language.id}: ${why?.message ?? "it did not start in time"}. ` +
				`Install one, or name it under hashline.lsp.servers.`,
		);
	}
	const capability = detectFormattingCapability(session.serverCapabilities);
	if (!capability.full) {
		throw new FormatUnsupportedError(language.id);
	}
	// #315: an explicit range call is a CONTRACT — if the server cannot serve
	// it, the fallback switch decides between whole-file and a refusal. There
	// is no silent degradation: the model asked for exactly this range.
	if (range !== undefined && !capability.range && !formatFallbackFullFile()) {
		throw new Error(
			`${E_FORMAT_UNSUPPORTED} ${language.id} advertises no range formatting provider, and format.fallback_full_file is false. ` +
			`Enable it to fall back to whole-file formatting, or call format without the range bounds.`,
		);
	}
	let server = language.id;
	try {
		const row = (await manager.status([language.id]))[0];
		if (row?.server?.displayName !== undefined) server = row.server.displayName;
	} catch {
		// The header's name is cosmetic; the language id reads fine.
	}

	const options = await resolveIndentOptions(
		input.io,
		input.absolutePath,
		normalized,
		isEditorconfigEnabled(),
	);
	const uri = pathToFileURL(input.absolutePath).href;
	// The server's document may lag the disk — sync before asking, exactly as
	// the auto pass does.
	syncDocumentContent(input.absolutePath, normalized);

	// The pass works in the read line space (LF, BOM-less); the disk form is
	// restored once, at the write.
	const LF_SHAPE = { bom: "", eol: "\n" } as const;
	let mode: FormatMode = "full-file";
	let applied = 0;
	let finalContent = normalized;
	let lineage: ReadonlyMap<number, ReadonlySet<number>> = new Map();

	const askRange =
		range !== undefined && capability.range
			? async (): Promise<boolean> => {
					try {
						const edits = await requestRangeFormatting(
							session,
							uri,
							{
								start: { line: range!.startLine - 1, character: 0 },
								end: {
									line: range!.endLine - 1,
									character: modelLines[range!.endLine - 1]?.length ?? 0,
								},
							},
							options,
							MANUAL_FORMAT_TIMEOUT_MS,
						);
						applied = edits.length;
						finalContent = applyTextEdits(normalized, edits, LF_SHAPE);
						lineage = lineMapFromTextEdits(modelLines.length, edits);
						mode = "range";
						return true;
					} catch (error) {
						// -32601 on the range request: the capability table said range
						// but the server lied. #315: the fallback switch decides — off
						// means the call FAILS (never a silent whole-file).
						if (!(error instanceof FormatUnsupportedError)) throw error;
						if (!formatFallbackFullFile()) {
							throw new Error(
								`${E_FORMAT_UNSUPPORTED} ${language.id} refused the range formatting request (-32601), and format.fallback_full_file is false. ` +
								`Enable it to fall back to whole-file formatting, or call format without the range bounds.`,
							);
						}
						return false;
					}
				}
			: async (): Promise<boolean> => false;

	if (!(await askRange())) {
		mode = "full-file";
		const edits = await requestFormatting(session, uri, options, MANUAL_FORMAT_TIMEOUT_MS);
		applied = edits.length;
		finalContent = applyTextEdits(normalized, edits, LF_SHAPE);
		lineage = lineMapFromTextEdits(modelLines.length, edits);
	}

	if (finalContent === normalized) {
		return {
			status: "noop",
			server,
			mode,
			requested: 0,
			applied: 0,
			section: {
				status: "noop",
				server,
				mode,
				requested: 0,
				applied: 0,
				changedLines: 0,
				unservedRows: 0,
				rows: [],
			},
			modelContent: normalized,
			finalContent: normalized,
			diskContent: rawText,
			changedLines: 0,
		};
	}

	// ---- the write transaction: one undo entry covers the whole call ----
	const finalLines = splitLines(finalContent);
	// The manual `format` tool is the model's MAIN output: every changed row is
	// answered with an anchor — served before this call or not (user ruling on
	// the #275 follow-up). No gate: buildServedRowsFromDiff mints the diff
	// window through the SAME workspace path edit uses (unchanged lines reuse
	// their standing anchors by construction) and writes anchors back into
	// finalHashes, so every section row is editable.
	const changed = formatterChangedLines(modelLines, finalLines, lineage);
	const finalHashes = lineHashesPure(finalContent);
	const servedRows = await buildServedRowsFromDiff({
		before: normalized,
		after: finalContent,
		resultHashes: finalHashes,
		absolutePath: input.absolutePath,
		cwd: input.cwd,
		sessionKey: input.sessionKey,
	});
	// A manual format answers for the whole file: every row is served, so the
	// section never renders a hash-less row.
	const eligibility = new Map<number, boolean>();
	for (let line = 1; line <= finalLines.length; line++) eligibility.set(line, true);

	const section = buildFormatSection({
		status: "formatted",
		server,
		mode,
		requested: 1,
		applied,
		finalLines,
		finalHashes,
		changed,
		eligibility,
		// A manual format has no separate main diff — the section IS the diff.
		alsoInMain: new Set<number>(),
	});

	const diskContent = bom + restoreEndings(finalContent, originalEnding);
	const undo = await saveUndo(input.absolutePath, {
		content: normalized,
		bom,
		originalEnding,
		hashes: fileHashes,
		resultContent: finalContent,
	});
	try {
		await input.io.writeText(input.absolutePath, diskContent, input.signal, input.exec, input.sandboxPolicy);
	} catch (error) {
		// The write never happened — the undo entry must not shadow a real one.
		await undo.restore();
		throw error;
	}
	notifyDocumentWritten(input.absolutePath, diskContent);
	// G1: a manual format never triggers the auto diagnostics push.
	if (servedRows.length > 0) {
		await recordServedTruncated(
			input.sessionKey,
			input.absolutePath,
			servedRows,
			finalLines.length,
		);
	}

	return {
		status: "formatted",
		server,
		mode,
		requested: 1,
		applied,
		section,
		modelContent: normalized,
		finalContent,
		diskContent,
		changedLines: changed.size,
	};
}
