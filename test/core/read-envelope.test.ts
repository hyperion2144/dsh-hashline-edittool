/**
 * Read modelText shape tests (issue #69 problem 2 → issue #71 direction B).
 *
 * Direction A wrapped read results in the dsh read envelope so the SHIPPED
 * web card rendered. Direction B (the bundled client plugin) renders the card
 * from presentationMeta alone, so the envelope is GONE from model texts — the
 * model sees the hashline legend + rows + footer directly, and json mode is
 * pure JSON again. {@link DSH_READ_ENVELOPE_RE} survives only for legacy
 * history tolerance in extractReadBody. These tests pin the new shape.
 *
 * @module dsh-hashline-edittool/test/read-envelope
 */
import { describe, expect, it, afterEach } from "vitest";
import { applyEffective } from "../../src/config.js";
import { DSH_READ_ENVELOPE_RE, extractReadBody } from "../../src/presentation-helpers.js";
import { hashlineHeader } from "../../src/hashline/hash-assign.js";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { localIO } from "../../src/fs-bridge.js";

afterEach(() => {
	applyEffective({});
});

/** Drive the registered read tool exactly like the web does (raw args in). */
async function executeRead(args: unknown, cwd: string) {
	const { buildReadTool } = await import("../../src/tool-read.js");
	const tool = buildReadTool(localIO());
	return tool.execute(args, makeExec(cwd)({}));
}

describe("read modelText has no dsh envelope (issue #71 direction B)", () => {
	it("emits legend + rows + footer without the <path>/<type>/<content> wrapper", async () => {
		await withTempFile("p.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "p.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).not.toMatch(DSH_READ_ENVELOPE_RE);
			expect(value.modelText.startsWith("ANCHOR:FILELINE")).toBe(true);
			expect(value.modelText).toMatch(/\[End of file - total 2 lines\.\]$/);
		});
	});

	it("json mode emits pure JSON (parseable, no envelope)", async () => {
		applyEffective({ output_format: "json" });
		await withTempFile("j.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "j.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).not.toMatch(DSH_READ_ENVELOPE_RE);
			const parsed = JSON.parse(value.modelText) as { path: string };
			expect(parsed.path).toBe("j.txt");
		});
	});

	it("emits the defensive fallback branch bare as well", async () => {
		await withTempFile("f.txt", "content", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "f.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).not.toMatch(DSH_READ_ENVELOPE_RE);
			expect(value.modelText).toContain("content");
		});
	});
});

describe("read file_path spelling (raw args the web validates)", () => {
	it("executes when the model sends file_path", async () => {
		await withTempFile("fp.txt", "alpha\n", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "fp.txt" }, cwd)) as {
				path: string;
				totalLines: number;
			};
			expect(value.path).toBe("fp.txt");
			expect(value.totalLines).toBe(1);
		});
	});

	it("still accepts the legacy path alias", async () => {
		await withTempFile("lp.txt", "alpha\n", async ({ cwd }) => {
			const value = (await executeRead({ path: "lp.txt" }, cwd)) as {
				totalLines: number;
			};
			expect(value.totalLines).toBe(1);
		});
	});

	it("declares file_path in the tool schema (raw-args contract, json channel)", async () => {
		applyEffective({ input_format: "json" });
		const { buildReadTool } = await import("../../src/tool-read.js");
		const tool = buildReadTool(localIO()) as unknown as {
			parameters: Record<string, unknown>;
			presentCall: (args: unknown) => { title: string } | undefined;
		};
		expect(tool.parameters.properties.file_path).toBeDefined();
		// `path` was removed from the schema (issue #69): file_path is the only
		// model-facing spelling, so the raw args satisfy validReadCall.
		expect(tool.parameters.properties.path).toBeUndefined();

		// presentCall prefers the file_path spelling for the call-card title.
		const card = tool.presentCall({ file_path: "a.txt", offset: 2 });
		expect(card?.title).toContain("a.txt");
		const legacy = tool.presentCall({ path: "b.txt" });
		expect(legacy?.title).toContain("b.txt");
	});

	it("text mode (default) advertises ONE string parameter — the whole call is plain text", async () => {
		// Decision (c), #53: the text channel is a real text contract, not an
		// object schema with prose. The model sees {type:"string"}.
		applyEffective({ input_format: "text" });
		const { buildReadTool } = await import("../../src/tool-read.js");
		const tool = buildReadTool(localIO()) as unknown as {
			parameters: Record<string, unknown>;
			presentCall: (args: unknown) => { title: string } | undefined;
		};
		expect(tool.parameters).toEqual({
			type: "string",
			description: expect.stringContaining("Plain-text read payload"),
		});
		// Runtime still accepts a JSON object (dual channel) and a text payload.
		const fromText = tool.presentCall("a.txt\noffset: 2");
		expect(fromText?.title).toContain("a.txt");
	});
});

describe("envelope helpers (legacy history tolerance)", () => {
	it("extractReadBody strips the legacy envelope from pre-0.4.2 history", () => {
		const legacy = `<path>p</path>\n<type>file</type>\n<content>\nthe-body\n</content>`;
		expect(extractReadBody(legacy)).toBe("the-body");
	});

	it("extractReadBody strips the ANCHOR:FILELINE header from current texts", () => {
		expect(extractReadBody(`${hashlineHeader()}\nthe-body`)).toBe("the-body");
	});
});
