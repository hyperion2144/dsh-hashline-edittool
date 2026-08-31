#!/usr/bin/env node
/**
 * Goal (a): distribution + throughput.
 *
 * Compares the CURRENT content hash (cyrb53, the same function as in
 * src/hashline/hash-assign.ts:contentChecksum) vs BLAKE2b-64 from
 * node:crypto. Node 26 dropped the `outputLength` option for non-XOF
 * ciphers, so we compute the 64-byte BLAKE2b-512 and take the first 8
 * bytes; BLAKE2 is variable-length by design, so the prefix IS the
 * parameter-digest_length=8 output.
 *
 * For each, we:
 *   1. Hash N = 200,000 random UTF-8 strings of varied length (mimics
 *      realistic line content).
 *   2. Fold each 64-bit (or 53-bit for cyrb53) digest into 3844 slots
 *      (62^2) via modulo, and report:
 *        - chi-square statistic vs uniform
 *        - max load (worst bucket occupancy)
 *        - load distribution percentiles
 *   3. Measure throughput in hashes/second.
 *
 * Output: docs/research/dynamic-hashline-hash-choice-scripts/results/01-distribution-throughput.json
 *         plus a printed summary table on stdout.
 */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// ----- current content hash (mirrors src/hashline/hash-assign.ts:cyrb53) -----
function cyrb53(str, seed = 0) {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334767);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ----- BLAKE2b-64 via node:crypto (no new dep) -----
// Node 26 dropped `outputLength` on non-XOF ciphers; we compute the full
// 64-byte BLAKE2b-512 and truncate to 8 bytes (== BLAKE2b-64 digest).
function blake2b64(buf) {
	return createHash("blake2b512").update(buf).digest().subarray(0, 8);
}

// ----- test corpus: 200k random strings, varied lengths/byte distributions -----
// Each line uses between MIN_LEN and MAX_LEN bytes from a freshly-allocated
// random buffer (length chosen from a uniform distribution).
function makeCorpus(n, minLen = 8, maxLen = 88) {
	const out = new Array(n);
	const buf = randomBytes((maxLen + 1) * n);
	let p = 0;
	for (let i = 0; i < n; i++) {
		const len = minLen + (buf[p++] % (maxLen - minLen + 1));
		out[i] = buf.subarray(p, p + len).toString("latin1");
		p += len;
	}
	return out;
}

const N = 200_000;
const SLOTS = 62 * 62; // 3844

function bucketLoadStats(values, slots) {
	const buckets = new Int32Array(slots);
	for (let i = 0; i < values.length; i++) buckets[values[i]]++;
	const counts = Array.from(buckets);
	const expected = values.length / slots;
	let chiSq = 0;
	for (let i = 0; i < slots; i++) {
		const d = counts[i] - expected;
		chiSq += (d * d) / expected;
	}
	counts.sort((a, b) => a - b);
	return {
		chiSquare: chiSq,
		max: counts[counts.length - 1],
		min: counts[0],
		p50: counts[Math.floor(counts.length * 0.5)],
		p95: counts[Math.floor(counts.length * 0.95)],
		p99: counts[Math.floor(counts.length * 0.99)],
		expected,
	};
}

function throughput(fn, inputs, ms = 1500) {
	// Warm up
	for (let i = 0; i < 5000; i++) fn(inputs[i % inputs.length]);
	const start = process.hrtime.bigint();
	let ops = 0;
	const end = start + BigInt(ms) * 1_000_000n;
	let i = 0;
	while (process.hrtime.bigint() < end) {
		fn(inputs[i % inputs.length]);
		ops++;
		i++;
	}
	const elapsedNs = Number(process.hrtime.bigint() - start);
	return ops / (elapsedNs / 1e9);
}

console.log(`generating corpus: ${N} random lines...`);
const corpus = makeCorpus(N);

// cyrb53: produce uint32-modulo 3844 (matches current `hashOf` shape via hashSpace)
console.log("running cyrb53...");
const cyrb53Slots = new Int16Array(N);
const cyrbStart = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
	cyrb53Slots[i] = cyrb53(corpus[i]) % SLOTS;
}
const cyrbElapsedMs = Number(process.hrtime.bigint() - cyrbStart) / 1e6;
const cyrbStats = bucketLoadStats(cyrb53Slots, SLOTS);
const cyrbTput = throughput(
	(s) => cyrb53(s) % SLOTS,
	corpus,
	1500,
);
console.log(
	`  cyrb53   ${cyrbElapsedMs.toFixed(1)} ms (one-shot), ${(cyrbTput / 1e6).toFixed(2)} Mops/s sustained`,
);

// BLAKE2b-64: produce 64-bit BE digest modulo 3844
console.log("running BLAKE2b-64...");
const blakeSlots = new Int16Array(N);
const blakeStart = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
	const d = blake2b64(Buffer.from(corpus[i], "latin1"));
	const u64 =
		(BigInt(d[0]) << 56n) |
		(BigInt(d[1]) << 48n) |
		(BigInt(d[2]) << 40n) |
		(BigInt(d[3]) << 32n) |
		(BigInt(d[4]) << 24n) |
		(BigInt(d[5]) << 16n) |
		(BigInt(d[6]) << 8n) |
		BigInt(d[7]);
	blakeSlots[i] = Number(u64 % BigInt(SLOTS));
}
const blakeElapsedMs = Number(process.hrtime.bigint() - blakeStart) / 1e6;
const blakeStats = bucketLoadStats(blakeSlots, SLOTS);
const blakeTput = throughput(
	(s) => {
		const d = blake2b64(Buffer.from(s, "latin1"));
		return Number(
			(((BigInt(d[0]) << 56n) | (BigInt(d[7]) & 0xffn)) % BigInt(SLOTS)) &
				0x7fffffffn,
		);
	},
	corpus,
	1500,
);
console.log(
	`  BLAKE2b  ${blakeElapsedMs.toFixed(1)} ms (one-shot), ${(blakeTput / 1e6).toFixed(2)} Mops/s sustained`,
);

// ----- summary -----
const summary = {
	N,
	slots: SLOTS,
	cyrb53: {
		chiSquare: cyrbStats.chiSquare,
		maxLoad: cyrbStats.max,
		minLoad: cyrbStats.min,
		expected: cyrbStats.expected,
		p50: cyrbStats.p50,
		p95: cyrbStats.p95,
		p99: cyrbStats.p99,
		throughputOpsPerSec: Math.round(cyrbTput),
		oneShotMs: cyrbElapsedMs,
	},
	blake2b64: {
		chiSquare: blakeStats.chiSquare,
		maxLoad: blakeStats.max,
		minLoad: blakeStats.min,
		expected: blakeStats.expected,
		p50: blakeStats.p50,
		p95: blakeStats.p95,
		p99: blakeStats.p99,
		throughputOpsPerSec: Math.round(blakeTput),
		oneShotMs: blakeElapsedMs,
	},
};

writeFileSync(
	join(RESULTS_DIR, "01-distribution-throughput.json"),
	JSON.stringify(summary, null, 2),
);

console.log("\n=== distribution (N=" + N + " across " + SLOTS + " slots) ===");
console.log(
	"hash        chi²         max    p99    p95    p50    expected  Mops/s",
);
for (const [name, s] of [
	["cyrb53  ", cyrbStats],
	["BLAKE2b ", blakeStats],
]) {
	const key = name.includes("cyrb") ? "cyrb53" : "blake2b64";
	console.log(
		`${name} ${s.chiSquare.toFixed(0).padStart(10)}   ${String(s.max).padStart(4)}   ${String(s.p99).padStart(4)}   ${String(s.p95).padStart(4)}   ${String(s.p50).padStart(4)}   ${s.expected.toFixed(1).padStart(5)}   ${(summary[key].throughputOpsPerSec / 1e6).toFixed(2).padStart(6)}`,
	);
}
console.log(
	"\nresult file: docs/research/dynamic-hashline-hash-choice-scripts/results/01-distribution-throughput.json",
);