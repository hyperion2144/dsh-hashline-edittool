/**
 * The compiled guidance sections: one per tool plus the cross-tool anchor
 * discipline. The text comes ONLY from the compiled defaults (#447 review) —
 * the plugin no longer reads per-preset documents from disk.
 *
 * @module dsh-hashline-edittool/guidance/resolve
 */
import {
	editGuidance,
	DELETE_GUIDANCE,
	RENAME_GUIDANCE,
	GREP_GUIDANCE,
	READ_GUIDANCE,
	readGuidance,
	UNDO_GUIDANCE,
	APPLY_PATCH_GUIDANCE,
} from "../domain/edit/prompts.js";
import { WRITE_GUIDANCE } from "../domain/write/guidance.js";
import { FORMAT_GUIDANCE } from "../domain/format/guidance.js";
import { AST_EDIT_GUIDANCE, AST_GREP_GUIDANCE } from "../ast/guidance.js";
import { LSP_GUIDANCE } from "../lsp/guidance.js";
import { ANCHORS_GUIDANCE } from "./anchors.js";
import type { ToolGuidance } from "../contract/tool-guidance.js";
import { getEffectiveConfig } from "../infra/settings.js";

/**
 * Render one section's guidance as its intro line, a blank line, then bullets.
 * Uniform across every section: no tool-schema description is duplicated
 * (that already reaches the model through the tool catalog).
 */
function guidanceText(g: ToolGuidance): string {
	return [g.intro, "", bulletLines(g.lines)].join("\n");
}

function bulletLines(lines: readonly string[]): string {
	return lines.map((line) => `- ${line}`).join("\n");
}

/** One compiled guidance section. */
export interface GuidanceSection {
	/** Registry section name, e.g. `tool:edit`. */
	name: string;
	/** Order in the assembled system prompt. */
	defaultOrder: number;
	/** The compiled default text — the only text this section ever carries. */
	renderDefault(): string;
}

/** The compiled sections, in default-order sequence: the anchor discipline first, then one section per tool. */
export const GUIDANCE_SECTIONS: readonly GuidanceSection[] = [
	{ name: "anchors", defaultOrder: 129, renderDefault: () => guidanceText(ANCHORS_GUIDANCE) },
	{
		name: "tool:read",
		defaultOrder: 130,
		renderDefault: () => guidanceText(readGuidance(getEffectiveConfig())),
	},
	{
		name: "tool:edit",
		defaultOrder: 131,
		// Flag-aware: with require_line_content ON the default teaches the
		// `{ anchor, line }` declaration form (rebuilt live on flag flip).
		renderDefault: () => guidanceText(editGuidance(getEffectiveConfig())),
	},
	{ name: "tool:undo_last_edit", defaultOrder: 132, renderDefault: () => guidanceText(UNDO_GUIDANCE) },
	{ name: "tool:grep", defaultOrder: 133, renderDefault: () => guidanceText(GREP_GUIDANCE) },
	{ name: "tool:delete", defaultOrder: 134, renderDefault: () => guidanceText(DELETE_GUIDANCE) },
	{ name: "tool:rename", defaultOrder: 135, renderDefault: () => guidanceText(RENAME_GUIDANCE) },
	{ name: "tool:apply_patch", defaultOrder: 136, renderDefault: () => guidanceText(APPLY_PATCH_GUIDANCE) },
	{ name: "tool:write", defaultOrder: 137, renderDefault: () => guidanceText(WRITE_GUIDANCE) },
	{ name: "tool:ast_grep", defaultOrder: 138, renderDefault: () => guidanceText(AST_GREP_GUIDANCE) },
	{ name: "tool:ast_edit", defaultOrder: 139, renderDefault: () => guidanceText(AST_EDIT_GUIDANCE) },
	{ name: "tool:lsp", defaultOrder: 140, renderDefault: () => guidanceText(LSP_GUIDANCE) },
	{ name: "tool:format", defaultOrder: 141, renderDefault: () => guidanceText(FORMAT_GUIDANCE) },
];

const SECTION_BY_NAME = new Map(
	GUIDANCE_SECTIONS.map((section) => [section.name, section]),
);

/** Render the compiled default text for one section. */
export function renderSectionDefault(name: string): string {
	const section = SECTION_BY_NAME.get(name);
	if (!section) throw new Error(`unknown guidance section: ${name}`);
	return section.renderDefault();
}

/** One section as the systemPrompt registry takes it. */
export interface SectionOverride {
	name: string;
	order: number;
	text: string;
}
