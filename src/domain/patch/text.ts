/**
 * The patch's model-facing text.
 *
 * Three sentences, and every one of them is a CONTRACT the model plans its
 * next call from: a success says which files changed and in which direction,
 * a stopped commit says exactly where it stopped and what never ran, and a
 * refusal says every problem at once — because a patch that reports one
 * problem at a time makes the model fix them one call at a time, and the whole
 * point of preflighting is that one call is enough.
 *
 * Anchors arrive through the diff groups, not through these sentences: the
 * sentences are the summary, the diff is the addressable payload.
 *
 * @module dsh-hashline-edittool/patch/text
 */

import { editDiffLegend } from "../edit/edit-response.js";
import type { CommittedOperation } from "./commit.js";
import type { PatchOperation } from "./plan.js";
import type { PatchRefusal } from "./preflight.js";

/** `A src/hello.ts` · `M src/old.ts -> src/new.ts` · `D src/dead.ts`. */
export function changeLine(operation: CommittedOperation): string {
	const letter =
		operation.kind === "add" ? "A" : operation.kind === "delete" ? "D" : "M";
	if (operation.kind === "move" && operation.destination !== undefined) {
		return `${letter} ${operation.path} -> ${operation.destination}`;
	}
	return `${letter} ${operation.path}`;
}

/** The `Completed:` block's lines, in patch order. */
function completedLines(operations: readonly CommittedOperation[]): string[] {
	return operations
		.filter((operation) => operation.status === "completed")
		.map(changeLine);
}

/** One stopped-commit detail line, addressed the way the refusal lines are. */
function failureLine(operation: CommittedOperation): string {
	const address = `operation ${operation.index + 1} (${operation.kind} ${operation.path}${operation.destination !== undefined ? ` -> ${operation.destination}` : ""
		}`;
	const code = operation.code !== undefined ? `[${operation.code}] ` : "";
	const message = operation.message ?? "the operation failed.";
	return `- ${address}): ${code}${message}`;
}

/** The `Not executed:` block's lines. */
function skippedLines(operations: readonly CommittedOperation[]): string[] {
	return operations
		.filter((operation) => operation.status === "skipped")
		.map(
			(operation) =>
				`- operation ${operation.index + 1} (${operation.kind} ${operation.path})`,
		);
}

/**
 * The diff payload appended to any text that has anchors to hand back.
 *
 * @param groups - the rendered per-file groups, in operation order.
 * @param lineNumbers - whether the user's line-number switch is on.
 * @returns the legend plus the groups, or `""` when nothing changed.
 */
export function diffPayload(
	groups: readonly { path: string; text: string }[],
	lineNumbers: boolean,
): string {
	if (groups.length === 0) return "";
	const legend = editDiffLegend(lineNumbers);
	return `${legend}\n${groups.map((group) => group.text).join("\n\n")}`;
}

/**
 * The success text: the change-set summary, then the anchors.
 *
 * @param operations - every operation, all completed.
 * @param lineNumbers - whether the user's line-number switch is on.
 * @param groups - the rendered diff groups.
 * @returns the model-facing text.
 */
export function successText(
	operations: readonly CommittedOperation[],
	lineNumbers: boolean,
	groups: readonly { path: string; text: string }[],
): string {
	const lines = completedLines(operations);
	const head =
		lines.length === 0
			? "Success. No operations in patch."
			: `Success. Updated the following files:\n${lines.join("\n")}`;
	const payload = diffPayload(groups, lineNumbers);
	return payload === "" ? head : `${head}\n\n${payload}`;
}

/**
 * The stopped-commit text: what completed, what failed, what never ran.
 *
 * A stopped commit is NOT an error value — the completed work is real, and
 * reporting it truthfully is what lets the model continue instead of retrying
 * the whole patch.
 *
 * @param operations - every operation, with settled statuses.
 * @param lineNumbers - whether the user's line-number switch is on.
 * @param groups - the rendered diff groups of the completed operations.
 * @returns the model-facing text.
 */
export function stoppedText(
	operations: readonly CommittedOperation[],
	lineNumbers: boolean,
	groups: readonly { path: string; text: string }[],
): string {
	const completed = completedLines(operations);
	const failed = operations
		.filter((operation) => operation.status === "failed" || operation.status === "unknown")
		.map(failureLine);
	const skipped = skippedLines(operations);
	const sections = [
		`Patch stopped after ${completed.length} of ${operations.length} operations.`,
	];
	if (completed.length > 0) {
		sections.push(`Completed:\n${completed.join("\n")}`);
	}
	if (failed.length > 0) {
		sections.push(`Failed:\n${failed.join("\n")}`);
	}
	if (skipped.length > 0) {
		sections.push(`Not executed:\n${skipped.join("\n")}`);
	}
	const payload = diffPayload(groups, lineNumbers);
	if (payload !== "") sections.push(payload);
	return sections.join("\n\n");
}

/** How many refusal lines the error text lists before summarizing the rest. */
export const REFUSAL_LIMIT = 10;

/** How many indented detail lines one refusal may carry. */
export const REFUSAL_DETAIL_LIMIT = 10;

/** The address a refusal line leads with. */
function refusalAddress(operation: PatchOperation, hunkLine?: number): string {
	const line = hunkLine ?? operation.line;
	const target =
		operation.destination !== undefined
			? `${operation.path} -> ${operation.destination}`
			: operation.path;
	return `operation ${operation.index + 1} (${operation.kind} ${target}, patch line ${line})`;
}

/**
 * One problem, as the lines it needs: its own line, then the engine's detail
 * indented beneath it.
 *
 * The detail is a rejection echo (the fresh rows for a stale anchor), so it
 * is load-bearing — dropping it would make reject-and-serve impossible. It is
 * capped per problem so ten problems cannot bury the list that names them,
 * and the FIRST lines survive the cap: a stale-anchor echo puts the markers and
 * the `reuse the fresh marker` hint at its head.
 *
 * @param refusal - one collected refusal.
 * @returns the refusal's lines, ready to join.
 */
function refusalLines(refusal: PatchRefusal): string[] {
	const [first, ...detail] = refusal.message.split("\n");
	const head = `- ${refusalAddress(refusal.operation, refusal.hunkLine)}: [${refusal.code}] ${(first ?? "").trimEnd()}`;
	const kept = detail
		.filter((line) => line.trim() !== "")
		.slice(0, REFUSAL_DETAIL_LIMIT)
		.map((line) => `    ${line}`);
	const dropped = detail.filter((line) => line.trim() !== "").length - kept.length;
	if (dropped > 0) kept.push(`    … (${dropped} more line${dropped === 1 ? "" : "s"})`);
	return [head, ...kept];
}

/**
 * The whole-patch refusal: one entry per problem, in PATCH order, truncated
 * after {@link REFUSAL_LIMIT} with an `and N more` tail.
 *
 * Ordering is not cosmetic: the model reads this list against the text it
 * just sent, and a list that starts at operation 2 sends it to the wrong
 * section. Preflight discovers refusals in two passes (path collisions, then
 * per-operation checks), so the sort is what restores the caller's order.
 *
 * @param refusals - every refusal preflight collected.
 * @returns the body of the `[E_PATCH_REFUSED]` error (the composer adds the head).
 */
export function refusalBody(refusals: readonly PatchRefusal[]): string {
	const ordered = [...refusals].sort(
		(left, right) => left.operation.index - right.operation.index,
	);
	const visible = ordered.slice(0, REFUSAL_LIMIT);
	const lines = visible.flatMap(refusalLines);
	const rest = ordered.length - visible.length;
	if (rest > 0) lines.push(`- and ${rest} more`);
	return lines.join("\n");
}

/**
 * The one-line head of a refusal: the count, so the model knows the list is
 * complete.
 *
 * @param count - how many problems preflight found.
 * @returns the head sentence, without the leading code marker.
 */
export function refusalHead(count: number): string {
	return `Patch rejected before any change (${count} problem${count === 1 ? "" : "s"}):`;
}
