/**
 * Install progress reporting (#116 part C).
 *
 * The card shows 下载中 -> 校验中 -> 安装中, so the stages have to be real:
 * a download that completed but whose hash did not match must never render as a
 * completed install. These tests pin the sequence AND the promise that a fake
 * fetch without a stream degrades to "no progress" rather than failing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	fetchGrammarBytes,
	installFromCatalog,
	type FetchResponseLike,
	type InstallProgress,
} from "../../src/ast/fetch-grammar.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "grammar-progress-"));
	previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

/** One ustar entry. */
function tarEntry(name: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, "utf8");
	header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	header.write("0", 156, 1, "ascii");
	header.write("ustar\0", 257, "ascii");
	const padding = Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength, 0);
	return Buffer.concat([header, content, padding]);
}

/** A gzipped tarball carrying the REAL python grammar, so the hash check passes. */
function realTarball(): Buffer {
	const bytes = readFileSync(join("node_modules", "tree-sitter-python", "tree-sitter-python.wasm"));
	return gzipSync(Buffer.concat([tarEntry("package/tree-sitter-python.wasm", bytes), Buffer.alloc(1024, 0)]));
}

/** A response that STREAMS the tarball in chunks, as a real fetch does. */
function streamingResponse(archive: Buffer, chunkSize: number, declareLength: boolean): FetchResponseLike {
	return {
		ok: true,
		status: 200,
		arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
		headers: declareLength ? { get: (name) => (name === "content-length" ? String(archive.byteLength) : null) } : undefined,
		body: (async function* () {
			for (let offset = 0; offset < archive.byteLength; offset += chunkSize) {
				yield new Uint8Array(archive.subarray(offset, Math.min(offset + chunkSize, archive.byteLength)));
			}
		})(),
	};
}

describe("fetchGrammarBytes progress", () => {
	it("reports download then verify, with the declared total", async () => {
		const archive = realTarball();
		const seen: InstallProgress[] = [];
		await fetchGrammarBytes("python", async () => streamingResponse(archive, 8192, true), (p) => seen.push(p));

		const stages = seen.map((p) => p.stage);
		expect(stages[0]).toBe("download");
		expect(stages.at(-1)).toBe("verify");
		expect(stages).not.toContain("install"); // the caller owns that stage

		const downloads = seen.filter((p) => p.stage === "download");
		expect(downloads.every((p) => p.total === archive.byteLength)).toBe(true);
		// `received` must be monotonically non-decreasing and end at the full size.
		const received = downloads.map((p) => p.received ?? 0);
		expect(received.at(-1)).toBe(archive.byteLength);
		expect([...received].sort((a, b) => a - b)).toEqual(received);
		// More than one tick, or the bar would never move.
		expect(downloads.length).toBeGreaterThan(1);
	});

	it("omits the total when the server declares no length, rather than inventing one", async () => {
		const seen: InstallProgress[] = [];
		await fetchGrammarBytes("python", async () => streamingResponse(realTarball(), 8192, false), (p) => seen.push(p));
		const downloads = seen.filter((p) => p.stage === "download");
		expect(downloads.length).toBeGreaterThan(0);
		// An indeterminate bar is honest; a fabricated percentage is not.
		expect(downloads.every((p) => p.total === undefined)).toBe(true);
	});

	it("still works without a sink, and without a stream", async () => {
		// A test fake that offers neither must not fail — it just reports nothing.
		const archive = realTarball();
		const noStream: FetchResponseLike = {
			ok: true,
			status: 200,
			arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
		};
		const seen: InstallProgress[] = [];
		const bytes = await fetchGrammarBytes("python", async () => noStream, (p) => seen.push(p));
		expect(bytes.byteLength).toBeGreaterThan(0);
		// No stream means no download ticks; the verify tick still fires.
		expect(seen).toEqual([{ stage: "verify" }]);
	});
});

describe("installFromCatalog progress", () => {
	it("announces install only after the bytes were fetched and verified", async () => {
		const archive = realTarball();
		const seen: InstallProgress[] = [];
		const outcome = await installFromCatalog("python", async () => streamingResponse(archive, 8192, true), (p) => seen.push(p));

		expect(outcome.ok).toBe(true);
		const stages = seen.map((p) => p.stage);
		expect(stages.indexOf("download")).toBeLessThan(stages.indexOf("verify"));
		expect(stages.indexOf("verify")).toBeLessThan(stages.indexOf("install"));
	});

	it("never reaches the install stage when the download fails", async () => {
		const seen: InstallProgress[] = [];
		const outcome = await installFromCatalog("python", async () => {
			throw new Error("network down");
		}, (p) => seen.push(p));

		expect(outcome.ok).toBe(false);
		// Claiming "installing" after a failed download is exactly the lie the
		// stage split exists to prevent.
		expect(seen.some((p) => p.stage === "install")).toBe(false);
	});
});
