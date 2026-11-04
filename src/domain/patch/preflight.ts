/**
 * Preflight — everything a patch must prove BEFORE a byte is written.
 *
 * The contract is all-or-nothing, and it is genuinely all: every operation is
 * checked, every failure is collected, and only a patch with no refusal reaches
 * the commit phase. That is why this module resolves the real work (the
 * per-file edit results the commit will write, the probes the deletes will
 * re-check) instead of merely validating: a second resolution at commit time
 * would be a second opinion, and the two opinions are exactly where a
 * half-applied patch comes from.
 *
 * Refusals are values, not throws: the caller aggregates them into ONE error
 * (`[E_PATCH_REFUSED] Patch rejected before any change (N problems)`), which is
 * the only shape that tells the model the whole patch was seen.
 *
 * @module dsh-hashline-edittool/patch/preflight
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { FileIO, FileProbe } from "../../infra/fs-bridge.js";
import { encodeText } from "../../hashline/anchor-pipeline.js";
import {
	runFileEdits,
	type FileEditResult,
	type PreparedItem,
} from "../edit/edit-engine.js";
import {
	operationsFromSections,
	type PatchOperation,
	type PatchOperationKind,
} from "./plan.js";
import type { PatchSection } from "./types.js";

/** One operation that passed every check, with the work commit will perform. */
export interface PreparedAdd {
	kind: "add";
	operation: PatchOperation;
	absolutePath: string;
	/** The section's whole content, LF-terminated per line. */
	content: string;
}

export interface PreparedUpdate {
	kind: "update";
	operation: PatchOperation;
	absolutePath: string;
	/** The resolved, not-yet-written edit result (diff, anchors, undo snapshot). */
	file: FileEditResult;
}

export interface PreparedDelete {
	kind: "delete";
	operation: PatchOperation;
	absolutePath: string;
	probe: FileProbe;
	/** The file's text at preflight, for the card's removed-file diff. */
	before: string;
}

export interface PreparedMove {
	kind: "move";
	operation: PatchOperation;
	absolutePath: string;
	destinationPath: string;
	probe: FileProbe;
	/** Present only for a move that also edits; a pure move has no hunks. */
	file?: FileEditResult;
}

export type PreparedOperation =
	| PreparedAdd
	| PreparedUpdate
	| PreparedDelete
	| PreparedMove;

/**
 * One reason the patch was refused, addressed the way the caller reports it:
 * `operation N (kind path, patch line L): [CODE] message`.
 */
export interface PatchRefusal {
	operation: PatchOperation;
	/** The hunk's input line, when the refusal is about one hunk. */
	hunkLine?: number;
	/** A bare code — no brackets; the composer adds them. */
	code: string;
	/** The message body, without its code marker. */
	message: string;
}

/** Preflight's whole answer: what may run, and what stopped it. */
export interface PatchPreflight {
	operations: PatchOperation[];
	prepared: PreparedOperation[];
	refusals: PatchRefusal[];
}

/** Everything preflight needs from the call. */
export interface PatchPreflightInput {
	sections: readonly PatchSection[];
	io: FileIO;
	cwd: string;
	sessionKey: string;
	exec: ToolExecution;
	lineNumbers: boolean;
	signal?: AbortSignal;
}

const CODE_MARKER = /\[(E_[A-Z0-9_]+)\]/;
const HUNK_INDEX = /edits?\[(\d+)\]/;

/**
 * Split a thrown domain error into the refusal's code and message.
 *
 * Anything without a marker is a bug, not a refusal — the caller re-throws it
 * rather than inventing a code, because a refusal the model cannot act on is
 * worse than a crash that reaches the log.
 */
function refusalCodeOf(error: unknown): { code: string; message: string } | undefined {
	const message = error instanceof Error ? error.message : String(error);
	// The engine wraps a per-item failure in a batch abort, and the batch code
	// says nothing the model can act on: `[E_BATCH_ABORT] … failed:
	// [E_RANGE_UNVERIFIED] …` is an anchor problem wearing a container's name.
	// The FIRST specific code wins, and the message is re-sliced after it so the
	// refusal line never quotes a code the line does not lead with.
	const markers = [...message.matchAll(/\[(E_[A-Z0-9_]+)\]/g)];
	const chosen =
		markers.find((match) => match[1] !== "E_BATCH_ABORT") ?? markers[0];
	if (chosen === undefined) return undefined;
	const start = (chosen.index ?? 0) + chosen[0].length;
	return {
		code: chosen[1]!,
		message: message.slice(start).replace(/^ /, ""),
	};
}

/**
 * Turn one thrown engine/probe error into a refusal for this operation.
 *
 * The engine names the offending item as `edits[K]`; translating that back to
 * the hunk's own input line is what lets the model find the header in the text
 * it just sent.
 */
function refusalFrom(
	operation: PatchOperation,
	error: unknown,
): PatchRefusal | undefined {
	const parts = refusalCodeOf(error);
	if (parts === undefined) return undefined;
	const raw = error instanceof Error ? error.message : String(error);
	const hunkIndex = HUNK_INDEX.exec(raw);
	const hunk =
		hunkIndex === null ? undefined : operation.section.hunks[Number(hunkIndex[1])];
	return {
		operation,
		...(hunk !== undefined ? { hunkLine: hunk.lineNumber } : {}),
		code: parts.code,
		message: parts.message,
	};
}

/** A refusal this module constructs itself. */
function selfRefusal(
	operation: PatchOperation,
	code: string,
	message: string,
	hunkLine?: number,
): PatchRefusal {
	return {
		operation,
		...(hunkLine !== undefined ? { hunkLine } : {}),
		code,
		message,
	};
}

/**
 * The probe's type, as a refusal — `undefined` when the shape is the one this
 * operation needs.
 *
 * The vocabulary is the delete/rename tools': a symlink is refused rather than
 * followed (`E_SYMLINK`), a directory is not a file (`E_NOT_FILE`), and a path
 * the patch expects to exist but does not is `E_NOT_FOUND`. A patch never
 * writes THROUGH a symlink, because the anchors belong to the link's text
 * while the bytes live somewhere else.
 */
function probeFailure(
	probe: FileProbe,
	path: string,
	want: "file" | "absent" | "directory",
): { code: string; message: string } | undefined {
	if (want === "absent") {
		if (probe.kind === "absent") return undefined;
		if (probe.kind === "file") {
			return { code: "E_EXISTS", message: `Path already exists: ${path}` };
		}
		return { code: "E_EXISTS", message: `Path already exists (${probe.kind}): ${path}` };
	}
	if (want === "directory") {
		if (probe.kind === "directory") return undefined;
		if (probe.kind === "absent") {
			return { code: "E_NOT_FOUND", message: `Parent directory does not exist: ${path}` };
		}
		return { code: "E_NOT_FILE", message: `Parent is not a directory: ${path}` };
	}
	if (probe.kind === "file") return undefined;
	if (probe.kind === "absent") {
		return { code: "E_NOT_FOUND", message: `File not found: ${path}` };
	}
	if (probe.kind === "symlink") {
		return {
			code: "E_SYMLINK",
			message: `${path} is a symbolic link; a patch addresses regular files, and following the link would edit a different path than the one you named.`,
		};
	}
	if (probe.kind === "directory") {
		return { code: "E_NOT_FILE", message: `Path is a directory: ${path}` };
	}
	return { code: "E_NOT_FILE", message: `Path is not a regular file: ${path}` };
}

/** The directory a path lives in, for the `new` section's parent check. */
function parentOf(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return at <= 0 ? trimmed.slice(0, at + 1) : trimmed.slice(0, at);
}

/**
 * One section's hunks as the engine's items.
 *
 * `insert` maps to `op: "ins"` (its anchor line is kept, the content lands
 * below it), `delete` to `op: "del"`, and `replace` to `op: "replace"` — the
 * three semantics `edit` already implements, reached through the same engine so
 * anchors, conflicts, drift, served migration and undo behave identically.
 */
function itemsFor(operation: PatchOperation, absolutePath: string): PreparedItem[] {
	return operation.section.hunks.map((hunk, index) => ({
		index,
		path: operation.path,
		absolutePath,
		remove_from: hunk.anchorStart,
		remove_to: hunk.anchorEnd ?? hunk.anchorStart,
		replacement_text:
			hunk.kind === "delete" ? "" : encodeText(hunk.lines),
		op: hunk.kind === "insert" ? "ins" : hunk.kind === "delete" ? "del" : "replace",
	}));
}

/**
 * Resolve every operation against reality.
 *
 * @param input - the parsed sections plus the call's IO/session context.
 * @returns the prepared operations commit will run, and every refusal found.
 */
export async function preflightPatch(
	input: PatchPreflightInput,
): Promise<PatchPreflight> {
	const { sections, io, cwd, sessionKey, exec, lineNumbers, signal } = input;
	const operations = operationsFromSections(sections);
	const prepared: PreparedOperation[] = [];
	const refusals: PatchRefusal[] = [];

	// Resolved paths first: the duplicate rule is about FILES, not about
	// spelling, so two spellings of one path must collide here.
	const resolved = new Map<number, string>();
	const claimed = new Map<string, PatchOperation>();

	for (const operation of operations) {
		try {
			const absolutePath = await io.resolve(operation.path, cwd, signal);
			resolved.set(operation.index, absolutePath);
		} catch (error) {
			const refusal = refusalFrom(operation, error);
			if (refusal === undefined) throw error;
			refusals.push(refusal);
			continue;
		}
		const absolutePath = resolved.get(operation.index)!;
		const previous = claimed.get(absolutePath);
		if (previous !== undefined) {
			refusals.push(
				selfRefusal(
					operation,
					"E_BAD_SHAPE",
					`${operation.path} already appears in this patch (operation ${previous.index + 1}, patch line ${previous.line}); one section per path, and a second one is refused rather than merged.`,
				),
			);
			continue;
		}
		claimed.set(absolutePath, operation);
		// A move's destination is a path this patch writes too, so it collides with
		// any OTHER section that names it — `move a -> b` beside `new b` is two
		// writes to one file, not a chain. The check is symmetric on purpose: a
		// destination claimed by an EARLIER section refuses this move, and a
		// destination claimed by a LATER one refuses that later section (its own
		// pass finds the destination already claimed). Either way exactly one
		// refusal, whichever section the model wrote first — an order-dependent
		// answer would let one spelling reach the commit phase and the other not.
		if (operation.destination !== undefined) {
			try {
				const destinationPath = await io.resolve(operation.destination, cwd, signal);
				const owner = claimed.get(destinationPath);
				if (owner !== undefined && owner !== operation) {
					refusals.push(
						selfRefusal(
							operation,
							"E_BAD_SHAPE",
							`${operation.destination} is written twice in this patch (also by operation ${owner.index + 1}, patch line ${owner.line}); a change set writes each path once.`,
						),
					);
				} else if (owner === undefined) {
					claimed.set(destinationPath, operation);
				}
			} catch {
				// The destination is resolved again by `prepareOne`, which owns its
				// refusal — a resolution failure here must not change the answer.
			}
		}
	}

	for (const operation of operations) {
		const absolutePath = resolved.get(operation.index);
		if (absolutePath === undefined) continue; // already refused above
		if (refusals.some((refusal) => refusal.operation === operation)) continue;

		try {
			const result = await prepareOne(operation, absolutePath, input);
			if ("code" in result) {
				refusals.push(result);
			} else {
				prepared.push(result);
			}
		} catch (error) {
			const refusal = refusalFrom(operation, error);
			if (refusal === undefined) throw error;
			refusals.push(refusal);
		}
	}

	return { operations, prepared, refusals };
}

/**
 * Prepare one operation, or explain why it cannot run.
 *
 * A refusal is returned, an unexpected error is thrown — the caller keeps the
 * two apart because only the first is the model's to fix.
 */
async function prepareOne(
	operation: PatchOperation,
	absolutePath: string,
	input: PatchPreflightInput,
): Promise<PreparedOperation | PatchRefusal> {
	const { io, cwd, sessionKey, exec, lineNumbers, signal } = input;
	const kind: PatchOperationKind = operation.kind;
	const section = operation.section;

	if (kind === "add") {
		const existing = await io.probeFile(operation.path, cwd, signal);
		const existsFailure = probeFailure(existing, operation.path, "absent");
		if (existsFailure !== undefined) return selfRefusal(operation, existsFailure.code, existsFailure.message);
		const parent = await io.probeFile(parentOf(absolutePath), cwd, signal);
		const parentFailure = probeFailure(parent, parentOf(operation.path), "directory");
		if (parentFailure !== undefined) return selfRefusal(operation, parentFailure.code, parentFailure.message);
		return {
			kind: "add",
			operation,
			absolutePath,
			content: section.content ?? "",
		};
	}

	if (kind === "delete") {
		const probe = await io.probeFile(operation.path, cwd, signal);
		const failure = probeFailure(probe, operation.path, "file");
		if (failure !== undefined) return selfRefusal(operation, failure.code, failure.message);
		let before = "";
		try {
			before = (await io.readTextTolerant(absolutePath, signal)).text;
		} catch {
			// The card loses its removed-file preview; the delete itself still
			// works, and preflight has no business refusing over a preview.
		}
		return { kind: "delete", operation, absolutePath, probe, before };
	}

	if (kind === "move") {
		const probe = await io.probeFile(operation.path, cwd, signal);
		const sourceFailure = probeFailure(probe, operation.path, "file");
		if (sourceFailure !== undefined) return selfRefusal(operation, sourceFailure.code, sourceFailure.message);
		const destination = section.destination;
		if (destination === undefined || destination === "") {
			return selfRefusal(
				operation,
				"E_BAD_SHAPE",
				`move section for ${operation.path} has no destination.`,
			);
		}
		const destinationPath = await io.resolve(destination, cwd, signal);
		const destinationProbe = await io.probeFile(destination, cwd, signal);
		const destinationFailure = probeFailure(destinationProbe, destination, "absent");
		if (destinationFailure !== undefined) {
			return selfRefusal(operation, destinationFailure.code, destinationFailure.message);
		}
		const parentProbe = await io.probeFile(parentOf(destinationPath), cwd, signal);
		const parentFailure = probeFailure(parentProbe, parentOf(destination), "directory");
		if (parentFailure !== undefined) return selfRefusal(operation, parentFailure.code, parentFailure.message);
		if (section.hunks.length === 0) {
			return { kind: "move", operation, absolutePath, destinationPath, probe };
		}
		const file = await runFileEdits(io, itemsFor(operation, absolutePath), {
			signal,
			sessionKey,
			lineNumbers,
			exec,
			cwd,
		});
		return { kind: "move", operation, absolutePath, destinationPath, probe, file };
	}

	// `file` — an update.
	const probe = await io.probeFile(operation.path, cwd, signal);
	const failure = probeFailure(probe, operation.path, "file");
	if (failure !== undefined) return selfRefusal(operation, failure.code, failure.message);
	if (section.hunks.length === 0) {
		return selfRefusal(
			operation,
			"E_BAD_SHAPE",
			`file section for ${operation.path} has no hunks; a section that changes nothing is refused rather than ignored.`,
		);
	}
	const file = await runFileEdits(io, itemsFor(operation, absolutePath), {
		signal,
		sessionKey,
		lineNumbers,
		exec,
		cwd,
	});
	return { kind: "update", operation, absolutePath, file };
}
