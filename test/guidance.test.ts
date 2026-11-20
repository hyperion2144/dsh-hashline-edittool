import { describe, expect, it } from "vitest";

import { GUIDANCE_SECTIONS, renderSectionDefault } from "../src/guidance.js";
import {
	editGuidance,
	READ_GUIDANCE,
	UNDO_GUIDANCE,
} from "../src/domain/edit/prompts.js";
import { applyEffective, getEffectiveConfig } from "../src/config.js";


const bullets = (lines: readonly string[]) =>
	lines.map((line) => `- ${line}`).join("\n");

describe("guidance sections", () => {
	it("exposes the thirteen sections with stable order and defaults", () => {
		expect(GUIDANCE_SECTIONS.map((s) => s.name)).toEqual([
			"anchors",
			"tool:read",
			"tool:edit",
			"tool:undo_last_edit",
			"tool:grep",
			"tool:delete",
			"tool:rename",
			"tool:apply_patch",
			"tool:write",
			"tool:ast_grep",
			"tool:ast_edit",
			"tool:lsp",
			"tool:format",
		]);
		expect(GUIDANCE_SECTIONS.map((s) => s.defaultOrder)).toEqual([
			129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141,
		]);
	});

	it("default render matches today's inline section text", () => {
		expect(renderSectionDefault("tool:read")).toBe(
			[READ_GUIDANCE.intro, "", bullets(READ_GUIDANCE.lines)].join("\n"),
		);
		expect(renderSectionDefault("tool:edit")).toBe(
			[editGuidance(getEffectiveConfig()).intro, "", bullets(editGuidance(getEffectiveConfig()).lines)].join("\n"),
		);
		expect(renderSectionDefault("tool:undo_last_edit")).toBe(
			[UNDO_GUIDANCE.intro, "", bullets(UNDO_GUIDANCE.lines)].join("\n"),
		);
	});

	it("teaches the confirmation-mode write rule only while that mode is on (#354)", () => {
		applyEffective(undefined);
		expect(renderSectionDefault("tool:read")).not.toContain("confirmation");
		applyEffective({ write: { preview: "confirmation" } });
		try {
			expect(renderSectionDefault("tool:read")).toContain("confirmation");
		} finally {
			applyEffective(undefined);
		}
	});
});

