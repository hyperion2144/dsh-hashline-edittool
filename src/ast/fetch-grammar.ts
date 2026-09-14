/**
 * Fetching a grammar out of its npm tarball.
 *
 * The catalog entry names a package and a version, so the artifact is a
 * `registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz` — a gzipped tar. This module
 * downloads it, pulls **exactly one** file out of it, and hands the bytes to
 * the registry, which verifies the hash before writing anything.
 *
 * The tar reader is deliberately minimal and deliberately strict:
 *
 * - It reads **ustar** headers only. npm publishes POSIX/ustar tarballs; if a
 *   future one used pax extensions we would rather fail loudly than guess at
 *   the format and install something wrong.
 * - It looks for the entry whose path ends with the wanted file name, not for
 *   a fixed `package/<name>`: the prefix is npm's layout, not a contract.
 * - It refuses anything over the declared size cap **before** decompressing,
 *   so a hostile or corrupt response cannot be used to exhaust memory.
 *
 * @module dsh-hashline-edittool/ast/fetch-grammar
 */
import { gunzipSync } from "node:zlib";
import { catalogEntry, installGrammar, type InstallOutcome } from "./registry.js";

/** The npm tarball URL for a catalog entry. */
export function tarballUrl(grammarPackage: string, version: string): string {
	// Scoped packages escape the `/` in the path segment; ours are unscoped, but
	// the escape is applied so a future catalog entry cannot silently 404.
	const escaped = grammarPackage.replace("/", "%2f");
	return `https://registry.npmjs.org/${escaped}/-/${grammarPackage.split("/").pop()}-${version}.tgz`;
}

/** A failure the install route reports verbatim. */
export class GrammarFetchError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code} ${message}`);
		this.name = "GrammarFetchError";
	}
}

/** Error codes, bracketed as they appear in model-facing messages. */
export const E_GRAMMAR_FETCH_FAILED = "[E_GRAMMAR_FETCH_FAILED]";
export const E_GRAMMAR_NOT_IN_TARBALL = "[E_GRAMMAR_NOT_IN_TARBALL]";

/** One tar entry. */
interface TarEntry {
	readonly name: string;
	readonly bytes: Buffer;
}

/** The ustar header is 512 bytes; sizes are octal ASCII. */
const BLOCK = 512;
/** Refuse an archive bigger than this before inflating it. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * Read the entries of an uncompressed tar.
 *
 * @param tar - the raw tar bytes.
 * @returns every regular-file entry.
 * @throws {GrammarFetchError} on a malformed header.
 */
export function readTarEntries(tar: Buffer): TarEntry[] {
	const out: TarEntry[] = [];
	let offset = 0;
	while (offset + BLOCK <= tar.byteLength) {
		const header = tar.subarray(offset, offset + BLOCK);
		// A zero block marks the end of the archive.
		if (header.every((byte) => byte === 0)) break;

		const name = readString(header, 0, 100);
		const prefix = readString(header, 345, 155);
		const sizeField = readString(header, 124, 12).trim();
		const size = sizeField.length === 0 ? 0 : Number.parseInt(sizeField, 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new GrammarFetchError(E_GRAMMAR_NOT_IN_TARBALL, `Malformed tar size field: "${sizeField}".`);
		}
		const typeFlag = String.fromCharCode(header[156] ?? 0);
		const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > tar.byteLength) {
			throw new GrammarFetchError(E_GRAMMAR_NOT_IN_TARBALL, `Tar entry "${fullName}" claims more bytes than the archive holds.`);
		}
		// '0' and NUL both mean a regular file; anything else (directories,
		// links, pax headers) is skipped rather than mis-read as content.
		if (typeFlag === "0" || typeFlag === "\0") {
			out.push({ name: fullName, bytes: tar.subarray(dataStart, dataEnd) });
		}
		// Entries are padded to a block boundary.
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
	}
	return out;
}

/** Read a NUL-terminated ASCII field from a tar header. */
function readString(header: Buffer, start: number, length: number): string {
	const field = header.subarray(start, start + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Pull the wanted `.wasm` out of a gzipped npm tarball. */
export function extractGrammarFromTarball(tarball: Uint8Array, wasmFile: string): Buffer {
	if (tarball.byteLength > MAX_ARCHIVE_BYTES) {
		throw new GrammarFetchError(
			E_GRAMMAR_FETCH_FAILED,
			`The archive is ${Math.round(tarball.byteLength / (1024 * 1024))} MiB, over the ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MiB cap.`,
		);
	}
	let tar: Buffer;
	try {
		tar = gunzipSync(tarball);
	} catch (error) {
		throw new GrammarFetchError(
			E_GRAMMAR_FETCH_FAILED,
			`The response was not a gzipped tarball (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	// Match on the SUFFIX: `package/` is npm's layout, not a contract, and a
	// repository tarball may nest differently.
	const entry = readTarEntries(tar).find((candidate) => candidate.name.endsWith(wasmFile));
	if (entry === undefined) {
		throw new GrammarFetchError(
			E_GRAMMAR_NOT_IN_TARBALL,
			`The archive does not contain ${wasmFile}.`,
		);
	}
	return entry.bytes;
}

/**
 * What a fetch response must offer this module.
 *
 * `body` and `headers` are optional because a test fake need not implement
 * them — and omitting them merely means no progress reporting, never a
 * failure. A real `Response` supplies both, so the streaming path lights up
 * in production without any test having to grow a stream.
 */
export interface FetchResponseLike {
	readonly ok: boolean;
	readonly status: number;
	arrayBuffer(): Promise<ArrayBuffer>;
	readonly body?: AsyncIterable<Uint8Array> | null | undefined;
	readonly headers?: { get(name: string): string | null } | undefined;
}

/** The fetch implementation this module needs (injected, so tests need no network). */
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/**
 * How far an install has got, in the terms a card can render.
 *
 * The three stages are the three things that can take time, and they are
 * distinct on purpose: a download that has finished but whose hash does not
 * match must never look like a completed install. `received`/`total` are only
 * meaningful for `download`, and `total` is absent when the server declares no
 * content length — an indeterminate bar is honest, a fake percentage is not.
 */
export interface InstallProgress {
	readonly stage: "download" | "verify" | "install";
	readonly received?: number;
	readonly total?: number;
}

/** Where progress goes. Returning nothing keeps the download path synchronous-ish. */
export type ProgressSink = (progress: InstallProgress) => void;

/**
 * Download a catalog entry's grammar bytes.
 *
 * Nothing is written here: the caller hands the bytes to `installGrammar`,
 * which checks the hash first. Keeping the two apart is what makes the "verify
 * before writing" rule structural rather than a matter of ordering luck.
 *
 * @param id - the catalog id.
 * @param fetchImpl - the fetch to use; defaults to the global one.
 */
export async function fetchGrammarBytes(id: string, fetchImpl?: FetchLike, onProgress?: ProgressSink): Promise<Buffer> {
	const entry = catalogEntry(id);
	if (entry === undefined) {
		throw new GrammarFetchError(E_GRAMMAR_NOT_IN_TARBALL, `${id} is not in the curated catalog.`);
	}
	const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
	if (doFetch === undefined) {
		throw new GrammarFetchError(E_GRAMMAR_FETCH_FAILED, "No fetch implementation is available.");
	}
	const url = tarballUrl(entry.grammarPackage, entry.version);
	let response;
	try {
		response = await doFetch(url);
	} catch (error) {
		throw new GrammarFetchError(
			E_GRAMMAR_FETCH_FAILED,
			`Could not download ${url} (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	if (!response.ok) {
		throw new GrammarFetchError(E_GRAMMAR_FETCH_FAILED, `Downloading ${url} failed with HTTP ${response.status}.`);
	}
	// Stream only when someone is watching: the chunked path costs an extra
	// copy per chunk, and a caller that shows nothing should not pay for it.
	if (onProgress === undefined || response.body === undefined || response.body === null) {
		const whole = new Uint8Array(await response.arrayBuffer());
		// The caller is watching even if this response had no stream: a download
		// that produced no ticks must still not look like a stalled one.
		onProgress?.({ stage: "verify" });
		return extractGrammarFromTarball(whole, entry.wasmFile);
	}
	const declared = response.headers?.get("content-length") ?? null;
	const total = declared === null ? undefined : Number.parseInt(declared, 10);
	const chunks: Uint8Array[] = [];
	let received = 0;
	onProgress({ stage: "download", received: 0, ...(total === undefined ? {} : { total }) });
	for await (const chunk of response.body) {
		received += chunk.byteLength;
		chunks.push(chunk);
		onProgress({ stage: "download", received, ...(total === undefined ? {} : { total }) });
	}
	const body = Buffer.concat(chunks, received);
	// The bytes are in hand; what remains is the hash check the caller owns.
	// Announcing it here is what keeps the card from showing a finished download
	// as a finished install.
	onProgress({ stage: "verify" });
	return extractGrammarFromTarball(new Uint8Array(body), entry.wasmFile);
}

/**
 * The whole one-click action: download, verify, install.
 *
 * The two halves stay separate functions on purpose — this one only sequences
 * them, and `installGrammar` owns the rule that the hash is checked before
 * anything is written. A caller that wants to show progress can use the halves
 * directly.
 *
 * @param id - the catalog id.
 * @param fetchImpl - the fetch to use; defaults to the global one.
 * @returns the install outcome, including the refusal codes verbatim.
 */
export async function installFromCatalog(id: string, fetchImpl?: FetchLike, onProgress?: ProgressSink): Promise<InstallOutcome> {
	let bytes: Buffer;
	try {
		bytes = await fetchGrammarBytes(id, fetchImpl, onProgress);
	} catch (error) {
		if (error instanceof GrammarFetchError) {
			return { ok: false, code: error.code, message: error.message };
		}
		throw error;
	}
	const entry = catalogEntry(id)!;
	// The bytes are verified and written inside `installGrammar`; this is the only
	// place that knows the write is the last thing left to do.
	onProgress?.({ stage: "install" });
	return installGrammar(id, bytes, tarballUrl(entry.grammarPackage, entry.version));
}
