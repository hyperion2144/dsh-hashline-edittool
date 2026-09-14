/**
 * The grammar registry: the intent/fact split, and the install trust boundary.
 *
 * The verification order is the load-bearing part — the hash is checked before
 * anything is written, so a tampered download cannot leave a partial install
 * that a later run mistakes for a working one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CATALOG, E_GRAMMAR_BUILTIN, E_GRAMMAR_HASH_MISMATCH, E_GRAMMAR_NO_DESCRIPTOR, E_GRAMMAR_UNKNOWN, catalogEntry, grammarDir, installGrammar, installedGrammars, isInstallable, languageStates, resolveGrammarAsset, sha256Of, uninstallGrammar, verifySri } from "../../src/ast/registry.js";
import { grammarWasmPath } from "../../src/ast/language.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "grammar-home-"));
	previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
});

afterEach(async () => {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	await rm(home, { recursive: true, force: true });
});

/** The real python grammar, as a stand-in download. */
function realGrammarBytes(): Uint8Array {
	return readFileSync(join("node_modules", "tree-sitter-python", "tree-sitter-python.wasm"));
}

describe("the catalog", () => {
	it("pins a real hash for every entry, never a placeholder", () => {
		for (const entry of CATALOG) {
			expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(entry.version).not.toBe("latest");
		}
	});

	it("carries the hash that the shipped package actually produces", () => {
		// The pinned hash must match the artifact this release was built
		// against — otherwise every install would be refused in the field.
		const bytes = realGrammarBytes();
		expect(catalogEntry("python")!.sha256).toBe(sha256Of(bytes));
	});
});

describe("install", () => {
	it("refuses bytes that do not match the pinned hash", async () => {
		const outcome = await installGrammar("python", new Uint8Array([1, 2, 3]), "https://example.invalid/x.wasm");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.code).toBe(E_GRAMMAR_HASH_MISMATCH);
			expect(outcome.message).toContain("refusing to install");
		}
		// Nothing was written: a partial install must not look like a working one.
		expect(await installedGrammars()).toEqual(new Map());
	});

	it("refuses an id outside the curated catalog", async () => {
		// NOT "ruby": it is a harvested catalog row now, so it exercises the
		// no-descriptor path instead. This needs a name that is in nothing.
		const outcome = await installGrammar("cobol", new Uint8Array([1]), "https://example.invalid/c.wasm");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe(E_GRAMMAR_UNKNOWN);
	});

	it("refuses any catalog row that has no semantic descriptor", async () => {
		// The guard is what keeps a listed-but-unclassifiable grammar from being
		// installed, and it has to hold whether or not such a row exists today.
		//
		// Written to work in BOTH states on purpose: it used to name `ruby`, which
		// broke the day ruby got a descriptor; then it asked the catalog, which
		// broke the day the LAST row got one. Neither failure was a bug — both were
		// the test assuming a particular row lacks a descriptor. Now it asserts the
		// refusal where one exists, and the full coverage where none does.
		const withoutDescriptor = CATALOG.filter((entry) => !isInstallable(entry));
		for (const entry of withoutDescriptor) {
			const outcome = await installGrammar(entry.id, new Uint8Array([1]), "https://example.invalid/x.wasm");
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.code).toBe(E_GRAMMAR_NO_DESCRIPTOR);
		}
		if (withoutDescriptor.length === 0) {
			// Every catalog row is installable, which is the state this work was
			// aiming at — assert it rather than silently passing over an empty loop.
			expect(CATALOG.every((entry) => isInstallable(entry))).toBe(true);
		}
	});

	it("installs verified bytes and records the facts", async () => {
		const bytes = realGrammarBytes();
		const outcome = await installGrammar("python", bytes, "https://registry.npmjs.org/tree-sitter-python/-/x.tgz");
		expect(outcome.ok).toBe(true);
		const installed = await installedGrammars();
		const facts = installed.get("python");
		expect(facts?.sha256).toBe(sha256Of(bytes));
		expect(facts?.bytes).toBe(bytes.byteLength);
		expect(facts?.version).toBe(catalogEntry("python")!.version);
		// The recorded file is really there and really is what was verified.
		expect(sha256Of(await readFile(facts!.wasmPath))).toBe(facts!.sha256);
	});

	it("uninstalls cleanly and reports whether anything was removed", async () => {
		// Installed first, so there is a copy to remove. `python` is packaged, so
		// the uninstall below is the REFUSAL path — the round trip lives in the
		// install-route test, which uses a real extension language.
		await installGrammar("python", realGrammarBytes(), "test");
		expect((await installedGrammars()).has("python")).toBe(true);
		const outcome = await uninstallGrammar("python");
		expect(outcome).toEqual({ ok: false, code: E_GRAMMAR_BUILTIN, message: expect.any(String) });
		// A refused uninstall must not have removed anything.
		expect((await installedGrammars()).has("python")).toBe(true);
	});

	it("ignores a directory with no install.json", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(grammarDir("python", "0.0.0"), { recursive: true });
		expect((await installedGrammars()).has("python")).toBe(false);
	});
});

describe("intent joined with fact", () => {
	it("reports a built-in as available from the package alone", async () => {
		const states = await languageStates(() => true);
		const python = states.find((state) => state.id === "python")!;
		expect(python.builtIn).toBe(true);
		expect(python.installed).toBe(false);
		expect(python.enabled).toBe(true);
		expect(python.available).toBe(true);
	});

	it("reports a language as unavailable when the user turned it off", async () => {
		const states = await languageStates((id) => id !== "python");
		expect(states.find((state) => state.id === "python")!.available).toBe(false);
		expect(states.find((state) => state.id === "typescript")!.available).toBe(true);
	});

	it("reflects an install in the installed flag without changing availability", async () => {
		await installGrammar("python", realGrammarBytes(), "test");
		const python = (await languageStates(() => true)).find((state) => state.id === "python")!;
		expect(python.installed).toBe(true);
		expect(python.available).toBe(true);
	});
});

describe("installed copy wins over the packaged one", () => {
	it("resolves to the packaged asset when nothing is installed", async () => {
		expect(await resolveGrammarAsset("python")).toBe(grammarWasmPath("python"));
	});

	it("resolves to the verified installed copy once one exists", async () => {
		await installGrammar("python", realGrammarBytes(), "test");
		const resolved = await resolveGrammarAsset("python");
		// Not the package path: the registry exists so the user's pinned copy
		// is the one that gets loaded, and this is the assertion that keeps the
		// whole install path from being decorative.
		expect(resolved).not.toBe(grammarWasmPath("python"));
		expect(resolved).toContain(join("grammars", "python"));
		expect(sha256Of(await readFile(resolved))).toBe(catalogEntry("python")!.sha256);
	});

	it("falls back to the packaged asset when the recorded file is gone", async () => {
		await installGrammar("python", realGrammarBytes(), "test");
		await rm(grammarDir("python", catalogEntry("python")!.version), { recursive: true, force: true });
		// The record may outlive the bytes; falling back beats failing, and the
		// card reports it as not installed.
		expect(await resolveGrammarAsset("python")).toBe(grammarWasmPath("python"));
	});
});

describe("verifySri — what makes an in-place update verifiable (#121)", () => {
	/**
	 * The catalog's pinned sha256 covers the version it was built against. A newer
	 * version has no entry, so its proof has to come from the registry's SRI —
	 * which is what turns "a newer one exists" into "and it can be installed
	 * without taking the bytes on faith".
	 */
	const sri = (bytes: Uint8Array, algo = "sha512"): string =>
		`${algo}-${createHash(algo).update(bytes).digest("base64")}`;

	it("accepts bytes that match, and rejects one flipped bit", () => {
		const bytes = new TextEncoder().encode("grammar bytes");
		expect(verifySri(bytes, sri(bytes))).toBe(true);
		const tampered = new Uint8Array(bytes);
		tampered[0] ^= 0xff;
		expect(verifySri(tampered, sri(bytes))).toBe(false);
	});

	it("honours the algorithm the SRI names", () => {
		const bytes = new TextEncoder().encode("grammar bytes");
		expect(verifySri(bytes, sri(bytes, "sha256"))).toBe(true);
		// A sha256 SRI carrying sha512-derived bytes must NOT pass by accident.
		expect(verifySri(bytes, `sha256-${createHash("sha512").update(bytes).digest("base64")}`)).toBe(false);
	});

	it("refuses anything it cannot parse rather than guessing", () => {
		const bytes = new TextEncoder().encode("grammar bytes");
		expect(verifySri(bytes, "md5-abc")).toBe(false);
		expect(verifySri(bytes, "sha512")).toBe(false);
		expect(verifySri(bytes, "")).toBe(false);
	});
});

describe("installGrammar with an update's own proof (#121)", () => {
	/**
	 * The catalog's pinned sha256 covers the version it was built against, so an
	 * UPDATE cannot use it — the version it is installing has no catalog entry.
	 * Its proof is the registry's SRI, and the two paths must not be confused:
	 * the pinned bytes must still be refused when they do not match, and an
	 * update must still be refused when its SRI does not.
	 */
	const sri = (bytes: Uint8Array): string =>
		`sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	// A real installable row: Go is in the catalog with a descriptor.
	const id = "go";
	const newer = new TextEncoder().encode("a newer grammar, not the catalog one");

	it("records the UPDATED version, not the catalog's", async () => {
		const outcome = await installGrammar(id, newer, "registry", {
			version: "99.0.0",
			integrity: sri(newer),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.installed.version).toBe("99.0.0");
	});

	it("refuses bytes that do not match the registry's integrity", async () => {
		const outcome = await installGrammar(id, newer, "registry", {
			version: "99.0.0",
			integrity: sri(new TextEncoder().encode("something else entirely")),
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(E_GRAMMAR_HASH_MISMATCH);
	});

	it("still refuses the pinned path's mismatch when no update is named", async () => {
		// The original contract must survive: without `expected`, the catalog hash
		// is the only proof, and bytes that do not match it are refused.
		const outcome = await installGrammar(id, newer, "catalog");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe(E_GRAMMAR_HASH_MISMATCH);
	});
});
