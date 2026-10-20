/**
 * The ONE path a served diff row takes — minted through the workspace entry
 * point, recorded for the next call, reused when the content is unchanged.
 *
 * WHY A SEPARATE MODULE. `edit`'s engine built this inline, and the manual
 * `format` tool (#275, user ruling) needs the exact same behavior: a row the
 * model is looking at gets an anchor — a fresh one when the content is new,
 * the existing one when it is not. Inlining a copy in the format layer would
 * fork the anchor path the contract promises never forks, and importing the
 * engine from the format layer would be a dependency cycle. So the function
 * lives here, imports point one way (engine → here ← format), and "the same
 * path" is a fact about the code, not a hope about two call sites.
 *
 * @module dsh-hashline-edittool/domain/edit/served-rows
 */
import { anchorForInWorkspace } from "../session/session-view.js";
import { contextLinesCfg } from "../../hashline/hash-assign.js";
import { splitLines } from "../../infra/utils.js";

/**
 * Mint-and-serve the diff window between `before` and `after`.
 *
 * The window pads by the CONFIGURED diff context (≥2): the response's genDiff
 * renders with `contextLinesCfg()`, and a served set narrower than the
 * rendered rows would leave context rows uneditable. Every window row is
 * minted through `anchorForInWorkspace` — the workspace store reuses the
 * standing anchor of an unchanged line by construction — and the caller's
 * `resultHashes` are updated in place so a diff built after this call shows
 * the real anchors.
 *
 * @param input.eligible - when present, a window row the gate refuses is not
 *   minted, not returned, and left hash-less (the auto-format section's
 *   served-before gate; absent = every row passes, the engine's normal
 *   behavior — the manual `format` tool passes no gate on purpose).
 * @returns the served rows, `[{position, anchor}]`, 0-based positions.
 */
export async function buildServedRowsFromDiff(input: {
	before: string;
	after: string;
	resultHashes: string[];
	absolutePath: string;
	cwd: string | undefined;
	sessionKey: string;
	eligible?: (position: number) => boolean;
}): Promise<{ position: number; anchor: string }[]> {
	const { before, after, resultHashes, absolutePath, cwd, sessionKey, eligible } = input;
	const ctxPad = Math.max(2, contextLinesCfg());
	const rows: { position: number; anchor: string }[] = [];
	const seen = new Set<number>();
	const resultLines = splitLines(after);
	const beforeLines = splitLines(before);
	// Simple LCS-free diff-window: a coarse but safe approximation that marks
	// the region around the first and last differing line as served, plus the
	// unchanged lines actually shown in the diff (which the model sees).
	const minLen = Math.min(beforeLines.length, resultLines.length);
	let firstDiff = -1;
	for (let k = 0; k < minLen; k++) {
		if (beforeLines[k] !== resultLines[k]) {
			firstDiff = k;
			break;
		}
	}
	if (firstDiff === -1 && beforeLines.length !== resultLines.length) {
		firstDiff = minLen;
	}
	const push = (pos: number) => {
		if (pos < 0 || pos >= resultHashes.length || seen.has(pos)) return;
		if (eligible !== undefined && !eligible(pos)) return;
		seen.add(pos);
		rows.push({ position: pos, anchor: resultHashes[pos]! });
	};
	if (firstDiff === -1) return rows;
	const lastDiff = (() => {
		let k = 0;
		while (
			k < minLen - firstDiff &&
			beforeLines[beforeLines.length - 1 - k] === resultLines[resultLines.length - 1 - k]
		)
			k++;
		return Math.max(firstDiff, resultLines.length - 1 - k);
	})();
	for (
		let p = Math.max(0, firstDiff - ctxPad);
		p <= Math.min(resultHashes.length - 1, lastDiff + ctxPad);
		p++
	) {
		push(p);
	}
	// #223: mints AND records served in one transaction, through the entry point.
	if (rows.length > 0) {
		const servedLineNos = rows.map((r) => r.position + 1);
		const allocated = await anchorForInWorkspace({
			cwd: cwd ?? "",
			absolutePath,
			content: after,
			lines: servedLineNos,
			sessionKey,
		});
		for (let k = 0; k < servedLineNos.length; k++) {
			resultHashes[servedLineNos[k]! - 1] = allocated[k]!;
			rows[k] = { position: servedLineNos[k]! - 1, anchor: allocated[k]! };
		}
	}
	return rows;
}

/**
 * The final lines the model-facing main diff RENDERS: every line within
 * `ctx` of a before→after difference — the same per-change ±context union
 * `genDiff` draws its blocks with (a gap wider than 2×context splits and
 * drops its middle). #312: the served window above is deliberately WIDER
 * than the rendered rows, so "served" cannot decide what the main diff
 * already shows — only rendered rows may withhold a formatter-changed line
 * from the auto-format section (rule 2); the rest come back as rows (rule 3).
 */
export function diffRenderedLines(before: string, after: string, ctx: number = contextLinesCfg()): Set<number> {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const rendered = new Set<number>();
	// A missing before-line reads as changed, so a pure tail insertion marks
	// the appended rows without a separate length branch.
	for (let k = 0; k < afterLines.length; k++) {
		if (beforeLines[k] === afterLines[k]) continue;
		const line = k + 1;
		for (let p = Math.max(1, line - ctx); p <= Math.min(afterLines.length, line + ctx); p++) {
			rendered.add(p);
		}
	}
	return rendered;
}
