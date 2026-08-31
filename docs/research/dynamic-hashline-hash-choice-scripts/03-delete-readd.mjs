#!/usr/bin/env node
/**
 * Goal (c): delete-then-re-add behavior.
 *
 * The dynamic-hashline spec accepts a trade-off (Q3-A): under heavy churn,
 * re-inserting the SAME content after it has been deleted and the slot
 * claimed by other lines may yield a DIFFERENT anchor. This script measures
 * that probability empirically.
 *
 * Two scenarios are run:
 *
 *   (c.1) Anchor stability WITH content_map tracking (the spec's normal
 *         operation): identical content always maps to the same anchor.
 *         This must be 100% stable and serves as a sanity check.
 *
 *   (c.2) Anchor stability WITHOUT content_map (simulates either:
 *         (a) a future design that drops content_map for memory savings;
 *         (b) the document's worst-case where the freed slot has been
 *             claimed by another line, so the re-add must probe).
 *
 *         Here we run a churn session on a 3000-line file:
 *           - delete 200 random lines
 *           - insert 200 DIFFERENT lines (which may take the freed slots)
 *           - re-insert the 200 original lines
 *           - measure: how many got a different anchor than at session start?
 *
 * Output: docs/research/dynamic-hashline-hash-choice-scripts/results/03-delete-readd.json
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

// BLAKE2b-64 — Node 26 dropped `outputLength` on non-XOF ciphers; we compute
// the full 64-byte BLAKE2b-512 and take the first 8 bytes (== BLAKE2b-64).
function blake2b64Num(buf) {
	const d = createHash("blake2b512")
		.update(buf)
		.digest()
		.subarray(0, 8);
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
 * Layered allocator.
 *   trackContent: when true, content_map short-circuits re-insertion.
 */
function makeAllocator(hashFn, { trackContent = true } = {}) {
	const anchorMap = new Map();
	const contentMap = new Map();
	const freeCounts = new Map([
		[2, 62 * 62],
		[3, 62 * 62 * 62],
	]);
	function allocate(content) {
		if (trackContent && contentMap.has(content)) {
			const a = contentMap.get(content);
			return { anchor: a, probes: 0, depth: a.length };
		}
		const fullHash = hashFn(content);
		for (let depth = 2; depth <= 3; depth++) {
			if (freeCounts.get(depth) === 0) continue;
			const total = 62 ** depth;
			const startIdx = Number(fullHash % BigInt(total));
			const step =
				total > 1
					? (Number(fullHash % BigInt(total - 1)) % total) + 1
					: 1;
			for (let offset = 0; offset < total; offset++) {
				const idx = (startIdx + offset * step) % total;
				const candidate = idxToBase62(idx, depth);
				if (!anchorMap.has(candidate)) {
					anchorMap.set(candidate, content);
					if (trackContent) contentMap.set(content, candidate);
					freeCounts.set(depth, freeCounts.get(depth) - 1);
					return { anchor: candidate, probes: offset + 1, depth };
				}
			}
		}
		throw new Error("hash space exhausted");
	}
	function deleteContent(content) {
		const anchor = trackContent
			? contentMap.get(content)
			: anchorOf(content, anchorMap, hashFn);
		if (anchor === undefined) return false;
		anchorMap.delete(anchor);
		if (trackContent) contentMap.delete(content);
		const depth = anchor.length;
		freeCounts.set(depth, freeCounts.get(depth) + 1);
		return true;
	}
	return { allocate, deleteContent, anchorMap, contentMap, freeCounts };
}

// Without content_map, "which anchor does content X have?" requires a probe.
function anchorOf(content, anchorMap, hashFn) {
	const fullHash = hashFn(content);
	for (let depth = 2; depth <= 3; depth++) {
		const total = 62 ** depth;
		const startIdx = Number(fullHash % BigInt(total));
		const step =
			total > 1
				? (Number(fullHash % BigInt(total - 1)) % total) + 1
				: 1;
		for (let offset = 0; offset < total; offset++) {
			const idx = (startIdx + offset * step) % total;
			const candidate = idxToBase62(idx, depth);
			if (anchorMap.get(candidate) === content) return candidate;
			if (!anchorMap.has(candidate)) return undefined; // slot free → not allocated
		}
	}
	return undefined;
}

// ----- distinct-line corpus (avoids the prior random-collision issue) -----
function makeDistinctCorpus(n) {
	// Each line is its own 16-byte hex chunk — guaranteed unique within 2^64.
	const out = new Array(n);
	const buf = randomBytes(16 * n);
	for (let i = 0; i < n; i++) {
		out[i] = `line_${buf.subarray(i * 16, (i + 1) * 16).toString("hex")}`;
	}
	return out;
}

const INITIAL_LINES = 3000;
const ROUNDS = 500;

console.log(
	`generating distinct corpus: ${INITIAL_LINES + ROUNDS} unique hex lines...`,
);
const corpus = makeDistinctCorpus(INITIAL_LINES + ROUNDS);

function runScenario(hashFn, trackContent) {
	const sys = makeAllocator(hashFn, { trackContent });
	const initialAnchors = new Map(); // content -> anchor at start
	for (let i = 0; i < INITIAL_LINES; i++) {
		const r = sys.allocate(corpus[i]);
		initialAnchors.set(corpus[i], r.anchor);
	}

	let anchorChanges = 0;
	const probesDuringReAdd = [];
	for (let i = 0; i < ROUNDS; i++) {
		const pickIdx = i; // walk through corpus[0..ROUNDS-1] deterministically
		const originalContent = corpus[pickIdx];
		const originalAnchor = initialAnchors.get(originalContent);
		// 1) delete
		sys.deleteContent(originalContent);
		// 2) insert DIFFERENT new content (from corpus[INITIAL_LINES..])
		const newContent = corpus[INITIAL_LINES + i];
		sys.allocate(newContent);
		// 3) re-insert the original content
		const re = sys.allocate(originalContent);
		if (re.anchor !== originalAnchor) anchorChanges++;
		probesDuringReAdd.push(re.probes);
		// Track the new anchor for the next round
		initialAnchors.set(originalContent, re.anchor);
	}
	const probesSorted = [...probesDuringReAdd].sort((a, b) => a - b);
	const sum = probesSorted.reduce((a, b) => a + b, 0);
	return {
		rounds: ROUNDS,
		trackContent,
		anchorChanges,
		changeRate: anchorChanges / ROUNDS,
		reAddProbes: {
			count: probesSorted.length,
			mean: sum / probesSorted.length,
			min: probesSorted[0],
			p50: probesSorted[Math.floor(probesSorted.length * 0.5)],
			p95: probesSorted[Math.floor(probesSorted.length * 0.95)],
			max: probesSorted[probesSorted.length - 1],
		},
	};
}

const results = {
	initialLines: INITIAL_LINES,
	rounds: ROUNDS,
};

for (const [name, fn] of [
	["cyrb53", (s) => BigInt(cyrb53(s))],
	["blake2b64", (s) => blake2b64Num(Buffer.from(s, "latin1"))],
]) {
	results[name] = {
		withContentMap: runScenario(fn, true),
		withoutContentMap: runScenario(fn, false),
	};
}

writeFileSync(
	join(RESULTS_DIR, "03-delete-readd.json"),
	JSON.stringify(results, null, 2),
);

console.log(
	"\n=== delete + re-add (3000 lines, 500 rounds, distinct corpus) ===",
);
for (const [name, r] of Object.entries(results).slice(0)) {
	if (name === "initialLines" || name === "rounds") continue;
	console.log(
		`  ${name.padEnd(10)} WITH content_map: changes=${r.withContentMap.anchorChanges}/${r.withContentMap.rounds} (${(r.withContentMap.changeRate * 100).toFixed(1)}%)  re-add probes: mean=${r.withContentMap.reAddProbes.mean.toFixed(2)} max=${r.withContentMap.reAddProbes.max}`,
	);
	console.log(
		`  ${name.padEnd(10)} NO content_map:   changes=${r.withoutContentMap.anchorChanges}/${r.withoutContentMap.rounds} (${(r.withoutContentMap.changeRate * 100).toFixed(1)}%)  re-add probes: mean=${r.withoutContentMap.reAddProbes.mean.toFixed(2)} max=${r.withoutContentMap.reAddProbes.max}`,
	);
}
console.log(
	"\nresult file: docs/research/dynamic-hashline-hash-choice-scripts/results/03-delete-readd.json",
);