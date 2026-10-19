/**
 * The automatic format pass: one file, one ready server, one budget.
 *
 * G3's boundary as a single function the edit engine and the write shadow
 * both call:
 *
 * - The switch is off, there is no READY server, or the server has no
 *   formatter → the pass never attempts (silent). `attempted: false` is the
 *   caller's "render nothing, warn nothing" signal — an edit must never
 *   spawn a language server just to format (G3: auto only `readySessionFor`).
 * - The formatter answers and the text is already conformant → `noop` (also
 *   silent: a no-op format is not an event worth a section).
 * - The attempt itself fails (timeout, closed session, malformed edits) →
 *   `skipped` + a reason. The caller keeps the model's content and surfaces
 *   the reason as a warning / a skipped section.
 *
 * The 2000 ms budget is a CONSTANT on purpose (G3: fixed, not configurable —
 * a format that needs tuning is a server problem, not a user preference).
 *
 * @module dsh-hashline-edittool/domain/format/auto-format
 */
import { pathToFileURL } from "node:url";
import { languageForPath } from "../../ast/language.js";
import { getLspManager } from "../../lsp/manager.js";
import { syncDocumentContent } from "../../lsp/sync.js";
import {
	applyTextEdits,
	detectFormattingCapability,
	requestFormatting,
	requestRangeFormatting,
	resolveIndentOptions,
	FormatUnsupportedError,
} from "../../lsp/format/index.js";
import { composeProvenance, lineMapFromTextEdits } from "./provenance.js";
import { isAutoFormatEnabled, isEditorconfigEnabled } from "../../infra/settings.js";
import type { FileIO } from "../../infra/fs-bridge.js";
import type { LineEnding } from "../../render/edit-diff.js";
import type { FormatMode } from "./types.js";
import { splitLines } from "../../infra/utils.js";

/** Per-request budget for the automatic pass (G3: fixed). */
export const AUTO_FORMAT_TIMEOUT_MS = 2_000;

/** One 1-based, inclusive model-content range the formatter is asked to cover. */
export interface AutoFormatRange {
	startLine: number;
	endLine: number;
}

export interface AutoFormatInput {
	io: FileIO;
	absolutePath: string;
	/** The post-model, pre-format content (what the server must see). */
	modelContent: string;
	/**
	 * The model's hunks in MODEL coordinates (1-based, inclusive). Non-empty
	 * asks for range formatting over them (adjacent hunks merged); empty or
	 * omitted asks for the whole document.
	 */
	ranges?: ReadonlyArray<AutoFormatRange>;
}

export interface AutoFormatOutcome {
	/** False = the pass never ran; the caller renders nothing and warns nothing. */
	readonly attempted: boolean;
	readonly status: "formatted" | "noop" | "skipped";
	/** The formatted text — `modelContent` unchanged unless status is `formatted`. */
	readonly content: string;
	/**
	 * Final line → the MODEL lines it descends from (1-based), composed across
	 * every range round. The engine feeds this to the provenance/eligibility
	 * walk; raw TextEdits are useless for it — each round's edits live in the
	 * coordinate space of the round BEFORE it.
	 */
	readonly finalToModel?: ReadonlyMap<number, ReadonlySet<number>>;
	readonly mode?: FormatMode;
	/** Ranges requested (merged hunks; 1 for a whole-file pass). */
	readonly requested?: number;
	/** TextEdits the server returned and were applied. */
	readonly applied?: number;
	readonly server?: string;
	/** Why the attempt failed (status `skipped` only). */
	readonly reason?: string;
}

const SILENT: AutoFormatOutcome = {
	attempted: false,
	status: "noop",
	content: "",
};

/** Merge adjacent/overlapping hunks into contiguous request ranges (G2). */
export function mergeFormatRanges(
	ranges: ReadonlyArray<AutoFormatRange>,
	lineCount: number,
): AutoFormatRange[] {
	const sorted = [...ranges]
		.map((r) => ({
			startLine: Math.min(Math.max(1, r.startLine), lineCount),
			endLine: Math.min(Math.max(1, r.endLine), lineCount),
		}))
		.filter((r) => r.startLine <= r.endLine)
		.sort((a, b) => a.startLine - b.startLine);
	const merged: AutoFormatRange[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		// "Adjacent" merges too: hunk A ends on line 5, hunk B starts on line
		// 6 — one request covers both, and a second request between them has
		// nothing untouched to hold on to.
		if (last !== undefined && r.startLine <= last.endLine + 1) {
			if (r.endLine > last.endLine) last.endLine = r.endLine;
			continue;
		}
		merged.push({ ...r });
	}
	return merged;
}

/** The skipped reason a caller can quote: one line, no stack, bounded. */
function reasonOf(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const firstLine = raw.split("\n", 1)[0] ?? raw;
	return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
}

/**
 * Run the automatic format pass for one file. Never throws: every failure is
 * classified into the outcome, because G3 made formatting non-blocking — a
 * formatter's bad day must not fail the edit that paid for it.
 */
export async function runAutoFormat(input: AutoFormatInput): Promise<AutoFormatOutcome> {
	if (!isAutoFormatEnabled()) return { ...SILENT, content: input.modelContent };
	const language = languageForPath(input.absolutePath);
	if (language === undefined) return { ...SILENT, content: input.modelContent };
	const manager = getLspManager();
	// Ready-only (G3): `readySessionFor` is synchronous and never warms. No
	// running server means "not my problem" — the next semantic call opens the
	// document with the final text anyway.
	const session = manager?.readySessionFor(language.id);
	if (manager === undefined || session === undefined) {
		return { ...SILENT, content: input.modelContent };
	}
	const capability = detectFormattingCapability(session.serverCapabilities);
	if (!capability.full) return { ...SILENT, content: input.modelContent };

	let server = language.id;
	try {
		const row = (await manager.status([language.id]))[0];
		if (row?.server?.displayName !== undefined) server = row.server.displayName;
	} catch {
		// The header's name is cosmetic; the language id reads fine.
	}

	const modelLines = splitLines(input.modelContent);
	const options = await resolveIndentOptions(
		input.io,
		input.absolutePath,
		input.modelContent,
		isEditorconfigEnabled(),
	);
	const uri = pathToFileURL(input.absolutePath).href;

	// The server's view is stale by one edit: bring it to the MODEL content
	// BEFORE asking (pre-write sync, ready servers only — G2's single-write
	// rule keeps the DISK at one write; the server's document is not the disk).
	syncDocumentContent(input.absolutePath, input.modelContent);

	// applyTextEdits restores the file's BOM/ending shape — which is exactly
	// what this pass must NOT do per round: the working text stays in the
	// read line space (LF, BOM-less), the same space `modelContent` and the
	// engine's undo/preview pipeline live in. The WRITE caller restores the
	// disk shape itself when it rewrites.
	const LF_SHAPE = { bom: "", eol: "\n" } as const;
	try {
		if (capability.range && input.ranges !== undefined && input.ranges.length > 0) {
			const merged = mergeFormatRanges(input.ranges, modelLines.length);
			if (merged.length > 0) {
				try {
					let content = input.modelContent;
					let lineDelta = 0;
					let applied = 0;
					let lineage: ReadonlyMap<number, ReadonlySet<number>> | undefined;
					for (let k = 0; k < merged.length; k++) {
						const range = merged[k]!;
						const start = range.startLine - 1 + (k === 0 ? 0 : lineDelta);
						const end = range.endLine - 1 + lineDelta;
						// clangd expands to the enclosing declaration (R1): apply
						// what CAME BACK and let the provenance walk report the
						// real span, never the requested one.
						const edits = await requestRangeFormatting(
							session,
							uri,
							{
								start: { line: start, character: 0 },
								end: { line: end, character: splitLines(content)[end]?.length ?? 0 },
							},
							options,
							AUTO_FORMAT_TIMEOUT_MS,
						);
						const before = content;
						content = applyTextEdits(content, edits, LF_SHAPE);
						applied += edits.length;
						lineDelta += splitLines(content).length - splitLines(before).length;
						// Each round's map speaks in the round's OWN coordinates; the
						// chain composes so the caller sees ONE map: final → model.
						const round = lineMapFromTextEdits(splitLines(before).length, edits);
						lineage = lineage === undefined ? round : composeProvenance(round, lineage);
						// The next request must be answered from the text this one
						// produced, or its coordinates describe a version the
						// server never saw.
						if (k < merged.length - 1) syncDocumentContent(input.absolutePath, content);
					}
					return finish(input, content, lineage ?? new Map(), "range", merged.length, applied, server);
				} catch (error) {
					// "no range formatting here" is a capability fact — fall back
					// to the whole document (G3: no warning on the fallback).
					if (!(error instanceof FormatUnsupportedError)) throw error;
				}
			}
		}
		const edits = await requestFormatting(session, uri, options, AUTO_FORMAT_TIMEOUT_MS);
		const content = applyTextEdits(input.modelContent, edits, LF_SHAPE);
		return finish(
			input,
			content,
			lineMapFromTextEdits(modelLines.length, edits),
			"full-file",
			1,
			edits.length,
			server,
		);
	} catch (error) {
		if (error instanceof FormatUnsupportedError) {
			// The capability table LIED (or raced): -32601 on the full-document
			// request is the same "no formatter" fact — silent, like R1 says.
			return { ...SILENT, content: input.modelContent };
		}
		return {
			attempted: true,
			status: "skipped",
			content: input.modelContent,
			server,
			reason: reasonOf(error),
		};
	}
}

/** The formatted outcome, or `noop` when the server changed nothing. */
function finish(
	input: AutoFormatInput,
	content: string,
	lineage: ReadonlyMap<number, ReadonlySet<number>>,
	mode: FormatMode,
	requested: number,
	applied: number,
	server: string,
): AutoFormatOutcome {
	if (content === input.modelContent) {
		return { attempted: true, status: "noop", content, server };
	}
	return {
		attempted: true,
		status: "formatted",
		content,
		finalToModel: lineage,
		mode,
		requested,
		applied,
		server,
	};
}
