/**
 * Issue #261 — op:"ins" destroyed its anchor line when the anchor token was a
 * pasted row (`<anchor>:<content>`), because two parsers disagreed: resolveIns
 * parsed the ref strictly (threw → early-returned the RAW replacement text)
 * while resEdit's autofix chain forgave the same token (stripped the trailing
 * content with an [E_BAD_REF] warning). The forgiven anchor then carried the
 * un-expanded replacement over the anchor line's range — silent content loss.
 *
 * The fix (maintainer decision Q1 (a), normalize-once): `buildPreparedItem`
 * salvages every anchor ref ONCE at the tool layer — the same salvage resEdit
 * applies — so the engine only ever sees reference forms it parses. edit's
 * single path, the batch path, and `ast_edit` (same builder) all inherit it.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { buildReadTool } from "../../src/tools/tool-read.js";
import { buildEditTool, buildPreparedItem } from "../../src/tools/tool-edit.js";
import { localIO, type FileIO } from "../../src/infra/fs-bridge.js";
import { FsSandboxController } from "../../src/infra/sandbox.js";

const THREE = "one\ntwo\nthree\n";

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

/** Drive the raw tool builders end-to-end over one cwd/session. */
function tools(cwd: string) {
	const io: FileIO = localIO();
	const sandbox = testSandbox();
	const run = <T>(
		tool: { execute: (args: unknown, exec: unknown) => Promise<T> },
		args: unknown,
	): Promise<T> => tool.execute(args, makeExec(cwd)(args)) as Promise<T>;
	return {
		read: (args: Record<string, unknown>) =>
			run(buildReadTool(io) as never, args) as Promise<{ modelText: string }>,
		edit: (args: Record<string, unknown>) =>
			run(buildEditTool(io, sandbox) as never, args) as Promise<{ modelText: string }>,
	};
}

/** The anchor of the row "two", taken from a real read the model would see. */
async function anchorOfTwo(h: ReturnType<typeof tools>): Promise<string> {
	const read = await h.read({ path: "f.txt" });
	const anchor = /^([A-Za-z0-9]{2,8}):two$/m.exec(read.modelText)?.[1];
	expect(anchor).toBeDefined();
	return anchor as string;
}

describe("#261 ins with a pasted-row anchor keeps the anchor line (normalize-once)", () => {
	it("single path: ins inserts below the anchor row; the anchor content survives; one salvage warning", async () => {
		await withTempFile("f.txt", THREE, async ({ cwd }) => {
			const h = tools(cwd);
			const anchor = await anchorOfTwo(h);
			const res = await h.edit({
				path: "f.txt",
				edits: [{ op: "ins", anchor_after: `${anchor}:two`, lines: ["X"] }],
			});
			expect(res.modelText).toContain("Successfully edited");
			// The salvaged row is TOLD, once — not silently forgiven.
			expect(res.modelText).toContain(
				`[E_BAD_REF] stripped trailing content — using "${anchor}"`,
			);
			expect(await readFile(`${cwd}/f.txt`, "utf-8")).toBe("one\ntwo\nX\nthree\n");
		});
	});

	it("batch path: the same shape inside a multi-item edits array", async () => {
		await withTempFile("f.txt", THREE, async ({ cwd }) => {
			const h = tools(cwd);
			const anchor = await anchorOfTwo(h);
			const res = await h.edit({
				path: "f.txt",
				edits: [
					{ op: "ins", anchor_after: `${anchor}:two`, lines: ["X"] },
					{ op: "replace", anchor_start: anchor, lines: ["TWO"] },
				],
			});
			expect(res.modelText).toContain("Successfully edited");
			expect(await readFile(`${cwd}/f.txt`, "utf-8")).toBe("one\nTWO\nX\nthree\n");
		});
	});

	it("del with a pasted-row anchor still deletes exactly that row (regression guard)", async () => {
		await withTempFile("f.txt", THREE, async ({ cwd }) => {
			const h = tools(cwd);
			const anchor = await anchorOfTwo(h);
			const res = await h.edit({
				path: "f.txt",
				edits: [{ op: "del", anchor_start: `${anchor}:two` }],
			});
			expect(res.modelText).toContain("Successfully edited");
			expect(await readFile(`${cwd}/f.txt`, "utf-8")).toBe("one\nthree\n");
		});
	});

	it("an unresolvable pasted anchor still rejects — never a destructive replace", async () => {
		await withTempFile("f.txt", THREE, async ({ cwd }) => {
			const h = tools(cwd);
			await h.read({ path: "f.txt" });
			const res = await h.edit({
				path: "f.txt",
				edits: [{ op: "ins", anchor_after: "ZZ:ghost line", lines: ["X"] }],
			});
			expect(res.modelText).not.toContain("Successfully edited");
			expect(res.modelText).toMatch(/E_STALE|E_BAD_REF/);
			expect(await readFile(`${cwd}/f.txt`, "utf-8")).toBe(THREE);
		});
	});
});

describe("#261 buildPreparedItem normalize-once (unit)", () => {
	it("salvages a pasted-row anchor_after once, for both bounds", () => {
		const item = buildPreparedItem(
			0,
			"f.txt",
			{ op: "ins", anchor_after: "Yn:line two", lines: ["X"] },
			"/abs/f.txt",
		);
		expect(item.remove_from).toBe("Yn");
		expect(item.remove_to).toBe("Yn");
		expect(item.refWarnings).toEqual([
			`[E_BAD_REF] stripped trailing content — using "Yn" (from "Yn:line two").`,
		]);
	});

	it("salvages anchor_start and anchor_end independently on replace", () => {
		const item = buildPreparedItem(
			0,
			"f.txt",
			{
				op: "replace",
				anchor_start: "Aa:one",
				anchor_end: "Bb:three",
				lines: ["N"],
			},
			"/abs/f.txt",
		);
		expect(item.remove_from).toBe("Aa");
		expect(item.remove_to).toBe("Bb");
		expect(item.refWarnings).toHaveLength(2);
	});

	it("leaves bare anchors, both hint orders and declaration forms verbatim — no warnings", () => {
		const bare = buildPreparedItem(
			0,
			"f.txt",
			{ op: "ins", anchor_after: "Yn", lines: ["X"] },
			"/abs/f.txt",
		);
		expect(bare.remove_from).toBe("Yn");
		expect(bare.refWarnings).toBeUndefined();

		const legacy = buildPreparedItem(
			0,
			"f.txt",
			{ op: "ins", anchor_after: "3:Yn", lines: ["X"] },
			"/abs/f.txt",
		);
		expect(legacy.remove_from).toBe("3:Yn");
		expect(legacy.refWarnings).toBeUndefined();

		const modern = buildPreparedItem(
			0,
			"f.txt",
			{ op: "ins", anchor_after: "Yn:3", lines: ["X"] },
			"/abs/f.txt",
		);
		expect(modern.remove_from).toBe("Yn:3");
		expect(modern.refWarnings).toBeUndefined();

		const declared = buildPreparedItem(
			0,
			"f.txt",
			{ op: "ins", anchor_after: { anchor: "Yn", line: "two" }, lines: ["X"] },
			"/abs/f.txt",
		);
		expect(declared.remove_from).toBe("Yn");
		expect(declared.expectedStart).toBe("two");
		expect(declared.refWarnings).toBeUndefined();
	});
});
