/**
 * Issue #273: "contains a NUL byte" is not "is a binary file". A file whose
 * bytes are valid UTF-8 — with a NUL anywhere in it — is a text file the
 * backend refuses for a heuristic, and `read`/`edit` refused it wholesale
 * (`[E_NOT_TEXT]`) even though the bytes decode LOSSLESSLY. The refusal
 * belongs to undecodable bytes, not to NUL.
 *
 * The classification seam is `readTextTolerant`, extended with a `fidelity`
 * answer: `native` (read through `readText`), `lossless` (raw bytes, fatal
 * UTF-8 decode succeeded — byte-exact text), `lossy` (raw bytes, U+FFFD
 * substituted — display only). Tools decide by fidelity:
 *
 *  - `read` serves `native`/`lossless` files normally; a `lossy` file renders
 *    unserved rows (`[line N] content`) with a note, minting nothing;
 *  - `edit` works on `lossless` (the write-back is byte-exact) and refuses a
 *    `lossy` file with `[E_LOSSY_BYTES]` — a string-only write seam cannot
 *    preserve undecodable bytes, so writing back would corrupt them;
 *  - `grep` upgrades `lossless` hits to served rows (#268 kept them unserved);
 *    `lossy` rows stay unserved;
 *  - `undo`/`write` read through the tolerant seam too (undo re-checks a file
 *    the backend refuses; write's pre-read must not refuse a NUL file).
 *
 * Every tool-level case runs over `ctxFsIO` + a fake backend that refuses
 * NUL-bearing and non-UTF-8 files exactly like `dsh-fs-local` does.
 * @module dsh-hashline-edittool/issue-273-nul-text-policy.test
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import {
	ctxFsIO,
	localIO,
	type FileIO,
} from "../../src/infra/fs-bridge.js";
import { buildWriteShadowTool } from "../../src/tools/tool-write-shadow.js";
import { outputSchemaOf, schemaViolations } from "../support/schema-check.js";
import {
	makeExec,
	setupIntegrationTest,
	withTempBytes,
	withTempDir,
	withTempFile,
} from "../support/fixtures.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsSandboxController } from "../../src/infra/sandbox.js";
import { applyEffective } from "../../src/config.js";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath } from "../../src/infra/paths.js";

/** A backend error with an `FsError`-shaped code, as dsh-fs throws them. */
function withCode(code: string): Error {
	return Object.assign(new Error(code), { code });
}

/** Unconfined sandbox controller for direct-execute tools (test default). */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

/** The UTF-8 replacement character a lossy decode produces. */
const REPLACEMENT = "\uFFFD";

interface FakeFs {
	fs: FileSystem;
	/** Every `writeText` content the fake backend accepted, in order. */
	writes: Array<{ path: string; content: string }>;
}

/**
 * A backend in the `dsh-fs-local` mold: `readText` refuses a file whose bytes
 * carry a NUL or are not valid UTF-8; `readBytes` returns the raw bytes and
 * never refuses; `writeText` writes the string back without sniffing it.
 */
function makeStrictFs(): FakeFs {
	const writes: FakeFs["writes"] = [];
	const readBytes = async (target: { displayPath: string }) =>
		readFile(target.displayPath);
	const fs = {
		resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => {
			const { resolve } = await import("node:path");
			const abs = resolve(opts?.cwd ?? process.cwd(), path);
			return { targetKey: abs, displayPath: abs };
		}),
		processPath: (target: { displayPath: string }) => target.displayPath,
		readText: vi.fn(async (target: { displayPath: string }) => {
			const bytes = await readFile(target.displayPath);
			// The two refusal reasons the real backend has: a NUL anywhere in
			// the sampled bytes, and bytes that are not valid UTF-8.
			let validUtf8 = true;
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				validUtf8 = false;
			}
			// The real backend sniffs only the first 8192 bytes for a NUL
			// (dsh-fs-local BINARY_SAMPLE_BYTES) — match that (review m3).
			const sampled = bytes.subarray(0, 8192);
			if (sampled.includes(0) || !validUtf8) throw withCode("FS_NOT_TEXT");
			return bytes.toString("utf-8");
		}),
		readBytes: vi.fn(readBytes),
		writeText: vi.fn(
			async (
				target: { displayPath: string },
				content: string,
			) => {
				writes.push({ path: target.displayPath, content });
				await writeFile(target.displayPath, content, "utf-8");
				return { operation: "update", version: "v-written" };
			},
		),
		stat: vi.fn(async (target: { displayPath: string }) => {
			const bytes = await readFile(target.displayPath);
			return {
				version: `v-${bytes.byteLength}`,
				type: "file" as const,
				size: bytes.byteLength,
			};
		}),
	} as unknown as FileSystem;
	return { fs, writes };
}

function fakeCtx(): Context {
	return {
		waterfall: vi.fn(async () => undefined),
		emit: () => undefined,
	} as unknown as Context;
}

function strictIO(): { io: FileIO; writes: FakeFs["writes"] } {
	const { fs, writes } = makeStrictFs();
	return { io: ctxFsIO(fs, fakeCtx()), writes };
}

function getText(result: unknown): string {
	return (result as { content: Array<{ text?: string }> }).content
		.map((part) => part.text ?? "")
		.join("");
}

describe("readTextTolerant classifies by lossless decode (#273)", () => {
	it("a plain text file is `native`", async () => {
		await withTempFile("a.txt", "plain text\n", async ({ path }) => {
			const { io } = strictIO();
			const answer = await io.readTextTolerant(path);
			expect(answer).toEqual({ text: "plain text\n", fidelity: "native" });
		});
	});

	it("a NUL-bearing but valid-UTF-8 file is `lossless` — the text is byte-exact", async () => {
		const bytes = Buffer.from("head\0tail\nneedle after the nul\n", "utf-8");
		await withTempBytes("nul.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const answer = await io.readTextTolerant(path);
			expect(answer.fidelity).toBe("lossless");
			expect(answer.text).toBe("head\0tail\nneedle after the nul\n");
		});
	});

	it("a file with undecodable bytes is `lossy` — U+FFFD substituted", async () => {
		const bytes = Buffer.concat([
			Buffer.from("text then ", "utf-8"),
			Buffer.from([0xff, 0xfe]),
			Buffer.from(" then end\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const answer = await io.readTextTolerant(path);
			expect(answer.fidelity).toBe("lossy");
			expect(answer.text).toContain(REPLACEMENT);
			expect(answer.text).toContain("text then");
		});
	});

	it("a UTF-8 BOM with NUL bytes is `lossless` — the decode keeps the BOM (ignoreBOM)", async () => {
		const bytes = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("head\0tail\n", "utf-8"),
		]);
		await withTempBytes("bom-nul.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const answer = await io.readTextTolerant(path);
			// Review M1: the default decode STRIPS the BOM, so a byte-perfect BOM
			// file failed the round-trip check and was misclassified as lossy.
			expect(answer.fidelity).toBe("lossless");
			expect(answer.text.startsWith("\uFEFF")).toBe(true);
		});
	});

	it("a NUL beyond the backend's 8192-byte sample window is `native`", async () => {
		const bytes = Buffer.concat([
			Buffer.from(`${"a".repeat(9000)}\n`, "utf-8"),
			Buffer.from("nul\0past the sample\n", "utf-8"),
		]);
		await withTempBytes("late-nul.txt", bytes, async ({ path }) => {
			const { io } = strictIO();
			// The fake must classify exactly what dsh-fs-local classifies: a NUL
			// past the sample window never triggers the refusal.
			expect((await io.readTextTolerant(path)).fidelity).toBe("native");
		});
	});

	it("the byte fallback stays bounded by TOLERANT_READ_MAX_BYTES", async () => {
		await withTempFile("a.txt", "x\0y\n", async ({ path }) => {
			const { fs } = makeStrictFs();
			const spy = fs.readBytes as ReturnType<typeof vi.fn>;
			const io = ctxFsIO(fs, fakeCtx());
			await io.readTextTolerant(path);
			const { TOLERANT_READ_MAX_BYTES } = await import(
				"../../src/infra/constants.js"
			);
			expect(spy).toHaveBeenCalledWith(
				expect.anything(),
				undefined,
				TOLERANT_READ_MAX_BYTES,
			);
		});
	});

	it("a too-large byte read still surfaces as [E_TOO_LARGE] (#271)", async () => {
		await withTempFile("a.txt", "x\0y\n", async ({ path }) => {
			const { fs } = makeStrictFs();
			(fs.readBytes as ReturnType<typeof vi.fn>) = vi.fn(async () => {
				throw withCode("FS_TOO_LARGE");
			});
			const io = ctxFsIO(fs, fakeCtx());
			await expect(io.readTextTolerant(path)).rejects.toThrow("[E_TOO_LARGE]");
		});
	});

	it("localIO never refuses: a NUL file is `native`, undecodable bytes are `lossy`", async () => {
		await withTempDir("local-273-", async (cwd) => {
			const io = localIO();
			const nulPath = join(cwd, "nul.txt");
			const badPath = join(cwd, "bad.txt");
			await writeFile(nulPath, Buffer.from("a\0b\n", "utf-8"));
			await writeFile(
				badPath,
				Buffer.concat([Buffer.from("ok ", "utf-8"), Buffer.from([0xff])]),
			);
			expect(await io.readTextTolerant(nulPath)).toEqual({
				text: "a\0b\n",
				fidelity: "native",
			});
			const lossy = await io.readTextTolerant(badPath);
			expect(lossy.fidelity).toBe("lossy");
			expect(lossy.text).toContain(REPLACEMENT);
		});
	});
});

describe("read over a strict backend (#273)", () => {
	it("a lossless NUL file is served with anchors — editable text", async () => {
		const bytes = Buffer.from("plain line\nnul\0line\nlast line\n", "utf-8");
		await withTempBytes("nul.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const text = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			// Served rows carry anchor markers; nothing renders as unserved.
			expect(text).toMatch(/^\S{2,8}[:|│](?:\d+[:|│])?\s*plain line$/m);
			expect(text).not.toMatch(/^\[line \d+\]/m);
			expect(text).toContain("nul\0line");
		});
	});

	it("a lossy file renders unserved rows plus the refusal note — nothing minted", async () => {
		const bytes = Buffer.concat([
			Buffer.from("first\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nlast\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const text = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			expect(text).toMatch(/^\[line 1\] first$/m);
			expect(text).not.toMatch(/^\s*[A-Za-z0-9]{2,8}:\d+[:|│]/m);
			expect(text.toLowerCase()).toContain("not editable");
			expect(text).toContain(REPLACEMENT);
		});
	});

	it("a lossy view still ends with the ONE window sentence — an unserved page forms a window", async () => {
		const bytes = Buffer.concat([
			Buffer.from("a\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nb\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			// Full read: the tail is the end-of-file sentence, not silence.
			const whole = getText(await harness.readTool.execute("read", { path }));
			expect(whole).toMatch(/^\[line 1\] a$/m);
			expect(whole).toContain("[Lines 1-3 of 3. End of file.]");
			// A user limit cut names the numeric offset — no anchor exists on an
			// unserved row, so the cursor is the line number itself.
			const limited = getText(await harness.readTool.execute("read", { path, limit: 2 }));
			expect(limited).toContain("[Lines 1-2 of 3. Use offset=2 to continue.]");
			// And a limit cut never mints a resume token.
			expect(limited).not.toContain("resume:");
		});
	});

	it("a long lossy read's budget cut still surfaces its resume token", async () => {
		// ~26 bytes/row × 2500 rows ≈ 65K chars > the 48,000-char budget: the
		// page must stop mid-file AND tell the model how to continue — before
		// the fix the token was minted but no sentence carried it.
		const filler = `line ${"x".repeat(20)}\n`;
		const bytes = Buffer.concat([
			Buffer.from([0xff]),
			Buffer.from(filler.repeat(2500), "utf-8"),
		]);
		await withTempBytes("big-bad.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const text = getText(await harness.readTool.execute("read", { path }));
			expect(text).toMatch(/^\[line 1\] /m);
			expect(text).toContain("Omitted ");
			expect(text).toMatch(/Use read \{resume: "[^"]+"\} to continue\.\]/m);
		});
	});

	it("a lossy read in JSON mode carries the rows and the refusal — never an empty payload", async () => {
		const bytes = Buffer.concat([
			Buffer.from("alpha\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nbeta\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			applyEffective({ output_format: "json" });
			try {
				const payload = JSON.parse(
					getText(await harness.readTool.execute("read", { path })),
				) as {
					totalLines: number;
					lines: Record<string, string>;
					unservedRows?: Array<{ number: number; text: string }>;
					warnings?: string[];
				};
				// Review B1: the payload used to carry `lines:{}` and drop the rows
				// entirely — a model could read the file as empty and overwrite it.
				expect(payload.totalLines).toBe(3);
				expect(payload.lines).toEqual({});
				expect(payload.unservedRows).toEqual([
					{ number: 1, text: "alpha" },
					{ number: 2, text: REPLACEMENT },
					{ number: 3, text: "beta" },
				]);
				expect(payload.warnings?.join("\n")).toContain("not editable");
			} finally {
				applyEffective({ output_format: "text" });
			}
		});
	});
});

describe("edit over a strict backend (#273)", () => {
	it("a lossless NUL file edits through, and the write-back is byte-exact", async () => {
		const bytes = Buffer.from("keep\0me\nnul\0line\nlast line\n", "utf-8");
		await withTempBytes("nul.log", bytes, async ({ path }) => {
			const { io, writes } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const readText = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			const anchor = /^\s*([A-Za-z0-9]{2,8})(?::\d+)?[:|│]\s*nul\0line$/m.exec(
				readText,
			)?.[1];
			expect(anchor).toBeDefined();

			const result = await harness.editTool.execute("edit", {
				path,
				edits: [
					{
						op: "replace",
						anchor_start: anchor!,
						anchor_end: anchor!,
						lines: ["nul\0REPLACED"],
					},
				],
			});
			expect(getText(result)).toContain("Successfully edited");

			// The write-back string is the ORIGINAL text with only the edited
			// line replaced — no U+FFFD anywhere, the untouched NUL intact.
			expect(writes).toHaveLength(1);
			expect(writes[0]!.content).toBe(
				"keep\0me\nnul\0REPLACED\nlast line\n",
			);
			const onDisk = await readFile(path);
			expect(onDisk.equals(Buffer.from("keep\0me\nnul\0REPLACED\nlast line\n", "utf-8"))).toBe(true);
		});
	});

	it("a BOM+NUL lossless file edits through, and the write-back is byte-exact (BOM re-attached)", async () => {
		const bytes = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("keep\0me\nnul\0line\nlast line\n", "utf-8"),
		]);
		await withTempBytes("bom-nul.log", bytes, async ({ path }) => {
			const { io, writes } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const readText = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			const anchor = /^\s*([A-Za-z0-9]{2,8})(?::\d+)?[:|│]\s*nul\0line$/m.exec(
				readText,
			)?.[1];
			expect(anchor).toBeDefined();
			const result = await harness.editTool.execute("edit", {
				path,
				edits: [
					{
						op: "replace",
						anchor_start: anchor!,
						anchor_end: anchor!,
						lines: ["nul\0REPLACED"],
					},
				],
			});
			expect(getText(result)).toContain("Successfully edited");
			const expected = Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from("keep\0me\nnul\0REPLACED\nlast line\n", "utf-8"),
			]);
			expect(writes).toHaveLength(1);
			expect((await readFile(path)).equals(expected)).toBe(true);
		});
	});

	it("a lossy file is refused with [E_LOSSY_BYTES]; nothing is written", async () => {
		const bytes = Buffer.concat([
			Buffer.from("first\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nlast\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path }) => {
			const { io, writes } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			// No anchors exist (the read was unserved); the refusal fires at the
			// read stage before any anchor verdict could.
			const result = await harness.editTool.execute("edit", {
				path,
				edits: [
					{
						op: "replace",
						anchor_start: "aa",
						anchor_end: "aa",
						lines: ["x"],
					},
				],
			});
			expect(getText(result)).toContain("[E_LOSSY_BYTES]");
			expect(getText(result)).toContain(path);
			expect(writes).toHaveLength(0);
			expect((await readFile(path)).equals(bytes)).toBe(true);
		});
	});
});

describe("grep over a strict backend (#273 upgrades #268)", () => {
	it("a lossless NUL file's hits are SERVED (anchored rows)", async () => {
		await withTempDir("grep-273-", async (cwd) => {
			await writeFile(cwd + "/plain.txt", "needle in plain text\n", "utf-8");
			await writeFile(
				cwd + "/nul.log",
				Buffer.from("head\0tail\nneedle after the nul\n", "utf-8"),
			);
			const { io } = strictIO();
			const harness = setupIntegrationTest(cwd, io);
			const text = getText(
				await harness.getTool("grep").execute("g", { path: ".", pattern: "needle" }),
			);
			// nul.log section exists AND its row is anchored, not `[line N]`.
			expect(text).toContain("nul.log");
			expect(text).toMatch(/nul\.log[\s\S]*[A-Za-z0-9]{2,8}[:|][^\n]*needle after the nul/);
			expect(text).not.toContain("[line 2] needle after the nul");
		});
	});

	it("a lossy file's hits stay unserved; no backend code leaks", async () => {
		await withTempDir("grep-273-lossy-", async (cwd) => {
			await writeFile(cwd + "/plain.txt", "needle in plain text\n", "utf-8");
			await writeFile(
				cwd + "/bad.log",
				Buffer.concat([
					Buffer.from("needle then ", "utf-8"),
					Buffer.from([0xff]),
					Buffer.from(" then end\n", "utf-8"),
				]),
			);
			const { io } = strictIO();
			const harness = setupIntegrationTest(cwd, io);
			const text = getText(
				await harness.getTool("grep").execute("g", { path: ".", pattern: "needle" }),
			);
			expect(text).toContain("bad.log");
			expect(text).toMatch(/\[line 1\][^\n]*needle then/);
			expect(text).not.toContain("FS_NOT_TEXT");
		});
	});
});

describe("undo and write over a strict backend (#273)", () => {
	it("undo after a lossless NUL-file edit restores the exact original bytes", async () => {
		const bytes = Buffer.from("keep\0me\nnul\0line\nlast line\n", "utf-8");
		await withTempBytes("nul.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const readText = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			const anchor = /^\s*([A-Za-z0-9]{2,8})(?::\d+)?[:|│]\s*nul\0line$/m.exec(
				readText,
			)?.[1]!;
			await harness.editTool.execute("edit", {
				path,
				edits: [
					{
						op: "replace",
						anchor_start: anchor,
						anchor_end: anchor,
						lines: ["nul\0REPLACED"],
					},
				],
			});
			const undoText = getText(
				await harness.getTool("undo_last_edit").execute("u", { path }),
			);
			expect(undoText).toContain("Undone last edit");
			expect((await readFile(path)).equals(bytes)).toBe(true);
		});
	});
	// The undo entry must survive the store: a NUL body stored as TEXT loses
	// everything past the first NUL on Node 22's node:sqlite, and SQLite's
	// LENGTH() stops at that NUL for TEXT — so the entry goes in as BLOB bytes.
	it("persists the undo entry's NUL body as BLOB bytes, not TEXT", async () => {
		const bytes = Buffer.from("keep\0me\nnul\0line\n", "utf-8");
		await withTempBytes("nul-store.log", bytes, async ({ path }) => {
			const { io } = strictIO();
			const harness = setupIntegrationTest(join(path, ".."), io);
			const readText = getText(
				await harness.readTool.execute("read", { path, offset: 1, limit: 10 }),
			);
			const anchor = /^\s*([A-Za-z0-9]{2,8})(?::\d+)?[:|│]\s*nul\0line$/m.exec(
				readText,
			)?.[1]!;
			await harness.editTool.execute("edit", {
				path,
				edits: [
					{
						op: "replace",
						anchor_start: anchor,
						anchor_end: anchor,
						lines: ["nul\0REPLACED"],
					},
				],
			});

			// Inspect the raw cell the edit just persisted (a fresh store per test,
			// so one row). TEXT here would mean the Node 22 data-loss bug is back.
			const raw = new DatabaseSync(hashStorePath(join(path, "..")), { readOnly: true });
			try {
				const row = raw.prepare("SELECT typeof(content) AS kind, LENGTH(content) AS n FROM undo").get() as {
					kind: string;
					n: number;
				};
				expect(row.kind).toBe("blob");
				expect(row.n).toBe(Buffer.byteLength(bytes, "utf8"));
			} finally {
				raw.close();
			}
		});
	});

	it("write can overwrite a NUL-bearing file (the pre-read no longer refuses)", async () => {
		const bytes = Buffer.from("old\0content\n", "utf-8");
		await withTempBytes("nul.txt", bytes, async ({ path, cwd }) => {
			const { io } = strictIO();
			const tool = buildWriteShadowTool(io, testSandbox());
			const result = await tool.execute(
				{ file_path: path, content: "new\0content with nul\n" },
				makeExec(cwd)({ file_path: path, content: "new\0content with nul\n" }) as never,
			);
			expect(JSON.stringify(result)).not.toContain("E_NOT_TEXT");
			expect(await readFile(path, "utf-8")).toBe("new\0content with nul\n");
		});
	});

	it("overwriting a lossy file: no fabricated diff rows, and the note names the lossy old side", async () => {
		const bytes = Buffer.concat([
			Buffer.from("alpha\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nbeta\n", "utf-8"),
		]);
		await withTempBytes("bad.log", bytes, async ({ path, cwd }) => {
			const { io } = strictIO();
			const tool = buildWriteShadowTool(io, testSandbox());
			const result = (await tool.execute(
				{ file_path: path, content: "fresh content\n" },
				makeExec(cwd)({ file_path: path, content: "fresh content\n" }) as never,
			)) as {
				beforeLossy?: boolean;
				diffRows?: unknown[];
				modelText: string;
				before: string | null;
			};
			// Review M2: `before` holds U+FFFD stand-ins — the per-line diff must
			// not present them as real old lines, and the model must hear why.
			expect(result.beforeLossy).toBe(true);
			expect(result.before).toContain(REPLACEMENT);
			expect(result.diffRows).toBeUndefined();
			expect(result.modelText).toContain("undecodable bytes");
			// The host validates the RETURNED value against this tool's declared output
			// schema and rejects an undeclared field — an `execute`-level test cannot
			// see that rejection, which is how the `modelText` incident shipped.
			expect(schemaViolations(outputSchemaOf(tool), result)).toEqual([]);
			expect(await readFile(path, "utf-8")).toBe("fresh content\n");
		});
	});
});

describe("the read card's presentationMeta over a strict backend (#273)", () => {
	it("carries the flag, the unserved rows and the note for a lossy view", async () => {
		const bytes = Buffer.concat([
			Buffer.from("alpha\n", "utf-8"),
			Buffer.from([0xff]),
			Buffer.from("\nbeta\n", "utf-8"),
		]);
		await withTempBytes("card.log", bytes, async ({ path, cwd }) => {
			const { io } = strictIO();
			const { buildReadTool } = await import("../../src/tools/tool-read.js");
			const tool = buildReadTool(io);
			const value = (await tool.execute({ path }, makeExec(cwd)({ path }) as never)) as Record<string, unknown>;
			const meta = (tool.output as unknown as {
				presentationMeta: (args: unknown, v: unknown) => Record<string, unknown>;
			}).presentationMeta({ path }, value);
			expect(meta.lossy).toBe(true);
			expect(meta.unservedRows).toEqual([
				{ number: 1, text: "alpha" },
				{ number: 2, text: "\uFFFD" },
				{ number: 3, text: "beta" },
			]);
			expect(String(meta.lossyNote)).toContain("not editable");
		});
	});

	it("carries none of it on an ordinary lossless view", async () => {
		await withTempFile("card.txt", "plain\n", async ({ path, cwd }) => {
			const { io } = strictIO();
			const { buildReadTool } = await import("../../src/tools/tool-read.js");
			const tool = buildReadTool(io);
			const value = (await tool.execute({ path }, makeExec(cwd)({ path }) as never)) as Record<string, unknown>;
			const meta = (tool.output as unknown as {
				presentationMeta: (args: unknown, v: unknown) => Record<string, unknown>;
			}).presentationMeta({ path }, value);
			expect(meta.lossy).toBeUndefined();
			expect(meta.unservedRows).toBeUndefined();
			expect(meta.lossyNote).toBeUndefined();
		});
	});
	it("the returned value conforms to the declared output schema — lossy fields included (review round 2)", async () => {
		const bytes = Buffer.concat([
			Buffer.from("alpha\n", "utf-8"),
			Buffer.from([0xff, 0xfe]),
			Buffer.from("\nbeta\n", "utf-8"),
		]);
		await withTempBytes("schema.log", bytes, async ({ path, cwd }) => {
			const { io } = strictIO();
			const { buildReadTool } = await import("../../src/tools/tool-read.js");
			const { outputSchemaOf, schemaViolations } = await import("../support/schema-check.js");
			const tool = buildReadTool(io);
			const value = (await tool.execute({ path }, makeExec(cwd)({ path }) as never)) as Record<string, unknown>;
			// The lossy fields ride on the value; the host rejects undeclared
			// fields outright (additionalProperties: false) at the session boundary.
			expect(value.lossy).toBe(true);
			expect(schemaViolations(outputSchemaOf(tool), value)).toEqual([]);
		});
	});
});
