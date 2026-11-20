/**
 * The cross-tool anchor discipline — the one section every anchored tool's
 * rules hang from (#447). Each tool's section teaches its own shape; this
 * section teaches where anchors come from and what counts as served.
 *
 * @module dsh-hashline-edittool/guidance/anchors
 */
import type { ToolGuidance } from "../contract/tool-guidance.js";

export const ANCHORS_GUIDANCE: ToolGuidance = {
	intro:
		"Anchors are the only address a line has: they exist solely in the rows that read, grep and lsp return, and in the diff and rejection echoes the editing tools produce.",
	lines: [
		"Anchors are copied, never invented: an anchor cannot be derived from a line number, the file's content or memory — a hand-written or stale anchor is rejected outright.",
		"Shell output does not count: what bash cat, sed, head, tail, grep, rg or find prints has no anchors and is not observed — after a shell lookup, still read or grep before editing.",
		"The workflow is grep to locate, read to see the lines, edit with the anchors those returns carry; a rejected call echoes its target rows as fresh serves — retry from them without re-reading.",
		"A multi-line range must be fully served first: every line between the range's two anchors has to have been read, so resume or offset through a long middle, or split the edit into smaller ranges.",
		"Edits and writes serve too: the diff rows after an edit, and a write's echo (except the confirmation preview), carry the fresh anchors for whatever comes next.",
	],
};
