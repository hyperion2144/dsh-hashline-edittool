/**
 * Issue #268: `grep` answered "No matches" for a file the backend refuses as
 * text. One `\0` byte was enough — `ctx.fs.readText` throws `FS_NOT_TEXT`
 * (mapped to `[E_NOT_TEXT]`), and the tool's read loop `continue`d, so the file
 * never reached the JS matcher. `rg -a` finds such a line, and so must we.
 *
 * The refusal is a BACKEND behaviour, so it is not stubbed at the tool seam:
 * these tests drive the real {@link ctxFsIO} bridge over a `ctx.fs` mock that
 * reproduces it, with the real `grep` tool over real files on disk.
 *
 * The `rg` pre-filter is deliberately NOT bypassed here (the mock backend still
 * lets `grep` list its candidates with ripgrep): a match that sits AFTER the
 * NUL byte is the case that would survive a read-path fix and still be dropped
 * one layer earlier, so the directory search below pins it.
 * @module dsh-hashline-edittool/issue-268-grep-binary.test
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve as nodeResolve } from "node:path";
import {
	ctxFsIO,
	localIO,
	type FileIO,
} from "../../src/infra/fs-bridge.js";
import { TOLERANT_READ_MAX_BYTES } from "../../src/infra/constants.js";
import { applyEffective } from "../../src/config.js";
import {
	getText,
	setupIntegrationTest,
	withTempBytes,
	withTempDir,
} from "../support/fixtures.js";

afterEach(() => {
	// The per-response budget is global state: restore the compiled defaults so
	// the spill test below cannot leak into any suite that runs after it.
	applyEffective(undefined);
});

/** The subset of `ctx.fs` the grep read path touches, as a `dsh-fs` backend behaves. */
interface FakeFsOptions {
	/** Fail every `readBytes` the way an over-ceiling backend does. */
	bytesFail?: string;
}

/**
 * A `ctx.fs` that refuses binary content the way `dsh-fs` does: `readText`
 * throws `FS_NOT_TEXT` for a file carrying a NUL byte, while `readBytes` is the
 * no-decoding, no-rejection seam.
 *
 * Every call is recorded, so a test can assert WHICH seam a read used.
 */
function makeDshFs(options: FakeFsOptions = {}) {
	const calls: string[] = [];
	const withCode = (code: string) => Object.assign(new Error(code), { code });
	const fs = {
		async resolve(path: string, opts?: { cwd?: string }) {
			calls.push("resolve");
			const absolute = nodeResolve(opts?.cwd ?? process.cwd(), path);
			return { targetKey: absolute, displayPath: absolute };
		},
		processPath(target: { displayPath: string }) {
			return target.displayPath;
		},
		async stat(target: { displayPath: string }) {
			calls.push("stat");
			const bytes = await readFile(target.displayPath);
			return { version: `v-${bytes.byteLength}`, type: "file", size: bytes.byteLength };
		},
		async readText(target: { displayPath: string }, signal?: AbortSignal) {
			calls.push("readText");
			let bytes: Buffer;
			// A backend reports an abort as an abort, not as a missing file — the
			// distinction the tool's skip path keys on.
			if (signal?.aborted === true) throw withCode("FS_ABORTED");
			try {
				bytes = await readFile(target.displayPath);
			} catch (error) {
				// A directory is not a text file; anything else absent is not found.
				const code = (error as NodeJS.ErrnoException).code;
				throw withCode(code === "EISDIR" ? "FS_NOT_REGULAR_FILE" : "FS_NOT_FOUND");
			}
			if (bytes.includes(0)) throw withCode("FS_NOT_TEXT");
			return bytes.toString("utf-8");
		},
		async readBytes(
			target: { displayPath: string },
			_signal: AbortSignal | undefined,
			maxBytes: number,
		) {
			calls.push("readBytes");
			if (options.bytesFail !== undefined) throw withCode(options.bytesFail);
			const bytes = await readFile(target.displayPath);
			if (bytes.byteLength > maxBytes) throw withCode("FS_TOO_LARGE");
			return new Uint8Array(bytes);
		},
	};
	return { fs, calls };
}

/**
 * The write half of the bridge contract. The grep read path must never reach it
 * — a call here means the tool took a path it has no business taking.
 */
function makeCtx() {
	const events: string[] = [];
	return {
		// grep never writes: a waterfall here means it reached the write half.
		waterfall: () => {
			throw new Error("unexpected ctx.waterfall on the grep read path");
		},
		// The read path DOES emit `fs/observed` — through `io.emitObserved`, the
		// event the observation policy keys on — so this records rather than
		// throws: swallowing that call would hide the emission.
		emit: (name: string) => {
			events.push(name);
		},
		events,
	};
}

/** A {@link FileIO} over the binary-refusing backend, i.e. the DSH deployment. */
function dshIO(options: FakeFsOptions = {}): { io: FileIO; calls: string[] } {
	const { fs, calls } = makeDshFs(options);
	return { io: ctxFsIO(fs as never, makeCtx() as never), calls };
}

type GrepTool = {
	execute(
		_id: string,
		params: Record<string, unknown>,
	): Promise<{ content: Array<{ text?: string }> }>;
};

function grepTool(h: ReturnType<typeof setupIntegrationTest>): GrepTool {
	return h.getTool("grep") as unknown as GrepTool;
}

const runGrep = async (
	h: ReturnType<typeof setupIntegrationTest>,
	params: Record<string, unknown>,
): Promise<string> => getText(await grepTool(h).execute("g", params));

/** One row of a grep section, by its content. */
function rowOf(out: string, content: string): string {
	const row = out.split("\n").find((line) => line.includes(content));
	expect(row, `no row containing ${JSON.stringify(content)} in:\n${out}`).toBeDefined();
	return row!;
}

describe("ctxFsIO.readTextTolerant (#268)", () => {
	it("returns the content the backend refused as text, NUL bytes included", async () => {
		const bytes = Buffer.from("hello\0 world\nsecond line\n", "utf-8");
		await withTempBytes("binaryish", bytes, async ({ path }) => {
			const { io } = dshIO();
			// The precondition: this is exactly the refusal the bug reported.
			await expect(io.readText(path)).rejects.toThrow("[E_NOT_TEXT]");
			await expect(io.readTextTolerant(path)).resolves.toEqual({
				text: "hello\0 world\nsecond line\n",
				// …and it says WHICH kind of refusal: the bytes are valid UTF-8, so the
				// text is byte-exact — served and editable (#273).
				fidelity: "lossless",
			});
		});
	});

	it("marks undecodable bytes instead of refusing the file", async () => {
		await withTempBytes("broken", Buffer.from([0x61, 0xff, 0x62, 0x00, 0x63]), async ({ path }) => {
			const { io } = dshIO();
			await expect(io.readText(path)).rejects.toThrow("[E_NOT_TEXT]");
			await expect(io.readTextTolerant(path)).resolves.toEqual({
				// The undecodable byte is marked; the NUL is passed through as itself.
				text: "a\uFFFDb\0c",
				fidelity: "lossy",
			});
		});
	});

	it("bounds the fallback by the documented ceiling", async () => {
		const { fs, calls } = makeDshFs();
		let seen: number | undefined;
		const spy = {
			...fs,
			async readBytes(
				target: { displayPath: string },
				signal: AbortSignal | undefined,
				maxBytes: number,
			) {
				seen = maxBytes;
				return fs.readBytes(target, signal, maxBytes);
			},
		};
		const io = ctxFsIO(spy as never, makeCtx() as never);

		await withTempBytes("binaryish", Buffer.from("a\0b\n"), async ({ path }) => {
			await io.readTextTolerant(path);
		});

		expect(seen).toBe(TOLERANT_READ_MAX_BYTES);
		// Pin the number, not the alias: two names for one ceiling must not drift.
		expect(TOLERANT_READ_MAX_BYTES).toBe(100 * 1024 * 1024);
		// ONE readText for a file already known to be refused — the refusal is the
		// signal, so re-reading it through the same door would be a wasted round trip.
		expect(calls.filter((call) => call === "readText")).toHaveLength(1);
		expect(calls).toContain("readBytes");
	});

	it("keeps plain text on the ordinary read path — no raw-bytes read", async () => {
		await withTempBytes("plain.txt", Buffer.from("just text\n", "utf-8"), async ({ path }) => {
			const { io, calls } = dshIO();
			await expect(io.readTextTolerant(path)).resolves.toEqual({ text: "just text\n", fidelity: "native" });
			expect(calls).toContain("readText");
			expect(calls).not.toContain("readBytes");
		});
	});

	it("still reports a missing file as not-found, never as unreadable bytes", async () => {
		const { io, calls } = dshIO();
		await expect(io.readTextTolerant("/no/such/file-268.txt")).rejects.toThrow(
			"[E_NOT_FOUND]",
		);
		expect(calls).not.toContain("readBytes");
	});

	it("is the same read as readText on the local backend", async () => {
		// The local bridge never refused binary content, so the tolerant read must
		// not change what a local deployment already answered.
		await withTempBytes("binaryish", Buffer.from("hello\0 world\n"), async ({ path }) => {
			const io = localIO();
			const read = await io.readTextTolerant(path);
			expect(read.text).toBe(await io.readText(path));
			// Nothing is ever refused here: a byte-exact decode is native (#273).
			expect(read.fidelity).toBe("native");
		});
	});
});

