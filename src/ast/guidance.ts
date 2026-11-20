/**
 * The `tool:ast_grep` and `tool:ast_edit` sections (#447).
 *
 * @module dsh-hashline-edittool/ast/guidance
 */
import type { ToolGuidance } from "../contract/tool-guidance.js";

export const AST_GREP_GUIDANCE: ToolGuidance = {
	intro: "Find code by syntax shape — the structural counterpart of grep.",
	lines: [
		"`ast_grep`: the pattern is ordinary source for the file's language, with `$NAME` (one node), `$$$NAME` (zero or more) and `$_` (unnamed) as metavariables; omit it for the file's outline.",
		"`ast_grep`: a pattern must parse as one node — wrap fragments (`class $_ { … }`); a grammar rejection is an error, not an empty result.",
		"`ast_grep`: a position that demands a specific token cannot take a metavariable as written — a module specifier is a string, so write `import $$$BODY from \"$MODULE\"`.",
		"`ast_grep`: the same name twice must match the same code, and metavariable names are uppercase standing for whole nodes.",
		"`ast_grep`: rows return in read's form — a match is served and can go straight to `edit`.",
	],
};

export const AST_EDIT_GUIDANCE: ToolGuidance = {
	intro: "Change code at the places a syntax pattern finds — the write half of `ast_grep`.",
	lines: [
		"`ast_edit`: `pat` selects the matches and `out` replaces them — it may reference the pattern's metavariables, and an empty `out` deletes the match.",
		"`ast_edit`: every match applies as one atomic batch through the same engine `edit` uses, and syntax is re-checked after the change.",
		"`ast_edit`: pattern rules are `ast_grep`'s — see that tool's section for the biting ones.",
		"`ast_edit`: a change that would break syntax refuses the whole batch and writes nothing; re-read the file before retrying.",
	],
};
