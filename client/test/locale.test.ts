/**
 * The cards' vocabulary contract (issue #372).
 *
 * Three things are locked here, and each of them was a hole once:
 *
 * 1. The zh and en dictionaries carry the SAME key set — a missing
 *    translation is a compile error in the module and a red test here.
 * 2. Every key a labels builder asks the host for exists in BOTH
 *    dictionaries. The four keys the shipped `conversation` seat never had
 *    (`diff.files.one`, `diff.files.other`, `lsp.title`,
 *    `lsp.diagnostics.summary`) rendered on screen as their own names; this
 *    is the pin that keeps them from coming back.
 * 3. The row labels the tool row calls DIRECTLY — no builder in between —
 *    are in the dictionary too.
 *
 * @module dsh-hashline-edittool-client/test/locale
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CARD_DICTIONARIES,
	CARD_NS,
	EN_CARD_DICTIONARY,
	ZH_CARD_DICTIONARY,
} from "../src/client/locale.js";
import {
	deleteCardLabels,
	diffBlockLabels,
	errorCardLabels,
	grepCardLabels,
	lspBlockLabels,
	readBlockLabels,
	readCardLabels,
	renameCardLabels,
} from "../src/client/labels.js";

/** The translator seat the builders take. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** One labels builder, as the coverage sweep calls it. */
type LabelBuilder = (t: Translate) => object;

/** The `{name}` placeholders a template carries, sorted. */
function placeholders(template: string): string[] {
	return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
}

/**
 * Run one labels builder and return every key it asks the host for.
 *
 * The lazy labels (the fold buttons, the footers) only ask when they are
 * CALLED, so they are called here — twice, with different counts, because the
 * count picks between the singular and the plural key (`diff.files.one` vs
 * `diff.files.other`) and between the whole and the truncated summary.
 */
function collectKeys(build: LabelBuilder): string[] {
	const keys: string[] = [];
	const t: Translate = (key) => {
		keys.push(key);
		return key;
	};
	const labels = build(t) as Record<string, unknown>;
	for (const value of Object.values(labels)) {
		if (typeof value !== "function") continue;
		const call = value as (...args: unknown[]) => unknown;
		call(1, 2, 3, false);
		call(2, 3, 4, true);
	}
	return keys;
}

describe("the card vocabulary", () => {
	it("lives under the plugin's own namespace", () => {
		expect(CARD_NS).toBe("hashline.card");
	});

	it("gives zh and en the SAME key set", () => {
		expect(Object.keys(ZH_CARD_DICTIONARY).sort()).toEqual(Object.keys(EN_CARD_DICTIONARY).sort());
		expect(Object.keys(EN_CARD_DICTIONARY).length).toBeGreaterThan(0);
	});

	it("gives zh and en the SAME placeholders", () => {
		for (const key of Object.keys(EN_CARD_DICTIONARY) as Array<keyof typeof EN_CARD_DICTIONARY>) {
			expect(placeholders(ZH_CARD_DICTIONARY[key])).toEqual(placeholders(EN_CARD_DICTIONARY[key]));
		}
	});

	it("registers both baseline languages with the host", () => {
		expect(Object.keys(CARD_DICTIONARIES).sort()).toEqual(["en", "zh"]);
		expect(CARD_DICTIONARIES.en).toBe(EN_CARD_DICTIONARY);
		expect(CARD_DICTIONARIES.zh).toBe(ZH_CARD_DICTIONARY);
	});

	it("fills the four holes the shipped seat left", () => {
		for (const key of [
			"diff.files.one",
			"diff.files.other",
			"lsp.title",
			"lsp.diagnostics.summary",
		]) {
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});
});

describe("the labels builders", () => {
	const builders: ReadonlyArray<readonly [string, LabelBuilder]> = [
		["read block", readBlockLabels],
		["read card", readCardLabels],
		["diff block", diffBlockLabels],
		["lsp block", lspBlockLabels],
		["grep card", grepCardLabels],
		["delete card", deleteCardLabels],
		["rename card", renameCardLabels],
		["error card", errorCardLabels],
	];

	for (const [name, build] of builders) {
		it(`asks only for keys the dictionary has — ${name}`, () => {
			const keys = collectKeys(build);
			expect(keys.length).toBeGreaterThan(0);
			for (const key of keys) {
				expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
				expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
			}
		});
	}
});

describe("the row labels the tool row calls directly", () => {
	it("are all in the dictionary — no builder in between to catch them", () => {
		for (const key of [
			"row.running",
			"row.failed",
			"row.stopped",
			"row.input",
			"row.output",
			"row.inspect",
		"row.title.generic",
		]) {
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});
});

describe("the collected hardcoded words", () => {
	it("are in the dictionary — the delete card's five, the rename card's four and the error hint", () => {
		for (const key of [
			"delete.title",
			"delete.failedTitle",
			"delete.status.failed",
			"delete.status.deleted",
			"delete.status.absent",
			"rename.title",
			"rename.failedTitle",
			"rename.status.renamed",
			"rename.status.failed",
			"error.hintLabel",
		]) {
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});
});

/**
 * The settings card's own words (#375).
 *
 * The card draws every word it shows through the host's `t`, and that seat
 * is narrowed to this namespace's key union — so a typo is a COMPILE error. These
 * two tests are the RUNTIME half of the same contract: every settings key the
 * card mentions is pinned in BOTH dictionaries, and no user-visible Chinese is
 * left in the component.
 */
describe("the settings card's vocabulary", () => {
	const cardSource = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "settings-card.tsx"),
		"utf8",
	);

	it("asks only for keys BOTH dictionaries carry", () => {
		// The keys asked for directly, plus the ones a lookup table holds (the
		// format modes), because both are vocabulary keys the card depends on.
		const asked = [...cardSource.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1] ?? "");
		const literal = [...cardSource.matchAll(/"(settings\.[A-Za-z0-9.]+)"/g)].map((match) => match[1] ?? "");
		const keys = [...new Set([...asked, ...literal])];
		expect(keys.length).toBeGreaterThan(20);
		for (const key of keys) {
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});

	it("leaves no user-visible Chinese in the component", () => {
		// Every Chinese run left in the card must sit in a COMMENT — the card's own
		// design notes quote the words it used to draw. A run on any other line is a
		// hardcoded string that escaped the vocabulary.
		const offenders: string[] = [];
		for (const [index, line] of cardSource.split("\n").entries()) {
			const trimmed = line.trim();
			const isComment =
				trimmed.startsWith("*") ||
				trimmed.startsWith("//") ||
				trimmed.startsWith("/*") ||
				trimmed.startsWith("{/*") ||
				line.includes("/*") ||
				line.includes("//");
			if (isComment) continue;
			if (/[一-龥]/.test(line)) offenders.push(`${index + 1}: ${trimmed}`);
		}
		expect(offenders).toEqual([]);
	});
});
