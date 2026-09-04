/**
 * Read-envelope + `file_path` spelling tests (issue #69 problem 2).
 *
 * The dsh 0.1.2 web client derives the read card from RAW call args
 * (`file_path`), the persisted presentationMeta, and a result text matching
 * {@link DSH_READ_ENVELOPE_RE}. These tests pin all three legs so a future
 * refactor cannot silently degrade the web read card again.
 *
 * @module dsh-hashline-edittool/test/read-envelope
 */
import { describe, expect, it, afterEach } from "vitest";
import {
	applyEffective,
} from "../../src/config.js";
import {
	DSH_READ_ENVELOPE_RE,
	envelopeReadText,
	extractReadBody,
} from "../../src/presentation-helpers.js";
import {
	withTempFile,
	makeExec,
} from "../support/fixtures.js";
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

describe("read modelText envelope (dsh 0.1.2 web parity)", () => {
	it("wraps text-mode rows in the dsh read envelope", async () => {
		await withTempFile("p.txt", "alpha\nbeta\n", async ({ cwd, path }) => {
			const value = (await executeRead({ file_path: "p.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).toMatch(DSH_READ_ENVELOPE_RE);
			expect(value.modelText).toContain("ANCHOR:FILELINE");
			expect(value.modelText.split("\n")[0]).toBe("<path>p.txt</path>");
			expect(value.modelText.endsWith("\n</content>")).toBe(true);
		});
	});

	it("wraps the pure-JSON view in the envelope in json mode", async () => {
		applyEffective({ output_format: "json" });
		await withTempFile("j.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "j.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).toMatch(DSH_READ_ENVELOPE_RE);
			expect(value.modelText).toContain('{"path"');
		});
	});


	it("envelopes even the defensive fallback branch", async () => {
		await withTempFile("f.txt", "content", async ({ cwd }) => {
			const value = (await executeRead({ file_path: "f.txt" }, cwd)) as {
				modelText: string;
			};
			expect(value.modelText).toMatch(DSH_READ_ENVELOPE_RE);
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

	it("declares file_path in the tool schema (raw-args contract)", async () => {
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
});

describe("envelope helpers", () => {
	it("envelopeReadText output always matches the dsh regex", () => {
		for (const body of ["", "rows\n\nfooter", "line\nwith\ntrailing\n"]) {
			expect(envelopeReadText("x/y.txt", body)).toMatch(DSH_READ_ENVELOPE_RE);
		}
	});

	it("extractReadBody strips the envelope and the legacy header", () => {
		expect(extractReadBody(envelopeReadText("p", "the-body"))).toBe("the-body");
	});
});
