/**
 * Issue #271: a backend's "too large to read" refusal (`FS_TOO_LARGE`, the
 * documented outcome of `readBytes` past its `maxBytes`) fell through
 * `mapFsError`'s whitelist and reached the caller as the raw backend error —
 * `message: "FS_TOO_LARGE"` with no `[E_*]` domain code, no path, no next
 * step. Every other `FS_*` refusal maps; this one must too.
 *
 * The mapping test drives the production `mapFsError` directly (no mocks);
 * the end-to-end test pins the #268 contract through `ctxFsIO` + the real
 * grep tool: mapping the code must NOT turn grep's silent skip of an
 * unreadable file into a surfaced error.
 * @module dsh-hashline-edittool/issue-271-too-large-mapping.test
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ctxFsIO, mapFsError } from "../../src/infra/fs-bridge.js";
import { setupIntegrationTest, withTempDir } from "../support/fixtures.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A backend error with an `FsError`-shaped code, as dsh-fs throws them. */
function withCode(code: string): Error {
	return Object.assign(new Error(code), { code });
}

describe("mapFsError maps FS_TOO_LARGE (#271)", () => {
	it("maps the refusal onto the [E_TOO_LARGE] domain code, with the path", () => {
		expect(() => mapFsError(withCode("FS_TOO_LARGE"), "/tmp/big.log")).toThrow(
			"[E_TOO_LARGE]",
		);
		expect(() => mapFsError(withCode("FS_TOO_LARGE"), "/tmp/big.log")).toThrow(
			"/tmp/big.log",
		);
	});

	it("keeps every other mapping intact (regression guard on the whitelist)", () => {
		expect(() => mapFsError(withCode("FS_NOT_FOUND"), "/p")).toThrow("[E_NOT_FOUND]");
		expect(() => mapFsError(withCode("FS_PERMISSION_DENIED"), "/p")).toThrow("[E_ACCESS]");
		expect(() => mapFsError(withCode("FS_NOT_TEXT"), "/p")).toThrow("[E_NOT_TEXT]");
		expect(() => mapFsError(withCode("FS_ABORTED"), "/p")).toThrow("Operation aborted");
	});
});

describe("mapping FS_TOO_LARGE keeps the #268 grep contract", () => {
	it("a file whose raw read is too large is still skipped silently — the rest still answer", async () => {
		await withTempDir("grep-271-", async (cwd) => {
			await writeFile(join(cwd, "plain.txt"), "needle in plain text\n");
			await writeFile(join(cwd, "huge.bin"), Buffer.from("x\0needle\n", "utf-8"));

			// A `ctx.fs` whose readText refuses the NUL-bearing file as text and
			// whose readBytes (the tolerant fallback) answers FS_TOO_LARGE — the
			// mapped error now carries [E_TOO_LARGE], and grep must still skip
			// the file instead of surfacing it.
			const calls: string[] = [];
			const fs = {
				resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => {
					const abs = (await import("node:path")).resolve(opts?.cwd ?? process.cwd(), path);
					calls.push("resolve");
					return { targetKey: abs, displayPath: abs };
				}),
				processPath: (target: { displayPath: string }) => target.displayPath,
				readText: vi.fn(async (target: { displayPath: string }) => {
					calls.push("readText");
					const bytes = await (await import("node:fs/promises")).readFile(target.displayPath);
					if (bytes.includes(0)) throw withCode("FS_NOT_TEXT");
					return bytes.toString("utf-8");
				}),
				readBytes: vi.fn(async (target: { displayPath: string }) => {
					calls.push("readBytes");
					throw withCode("FS_TOO_LARGE");
				}),
				stat: vi.fn(async (target: { displayPath: string }) => {
					calls.push("stat");
					const bytes = await (await import("node:fs/promises")).readFile(target.displayPath);
					return { version: `v-${bytes.byteLength}`, type: "file", size: bytes.byteLength };
				}),
			};
			const unexpected = () => {
				throw new Error("unexpected ctx.waterfall on the grep read path");
			};
			const ctx = { waterfall: unexpected, emit: () => undefined } as unknown as Context;

			const { io } = { io: ctxFsIO(fs as never, ctx) };
			const harness = setupIntegrationTest(cwd, io);
			const result = await harness.getTool("grep").execute("g", { path: ".", pattern: "needle" });
			const text = (result as { content: Array<{ text?: string }> }).content
				.map((part) => part.text ?? "")
				.join("");

			expect(text).toContain("needle in plain text");
			expect(text).not.toContain("huge.bin");
			expect(text).not.toContain("[E_TOO_LARGE]");
			expect(text).not.toContain("FS_TOO_LARGE");
			// readBytes is only reached after readText throws FS_NOT_TEXT, so its
			// presence proves the fallback ran ("read failed, then skipped")
			// instead of the file never being read at all.
			expect(calls).toContain("readText");
			expect(calls).toContain("readBytes");
		});
	});
});
