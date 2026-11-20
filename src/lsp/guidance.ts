/**
 * The `tool:lsp` section (#447).
 *
 * @module dsh-hashline-edittool/lsp/guidance
 */
import type { ToolGuidance } from "../contract/tool-guidance.js";

export const LSP_GUIDANCE: ToolGuidance = {
	intro: "Semantic code intelligence from a language server — meaning, not shape.",
	lines: [
		"`lsp`: for definitions, references, implementations, hover, symbols or diagnostics; a server follows shadowing, re-exports and cross-file usage a syntax tree cannot see.",
		"`lsp`: the `operation` field selects the request; navigation needs a cursor — name the line's text with `symbol` rather than counting UTF-16 columns.",
		"`lsp`: every line an answer names is served as an editable row, ready for `edit`.",
		"`lsp`: refuses rather than returning nothing when no server can be started, and says why; `status` reports without starting anything, `warm` starts one language's server now.",
	],
};
