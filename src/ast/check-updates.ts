/**
 * Update detection for installed grammars — DETECTION ONLY, and the limit is the
 * whole design.
 *
 * A newer version cannot be installed by this plugin. Installation verifies a
 * sha256 that was measured when the version was pinned (ADR-0006 D2: `latest` is
 * never consulted, because a published tag can move under a pinned version), and
 * nothing here knows the hash of a version that did not exist when the catalog
 * was written. Installing one anyway would be an UNVERIFIED install, which is the
 * single thing the catalog exists to prevent.
 *
 * So the honest answer to "is there a newer one" is a notice, not an upgrade: the
 * newer grammar arrives with a newer PLUGIN, which ships a catalog that measured
 * it. That is a weaker feature than it sounds like it should be, and it is the
 * strongest one that does not lie.
 *
 * Every failure is SILENT. A registry that is unreachable, rate-limited, or
 * answering something unexpected is not a problem the user can act on, and a
 * banner about it would teach them to ignore the one that matters.
 *
 * @module dsh-hashline-edittool/ast/check-updates
 */
import { installedGrammars, catalogEntry } from "./registry.js";
import type { FetchLike } from "./fetch-grammar.js";

export interface GrammarUpdate {
	readonly id: string;
	readonly installed: string;
	readonly latest: string;
	/** The tarball to fetch for `latest`. */
	readonly tarball: string;
	/**
	 * The SRI hash npm publishes for that tarball.
	 *
	 * THIS is what makes a one-click update honest, and its absence was the
	 * reason I first gave for not building one — wrongly. The registry serves
	 * `dist.integrity` (plus `dist.signatures`) for every version, so a newer
	 * grammar can be downloaded and VERIFIED exactly as the pinned one is.
	 *
	 * The pinned hash still buys something the live one cannot: it was captured
	 * EARLIER, so a registry compromised since then cannot forge it. Live
	 * integrity covers tampering in transit, and `signatures` covers the
	 * publisher. Neither is "no verification", which is what I claimed.
	 */
	readonly integrity: string;
}

/** Parse `x.y.z` into numbers; anything unparseable yields undefined. */
function parts(version: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is strictly newer than `current`. */
function isNewer(candidate: string, current: string): boolean {
	const a = parts(candidate);
	const b = parts(current);
	if (a === undefined || b === undefined) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i]! !== b[i]!) return a[i]! > b[i]!;
	}
	return false;
}

/**
 * Installed grammars that have a newer version published.
 *
 * @param fetchImpl - the fetch to use; defaults to the global one.
 * @returns the newer ones, in catalog order; empty when nothing is newer, when
 *   nothing is installed, or when the registry could not be read.
 */
export async function checkGrammarUpdates(fetchImpl?: FetchLike): Promise<GrammarUpdate[]> {
	const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
	if (doFetch === undefined) return [];
	let installed: Map<string, { version: string }>;
	try {
		installed = await installedGrammars();
	} catch {
		return [];
	}
	const out: GrammarUpdate[] = [];
	for (const [id, grammar] of installed) {
		const entry = catalogEntry(id);
		if (entry === undefined) continue;
		try {
			// The `/latest` endpoint, not the full packument: this asks one question
			// and a packument for a grammar is megabytes of history.
			const response = await doFetch(`https://registry.npmjs.org/${entry.grammarPackage.replace("/", "%2f")}/latest`);
			if (!response.ok) continue; // offline, rate-limited, renamed — all silent
			// `FetchResponseLike` offers bytes, not `json()` — it is the seam the
			// installer already uses, and widening it for this would be a change to a
			// verified path for the sake of one convenience call.
			const body = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())) as {
				version?: unknown;
				dist?: { integrity?: unknown; tarball?: unknown };
			};
			if (typeof body.version !== "string") continue;
			// An entry without both halves is not actionable: a version we cannot
			// verify is one we must not offer to install. Checked BEFORE the version
			// comparison, so a usable update is never reported without its proof.
			const integrity = body.dist?.integrity;
			const tarball = body.dist?.tarball;
			if (typeof integrity !== "string" || typeof tarball !== "string") continue;
			if (isNewer(body.version, grammar.version)) {
				out.push({ id, installed: grammar.version, latest: body.version, tarball, integrity });
			}
		} catch {
			// Silence is the contract: a failure here is not actionable, and a banner
			// about it would train the user to ignore the ones that are.
			continue;
		}
	}
	return out;
}
