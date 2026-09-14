/**
 * The install/uninstall route. Driven directly with fake request/response
 * objects, so the whole surface is verifiable without an HTTP server — and
 * without the network, since the fetch is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { handleInstall,
	handleUpdates, handleStatus, handleUninstall, registerGrammarRoutes, ROUTE_BASE } from "../../src/ast/install-route.js";
import { CATALOG, grammarDir, installedGrammars, sha256Of } from "../../src/ast/registry.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "install-route-"));
	previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

/** A minimal request: the handlers only read `method` and the body. */
function req(method: string, body?: unknown, headers?: Record<string, string>): IncomingMessage {
	const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
	Object.defineProperty(stream, "method", { value: method });
	// A real IncomingMessage ALWAYS carries headers, so the fake must too — the
	// route reads `accept` to decide between the JSON and NDJSON contracts.
	Object.defineProperty(stream, "headers", { value: headers ?? {} });
	return stream;
}

/** A response that records what was written. */
function res(): {
	response: ServerResponse;
	status: () => number;
	body: () => unknown;
	/** The NDJSON events written, when the handler streamed. */
	stream: () => Array<{ type?: string; stage?: string; ok?: boolean; id?: string; message?: string }>;
} {
	let status = 0;
	let payload = "";
	const written: string[] = [];
	const response = {
		writeHead(code: number) {
			status = code;
			return this;
		},
		write(chunk: string) {
			// The streaming contract is checked through these, so a fake that
			// dropped them would silently pass an empty stream.
			written.push(chunk);
			return true;
		},
		end(chunk?: string) {
			payload = chunk ?? "";
			return this;
		},
	} as unknown as ServerResponse;
	return { response, status: () => status, body: () => (payload === "" ? undefined : JSON.parse(payload)), stream: () => written.join("").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) };
}

/** One ustar entry, for building a fake tarball response. */
function tarEntry(name: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, "utf8");
	header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	header.write("0", 156, 1, "ascii");
	header.write("ustar\0", 257, "ascii");
	const padding = Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength, 0);
	return Buffer.concat([header, content, padding]);
}

function tarballWith(fileName: string, bytes: Buffer): Buffer {
	return gzipSync(Buffer.concat([tarEntry(`package/${fileName}`, bytes), Buffer.alloc(1024, 0)]));
}

/** A fetch that returns the real python grammar inside a synthetic tarball. */
function fetchServing(bytes: Buffer, wasmFile = "tree-sitter-python.wasm") {
	const archive = tarballWith(wasmFile, bytes);
	return async () => ({ ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer });
}

function realPythonGrammar(): Buffer {
	return readFileSync(join("node_modules", "tree-sitter-python", "tree-sitter-python.wasm"));
}

describe("status", () => {
	it("lists the catalog joined with what is installed", async () => {
		const r = res();
		await handleStatus(req("GET"), r.response);
		const body = r.body() as { languages: Array<{ id: string; installed: boolean; version: string }> };
		expect(r.status()).toBe(200);
		expect(body.languages.map((l) => l.id)).toEqual(CATALOG.map((e) => e.id));
		expect(body.languages.every((l) => l.installed === false)).toBe(true);
	});

	it("reflects an install", async () => {
		const r1 = res();
		await handleInstall(req("POST", { id: "python" }), r1.response, { fetchImpl: fetchServing(realPythonGrammar()) });
		expect(r1.status()).toBe(200);
		const r2 = res();
		await handleStatus(req("GET"), r2.response);
		const python = (r2.body() as { languages: Array<{ id: string; installed: boolean; installedVersion?: string }> }).languages.find((l) => l.id === "python")!;
		expect(python.installed).toBe(true);
		expect(python.installedVersion).toBe(CATALOG.find((e) => e.id === "python")!.version);
	});
});

describe("install", () => {
	it("installs a verified download and reports the facts", async () => {
		const bytes = realPythonGrammar();
		const r = res();
		await handleInstall(req("POST", { id: "python" }), r.response, { fetchImpl: fetchServing(bytes) });
		expect(r.status()).toBe(200);
		expect(r.body()).toMatchObject({ ok: true, id: "python", sha256: sha256Of(bytes), bytes: bytes.byteLength });
		expect((await installedGrammars()).has("python")).toBe(true);
	});

	it("refuses an id outside the curated catalog, without fetching", async () => {
		let fetched = 0;
		const r = res();
		await handleInstall(req("POST", { id: "cobol" }), r.response, {
			fetchImpl: async () => {
				fetched += 1;
				throw new Error("must not be called");
			},
		});
		expect(r.status()).toBe(400);
		expect((r.body() as { code: string }).code).toContain("E_GRAMMAR_UNKNOWN");
		// The catalog is the allowlist: an unknown id never reaches the network.
		expect(fetched).toBe(0);
	});

	it("refuses a non-POST method rather than acting on it", async () => {
		const r = res();
		await handleInstall(req("GET"), r.response, { fetchImpl: fetchServing(realPythonGrammar()) });
		expect(r.status()).toBe(405);
	});

	it("refuses a body without an id", async () => {
		const r = res();
		await handleInstall(req("POST", {}), r.response);
		expect(r.status()).toBe(400);
		expect((r.body() as { code: string }).code).toContain("E_BAD_SHAPE");
	});

	it("refuses a body that is not a JSON object", async () => {
		const stream = Readable.from([Buffer.from("[1,2,3]", "utf8")]) as unknown as IncomingMessage;
		Object.defineProperty(stream, "method", { value: "POST" });
		Object.defineProperty(stream, "headers", { value: {} });
		const r = res();
		await handleInstall(stream, r.response);
		expect(r.status()).toBe(400);
	});

	it("refuses an oversized body instead of buffering it", async () => {
		const stream = Readable.from([Buffer.alloc(9 * 1024, 0x61)]) as unknown as IncomingMessage;
		Object.defineProperty(stream, "method", { value: "POST" });
		Object.defineProperty(stream, "headers", { value: {} });
		const r = res();
		await handleInstall(stream, r.response);
		expect(r.status()).toBe(400);
		expect((r.body() as { message: string }).message).toContain("exceeds");
	});

	it("refuses a download whose bytes do not match the pinned hash", async () => {
		const r = res();
		// A syntactically valid tarball carrying the WRONG bytes: the hash check
		// is the only thing standing between this and a poisoned install.
		await handleInstall(req("POST", { id: "python" }), r.response, {
			fetchImpl: fetchServing(Buffer.from("not the real grammar")),
		});
		expect(r.status()).toBe(400);
		expect((r.body() as { code: string }).code).toContain("E_GRAMMAR_HASH_MISMATCH");
		expect((await installedGrammars()).has("python")).toBe(false);
	});

	it("reports a download failure as a bad gateway, not a bad request", async () => {
		const r = res();
		await handleInstall(req("POST", { id: "python" }), r.response, {
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		expect(r.status()).toBe(502);
		expect((r.body() as { message: string }).message).toContain("network down");
	});
});

describe("uninstall", () => {
	it("refuses to remove a packaged language, and removes nothing", async () => {
		// `python` ships with the plugin. Before the guard this reported a
		// cheerful `removed:false`; a caller that asked has a bug, so it is now a
		// refusal carrying a reason.
		const r = res();
		await handleUninstall(req("POST", { id: "python" }), r.response);
		expect(r.status()).toBe(400);
		expect(r.body()).toMatchObject({ ok: false, code: "[E_GRAMMAR_BUILTIN]" });
	});

	it("removes an added language, and reports removed:false when it was absent", async () => {
		// A real removal needs a language that is NOT packaged. `go` is an
		// extension language with a descriptor, so the guard lets it through —
		// and its directory is created here directly rather than downloaded,
		// which keeps this test offline.
		const dir = grammarDir("go", "0.25.0");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "grammar.wasm"), Buffer.from([1, 2, 3]));

		const first = res();
		await handleUninstall(req("POST", { id: "go" }), first.response);
		expect(first.body()).toMatchObject({ ok: true, id: "go", removed: true });
		expect(existsSync(dir)).toBe(false);

		// Second time there is nothing there — a success, not a refusal.
		const second = res();
		await handleUninstall(req("POST", { id: "go" }), second.response);
		expect(second.body()).toMatchObject({ ok: true, removed: false });
	});

	it("refuses a non-POST method", async () => {
		const r = res();
		await handleUninstall(req("DELETE", { id: "python" }), r.response);
		expect(r.status()).toBe(405);
	});
});

describe("registration", () => {
	it("registers four exact routes under the plugin's prefix", () => {
		const registered: Array<{ kind: string; path: string }> = [];
		const disposers = registerGrammarRoutes({ register: (route: { kind: string; path: string }) => (registered.push(route), () => undefined) });
		expect(disposers).toHaveLength(4);
		expect(registered.map((r) => r.path)).toEqual([
			ROUTE_BASE,
			`${ROUTE_BASE}/install`,
			`${ROUTE_BASE}/uninstall`,
			// Separate on purpose: this one reaches the network, and the main list
			// must render without waiting on it.
			`${ROUTE_BASE}/updates`,
		]);
		expect(registered.every((r) => r.kind === "exact")).toBe(true);
	});

	it("is a no-op without a web server, which is the headless profile", () => {
		// Declaring `webServer` in `inject` would stop the plugin loading at all
		// in a profile that has no HTTP carrier.
		expect(registerGrammarRoutes(undefined)).toEqual([]);
		expect(registerGrammarRoutes({})).toEqual([]);
	});

	it("survives a route collision instead of failing the boot", () => {
		const disposers = registerGrammarRoutes({
			register: () => {
				throw new Error("duplicate (kind, path)");
			},
		});
		expect(disposers).toEqual([]);
	});
});


describe("install progress stream", () => {
	const NDJSON = { accept: "application/x-ndjson" };

	it("streams each download stage, then one done line", async () => {
		const r = res();
		await handleInstall(req("POST", { id: "python" }, NDJSON), r.response, { fetchImpl: fetchServing(realPythonGrammar()) });

		const events = r.stream();
		expect(events.at(-1)).toMatchObject({ type: "done", ok: true, id: "python" });
		const stages = events.filter((e) => e.type === "progress").map((e) => e.stage);
		// The stage order is the whole promise of the card: a download that
		// finished but has not been verified must not read as installed.
		expect(stages.indexOf("download")).toBeLessThan(stages.indexOf("verify"));
		expect(stages.indexOf("verify")).toBeLessThan(stages.indexOf("install"));
	});

	it("reports a refusal inside the stream instead of by status", async () => {
		// By the time the download fails the response has already begun, so a
		// truncated stream would be worse than one that reports its own failure.
		const r = res();
		await handleInstall(req("POST", { id: "python" }, NDJSON), r.response, {
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		const events = r.stream();
		expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
		expect((events.at(-1) as { message: string }).message).toContain("network down");
	});

	it("keeps the single-JSON contract for a caller that does not ask to stream", async () => {
		// Back-compat: the tests above and any existing caller pass no accept.
		const r = res();
		await handleInstall(req("POST", { id: "python" }), r.response, { fetchImpl: fetchServing(realPythonGrammar()) });
		expect(r.stream()).toEqual([]);
		expect(r.body()).toMatchObject({ ok: true, id: "python" });
	});
	it("reports a cancelled download in the stream rather than dying", async () => {
		// Cancelling aborts the fetch, which surfaces here as a thrown error. The
		// response has already begun, so the only honest thing left is a final
		// done line — a hang or a truncated stream would leave the card stuck on
		// "installing" forever, which is exactly what cancelling exists to escape.
		const r = res();
		await handleInstall(req("POST", { id: "python" }, NDJSON), r.response, {
			fetchImpl: async () => {
				const aborted = new Error("The operation was aborted.");
				aborted.name = "AbortError";
				throw aborted;
			},
		});
		expect(r.stream().at(-1)).toMatchObject({ type: "done", ok: false });
		// And nothing was written: a cancelled install leaves no half state.
		expect((await installedGrammars()).has("python")).toBe(false);
	});
});

describe("catalog row contract", () => {
	it("returns the fields the settings card reads, omitting the undefined ones", async () => {
		// The card declares its own `LanguageRow` (it cannot import this package),
		// so nothing else would catch a field being renamed or dropped here — the
		// card would simply start rendering blanks. Pinning the key set is the
		// cross-package check the type system cannot give us.
		//
		// The set is NOT fixed per row: JSON.stringify drops keys whose value is
		// undefined, so a packaged language has no `size` and an uninstalled one has
		// no version. That is the real contract, and the card's optional fields
		// (`size?`) are written for it — asserting one fixed list was my mistake,
		// and this test caught it.
		const ALWAYS = ["builtin", "displayName", "enabled", "extensions", "id", "installable", "installed", "version"];
		const SOMETIMES = ["installedAt", "installedVersion", "size"];

		const r = res();
		await handleStatus(req("GET"), r.response);
		const rows = (r.body() as { languages: Array<Record<string, unknown>> }).languages;
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			const keys = Object.keys(row).sort();
			for (const required of ALWAYS) expect(keys).toContain(required);
			for (const key of keys) expect([...ALWAYS, ...SOMETIMES]).toContain(key);
		}
	});

	it("reports the packaged four as builtin and non-uninstallable", async () => {
		const r = res();
		await handleStatus(req("GET"), r.response);
		const rows = (r.body() as { languages: Array<{ id: string; builtin: boolean; installable: boolean }> }).languages;
		const builtins = rows.filter((row) => row.builtin);
		expect(builtins.map((row) => row.id).sort()).toEqual(["javascript", "python", "tsx", "typescript"]);
		// A packaged language is installable (a deployment may have pruned it) but
		// never removable — the card renders those two facts differently.
		expect(builtins.every((row) => row.installable)).toBe(true);
	});
});

describe("the updates route (#121)", () => {
	/**
	 * It reaches the network, so it is a SEPARATE route: the card's main list must
	 * render without waiting on a registry. An empty list is the honest answer for
	 * "nothing newer" and for "could not ask" alike.
	 */
	it("answers with an updates array, and never an error status", async () => {
		const r = res();
		// No grammars are installed in this sandbox, so the registry is not even
		// consulted — which is itself the behaviour worth pinning: an install-free
		// deployment must not make a network call to answer this.
		await handleUpdates(req("GET", {}), r.response);
		expect(r.status()).toBe(200);
		expect(r.body()).toEqual({ updates: [] });
	});
});
