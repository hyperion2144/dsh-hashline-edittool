/**
 * `.editorconfig` reading — the minimal, honest subset.
 *
 * The plugin's slice is two keys and exact-name sections; everything else
 * MUST fall back rather than guess. These tests pin both directions: what is
 * read, and what is deliberately not.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readIndentFromEditorconfig } from "../../src/lsp/editorconfig.js";
import { resolveIndentOptions } from "../../src/lsp/format/options.js";

const io = {
	readText: async (p: string) => readFileSync(p, "utf-8"),
} as never;

let dir: string;
afterEach(async () => {
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

async function inTemp(files: Record<string, string>): Promise<{ file: string; root: string }> {
	dir = await mkdtemp(join(tmpdir(), "editorconfig-"));
	for (const [name, content] of Object.entries(files)) {
		const path = join(dir, name);
		if (name.includes("/")) await mkdir(join(dir, name.split("/")[0]!), { recursive: true });
		await writeFile(path, content, "utf-8");
	}
	return { file: join(dir, "a.ts"), root: dir };
}

describe("readIndentFromEditorconfig", () => {
	it("reads indent_style and indent_size from [*]", async () => {
		const { file, root } = await inTemp({
			".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 2\n",
		});
		expect(await readIndentFromEditorconfig(io, file, root)).toEqual({
			insertSpaces: true,
			tabSize: 2,
		});
	});

	it("reads tabs", async () => {
		const { file, root } = await inTemp({
			".editorconfig": "[*]\nindent_style = tab\n",
		});
		expect(await readIndentFromEditorconfig(io, file, root)).toEqual({
			insertSpaces: false,
		});
	});

	it("matches an exact-basename section", async () => {
		const { file, root } = await inTemp({
			".editorconfig": "[a.ts]\nindent_size = 8\n",
		});
		expect(await readIndentFromEditorconfig(io, file, root)).toEqual({ tabSize: 8 });
	});

	it("ignores glob sections — unsupported falls back, not guesses", async () => {
		const { file, root } = await inTemp({
			".editorconfig": "[*.{ts,tsx}]\nindent_size = 2\n",
		});
		expect(await readIndentFromEditorconfig(io, file, root)).toBeUndefined();
	});

	it("walks up to a parent directory's file", async () => {
		dir = await mkdtemp(join(tmpdir(), "editorconfig-"));
		await writeFile(
			join(dir, ".editorconfig"),
			"[*]\nindent_style = tab\nindent_size = 2\n",
			"utf-8",
		);
		await mkdir(join(dir, "sub"), { recursive: true });
		await writeFile(join(dir, "sub", "a.ts"), "", "utf-8");
		expect(await readIndentFromEditorconfig(io, join(dir, "sub", "a.ts"), dir)).toEqual({
			insertSpaces: false,
			tabSize: 2,
		});
	});

	it("returns undefined outside the workspace root", async () => {
		dir = await mkdtemp(join(tmpdir(), "editorconfig-"));
		await writeFile(join(dir, ".editorconfig"), "[*]\nindent_size = 2\n", "utf-8");
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "nested", "a.ts"), "", "utf-8");
		// The workspace root is the NESTED directory: the walk must not climb
		// out of it to the parent's config.
		expect(
			await readIndentFromEditorconfig(io, join(dir, "nested", "a.ts"), join(dir, "nested")),
		).toBeUndefined();
	});

	it("returns undefined with no file in scope", async () => {
		const { file, root } = await inTemp({});
		expect(await readIndentFromEditorconfig(io, file, root)).toBeUndefined();
	});
});

describe("resolveIndentOptions", () => {
	it("prefers the heuristic when the setting is off", async () => {
		const { file, root } = await inTemp({
			".editorconfig": "[*]\nindent_style = tab\n",
			"a.ts": "const a = {\n  b: 1,\n};\n",
		});
		expect(
			await resolveIndentOptions(io, file, "const a = {\n  b: 1,\n};\n", false),
		).toEqual({ insertSpaces: true, tabSize: 2 });
		void root;
	});

	it("composes per key: config's style, the file's width", async () => {
		await inTemp({
			// Only a style, no size: the width comes from the file (2 spaces).
			".editorconfig": "[a.ts]\nindent_style = tab\n",
			"a.ts": "",
		});
		expect(await resolveIndentOptions(io, join(dir, "a.ts"), "", true)).toEqual({
			insertSpaces: false,
			tabSize: 4,
		});
	});

	it("config wins outright when it names both keys", async () => {
		await inTemp({
			".editorconfig": "[*]\nindent_style = space\nindent_size = 8\n",
			"a.ts": "",
		});
		expect(await resolveIndentOptions(io, join(dir, "a.ts"), "", true)).toEqual({
			insertSpaces: true,
			tabSize: 8,
		});
	});
});
