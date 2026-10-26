/**
 * The guarded delete seam on {@link ctxFsIO}: policy fences, the local-only
 * probe, the symlink refusal, and the version re-check before `unlink`.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { ctxFsIO } from "../../src/infra/fs-bridge.js";

const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface MockOptions {
	allow: boolean;
	remote?: boolean;
	symlink?: boolean;
	versions?: string[];
}

function mockFs(filePath: string, options: MockOptions) {
	const versions = [...(options.versions ?? ["v1", "v1", "v1"])];
	const contains = vi.fn(() => options.allow);
	const fs = {
		lstat: vi.fn(async () => (options.symlink ? { type: "symlink" } : { type: "file" })),
		resolve: vi.fn(async (input: unknown) => {
			const key = typeof input === "string" ? input : "";
			const root = key === "/workspace" || key === "/tmp" || key === tmpdir();
			return { targetKey: root ? "root" : "file", displayPath: key };
		}),
		processPath: vi.fn((target: { targetKey: string }) =>
			target.targetKey === "root" ? "/tmp" : filePath,
		),
		processPathFromHostPath: vi.fn((path: string) => (options.remote ? undefined : path)),
		stat: vi.fn(async () => ({
			type: "file",
			version: versions.shift() ?? "v1",
		})),
		contains,
	};
	return { fs, contains };
}

async function tempFile(): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-delete-bridge-"));
	cleanup.push(dir);
	const path = join(dir, "file.ts");
	await writeFile(path, "x\n", "utf-8");
	return { dir, path };
}

const writePolicy: SandboxExecutionPolicy = {
	mode: "workspace-write",
	workspaceRoot: "/workspace",
};

const readOnlyPolicy: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: "/workspace" };
const fullPolicy: SandboxExecutionPolicy = { mode: "danger-full-access", workspaceRoot: "/workspace" };

describe("ctxFsIO.deleteFile", () => {
	it("deletes under workspace-write when a writable root contains the target", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: true });
		const io = ctxFsIO(fs as never, {} as Context);

		const expected = await io.probeFile(path, dir);
		const outcome = await io.deleteFile(path, dir, expected, undefined, writePolicy);

		expect(outcome).toEqual({ kind: "deleted", path });
		expect(existsSync(path)).toBe(false);
	});

	it("refuses in read-only mode and leaves the file alone", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: true });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		await expect(io.deleteFile(path, dir, expected, undefined, readOnlyPolicy)).rejects.toMatchObject({
			code: "FS_SANDBOX_DENIED",
		});
		expect(existsSync(path)).toBe(true);
	});

	it("refuses when no writable root contains the target", async () => {
		const { dir, path } = await tempFile();
		const { fs, contains } = mockFs(path, { allow: false });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		await expect(io.deleteFile(path, dir, expected, undefined, writePolicy)).rejects.toMatchObject({
			code: "FS_SANDBOX_DENIED",
		});
		expect(contains).toHaveBeenCalled();
		expect(existsSync(path)).toBe(true);
	});

	it("deletes under danger-full-access without consulting writable roots", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: false });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		const outcome = await io.deleteFile(path, dir, expected, undefined, fullPolicy);

		expect(outcome.kind).toBe("deleted");
		expect(existsSync(path)).toBe(false);
	});

	it("refuses a backend whose process path is not a host path", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: true, remote: true });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		await expect(io.deleteFile(path, dir, expected, undefined, fullPolicy)).rejects.toThrow(
			/\[E_DELETE_UNSUPPORTED\]/,
		);
		expect(existsSync(path)).toBe(true);
	});

	it("refuses a symlink before any unlink", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: true, symlink: true });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		await expect(io.deleteFile(path, dir, expected, undefined, fullPolicy)).rejects.toThrow(/\[E_SYMLINK\]/);
		expect(existsSync(path)).toBe(true);
	});

	it("refuses when the file version changed before the unlink", async () => {
		const { dir, path } = await tempFile();
		const { fs } = mockFs(path, { allow: true, versions: ["v1", "v1", "v2"] });
		const io = ctxFsIO(fs as never, {} as Context);
		const expected = await io.probeFile(path, dir);

		await expect(io.deleteFile(path, dir, expected, undefined, writePolicy)).rejects.toThrow(
			/\[E_DELETE_STALE\]/,
		);
		expect(existsSync(path)).toBe(true);
	});
});
