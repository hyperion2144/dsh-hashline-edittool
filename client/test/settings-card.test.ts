/**
 * The settings card's registration-free seam: which view the manager page's
 * props select, and the summary one-liner.
 *
 * The JSX wiring (summary → one line, page → the form) and the slot
 * registration (name `plugins.bundle.config`, key `dsh-hashline-edittool`)
 * are component/build concerns — the registration is pinned by
 * `scripts/verify-bundle.mjs` against the exact shipped artifact, the same
 * split the tool rows made: text-deciding logic here, visuals real-machine.
 *
 * @module dsh-hashline-edittool/client/test/settings-card
 */
import { describe, expect, it } from "vitest";
import { requestedView, settingsSummaryText } from "../src/client/settings-model.js";

describe("requestedView — the manager page's view prop", () => {
	it("hands the page form to an absent prop (defensive default)", () => {
		expect(requestedView(undefined)).toBe("page");
	});
	it("renders the one-liner only for the summary view", () => {
		expect(requestedView("summary")).toBe("summary");
	});
	it("renders the page form for the page view", () => {
		expect(requestedView("page")).toBe("page");
	});
});

describe("settingsSummaryText — the bundle page's one-liner", () => {
	it("says what the card governs in a single line", () => {
		const text = settingsSummaryText();
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toMatch(/\n/);
		expect(text).toContain("read");
	});
});
