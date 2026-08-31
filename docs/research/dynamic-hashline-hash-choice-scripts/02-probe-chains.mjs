#!/usr/bin/env node
/**
 * Goal (b): worst-case probe chain length when allocating into the 2-char layer.
 *
 * Implements the double-hash probe from docs/dynamic-hashline.md §5.3:
 *   start = full_hash % total
 *   step  = (full_hash % (total - 1)) + 1
 *   slot[i] = (start + i * step) % total
 *
 * For each candidate hash (cyrb53 / BLAKE2b-64) we:
 *   - allocate exactly 3844 distinct lines into the 2-char layer
 *     (one less than the layer's 3844 capacity, to measure the worst
 *     pre-filling behavior);
 *   - then 3845 lines (the 3845th must roll over to a 3-char layer);
 *   - then 10,000 lines (typical upper bound).
 *
 * For each scenario we report:
 *   - mean, p50, p95, p99, max probe chain length
 *   - # of allocations that exhausted the layer and rolled over
 *
 * Output: docs/research/dynamic-hashline-hash-choice-scripts/results/02-probe-chains.json
 *         + summary printed to stdout.
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
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ----- BLAKE2b-64 -----
// Node 26 dropped `outputLength` on non-XOF ciphers; compute the full
// 64-byte BLAKE2b-512 and take the first 8 bytes (== BLAKE2b-64 digest).
function blake2b64(buf) {
return createHash("blake2b512").update(buf).digest().subarray(0, 8);
}
function blake2b64Num(buf) {
	const d = blake2b64(buf);
	return (
		(BigInt(d[0]) << 56n) |
		(BigInt(d[1]) << 48n) |
		(BigInt(d[2]) << 40n) |
		(BigInt(d[3]) << 32n) |
		(BigInt(d[4]) << 24n) |
		(BigInt(d[5]) << 16n) |
		(BigInt(d[6]) << 8n) |
		BigInt(d[7])
	);
}

const ALPH =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function idxToBase62(idx, len) {
	let out = "";
	for (let j = 0; j < len; j++) {
		out = ALPH[idx % 62] + out;
		idx = Math.floor(idx / 62);
	}
	return out;
}

/**
 * Allocate one line given a 64-bit hash function.
 * Returns { anchor, depth, probes } where:
 *   - anchor: the allocated base62 string (with `@` prefix? — not in this sim)
 *   - depth:  2 or 3
 *   - probes: how many probe iterations until an empty slot was found
 *
 * Implements the layered allocation per docs/dynamic-hashline.md §5.3:
 *   for depth in [2, 3, ...]:
 *     total = 62**depth
 *     start = full_hash % total
 *     step  = (full_hash % (total - 1)) + 1
 *     for offset in [0, total):
 *       candidate = encode(start + offset*step, depth)
 *       if candidate not in anchor_map: allocate, return
 */
function makeAllocator(hashFn) {
	const anchorMap = new Map(); // anchor -> content
	const freeCounts = new Map([
		[2, 62 * 62],
		[3, 62 * 62 * 62],
		[4, 62 ** 4],
	]);
	return function allocate(content) {
		const fullHash = hashFn(content);
		for (let depth = 2; depth <= 4; depth++) {
			if (freeCounts.get(depth) === 0) continue;
			const total = 62 ** depth;
			const startIdx =
				depth === 2
					? Number(BigInt(fullHash) % BigInt(total))
					: depth === 3
						? Number(BigInt(fullHash) % BigInt(total))
						: Number(BigInt(fullHash) % BigInt(total));
			// step: must be coprime with total for double-hash coverage.
			// total = 62^d. for d=2, 62^2 = 3844 = 2^2 * 31^2.
			// (full_hash % (total-1)) + 1 yields 1..total-1, which CAN share factors with total.
			// The doc accepts this; we replicate it verbatim.
			const step =
				total > 1
					? (Number(BigInt(fullHash) % BigInt(total - 1)) % total) + 1
					: 1;
			for (let offset = 0; offset < total; offset++) {
				const idx = (startIdx + offset * step) % total;
				const candidate = idxToBase62(idx, depth);
				if (!anchorMap.has(candidate)) {
					anchorMap.set(candidate, content);
					freeCounts.set(depth, freeCounts.get(depth) - 1);
					return { anchor: candidate, depth, probes: offset + 1 };
				}
			}
			// layer full, fall through
		}
		throw new Error("hash space exhausted");
	};
}

function makeCorpus(n) {
	const out = new Array(n);
	const r = randomBytes(8 * n);
	let p = 0;
	for (let i = 0; i < n; i++) {
		const len = 8 + (r[p++] % 80);
		const buf = r.subarray(p, p + len);
		p += len;
		out[i] = buf.toString("latin1");
	}
	return out;
}

function summarizeProbes(probes) {
	const sorted = [...probes].sort((a, b) => a - b);
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		count: sorted.length,
		mean: sum / sorted.length,
		min: sorted[0],
		p50: sorted[Math.floor(sorted.length * 0.5)],
		p95: sorted[Math.floor(sorted.length * 0.95)],
		p99: sorted[Math.floor(sorted.length * 0.99)],
		max: sorted[sorted.length - 1],
	};
}

function scenario(label, hashFn, totalLines, corpus) {
	const alloc = makeAllocator(hashFn);
	const probes = new Array(totalLines);
	let depth2 = 0;
	let depth3 = 0;
	for (let i = 0; i < totalLines; i++) {
		const r = alloc(corpus[i]);
		probes[i] = r.probes;
		if (r.depth === 2) depth2++;
		else if (r.depth === 3) depth3++;
	}
	const stats = summarizeProbes(probes);
	return {
		label,
		allocated: totalLines,
		depth2Count: depth2,
		depth3Count: depth3,
		probes: stats,
	};
}

const SCENARIOS = [
	{ name: "3844 lines (just fills 2-char)", lines: 3844 },
	{ name: "3845 lines (first 3-char spillover)", lines: 3845 },
	{ name: "5000 lines (mid)", lines: 5000 },
	{ name: "10000 lines (typical upper bound)", lines: 10000 },
];

const CORPUS_SIZE = 12000;
console.log(`generating corpus: ${CORPUS_SIZE} random lines...`);
const corpus = makeCorpus(CORPUS_SIZE);

const results = { cyrb53: {}, blake2b64: {} };
for (const [name, fn] of [
	["cyrb53", (s) => BigInt(cyrb53(s))],
	["blake2b64", (s) => blake2b64Num(Buffer.from(s, "latin1"))],
]) {
	console.log(`\nrunning ${name} scenarios...`);
	for (const sc of SCENARIOS) {
		const r = scenario(sc.name, fn, sc.lines, corpus);
		results[name][sc.lines] = r;
		console.log(
			`  ${sc.name.padEnd(35)} depth2=${r.depth2Count.toString().padStart(4)} depth3=${r.depth3Count.toString().padStart(4)} probes: mean=${r.probes.mean.toFixed(2).padStart(6)} p99=${r.probes.p99.toString().padStart(4)} max=${r.probes.max.toString().padStart(4)}`,
		);
	}
}

writeFileSync(
	join(RESULTS_DIR, "02-probe-chains.json"),
	JSON.stringify(results, null, 2),
);

console.log(
	"\nresult file: docs/research/dynamic-hashline-hash-choice-scripts/results/02-probe-chains.json",
);