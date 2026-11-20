/**
 * #447 — the prompt-surface contract.
 *
 * Three layers, each asserted where it lives:
 * - tool descriptions: purpose-first single paragraphs, without the banned
 *   vocabulary (code fences, bullet lists, error-code enumerations);
 * - schema fields: every parameter of every tool the ticket names carries a
 *   non-empty description (the traversal the ticket asked to automate);
 * - guidance sections: the anchor discipline plus one section per tool, each
 *   an intro with at most five bullets, and the anchor rules retrievable.
 *
 * The two end-to-end acceptance items (real model behavior) are manual by
 * the 2026-11-20 decision — CI asserts these static ones.
 *
 * @module dsh-hashline-edittool/test-prompt-contract
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { GUIDANCE_SECTIONS, renderSectionDefault } from "../../src/guidance/resolve.js";
import { compiledDefaultSections } from "../../src/index.js";
import type { FileIO } from "../../src/infra/fs-bridge.js";
import type { FsSandboxController } from "../../src/infra/sandbox.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { buildGrepTool } from "../../src/tools/tool-grep.js";
import { buildDeleteTool } from "../../src/tools/tool-delete.js";
import { buildRenameTool } from "../../src/tools/tool-rename.js";
import { buildUndoTool } from "../../src/tools/tool-undo.js";
import { buildAstGrepTool } from "../../src/tools/tool-ast-grep.js";
import { buildAstEditTool } from "../../src/tools/tool-ast-edit.js";
import { buildLspTool } from "../../src/tools/tool-lsp.js";
import { buildFormatTool } from "../../src/tools/tool-format.js";
import { buildApplyPatchTool } from "../../src/tools/tool-apply-patch.js";

interface ToolLike {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

const io = {} as FileIO;
const sandbox = { escalationModes: [], schemaFields: () => ({}) } as unknown as FsSandboxController;

/** The twelve tools the ticket names, built with neutral stubs. */
function theTools(): ToolLike[] {
	return [
		buildReadTool(io),
		buildEditTool(io, sandbox),
		buildWriteShadowTool(io, sandbox),
		buildGrepTool(io),
		buildDeleteTool(io, sandbox),
		buildRenameTool(io, sandbox),
		buildUndoTool(io, sandbox),
		buildAstGrepTool(io),
		buildAstEditTool(io, sandbox),
		buildLspTool(io),
		buildFormatTool(io, sandbox),
		buildApplyPatchTool(io, sandbox),
	].map((tool) => tool as unknown as ToolLike);
}

/**
 * Collect schema paths of field nodes lacking a description. A node is a
 * field when it is a named parameter, a member of `properties`, or `items`;
 * `oneOf` alternatives are covered by the enclosing field's own description.
 */
function fieldsMissingDescriptions(node: unknown, path: string, out: string[]): void {
	if (Array.isArray(node)) {
		node.forEach((child, index) => fieldsMissingDescriptions(child, `${path}[${index}]`, out));
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const shaped =
		record.type !== undefined || record.oneOf !== undefined || record.enum !== undefined;
	if (shaped) {
		const description = record.description;
		if (typeof description !== "string" || description.trim() === "") out.push(path);
	}
	if (record.oneOf !== undefined) return;
	const properties = record.properties;
	if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
		for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
			fieldsMissingDescriptions(value, `${path}.${key}`, out);
		}
	}
	if (record.items !== undefined) fieldsMissingDescriptions(record.items, `${path}[]`, out);
}

/** The twelve names, in the ticket's order. */
const TWELVE = [
	"read",
	"edit",
	"write",
	"grep",
	"delete",
	"rename",
	"undo_last_edit",
	"ast_grep",
	"ast_edit",
	"lsp",
	"format",
	"apply_patch",
] as const;

describe("#447 — tool descriptions are purpose-first", () => {
	beforeEach(() => {
		applyEffective(undefined);
	});
	afterEach(() => {
		applyEffective(undefined);
	});

	it("covers exactly the twelve tools the ticket names", () => {
		expect(theTools().map((tool) => tool.name)).toEqual([...TWELVE]);
	});

	it("each description is one paragraph without fences, lists or error codes", () => {
		for (const tool of theTools()) {
			expect(tool.description, `${tool.name} has a description`).toBeTruthy();
			expect(tool.description, `${tool.name} is a single paragraph`).not.toContain("\n");
			expect(tool.description, `${tool.name} has no code fence`).not.toContain("```");
			expect(tool.description, `${tool.name} has no error-code enumeration`).not.toMatch(
				/\[E_[A-Z_]+\]/,
			);
		}
	});
});

describe("#447 — every schema field is described", () => {
	it("no field node of the twelve tools lacks a description", () => {
		const missing: string[] = [];
		for (const tool of theTools()) {
			for (const [name, field] of Object.entries(tool.parameters)) {
				fieldsMissingDescriptions(field, `${tool.name}.${name}`, missing);
			}
		}
		expect(missing).toEqual([]);
	});
});

describe("#447 — the guidance sections", () => {
	beforeEach(() => {
		applyEffective(undefined);
	});
	afterEach(() => {
		applyEffective(undefined);
	});

	it("cover the anchor discipline plus one section per tool, in unique order", () => {
		expect(GUIDANCE_SECTIONS.map((section) => section.name)).toEqual([
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
		const orders = GUIDANCE_SECTIONS.map((section) => section.defaultOrder);
		expect(new Set(orders).size).toBe(orders.length);
	});

	it("each section renders as an intro plus at most five bullets, without error codes", () => {
		for (const section of GUIDANCE_SECTIONS) {
			const text = renderSectionDefault(section.name);
			const lines = text.split("\n");
			expect(lines[0], `${section.name} intro`).not.toHaveLength(0);
			const bullets = lines.filter((line) => line.startsWith("- "));
			expect(bullets.length, `${section.name} has bullets`).toBeGreaterThan(0);
			expect(bullets.length, `${section.name} keeps ≤ 5 bullets`).toBeLessThanOrEqual(5);
			expect(text, `${section.name} carries no error-code table`).not.toMatch(/\[E_[A-Z_]+\]/);
		}
	});

	it("carries the anchor rules and the workflow the model was missing", () => {
		const text = GUIDANCE_SECTIONS.map((section) => renderSectionDefault(section.name)).join(
			"\n\n",
		);
		// Only from tool returns — cannot be invented:
		expect(text).toContain("cannot be derived from a line number");
		// Shell output does not count:
		expect(text).toContain("no anchors and is not observed");
		// The grep → read → edit workflow:
		expect(text).toContain("grep to locate, read to see the lines");
		// Multi-line ranges must be fully served first:
		expect(text).toContain("must be fully served first");
		expect(text).toContain("resume or offset through a long middle");
	});
});

describe("#447 — the injected text is the compiled default", () => {
	it("compiledDefaultSections() serves exactly the rendered defaults", () => {
		const injected = compiledDefaultSections();
		expect(injected.map((section) => section.name)).toEqual(
			GUIDANCE_SECTIONS.map((section) => section.name),
		);
		expect(injected.map((section) => section.order)).toEqual(
			GUIDANCE_SECTIONS.map((section) => section.defaultOrder),
		);
		for (const section of injected) {
			expect(section.text).toBe(renderSectionDefault(section.name));
		}
	});
});
