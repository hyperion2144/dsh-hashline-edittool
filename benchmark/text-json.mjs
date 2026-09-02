#!/usr/bin/env node
/**
 * text-json.mjs — text vs json output-format token comparison.
 *
 * Measures the MODEL-SIDE INPUT tokens (what the tool results feed back
 * into the context) for the plugin's two output formats, using the real
 * lib renderers:
 *
 *   read — buildReadPresentation (text rows) vs buildReadJson (lines dict)
 *   edit — text response (header + diff rows, fresh anchors) vs json envelope
 *          (ok/files/applied/finalLines/hints/warnings/errors)
 *
 * Deterministic: fixed corpus, fixed windows, js-tiktoken cl100k_base when
 * available (chars/4 fallback).
 *
 * Run: node benchmark/text-json.mjs
 */
import { getEncoding } from "js-tiktoken";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const { buildReadPresentation, buildReadJson } = require(
	join(repoRoot, "lib/presentation-helpers.js"),
);
const { lineHashesPure } = require(
	join(repoRoot, "lib/hashline/hash-assign.js"),
);
const { genDiff } = require(join(repoRoot, "lib/edit-diff.js"));
const { hashlineHeader } = require(join(repoRoot, "lib/hashline/hash-assign.js"));

let tokenizer = null;
try {
	tokenizer = getEncoding("cl100k_base");
} catch {
	// fall through
}
function tokens(text) {
	if (tokenizer) return tokenizer.encode(text).length;
	return Math.ceil(text.length / 4);
}
const TOKENIZER_NAME = tokenizer ? "js-tiktoken cl100k_base" : "chars/4";

const corpusPath = join(__dirname, "corpus", "shopping-cart.ts");
const CORPUS = readFileSync(corpusPath, "utf8");
const HASHLEN = 2; // match the live settings (hash_length: 2)

// --- read arms ---------------------------------------------------------------
function readText(content, offset, limit) {
	const hashes = lineHashesPure(content);
	return buildReadPresentation(content, hashes, offset, limit, "cart.ts")
		.modelText;
}
function readJson(content, offset, limit) {
	const hashes = lineHashesPure(content);
	return JSON.stringify(
		buildReadJson(content, hashes, offset, limit, "cart.ts"),
	);
}

// --- edit arms ---------------------------------------------------------------
// Text: header + diff rows (genDiff, fresh anchors). Json: the envelope with
// finalLines window + applied before/after.
function editText(content, start, end, newLines) {
	const result = [
		...content.split("\n").slice(0, start - 1),
		...newLines,
		...content.split("\n").slice(end),
	].join("\n");
	// v2.0: no Shift block — the post-edit diff rows carry fresh anchors.
	const diff = genDiff(content, result, 2, undefined, undefined);
	return `${hashlineHeader()}\n${diff.diff}`;
}
function editJson(content, start, end, newLines) {
	const result = [
		...content.split("\n").slice(0, start - 1),
		...newLines,
		...content.split("\n").slice(end),
	].join("\n");
	// Mirror the real json view: anchor-keyed diff dict.
	const diff = genDiff(content, result, 3, undefined, undefined);
	const diffDict = {};
	for (const r of diff.rows) {
		diffDict[r.kind === "-" ? "-" + r.anchor : r.kind === "+" ? "+" + r.anchor : r.anchor] = r.content;
	}
	return JSON.stringify({
		ok: true,
		path: "cart.ts",
		diff: diffDict,
		hints: [
			`edits[0]: original lines ${start}..${end} moved to ${start}..${start + newLines.length - 1} (${newLines.length - (end - start + 1) >= 0 ? "+" : ""}${newLines.length - (end - start + 1)})`,
		],
		warnings: [],
		errors: [],
	});
}


const rows = [];

const full = CORPUS.split("\n").length;
const windows = [
	{ label: "read · whole file", offset: 1, limit: full },
	{ label: "read · 50-line window", offset: 40, limit: 50 },
	{ label: "read · 10-line window", offset: 80, limit: 10 },
];
for (const w of windows) {
	const t = tokens(readText(CORPUS, w.offset, w.limit));
	const j = tokens(readJson(CORPUS, w.offset, w.limit));
	rows.push({
		label: w.label,
		text: t,
		json: j,
		delta: j - t,
		ratio: (j / t).toFixed(2),
	});
}

const editScenarios = [
	{ label: "edit · 1→1 single line", start: 41, end: 41, newLines: ["export const TAX_RATE = 0.21;"] },
	{
		label: "edit · 10→2 shrink",
		start: 90,
		end: 99,
		newLines: ["new line one", "new line two"],
	},
	{ label: "edit · 2→10 expand", start: 90, end: 91, newLines: Array.from({ length: 10 }, (_, i) => `new line ${i + 1}`) },
];
for (const e of editScenarios) {
	const t = tokens(editText(CORPUS, e.start, e.end, e.newLines));
	const j = tokens(editJson(CORPUS, e.start, e.end, e.newLines));
	rows.push({
		label: e.label,
		text: t,
		json: j,
		delta: j - t,
		ratio: (j / t).toFixed(2),
	});
}

// --- report ------------------------------------------------------------------
console.log(`\ndsh-hashline-edittool — text vs json output tokens (${TOKENIZER_NAME})`);
console.log(`corpus: ${basename(corpusPath)} · ${full} lines\n`);
const pad = (s, n) => String(s).padEnd(n);
const cell = (s, n) => pad(s, n);
console.log(
	`${pad("scenario", 28)} | ${cell("text", 7)} | ${cell("json", 7)} | ${cell("json−text", 11)} | ${cell("json/text", 9)} |`,
);
console.log("-".repeat(72));
for (const r of rows) {
	console.log(
		`${pad(r.label, 28)} | ${cell(r.text, 7)} | ${cell(r.json, 7)} | ${cell(`${r.delta >= 0 ? "+" : ""}${r.delta}`, 11)} | ${cell(r.ratio, 9)} |`,
	);
}
console.log(`\nread rows: json keys repeat the anchor per line; text rows repeat it
too, but json adds object punctuation + totalLines/offset fields, while text adds
the header teaching suffix once. Edit responses: text keeps diff rows with
fresh anchors; json keeps the envelope (diff dict, hints, warnings). Both are model-INPUT
tokens (tool results), not the model's output tokens.\n`);

function basename(p) {
	return p.split("/").pop();
}