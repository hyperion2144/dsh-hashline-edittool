/**
 * Output-schema pins for the format section (map #275 / T0's rule).
 *
 * The tool DSL validates a RETURNED value against the tool's declared output
 * schema at session mount — not when a unit test calls `execute` (the
 * `modelText` incident). `formats` rides `presentationMeta` on edit, ast_edit
 * and write; these pins keep all three schema declarations from drifting.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { localIO } from "../../src/infra/fs-bridge.js";
import { buildAstEditTool } from "../../src/tools/tool-ast-edit.js";
import { buildEditTool } from "../../src/tools/tool-edit.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { buildFormatTool } from "../../src/tools/tool-format.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";

/** The minimal section shape the tools carry — exactly what the card reads. */
const SECTION = {
	status: "formatted",
	mode: "full-file",
	requested: 1,
	applied: 2,
	changedLines: 1,
	unservedRows: 0,
	inMainDiffRows: 2,
	rows: [{ kind: " ", lineNumber: 3, hash: "", text: "x" }],
};

describe("format section schema pins (map #275)", () => {
	it("edit declares formats", () => {
		const tool = buildEditTool(localIO(), { escalationModes: [], schemaFields: () => ({}) } as never);
		const value = {
			path: "a.ts",
			before: "b",
			after: "c",
			modelText: "m",
			formats: [SECTION],
		};
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("ast_edit declares formats", () => {
		const tool = buildAstEditTool(localIO(), { escalationModes: [], schemaFields: () => ({}) } as never);
		const value = {
			path: "a.ts",
			before: "b",
			after: "c",
			pat: "$X",
			count: 1,
			ok: true,
			modelText: "m",
			formats: [{ ...SECTION, path: "a.ts" }],
		};
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("write declares formats", () => {
		const tool = buildWriteShadowTool(localIO(), { escalationModes: [], schemaFields: () => ({}) } as never);
		const value = {
			path: "a.ts",
			operation: "create",
			before: null,
			after: "c",
			modelText: "m",
			formats: [SECTION],
		};
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("format declares every value field (manual tool)", () => {
		const tool = buildFormatTool(localIO(), { escalationModes: [], schemaFields: () => ({}) } as never);
		const value = {
			path: "a.ts",
			operation: "format",
			status: "formatted",
			server: "fake-ts",
			mode: "full-file",
			requested: 1,
			applied: 2,
			changedLines: 1,
			unservedRows: 0,
			inMainDiffRows: 0,
			rows: SECTION.rows,
			modelText: "m",
		};
		expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
	});

	it("format's error path answers {modelText, error} without a schema fight", () => {
		// #288 review: the refusal for a language with no server is thrown from
		// execute and converted to thrownErrorResult INSIDE the tool, so the
		// error object IS the validated value — only `modelText` may be required.
		const tool = buildFormatTool(localIO(), { escalationModes: [], schemaFields: () => ({}) } as never);
		const schema = outputSchemaOf(tool);
		// defineTool normalizes the per-property flags into a top-level array.
		const required = (schema as { required?: readonly string[] }).required ?? [];
		expect(required).toEqual(["modelText"]);
		for (const field of ["path", "operation", "status", "server", "mode", "requested", "applied", "changedLines", "inMainDiffRows", "unservedRows"]) {
			expect(required).not.toContain(field);
		}
		expect(schemaViolations(schema, { modelText: "[E_LSP_NO_SERVER] no language…", error: { code: "E_LSP_NO_SERVER", message: "no language" } })).toEqual([]);
	});
});
