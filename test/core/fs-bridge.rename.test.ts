/**
 * The guarded rename seam on {@link ctxFsIO}: the two-sided policy fence, the
 * local-only probe, the symlink refusal, the destination-exists refusal, and
 * the source version re-check before `node:fs.rename`.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { ctxFsIO } from "../../src/infra/fs-bridge.js";

const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SRC = "/workspace/src.ts";
const DEST = "/workspace/dest.ts";

interface MockOptions {
	allow?: boolean;
	remote?: boolean;
	symlink?: boolean;
	destExists?: boolean;
	sourceVersions?: string[];
	destVersion?: string;
}

function notFound(): Error {
	return Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
}

function mockFs(srcHost: string, destHost: string, options: MockOptions = {}) {
	const sourceVersions = [...(options.sourceVersions ?? ["v1", "v1", "v1", "v1"])];
	const hostOf = new Map<string, string>([
		[SRC, srcHost],
		[DEST, destHost],
	]);
	const fs = {
		lstat: vi.fn(async (input: unknown) => {
			const key = typeof input === "string" ? input : "";
			if (key === DEST && options.destExists !== true) throw notFound();
			if (key === SRC) return { type: options.symlink === true ? "symlink" : "file" };
			return { type: "file" };
		}),
		resolve: vi.fn(async (input: unknown) => ({
			targetKey: typeof input === "string" ? input : "",
		})),
		processPath: vi.fn((target: { targetKey: string }) => hostOf.get(target.targetKey) ?? target.targetKey),
		processPathFromHostPath: vi.fn((path: string) => (options.remote === true ? undefined : path)),
		stat: vi.fn(async (target: { targetKey: string }) => {
			if (target.targetKey === DEST) {
				if (options.destExists !== true) throw notFound();
				return { type: "file", version: options.destVersion ?? "v1" };
			}
			return { type: "file", version: sourceVersions.shift() ?? "v1" };
		}),
		contains: vi.fn(() => options.allow !== false),
	};
	return fs;
}

async function tempPair(): Promise<{ dir: string; src: string; dest: string }> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-rename-bridge-"));
	cleanup.push(dir);
	const src = join(dir, "src.ts");
	const dest = join(dir, "dest.ts");
	await writeFile(src, "x\n", "utf-8");
	return { dir, src, dest };
}

const writePolicy: SandboxExecutionPolicy = {
	mode: "workspace-write",
	workspaceRoot: "/workspace",
};

const readOnlyPolicy: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: "/workspace" };
const fullPolicy: SandboxExecutionPolicy = {
	mode: "danger-full-access",
	workspaceRoot: "/workspace",
};

describe("ctxFsIO.renameFile", () => {
	it("renames under workspace-write when a writable root contains both sides", async () => {
		const { dir, src, dest } = await tempPair();
		const fs = mockFs(src, dest);
		const io = ctxFsIO(fs as never, {} as Context);

		const expected = await io.probeFile(SRC, dir);
		const outcome = await io.renameFile(SRC, DEST, dir, expected, undefined, writePolicy);

		expect(outcome).toEqual({ from: src, to: dest });
		expect(existsSync(src)).toBe(false);
		expect(existsSync(dest)).toBe(true);
	});

	it("refuses in read-only mode", async () => {
		const { dir, src, dest } = await tempPair();
		const io = ctxFsIO(mockFs(src, dest) as never, {} as Context);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, readOnlyPolicy),
		).rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
		expect(existsSync(src)).toBe(true);
	});

	it("refuses when the fence does not contain a side", async () => {
		const { dir, src, dest } = await tempPair();
		const fs = mockFs(src, dest, { allow: false });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, writePolicy),
		).rejects.toMatchObject({ code: "FS_SANDBOX_DENIED" });
		expect(fs.contains).toHaveBeenCalled();
		expect(existsSync(src)).toBe(true);
	});

	it("renames under danger-full-access without consulting writable roots", async () => {
		const { dir, src, dest } = await tempPair();
		const fs = mockFs(src, dest, { allow: false });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(SRC, dir);

		const outcome = await io.renameFile(SRC, DEST, dir, expected, undefined, fullPolicy);

		expect(outcome).toEqual({ from: src, to: dest });
		expect(fs.contains).not.toHaveBeenCalled();
		expect(existsSync(dest)).toBe(true);
	});

	it("refuses a backend whose process path is not a host path", async () => {
		const { dir, src, dest } = await tempPair();
		const io = ctxFsIO(mockFs(src, dest, { remote: true }) as never, {} as Context);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, fullPolicy),
		).rejects.toThrow(/\[E_RENAME_UNSUPPORTED\]/);
		expect(existsSync(src)).toBe(true);
	});

	it("refuses a symlink source", async () => {
		const { dir, src, dest } = await tempPair();
		const io = ctxFsIO(mockFs(src, dest, { symlink: true }) as never, {} as Context);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, fullPolicy),
		).rejects.toThrow(/\[E_SYMLINK\]/);
		expect(existsSync(src)).toBe(true);
	});

	it("refuses a destination that is another file", async () => {
		const { dir, src, dest } = await tempPair();
		const io = ctxFsIO(
			mockFs(src, dest, { destExists: true, destVersion: "v9" }) as never,
			{} as Context,
		);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, fullPolicy),
		).rejects.toThrow(/\[E_EXISTS\]/);
		expect(existsSync(src)).toBe(true);
		expect(existsSync(dest)).toBe(false);
	});

	it("refuses when the source version changed before the rename", async () => {
		const { dir, src, dest } = await tempPair();
		const io = ctxFsIO(
			mockFs(src, dest, { sourceVersions: ["v1", "v1", "v2"] }) as never,
			{} as Context,
		);
		const expected = await io.probeFile(SRC, dir);

		await expect(
			io.renameFile(SRC, DEST, dir, expected, undefined, writePolicy),
		).rejects.toThrow(/\[E_RENAME_STALE\]/);
		expect(existsSync(src)).toBe(true);
	});
});
