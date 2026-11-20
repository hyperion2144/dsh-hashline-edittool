/**
 * The `tool:write` section (#447): the outright-replace half of the surface.
 *
 * @module dsh-hashline-edittool/domain/write/guidance
 */
import type { ToolGuidance } from "../../contract/tool-guidance.js";

export const WRITE_GUIDANCE: ToolGuidance = {
	intro: "Create a file or replace one outright — the one-shot source of a file's whole content.",
	lines: [
		"`write`: prefer `edit` for targeted changes — a write re-issues the whole file, and re-issuing from memory silently drops whatever was never read.",
		"`write`: the echo serves the rows it shows under the full preview, or draws them as a unified diff; the confirmation preview serves nothing, so read before editing what it wrote.",
		"`write`: a create, or a replace whose pre-write read was lossy, cannot draw a diff and stays on the plain echo.",
	],
};
