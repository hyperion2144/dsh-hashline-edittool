/**
 * Update detection, and the two rules that make it safe to have.
 *
 * The comparisons are ordinary; what is worth pinning is what the checker REFUSES
 * to report and what it refuses to say when it cannot find out. An update notice
 * is only actionable if the version it names can be installed, and installation
 * needs the registry's integrity hash — so an entry without one is dropped rather
 * than shown as a version the user then cannot get.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkGrammarUpdates } from "../../src/ast/check-updates.js";
import { grammarDir } from "../../src/ast/registry.js";
import type { FetchLike } from "../../src/ast/fetch-grammar.js";
import { useTestHome } from "../support/fixtures.js";

const { testPath } = useTestHome();

/** Record an installed grammar by writing the artifacts, so the VERSION is ours. */
async function recordInstall(id: string, version: string): Promise<void> {
	const dir = grammarDir(id, version);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "grammar.wasm"), "wasm");
	await writeFile(
		join(dir, "install.json"),
		`${JSON.stringify({ id, version, sha256: "0".repeat(64), source: "test", bytes: 4, installedAt: new Date().toISOString() })}\n`,
		"utf-8",
	);
}

/** A fetch that answers every package with the same manifest. */
function registryAnswer(manifest: unknown, status = 200): FetchLike & { readonly urls: string[] } {
	const urls: string[] = [];
	const fetch = (async (url: string) => {
		urls.push(url);
		return {
			ok: status >= 200 && status < 300,
			status,
			arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(manifest)).buffer,
		};
	}) as unknown as FetchLike & { urls: string[] };
	Object.defineProperty(fetch, "urls", { value: urls });
	return fetch;
}

const at = (version: string, integrity = "sha512-AAAA") => ({
	version,
	dist: { integrity, tarball: `https://registry.invalid/x/-/x-${version}.tgz` },
});

beforeEach(async () => {
	await rm(join(testPath, "grammars"), { recursive: true, force: true });
});

afterEach(async () => {
	await rm(join(testPath, "grammars"), { recursive: true, force: true });
});

describe("checkGrammarUpdates", () => {
	it("reports a newer version, with what an install would need to verify it", async () => {
		await recordInstall("typescript", "0.1.0");
		const updates = await checkGrammarUpdates(registryAnswer(at("0.2.0")));
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			id: "typescript",
			installed: "0.1.0",
			latest: "0.2.0",
			integrity: "sha512-AAAA",
			tarball: "https://registry.invalid/x/-/x-0.2.0.tgz",
		});
	});

	it("stays quiet for the same version and for an OLDER one", async () => {
		await recordInstall("typescript", "0.2.0");
		expect(await checkGrammarUpdates(registryAnswer(at("0.2.0")))).toEqual([]);
		// A registry can serve an older `latest` after a bad publish; offering it
		// would be an invitation to downgrade.
		expect(await checkGrammarUpdates(registryAnswer(at("0.1.0")))).toEqual([]);
	});

	it("compares NUMERICALLY, not as strings", async () => {
		await recordInstall("typescript", "0.9.0");
		// "0.10.0" < "0.9.0" as strings, and every release past .9 would be missed.
		expect(await checkGrammarUpdates(registryAnswer(at("0.10.0")))).toHaveLength(1);
	});

	it("DROPS a version it cannot verify, rather than naming one nobody can install", async () => {
		await recordInstall("typescript", "0.1.0");
		const noIntegrity = { version: "0.2.0", dist: { tarball: "https://registry.invalid/x.tgz" } };
		expect(await checkGrammarUpdates(registryAnswer(noIntegrity))).toEqual([]);
		// Same for a missing tarball: half the material is not enough to act on.
		const noTarball = { version: "0.2.0", dist: { integrity: "sha512-AAAA" } };
		expect(await checkGrammarUpdates(registryAnswer(noTarball))).toEqual([]);
	});

	it("is SILENT when the registry fails, because that is not actionable", async () => {
		await recordInstall("typescript", "0.1.0");
		// 404, rate limit, offline — all the same answer from here: nothing to say.
		expect(await checkGrammarUpdates(registryAnswer(at("0.2.0"), 404))).toEqual([]);
		expect(await checkGrammarUpdates(registryAnswer(at("0.2.0"), 429))).toEqual([]);
		const throwing = (async () => {
			throw new Error("ENOTFOUND");
		}) as unknown as FetchLike;
		expect(await checkGrammarUpdates(throwing)).toEqual([]);
	});

	it("checks the PACKAGED grammars too — their updates are the plugin being behind", async () => {
		// The first version of this test claimed no call happens when nothing is
		// installed, and it was wrong about the world rather than about the code:
		// `installedGrammars` includes the grammars that SHIP with the plugin, so
		// there is no such thing as an empty set here.
		//
		// And checking them is right. A packaged grammar is pinned by the plugin
		// version, so a newer one published upstream is exactly the signal that the
		// plugin itself is behind — suppressing it would hide the only update that
		// the user's own action can act on.
		const fetch = registryAnswer(at("999.0.0"));
		const updates = await checkGrammarUpdates(fetch);
		expect(fetch.urls.length).toBeGreaterThan(0);
		expect(updates.some((u) => u.id === "typescript")).toBe(true);
	});

	it("ignores a manifest that is missing or the wrong shape", async () => {
		await recordInstall("typescript", "0.1.0");
		expect(await checkGrammarUpdates(registryAnswer({}))).toEqual([]);
		expect(await checkGrammarUpdates(registryAnswer({ version: 7, dist: {} }))).toEqual([]);
		const notJson = (async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new TextEncoder().encode("<html>nope").buffer,
		})) as unknown as FetchLike;
		expect(await checkGrammarUpdates(notJson)).toEqual([]);
	});
});
