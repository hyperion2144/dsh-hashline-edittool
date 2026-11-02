/**
 * The `lsp` answers that have NO rows of their own (#397 review).
 *
 * Three of the tool's answers are not line-anchored: a hover's contents, the
 * actions a server offers at a range, and a raw `request` JSON. The read
 * projection therefore carried zero rows, so BOTH card models rejected the meta
 * and the expanded row fell back to a raw input/output dump — the one thing
 * this plugin's cards exist to avoid.
 *
 * The host projects a discriminator (`operation`) plus the answer's own data.
 * This reads it back, soft-validated like every other meta reader: ANY
 * deviation yields `null`, which keeps the row on the generic body rather than
 * drawing a guess.
 *
 * @module dsh-hashline-edittool-client/lsp-answer
 */
import type { LspActionMeta, LspAnswerModel, ToolCallBlock } from "./types.js";

/**
 * The card model for a row-less `lsp` answer.
 *
 * @param block - the running or settled call.
 * @returns the answer's card model, or `null` when this meta is not one.
 */
export function lspAnswerModel(block: ToolCallBlock): LspAnswerModel | null {
	if (!("kind" in block) || block.isError) return null;
	const meta = block.meta;
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
	const value = meta as Record<string, unknown>;
	const path = typeof value.path === "string" && value.path !== "" ? value.path : undefined;
	const base = path === undefined ? {} : { path };
	const note = typeof value.note === "string" && value.note !== "" ? value.note : undefined;
	if (value.operation === "hover") {
		if (typeof value.hover === "string" && value.hover !== "") {
			return { kind: "hover", ...base, text: value.hover };
		}
		// An empty hover is the ANSWER (`No hover information.`): the host's
		// sentence draws in the same frame rather than an empty body.
		return note === undefined ? null : { kind: "note", ...base, text: note };
	}
	if (value.operation === "code_actions") {
		if (!Array.isArray(value.actions)) return null;
		const actions: LspActionMeta[] = [];
		for (const candidate of value.actions) {
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
			const action = candidate as Record<string, unknown>;
			if (typeof action.title !== "string") return null;
			if (action.kind !== undefined && typeof action.kind !== "string") return null;
			actions.push({ title: action.title, ...(action.kind === undefined ? {} : { kind: action.kind }) });
		}
		return { kind: "actions", ...base, actions, ...(note === undefined ? {} : { note }) };
	}
	if (value.operation === "request") {
		if (typeof value.json !== "string" || value.json === "") return null;
		return { kind: "json", ...base, text: value.json };
	}
	// A ONE-SENTENCE answer — an empty navigation result — is still an answer:
	// the sentence is the card, not a dump of the raw call.
	if (note !== undefined && value.card !== "lsp-status") return { kind: "note", ...base, text: note };
	return null;
}
