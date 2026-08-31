#!/usr/bin/env node
/**
 * Goal (d): token-size comparison on a realistic file.
 *
 * Reuses benchmark/corpus/shopping-cart.ts (the same file the
 * `benchmark/run.mjs` harness uses) and computes the OUTPUT size of
 * rendering the whole file under three anchor strategies:
 *
 *   1. fixed-3-char anchor (current contract)            e.g. "12#aBc"
 *   2. variable-length 2-char-first anchor               e.g. "12#aB"
 *      (with no @ prefix; we test the @ prefix separately)
 *   3. variable-length 2-char-first anchor WITH @ prefix e.g. "12#@aB"
 *
 * Each row format mirrors `fmtHashlineRow` from
 * src/hashline/hash-assign.ts. We measure:
 *   - total bytes
 *   - mean anchor length
 *   - byte savings vs the fixed-3-char baseline
 *
 * Allocation: we hash every line with BLAKE2b-64 (recommended hash;
 * see report) and use the layered allocator from script 02.
 *
 * Output: docs/research/dynamic-hashline-hash-choice-scripts/results/04-token-size.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const CORPUS_PATH = join(
	__dirname,
	"..",
	"..",
	"..",
	"benchmark",
	"corpus",
	"shopping-cart.ts",
);
const corpus = readFileSync(CORPUS_PATH, "utf8");

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

// Node 26 dropped `outputLength` on non-XOF ciphers; compute the full
// 64-byte BLAKE2b-512 and take the first 8 bytes (== BLAKE2b-64 digest).
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

// Variable-length 2-char-first allocator (same logic as script 02).
function allocateVariable(corpusLines) {
	const anchorMap = new Map();
	const contentMap = new Map();
	const freeCounts = new Map([
		[2, 62 * 62],
		[3, 62 * 62 * 62],
	]);
	const anchors = new Array(corpusLines.length);
	for (let i = 0; i < corpusLines.length; i++) {
		const line = corpusLines[i];
		if (contentMap.has(line)) {
			anchors[i] = contentMap.get(line);
			continue;
		}
		const fullHash = blake2b64Num(Buffer.from(line, "utf8"));
		let allocated = null;
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
					anchorMap.set(candidate, line);
					contentMap.set(line, candidate);
					freeCounts.set(depth, freeCounts.get(depth) - 1);
					allocated = candidate;
					break;
				}
			}
			if (allocated) break;
		}
		anchors[i] = allocated;
	}
	return anchors;
}

// Fixed-3-char allocator (current contract).
function allocateFixed3(corpusLines) {
	const anchorMap = new Map();
	const SPACE = 62 * 62 * 62;
	const anchors = new Array(corpusLines.length);
	for (let i = 0; i < corpusLines.length; i++) {
		const line = corpusLines[i];
		const fullHash = blake2b64Num(Buffer.from(line, "utf8"));
		let c = Number(fullHash % BigInt(SPACE));
		for (let k = 0; k < SPACE; k++) {
			const ch =
				ALPH[c % 62] +
				ALPH[Math.floor(c / 62) % 62] +
				ALPH[Math.floor(c / 3844) % 62];
			if (!anchorMap.has(ch)) {
				anchorMap.set(ch, line);
				anchors[i] = ch;
				break;
			}
			c = (c + 1) % SPACE;
		}
	}
	return anchors;
}

function render(anchors, lines, prefix, sep) {
	// Pad anchor to the widest in the block for clean columns (matches
	// src/hashline/hash-assign.ts:fmtHashlineRow visual).
	const width = Math.max(...anchors.map((a) => a.length));
	let out = "";
	for (let i = 0; i < lines.length; i++) {
		const padded = anchors[i].padStart(width);
		out += `${prefix}${i + 1}#${padded}${sep} ${lines[i]}\n`;
	}
	return out;
}

function measure(buf) {
	return Buffer.byteLength(buf, "utf8");
}

function meanAnchorLen(anchors) {
	return anchors.reduce((s, a) => s + a.length, 0) / anchors.length;
}

const lines = corpus.split("\n");
if (lines[lines.length - 1] === "") lines.pop();

console.log(`corpus: ${lines.length} lines from ${CORPUS_PATH}`);

const fixedAnchors = allocateFixed3(lines);
const varAnchors = allocateVariable(lines);

const fixedOut = render(fixedAnchors, lines, "", ":");
const varOut = render(varAnchors, lines, "", ":");
const varAtOut = render(varAnchors, lines, "", "#"); // the @ is in the anchor itself
const varAtAnchors = varAnchors.map((a) => "@" + a);
const varAtOut2 = render(varAtAnchors, lines, "", ":");

const results = {
	corpusPath: CORPUS_PATH,
	lineCount: lines.length,
	fixed3: {
		meanAnchorLen: meanAnchorLen(fixedAnchors),
		totalBytes: measure(fixedOut),
	},
	variable2First: {
		meanAnchorLen: meanAnchorLen(varAnchors),
		totalBytes: measure(varOut),
	},
	variable2FirstWithAtPrefix: {
		meanAnchorLen: meanAnchorLen(varAtAnchors),
		totalBytes: measure(varAtOut2),
	},
};

results.bytesSaved_variable_vs_fixed =
	results.fixed3.totalBytes - results.variable2First.totalBytes;
results.pctSaved_variable_vs_fixed =
	(results.bytesSaved_variable_vs_fixed / results.fixed3.totalBytes) * 100;

results.bytesSavedAtPrefix =
	results.fixed3.totalBytes - results.variable2FirstWithAtPrefix.totalBytes;
results.pctSavedAtPrefix =
	(results.bytesSavedAtPrefix / results.fixed3.totalBytes) * 100;

writeFileSync(
	join(RESULTS_DIR, "04-token-size.json"),
	JSON.stringify(results, null, 2),
);

console.log("\n=== token-size comparison (corpus = shopping-cart.ts) ===");
console.log(`lines: ${lines.length}`);
console.log(
	`fixed-3-char anchor:   mean-anchor-len=${results.fixed3.meanAnchorLen.toFixed(3)} total-bytes=${results.fixed3.totalBytes}`,
);
console.log(
	`variable (2-first):    mean-anchor-len=${results.variable2First.meanAnchorLen.toFixed(3)} total-bytes=${results.variable2First.totalBytes}`,
);
console.log(
	`  → saved ${results.bytesSaved_variable_vs_fixed} bytes (${results.pctSaved_variable_vs_fixed.toFixed(1)}%) vs fixed-3`,
);
console.log(
	`variable + '@' prefix: mean-anchor-len=${results.variable2FirstWithAtPrefix.meanAnchorLen.toFixed(3)} total-bytes=${results.variable2FirstWithAtPrefix.totalBytes}`,
);
console.log(
	`  → saved ${results.bytesSavedAtPrefix} bytes (${results.pctSavedAtPrefix.toFixed(1)}%) vs fixed-3`,
);

console.log(
	"\nresult file: docs/research/dynamic-hashline-hash-choice-scripts/results/04-token-size.json",
);