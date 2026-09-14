/**
 * The grammar registry: what is **installed** on this machine, as opposed to
 * what the user **intends** to use.
 *
 * Two layers, joined at runtime (spec §7.1):
 *
 * | Layer | Where | What |
 * | --- | --- | --- |
 * | Intent | the `hashline.ast` settings namespace | which languages are wanted |
 * | Fact | `$DSH_HOME/plugins/dsh-hashline-edittool/grammars/<id>/<version>/` | which grammars are actually present |
 *
 * They are kept apart because they fail apart: losing intent simply disables a
 * language, losing assets simply needs a reinstall — and each heals without
 * touching the other. A language is usable when the two agree.
 *
 * The three built-ins ship inside the package (their `.wasm` resolves through
 * each grammar package's `package.json`), so an empty registry is a working
 * registry for them. Everything else arrives through an install, which is why
 * **the installed copy wins** when both exist: it is the one the user asked for
 * and the one whose hash was checked.
 *
 * @module dsh-hashline-edittool/ast/registry
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "../paths.js";
import { LANGUAGES, languageById, grammarWasmPath, type LanguageId } from "./language.js";
import { HARVESTED_CATALOG } from "./catalog-data.js";

/** One curated catalog entry. Versions and hashes are pinned, never floated. */
export interface CatalogEntry {
	readonly id: string;
	readonly displayName: string;
	/** The official npm package the `.wasm` comes from. */
	readonly grammarPackage: string;
	/** A pinned version — `latest` is never consulted (see ADR-0006 D2). */
	readonly version: string;
	/** The `.wasm` file name at the package root. */
	readonly wasmFile: string;
	/**
	 * Lowercase hex SHA-256 of that file, pinned from the package the release
	 * was built against. A mismatch refuses the install; `latest` is never
	 * consulted, because the published tag can move under a pinned version.
	 */
	readonly sha256: string;
	/**
	 * Ships inside the package: always present, and impossible to uninstall.
	 *
	 * Host-side, not a UI convention — hiding a button leaves the route able to
	 * delete assets the plugin needs to start.
	 */
	readonly builtin: boolean;
	/**
	 * Byte size of the `.wasm`, for the one figure a user can judge before
	 * clicking. Absent for the packaged four, which are never downloaded.
	 */
	readonly size?: number;
	/** Lowercase extensions with the leading dot. */
	readonly extensions: readonly string[];
}

/**
 * The curated catalog.
 *
 * The three built-ins are listed so the card can report their state and offer
 * a reinstall; their assets already ship in the package, so installing them is
 * only meaningful for a deployment that pruned them.
 */
const PACKAGED: readonly Omit<CatalogEntry, "builtin" | "extensions">[] = [
	{
		id: "typescript",
		displayName: "TypeScript",
		grammarPackage: "tree-sitter-typescript",
		version: "0.23.2",
		wasmFile: "tree-sitter-typescript.wasm",
		sha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
	},
	{
		id: "tsx",
		displayName: "TSX",
		grammarPackage: "tree-sitter-typescript",
		version: "0.23.2",
		wasmFile: "tree-sitter-tsx.wasm",
		sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
	},
	{
		id: "javascript",
		displayName: "JavaScript",
		grammarPackage: "tree-sitter-javascript",
		version: "0.25.0",
		wasmFile: "tree-sitter-javascript.wasm",
		sha256: "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240",
	},
	{
		id: "python",
		displayName: "Python",
		grammarPackage: "tree-sitter-python",
		version: "0.25.0",
		wasmFile: "tree-sitter-python.wasm",
		sha256: "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47",
	},
];

/**
 * The curated catalog: the four packaged languages plus every grammar that
 * publishes a prebuilt wasm.
 *
 * Derived rather than restated. The builtins' extensions come from their
 * descriptors, so the two lists cannot drift; the harvested rows carry hashes
 * and sizes measured from the artifacts themselves (`catalog-data.ts` is
 * generated, never typed by hand).
 *
 * What is NOT here matters as much: eleven candidate packages ship C source
 * and native bindings with no wasm at all, and two others now resolve to a
 * `0.0.1-security` placeholder. The catalog is curated, not mirrored.
 */
export const CATALOG: readonly CatalogEntry[] = [
	...PACKAGED.map((row) => {
		const language = languageById(row.id);
		return { ...row, builtin: true, extensions: language?.extensions ?? [] };
	}),
	...HARVESTED_CATALOG.map((row) => ({ ...row, builtin: false })),
];

/** Where a language's installed assets live. */
export function grammarDir(id: string, version: string): string {
	return join(configDir(), "grammars", id, version);
}

/** The recorded install facts for one language. */
export interface InstalledGrammar {
	readonly id: string;
	readonly version: string;
	readonly sha256: string;
	readonly source: string;
	readonly bytes: number;
	readonly installedAt: string;
	readonly wasmPath: string;
}

/** SHA-256 of a buffer, lowercase hex. */
export function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify bytes against an SRI string (`sha512-<base64>`), as npm publishes.
 *
 * This is what makes an in-place UPDATE verifiable rather than merely hopeful.
 * The catalog's pinned sha256 covers the version it was built against; a newer
 * version is verified against the hash the registry publishes FOR IT, so an
 * update is not an unverified install.
 *
 * The trust is narrower than pinning and worth stating: a pinned hash was
 * captured EARLIER, so a registry compromised since then cannot forge it; this
 * one is read now. It covers tampering in transit, which is what `integrity`
 * is for, and npm's `signatures` cover the publisher separately.
 *
 * @param bytes - the downloaded bytes.
 * @param integrity - the SRI string, e.g. `sha512-…==`.
 * @returns true when the bytes match.
 */
export function verifySri(bytes: Uint8Array, integrity: string): boolean {
	const match = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity);
	if (match === null) return false;
	const actual = createHash(match[1]!).update(bytes).digest("base64");
	// Constant-time is not the concern here (the hash is public); a plain compare
	// is readable and cannot be talked into a false positive by an odd encoding.
	return actual === match[2];
}

/**
 * Every installed grammar, by language id.
 *
 * A directory without a readable `install.json` is treated as absent: a
 * half-finished install must not look like a working one.
 */
export async function installedGrammars(): Promise<Map<string, InstalledGrammar>> {
	const out = new Map<string, InstalledGrammar>();
	const root = join(configDir(), "grammars");
	let ids: string[];
	try {
		ids = await readdir(root);
	} catch {
		return out; // nothing installed yet
	}
	for (const id of ids) {
		let versions: string[];
		try {
			versions = await readdir(join(root, id));
		} catch {
			continue;
		}
		for (const version of versions) {
			try {
				const raw = await readFile(join(root, id, version, "install.json"), "utf-8");
				const meta = JSON.parse(raw) as Omit<InstalledGrammar, "wasmPath">;
				const wasmPath = join(root, id, version, "grammar.wasm");
				out.set(id, { ...meta, wasmPath });
			} catch {
				continue;
			}
		}
	}
	return out;
}

/** A language's state as the settings card shows it. */
export interface LanguageState {
	readonly id: string;
	readonly displayName: string;
	/** Ships in the package (so it works with an empty registry). */
	readonly builtIn: boolean;
	readonly installed: boolean;
	/** The user's intent for this language. */
	readonly enabled: boolean;
	/** Usable = enabled AND (built-in or installed). */
	readonly available: boolean;
}

/** Assemble the card's view: intent joined with fact. */
export async function languageStates(isEnabled: (id: string) => boolean): Promise<LanguageState[]> {
	const installed = await installedGrammars();
	return LANGUAGES.map((language) => {
		const enabled = isEnabled(language.id);
		const isInstalled = installed.has(language.id);
		return {
			id: language.id,
			displayName: language.displayName,
			builtIn: language.builtin === true,
			installed: isInstalled,
			enabled,
			// Built-ins resolve through their npm package, so "installed" is not
			// a precondition for them; the registry only adds a pinned copy.
			available: enabled,
		};
	});
}

/** The outcome of an install attempt. */
export type InstallOutcome =
	| { readonly ok: true; readonly installed: InstalledGrammar }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** Error codes, bracketed as they appear in model-facing messages. */
export const E_GRAMMAR_HASH_MISMATCH = "[E_GRAMMAR_HASH_MISMATCH]";
export const E_GRAMMAR_UNKNOWN = "[E_GRAMMAR_UNKNOWN]";
/**
 * The catalog lists the language, but nothing can classify it.
 *
 * A grammar without a descriptor parses and enumerates NOTHING, so installing
 * it would hand the user a language that silently does not work. Refusing is
 * the honest outcome, and it is why the descriptor travels WITH the catalog
 * row rather than being assumed.
 */
export const E_GRAMMAR_NO_DESCRIPTOR = "[E_GRAMMAR_NO_DESCRIPTOR]";
/**
 * A packaged language cannot be uninstalled.
 *
 * Its assets ship inside the plugin, so removing them would break the next
 * start. Enforced here, not in the card: a hidden button is not a rule.
 */
export const E_GRAMMAR_BUILTIN = "[E_GRAMMAR_BUILTIN]";

/**
 * Install one catalog entry from an already-downloaded buffer.
 *
 * The verification order matters: the hash is checked **before** anything is
 * written, so a tampered or truncated download leaves no partial install for a
 * later run to mistake for a working one.
 *
 * @param id - the catalog id.
 * @param bytes - the downloaded `.wasm`.
 * @param source - where it came from, recorded for auditability.
 */
/**
 * Whether a catalog entry can actually be installed.
 *
 * The test is the DESCRIPTOR, not the row: a row says the artifact exists and
 * where to get it, while the descriptor says the resulting grammar could be
 * classified into symbols. Only both together are a usable language.
 *
 * @param entry - the catalog row.
 */
export function isInstallable(entry: CatalogEntry): boolean {
	return languageById(entry.id) !== undefined;
}

/** Install verified grammar bytes; the hash is checked before anything is written. */
export async function installGrammar(
	id: string,
	bytes: Uint8Array,
	source: string,
	expected?: { readonly version: string; readonly integrity: string },
): Promise<InstallOutcome> {
	const entry = CATALOG.find((candidate) => candidate.id === id);
	if (entry === undefined) {
		return { ok: false, code: E_GRAMMAR_UNKNOWN, message: `${id} is not in the curated catalog.` };
	}
	// Before the hash: a descriptor-less language is not installable at ANY
	// bytes, so downloading and verifying first would be wasted work and would
	// report the wrong reason on failure.
	if (!isInstallable(entry)) {
		return {
			ok: false,
			code: E_GRAMMAR_NO_DESCRIPTOR,
			message:
				`${entry.displayName} is listed in the catalog but has no semantic descriptor, ` +
				`so its grammar could not be classified — refusing to install a language that would parse but enumerate nothing.`,
		};
	}
	const actual = sha256Of(bytes);
	// TWO WAYS TO BE VERIFIED, and exactly one of them applies.
	//
	// The catalog's pinned sha256 covers the version it was built against. An
	// UPDATE has no catalog entry for the version it is installing, so its proof
	// comes from the registry's SRI for that version instead — which is what makes
	// an in-place update a verified install rather than a hopeful one.
	//
	// The pinned path is not merely the older one: it was captured EARLIER, so a
	// registry compromised since then cannot forge it. A live SRI covers tampering
	// in transit. Both are checks; neither is "no check".
	// Computed BEFORE the check: `verified` is a boolean, and TypeScript cannot
	// narrow `expected` back from it — the message would need an assertion to say
	// what this says by construction.
	const expectedLabel =
		expected === undefined
			? `the catalog hash ${entry.sha256}`
			: `the registry's integrity hash for ${expected.version}`;
	const verified =
		expected === undefined ? actual === entry.sha256 : verifySri(bytes, expected.integrity);
	if (!verified) {
		return {
			ok: false,
			code: E_GRAMMAR_HASH_MISMATCH,
			message:
				`${entry.displayName} did not match — refusing to install. ` +
				`Expected ${expectedLabel}, got ${actual} (source: ${source}).`,
		};
	}
	const version = expected?.version ?? entry.version;
	const dir = grammarDir(entry.id, version);
	// The version actually installed, which is the catalog's only when no update was
	// named. Recording the catalog's beside newer bytes would make the installed
	// version a lie, and the status surface reads it.
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "grammar.wasm"), bytes);
	const facts: Omit<InstalledGrammar, "wasmPath"> = {
		id: entry.id,
		version,
		sha256: actual,
		source,
		bytes: bytes.byteLength,
		installedAt: new Date().toISOString(),
	};
	await writeFile(join(dir, "install.json"), `${JSON.stringify(facts, null, 1)}\n`, "utf-8");
	return { ok: true, installed: { ...facts, wasmPath: join(dir, "grammar.wasm") } };
}

/** What an uninstall did: removed, absent, or refused. */
export type UninstallOutcome =
	| { readonly ok: true; readonly removed: boolean }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Remove a language's installed assets.
 *
 * Refuses the packaged languages outright. They ship inside the plugin rather
 * than in the writable grammar directory, so there is nothing of theirs to
 * delete — but a caller that asked anyway has a bug worth surfacing instead of
 * a cheerful `removed: false`.
 *
 * @param id - the language id.
 * @returns whether anything was removed, or why the request was refused.
 */
export async function uninstallGrammar(id: string): Promise<UninstallOutcome> {
	const entry = CATALOG.find((candidate) => candidate.id === id);
	if (entry?.builtin === true) {
		return {
			ok: false,
			code: E_GRAMMAR_BUILTIN,
			message: `${entry.displayName} ships with the plugin and cannot be uninstalled.`,
		};
	}
	const root = join(configDir(), "grammars", id);
	try {
		await stat(root);
	} catch {
		return { ok: true, removed: false };
	}
	await rm(root, { recursive: true, force: true });
	return { ok: true, removed: true };
}

/**
 * Where a language's `.wasm` should be loaded from.
 *
 * An installed copy wins over the packaged one: it is what the user asked for
 * and the only copy whose hash was verified.
 *
 * @param id - a built-in language id.
 * @returns the absolute `.wasm` path.
 */
export async function resolveGrammarAsset(id: LanguageId): Promise<string> {
	const installed = (await installedGrammars()).get(id);
	if (installed !== undefined) {
		try {
			await stat(installed.wasmPath);
			return installed.wasmPath;
		} catch {
			// Recorded but gone: fall through to the packaged asset rather than
			// failing, and let the card show it as not installed.
		}
	}
	return grammarWasmPath(id);
}

/** Catalog entry lookup, for the install route. */
export function catalogEntry(id: string): CatalogEntry | undefined {
	return CATALOG.find((entry) => entry.id === id);
}

/** Whether a string names a built-in language. */
export function isKnownLanguage(id: string): boolean {
	return languageById(id) !== undefined;
}
