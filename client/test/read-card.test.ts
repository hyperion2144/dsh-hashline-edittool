/**
 * Tests for the read card's pure half and its one structural promise.
 *
 * What cannot be asserted here is the rendering: this environment has no DOM, so
 * "the two columns line up" is a real-machine check. What CAN be asserted is the
 * rule that keeps them aligned (one fold window drives both columns) and the
 * promise that the card mounts no shipped primitive.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCardLabels } from "../src/client/labels.js";
import { foldWindow, markerColumnCh, readCardMeta } from "../src/client/read-meta.js";
import type { ReadCardModel } from "../src/client/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const cardSource = readFileSync(join(clientRoot, "src", "client", "read-card.tsx"), "utf8");
const bundleSource = readFileSync(join(clientRoot, "lib", "client.js"), "utf8");

/** A minimal translator: returns `key(params)` so assertions can see the key. */
const t = (key: string, params?: Record<string, unknown>): string =>
	params === undefined ? key : `${key}(${Object.values(params).join(",")})`;

/** A two-row window out of a three-line file. */
function model(overrides: Partial<ReadCardModel> = {}): ReadCardModel {
	return {
		path: "/w/src/a.ts",
		label: "src/a.ts",
		rows: [
			{ number: 1, hash: "a1", gutter: "1:a1", text: "const a = 1;" },
			{ number: 2, hash: "b2", gutter: "2:b2", text: "const b = 2;" },
		],
		totalLines: 3,
		lang: "ts",
		...overrides,
	};
}

describe("readCardMeta", () => {
	it("reports the language hint and the window count, in that order", () => {
		expect(readCardMeta(model(), readCardLabels(t))).toEqual(["ts", "read.window(2,3)"]);
	});

	it("drops the window count when the read IS the whole file", () => {
		expect(readCardMeta(model({ totalLines: 2 }), readCardLabels(t))).toEqual(["ts"]);
	});

	it("draws no footer at all when there is nothing to say", () => {
		expect(readCardMeta(model({ lang: undefined, totalLines: 2 }), readCardLabels(t))).toEqual([]);
		expect(readCardMeta(model({ lang: "", totalLines: 2 }), readCardLabels(t))).toEqual([]);
	});
});

describe("foldWindow drives both columns", () => {
	it("caps the middle: half the window at the head, the REST at the tail", () => {
		expect(foldWindow(10, 8, false)).toEqual({ head: [0, 1, 2, 3], tail: [6, 7, 8, 9], hidden: 2 });
	});

	it("splits an ODD cap the way the shipped card did: tail = cap - head", () => {
		// The bug this pins: `tail` is `maxLines - head`, NOT `head`. They agree
		// only for an even cap, which is how a one-row drift once hid.
		expect(foldWindow(20, 7, false)).toEqual({ head: [0, 1, 2, 3], tail: [17, 18, 19], hidden: 13 });
	});

	it("holds every row when the cap is not reached, and opens to every row", () => {
		expect(foldWindow(5, 8, false)).toEqual({ head: [0, 1, 2, 3, 4], tail: [], hidden: 0 });
		expect(foldWindow(10, 8, true).head).toHaveLength(10);
		expect(foldWindow(10, 8, true).tail).toEqual([]);
		expect(foldWindow(10, 8, true).hidden).toBe(2);
	});

	it("never names a row the card does not hold, and never twice", () => {
		for (const total of [0, 1, 7, 8, 9, 120]) {
			for (const expanded of [false, true]) {
				const view = foldWindow(total, 8, expanded);
				const named = [...view.head, ...view.tail];
				expect(named.every((index) => index >= 0 && index < total)).toBe(true);
				expect(new Set(named).size).toBe(named.length);
			}
		}
	});
});

describe("the card mounts nothing shipped", () => {
	it("imports no primitive component", () => {
		// The whole point: the frame, gutter, fold and colours are ours. Only the
		// clipboard helper comes from the primitives, and it renders nothing.
		// The prose explains WHY the shipped block is not used, so the assertion is
		// about the import/JSX, not about the word.
		expect(/import[^;]*ReadBlock/.test(cardSource)).toBe(false);
		expect(cardSource).not.toContain("jsx_(ReadBlock");
		expect(cardSource).toContain('from "@deepseek-ai/dsh-client-ui-primitives"');
		expect(cardSource).toContain("writeClipboard");
	});

	it("draws its own gutter, fold and syntax classes", () => {
		expect(cardSource).toContain("dshl-read-gutter");
		expect(cardSource).toContain("dshl-read-fold");
		expect(cardSource).toContain("TOKEN_CLASS");
	});

	it("colours from theme tokens, never from a literal colour", () => {
		// The sheet may carry no hex/rgb colour: the token sheet IS the palette, and
		// a literal would be wrong in one of the two themes.
		expect(/#[0-9a-fA-F]{3,8}\b/.test(cardSource)).toBe(false);
		expect(/rgb\(/.test(cardSource)).toBe(false);
		expect(cardSource).toContain("var(--dsw-alias-state-business-primary)");
	});

	it("marker cells are selectable except during a code-origin drag", () => {
		// The marker column is plain text by default. The ONE allowed
		// `user-select:none` is the drag-origin rule (#131): when a drag starts
		// in the code, the anchor cells are passed over for that drag — when it
		// starts in the anchor column, anchors and text select together.
		const sources = ["read-card.tsx", "diff-block.tsx", "grep-card.tsx", "lsp-block.tsx"].map(
			(name) => readFileSync(join(clientRoot, "src", "client", name), "utf8"),
		);
		for (const source of sources) {
			const lines = source.split("\n").filter((line) => line.includes("user-select:none"));
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("dshl-suppress-anchor-select");
		}
		// The shared classifier must exist and reference every card's anchor cells.
		const classifier = readFileSync(join(clientRoot, "src", "client", "anchor-select.ts"), "utf8");
		expect(classifier).toContain("mousedown");
		expect(classifier).toContain("dshl-suppress-anchor-select");
	});
});

describe("the built bundle", () => {
	it("ships the card's own DOM and no ReadBlock mount", () => {
		expect(bundleSource).toContain("dshl-read-gutter");
		expect(bundleSource).toContain("dshl-read-fold");
		expect(bundleSource).not.toContain("ReadBlock");
	});
});

describe("markerColumnCh sizes the column from the data", () => {
	it("fits the widest marker with a character of room on each side", () => {
		expect(markerColumnCh(["1:a1", "2:b2"])).toBe(6);
		expect(markerColumnCh(["1089:1f"])).toBe(9);
	});

	it("never squeezes below a two-digit number", () => {
		expect(markerColumnCh(["1", "2"])).toBe(6);
		expect(markerColumnCh([])).toBe(6);
	});

	it("tracks the widest row, not the first", () => {
		expect(markerColumnCh(["1:a1", "10000:zz"])).toBe(10);
	});
});
