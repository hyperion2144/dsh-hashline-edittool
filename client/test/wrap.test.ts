/**
 * Tests for the wrap switch (issue #373).
 *
 * What cannot be asserted here is the RENDERING: this environment has no DOM,
 * so "the long line folds instead of scrolling sideways" is a real-machine
 * check. What CAN be asserted is everything the switch is made of — the state
 * machine, the button's shape (pressed + glyph), the attribute a card body
 * carries, and the ONE sheet that owns the five card kinds' double-state rules.
 *
 * The structural promises are asserted against the SOURCE, the way the read
 * card's own test does it: the switch is a promise that the five card bodies
 * share one rule sheet, and a promise that the delete and settings cards stay
 * out of it.
 *
 * @module dsh-hashline-edittool-client/test/wrap
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_WRAP_STATE,
	WRAP_BUTTON_CLASS,
	WRAP_STATES,
	nextWrapState,
	wrapButtonShape,
	wrapStateProps,
} from "../src/client/wrap.js";
import { EN_CARD_DICTIONARY, ZH_CARD_DICTIONARY } from "../src/client/locale.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");

/** One source file of the client package, read as text. */
function source(name: string): string {
	return readFileSync(join(clientRoot, "src", "client", name), "utf8");
}

/** The card sources that draw code-ish text, and the sheet that owns their rules. */
const CARD_SOURCES = [
	["read", "read-card.tsx"],
	["grep", "grep-card.tsx"],
	["diff", "diff-block.tsx"],
	["lsp", "lsp-block.tsx"],
	["error", "error-card.tsx"],
] as const;

describe("the wrap switch's state", () => {
	it("starts with the text WRAPPING — the default is the readable one", () => {
		expect(DEFAULT_WRAP_STATE).toBe("on");
	});

	it("has exactly two states", () => {
		expect([...WRAP_STATES]).toEqual(["on", "off"]);
	});

	it("flips to the other state", () => {
		expect(nextWrapState("on")).toBe("off");
		expect(nextWrapState("off")).toBe("on");
	});

	it("round-trips: two flips are the state again", () => {
		for (const state of WRAP_STATES) {
			expect(nextWrapState(nextWrapState(state))).toBe(state);
		}
	});
});

describe("the button's shape", () => {
	it("is PRESSED and draws the wrap glyph while the text wraps", () => {
		expect(wrapButtonShape("on")).toEqual({ pressed: true, icon: "wrap" });
	});

	it("is UNPRESSED and draws the nowrap glyph while it does not", () => {
		expect(wrapButtonShape("off")).toEqual({ pressed: false, icon: "nowrap" });
	});

	it("never shows the same glyph in both states", () => {
		expect(wrapButtonShape("on").icon).not.toBe(wrapButtonShape("off").icon);
	});
});

describe("the body's state attribute", () => {
	it("is `data-wrap`, carrying the state itself", () => {
		expect(wrapStateProps("on")).toEqual({ "data-wrap": "on" });
		expect(wrapStateProps("off")).toEqual({ "data-wrap": "off" });
	});
});

describe("the vocabulary", () => {
	it("carries the toggle's word in BOTH languages", () => {
		expect(EN_CARD_DICTIONARY["wrap.toggle"]).toBe("Toggle line wrap");
		expect(ZH_CARD_DICTIONARY["wrap.toggle"]).toBe("切换自动换行");
	});
});

describe("the cards that draw the switch", () => {
	for (const [name, file] of CARD_SOURCES) {
		it(`draws the wrap button — ${name}`, () => {
			expect(source(file)).toContain("WrapToggleButton");
		});

		it(`carries the state on its own text container — ${name}`, () => {
			expect(source(file)).toContain("wrapStateProps");
		});
	}

	it("keeps the delete and the settings cards out of it", () => {
		expect(source("delete-card.tsx")).not.toContain("WrapToggleButton");
		expect(source("settings-card.tsx")).not.toContain("WrapToggleButton");
	});
});

describe("the tab strip's trailing slot", () => {
	it("exists, and renders BEFORE the copy button", () => {
		const strip = source("tab-strip.tsx");
		expect(strip).toContain("trailing");
		const trailing = strip.indexOf("trailing ?? null");
		const copy = strip.indexOf("copy ?? null");
		expect(trailing).toBeGreaterThan(-1);
		expect(copy).toBeGreaterThan(-1);
		expect(trailing).toBeLessThan(copy);
	});

	it("is a general slot, not a wrap-specific one", () => {
		// The strip knows nothing about wrapping: it takes a node, and it does
		// not import the switch. The card decides what the node is.
		const strip = source("tab-strip.tsx");
		expect(strip).not.toContain('from "./wrap.js"');
		expect(strip).not.toContain('from "./wrap-button.js"');
		expect(strip).not.toContain("WrapToggleButton");
	});
});

describe("the shared sheet", () => {
	const sheet = source("wrap-button.tsx");

	it("is the ONE place the five card kinds' double-state rules live", () => {
		for (const selector of [
			".dshl-read-body[data-wrap=on]",
			".dshl-grep-body[data-wrap=on]",
			".dshl-diff-body[data-wrap=on]",
			".dshl-lsp-body[data-wrap=on]",
			".dshl-errorContext[data-wrap=on]",
		]) {
			expect(sheet).toContain(selector);
		}
	});

	it("folds the text instead of scrolling it sideways", () => {
		expect(sheet).toContain("white-space:pre-wrap");
		expect(sheet).toContain("overflow-wrap:break-word");
		expect(sheet).toContain("overflow-x:hidden");
	});

	it("never folds the gutter — the anchor column keeps its own line", () => {
		// The anchor column is a fixed-width cell: folding it would move the
		// markers away from the lines they address.
		expect(sheet).toContain(
			".dshl-read-gutter,.dshl-grep-gutter,.dshl-diff-gutter-line,.dshl-lsp-gutter{white-space:pre}",
		);
	});

	it("gives the button the strip's own icon-button language", () => {
		expect(sheet).toContain(WRAP_BUTTON_CLASS);
		expect(sheet).toContain("width:28px");
		expect(sheet).toContain("height:28px");
	});

	it("draws the two glyphs the switch promises", () => {
		expect(sheet).toContain("IconWrapLinesOutlineMedium");
		expect(sheet).toContain("IconNowrapFillMedium");
		expect(sheet).toContain("size: 14");
	});
});

describe("the built bundle", () => {
	const bundleSource = readFileSync(join(clientRoot, "lib", "client.js"), "utf8");

	it("ships the switch and its rules", () => {
		expect(bundleSource).toContain(WRAP_BUTTON_CLASS);
		expect(bundleSource).toContain("data-wrap=on");
	});
});
