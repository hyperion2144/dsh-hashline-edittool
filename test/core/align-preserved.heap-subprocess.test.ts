/**
 * Restricted-heap subprocess regression (ADR-0011, issue #180).
 *
 * The whole reason for the bounded aligner is that the old `8·(m+1)·(n+1)`
 * DP table SIGABRTs under a 256 MB heap on a 10k² input. This test re-runs
 * the bounded aligner under exactly that constraint on a 50k×50k input —
 * the blocked path's "block size squared" memory bound is the implementation
 * claim that must hold here.
 *
 * If `lib/hashline/align-bounded.js` is not built yet, the test is skipped
 * (with a clear log) so CI doesn't fail on a fresh checkout. Run `npm run
 * build` first.
 *
 * @module test/core/align-preserved.heap-subprocess
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RUNNER = join(process.cwd(), "lib", "hashline", "align-bounded.js");

// A 50k×50k input where the two sides share NO content. mMid=nMid=50_000,
// mMid*nMid=2.5·10⁹ ≫ default budget ⇒ the blocked path runs. With the
// previous implementation this allocation would have been 20 GB → SIGABRT.
const N = 50_000;

// Script body the subprocess runs. Uses ESM dynamic import so it works
// regardless of whether the runner file is CJS or ESM.
const SCRIPT = `
// A file:// URL, not a bare path: Windows rejects an absolute path as an ESM
// specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME, protocol 'd:').
const mod = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});
const N = ${N};
const oldKeys = new Array(N);
const newKeys = new Array(N);
for (let i = 0; i < N; i++) {
  oldKeys[i] = i;
  newKeys[i] = i + N; // disjoint ranges → no LCS match
}
const t0 = Date.now();
const r = mod.alignPreservedBounded(oldKeys, newKeys);
const ms = Date.now() - t0;
console.log(JSON.stringify({
  pairs: r.pairs.size,
  degraded: r.degraded,
  ms,
}));
`;

describe("restricted-heap subprocess regression", () => {
	const built = existsSync(RUNNER);

	if (!built) {
		it.skip("run npm run build first — lib/hashline/align-bounded.js is missing", () => {
			// eslint-disable-next-line no-console
			console.warn(
				`[skip] ${RUNNER} not found; run 'npm run build' to enable this regression.`,
			);
		});
		return;
	}

	it("50k×50k with --max-old-space-size=256 returns normally (no SIGABRT)", () => {
		const result = spawnSync(
			process.execPath,
			["--max-old-space-size=256", "--input-type=module", "-e", SCRIPT],
			{
				encoding: "utf-8",
				timeout: 60_000,
				// Block stdio so a runaway subprocess doesn't keep the
				// vitest worker pinned. We re-emit on failure below.
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		// The whole point: the process must not be killed by an un-catchable
		// signal (the previous implementation SIGABRT'd here on V8's
		// "Ineffective mark-compacts near heap limit" path).
		expect(result.signal).toBeNull();

		// And it must have exited normally with a non-error code.
		if (result.status !== 0) {
			// Surface stderr/stdout so a future CI failure has a paper trail.
			// eslint-disable-next-line no-console
			console.error("[heap-subprocess stdout]", result.stdout);
			// eslint-disable-next-line no-console
			console.error("[heap-subprocess stderr]", result.stderr);
		}
		expect(result.status).toBe(0);

		// Sanity: the bounded aligner returned a real result object. The
		// disjoint ranges guarantee `degraded: true` (no block pair survives
		// the similarity check) and `pairs.size === 0`.
		const parsed = JSON.parse(result.stdout.trim());
		expect(parsed.degraded).toBe(true);
		expect(parsed.pairs).toBe(0);
		// A timing floor — the subprocess must finish in well under the
		// 60-second kill. The blocked path on 50k×50k should run in seconds,
		// not minutes.
		expect(parsed.ms).toBeLessThan(60_000);
	});
});