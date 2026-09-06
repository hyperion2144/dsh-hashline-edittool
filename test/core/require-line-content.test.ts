/**
 * Contract tests for the declared line-content mode
 * (`hashline.require_line_content`, wayfinder map #74 / contract #76).
 *
 * Matrix: schema shape (both switch states), bidirectional hard reject,
 * two-stage matching (marker-prefix tolerated, marker-shaped content never
 * mis-stripped), dual-anchor declarations (range + omitted-end fold),
 * E_CONTENT_MISMATCH echo with the same-content hint, batch atomicity, and
 * the served-E_STALE-first timing.
 * @module dsh-hashline-edittool/test-require-line-content
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { applyEffective } from "../../src/config.js";
import { assertEditRequest, buildEditItemSchema, buildEditsSchema } from "../../src/contract.js";
import { declaredLineMatches } from "../../src/declaration.js";
import {
	withTempFile,
	setupIntegrationTest,
	getText,
} from "../support/fixtures.js";

const ABC = "alpha\nbeta\ngamma\n";

type Tool = {
	execute: (
		_callId: string,
		params: unknown,
	) => Promise<{ content: Array<{ text?: string }> }>;
};

/** Read through the hashline `read` tool so anchors are served, then parse rows. */
async function servedRows(
	harness: ReturnType<typeof setupIntegrationTest>,
	path: string,
): Promise<Array<{ hash: string; content: string }>> {
	const res = await harness.readTool.execute("read", { path });
	const rows: Array<{ hash: string; content: string }> = [];
	for (const line of getText(res).split("\n")) {
		if (line.startsWith("ANCHOR:")) continue;
		const m = /^(?:[+\- ])?(\d+):([A-Za-z0-9]{2,8}):\s?(.*)$/.exec(line);
		if (m) rows.push({ hash: m[2]!, content: m[3]! });
		else {
			const bare = /^([A-Za-z0-9]{2,8}):\s?(.*)$/.exec(line.replace(/^[+\- ]/, ""));
			if (bare) rows.push({ hash: bare[1]!, content: bare[2]! });
		}
	}
	return rows;
}

afterEach(() => {
	applyEffective({});
});

describe("schema shape — both switch states", () => {
	it("OFF: anchors are plain strings, no line sub-parameter", () => {
		const schema = buildEditsSchema(false);
		const item = schema.items as {
			properties: Record<string, { type: string; properties?: unknown }>;
		};
		expect(item.properties.anchor_start!.type).toBe("string");
		expect(item.properties.anchor_end!.type).toBe("string");
		expect(item.properties.anchor_start!.properties).toBeUndefined();
		expect(item.properties.anchor_end!.properties).toBeUndefined();
	});

	it("ON: anchors are { anchor, line } objects, both sub-fields required", () => {
		const schema = buildEditsSchema(true);
		const item = schema.items as {
			properties: Record<
				string,
				{
					type: string;
					required?: boolean;
					properties: Record<string, { type: string; required?: boolean }>;
				}
			>;
		};
		const start = item.properties.anchor_start!;
		expect(start.type).toBe("object");
		expect(start.required).toBe(true);
		expect(start.properties.anchor!.type).toBe("string");
		expect(start.properties.anchor!.required).toBe(true);
		expect(start.properties.line!.type).toBe("string");
		expect(start.properties.line!.required).toBe(true);

		const end = item.properties.anchor_end!;
		expect(end.type).toBe("object");
		// anchor_end stays optional at the schema level (fold rules unchanged).
		expect(end.required).toBeUndefined();
	});

	it("buildEditItemSchema matches buildEditsSchema's items in both states", () => {
		for (const flag of [false, true]) {
			expect(buildEditItemSchema(flag)).toEqual(
				(buildEditsSchema(flag) as { items: unknown }).items,
			);
		}
	});
});

describe("two-stage declared/actual matching (declaration.ts)", () => {
	it("matches verbatim after trailing-whitespace trim", () => {
		expect(declaredLineMatches("const x = 1", "const x = 1")).toBe(true);
		expect(declaredLineMatches("const x = 1  ", "const x = 1")).toBe(true);
	});

	it("tolerates a copied read-row marker prefix as the stage-2 fallback", () => {
		expect(declaredLineMatches("12:xY3| const x = 1", "const x = 1")).toBe(true);
		expect(declaredLineMatches("xY3| const x = 1", "const x = 1")).toBe(true);
	});

	it("never trims leading (content) whitespace", () => {
		expect(declaredLineMatches("  indented", "indented")).toBe(false);
		expect(declaredLineMatches("  indented", "  indented")).toBe(true);
	});

	it("does not mis-strip marker-shaped content (verbatim wins first)", () => {
		// The ACTUAL line genuinely looks like a read row — verbatim compare
		// at stage 1 must match it without any stripping on either side.
		expect(declaredLineMatches("5:xY3| hello", "5:xY3| hello")).toBe(true);
		// A real mismatch stays a mismatch even when stripping could fake one.
		expect(declaredLineMatches("x|b", "b")).toBe(false);
	});
});

describe("require_line_content ON — behavior", () => {
	it("accepts a truthful single-line declaration (replace)", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const beta = served.find((r) => r.content === "beta")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "replace",
						anchor_start: { anchor: beta.hash, line: "beta" },
						lines: ["BETA"],
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
		});
	});

	it("rejects a plain string anchor at the schema gate (stale-schema shape mismatch)", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const alpha = served.find((r) => r.content === "alpha")!;
			// defineTool's own arg validation gates first: the ON schema
			// declares anchor_start as an object, so a plain string fails there.
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [{ op: "replace", anchor_start: alpha.hash, lines: ["A"] }],
				}),
			).rejects.toThrow(/invalid arguments.*anchor_start/);
		});
	});

	it("rejects a multi-line `line` declaration (E_BAD_SHAPE)", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const alpha = served.find((r) => r.content === "alpha")!;
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: alpha.hash, line: "alpha\nbeta" },
							lines: ["A"],
						},
					],
				}),
			).rejects.toThrow(/E_BAD_SHAPE.*SINGLE line/);
		});
	});

	it("rejects a wrong declaration with E_CONTENT_MISMATCH + actual echo + same-content hint", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			// Model holds alpha's anchor but declares gamma's content — the
			// classic wrong-anchor mistake the switch exists to catch.
			const alpha = served.find((r) => r.content === "alpha")!;
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: alpha.hash, line: "gamma" },
							lines: ["A"],
						},
					],
				}),
			).rejects.toThrow(/E_CONTENT_MISMATCH[\s\S]*declared:[\s\S]*gamma[\s\S]*actual:[\s\S]*alpha[\s\S]*currently appears at line 3/);
			// Atomic: nothing was written.
			expect(await readFile(path, "utf-8")).toBe(ABC);
		});
	});

	it("tolerates trailing-whitespace and marker-prefixed declarations", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const beta = served.find((r) => r.content === "beta")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "replace",
						anchor_start: { anchor: beta.hash, line: `1:${beta.hash}| beta` },
						lines: ["BETA"],
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
		});
	});

	it("accepts an empty-string declaration for an empty line", async () => {
		await withTempFile("t.txt", "alpha\n\ngamma\n", async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const blank = served.find((r) => r.content === "")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "replace",
						anchor_start: { anchor: blank.hash, line: "" },
						lines: ["filled"],
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nfilled\ngamma\n");
		});
	});

	it("requires (and verifies) BOTH declarations on a range edit; end mismatch names anchor_end", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: by("alpha")!.hash, line: "alpha" },
							anchor_end: { anchor: by("beta")!.hash, line: "BETA" },
							lines: ["X"],
						},
					],
				}),
			).rejects.toThrow(/E_CONTENT_MISMATCH[\s\S]*`anchor_end\.line`/);
		});
	});

	it("verifies a range edit when both declarations are truthful (ins after end-anchored range)", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "del",
						anchor_start: { anchor: by("alpha")!.hash, line: "alpha" },
						anchor_end: { anchor: by("beta")!.hash, line: "beta" },
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("gamma\n");
		});
	});

	it("omitted anchor_end (single-line fold) declares only anchor_start", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const gamma = served.find((r) => r.content === "gamma")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "del",
						anchor_start: { anchor: gamma.hash, line: "gamma" },
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\n");
		});
	});

	it("applies declarations per item in a batch; one mismatch rejects the WHOLE batch", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const by = (c: string) => served.find((r) => r.content === c)!;
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: by("alpha")!.hash, line: "alpha" },
							lines: ["A"],
						},
						{
							op: "replace",
							anchor_start: { anchor: by("beta")!.hash, line: "WRONG" },
							lines: ["B"],
						},
					],
				}),
			).rejects.toThrow(/E_CONTENT_MISMATCH/);
			expect(await readFile(path, "utf-8")).toBe(ABC);
		});
	});

	it("served staleness wins over the declaration check (E_STALE first)", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const beta = served.find((r) => r.content === "beta")!;
			// External drift AFTER the serve: the served check must fire
			// before any declaration verdict.
			await writeFile(path, "alpha\nDRIFTED\ngamma\n", "utf-8");
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: beta.hash, line: "ALSO-WRONG" },
							lines: ["B"],
						},
					],
				}),
			).rejects.toThrow(/E_RANGE_UNSERVED|E_RANGE_UNVERIFIED|E_STALE/);
		});
	});

	it("op:\"ins\" requires the anchor_start declaration only", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({ require_line_content: true });
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const gamma = served.find((r) => r.content === "gamma")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [
					{
						op: "ins",
						anchor_start: { anchor: gamma.hash, line: "gamma" },
						lines: ["delta"],
					},
				],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nbeta\ngamma\ndelta\n");
		});
	});
});

describe("require_line_content OFF — zero regression + bidirectional reject", () => {
	it("keeps the plain-string anchor contract fully working", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd, path }) => {
			applyEffective({});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const beta = served.find((r) => r.content === "beta")!;
			await harness.editTool.execute("edit", {
				path: "t.txt",
				edits: [{ op: "replace", anchor_start: beta.hash, lines: ["BETA"] }],
			});
			expect(await readFile(path, "utf-8")).toBe("alpha\nBETA\ngamma\n");
		});
	});

	it("rejects the { anchor, line } object form at the schema gate", async () => {
		await withTempFile("t.txt", ABC, async ({ cwd }) => {
			applyEffective({});
			const harness = setupIntegrationTest(cwd);
			const served = await servedRows(harness, "t.txt");
			const beta = served.find((r) => r.content === "beta")!;
			// The OFF schema declares anchor_start as a string — the dict form
			// fails arg validation before reaching the tool body.
			await expect(
				harness.editTool.execute("edit", {
					path: "t.txt",
					edits: [
						{
							op: "replace",
							anchor_start: { anchor: beta.hash, line: "beta" },
							lines: ["BETA"],
						},
					],
				}),
			).rejects.toThrow(/invalid arguments.*anchor_start.*must be a string/);
		});
	});

	describe("runtime backstop — assertEditRequest direct (stale-schema drift)", () => {
		it("ON + plain string → E_BAD_SHAPE guiding to declare line", () => {
			expect(() =>
				assertEditRequest(
					{ edits: [{ op: "replace", anchor_start: "xY3", lines: ["A"] }] },
					true,
				),
			).toThrow(/E_BAD_SHAPE.*missing the required line declaration[\s\S]*line: \"<the current full text/);
		});

		it("OFF + dict → E_BAD_SHAPE pointing at the setting", () => {
			expect(() =>
				assertEditRequest(
					{ edits: [{ op: "replace", anchor_start: { anchor: "xY3", line: "a" }, lines: ["A"] }] },
					false,
				),
			).toThrow(/E_BAD_SHAPE.*only valid when the hashline.require_line_content setting is enabled/);
		});

		it("ON + truthful dict passes the request assert", () => {
			expect(() =>
				assertEditRequest(
					{ path: "t.txt", edits: [{ op: "del", anchor_start: { anchor: "xY3", line: "a" } }] },
					true,
				),
			).not.toThrow();
		});
	});
});
