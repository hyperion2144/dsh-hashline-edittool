/**
 * The `tool:format` section (#447).
 *
 * @module dsh-hashline-edittool/domain/format/guidance
 */
import type { ToolGuidance } from "../../contract/tool-guidance.js";

export const FORMAT_GUIDANCE: ToolGuidance = {
	intro: "Format a file through its language server, keeping the anchors of unchanged lines stable.",
	lines: [
		"`format`: whole file by default; `range` formats only the lines between two served anchors — both bounds served, the middle may not be.",
		"`format`: the reply lists the formatter-changed rows with fresh anchors; a row never served before shows a blank anchor and must be read before it can be edited.",
		"`format`: indentation follows the project's `.editorconfig` when present, otherwise the file's own indent steps.",
		"`format`: refuses honestly when no server or no formatting provider exists — it never guesses or silently falls back; a server may cold-start, so the first call can take seconds.",
	],
};
