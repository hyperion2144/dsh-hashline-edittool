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
import { buildFieldOp, requestedView, settingsSummaryText } from "../src/client/settings-model.js";

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

describe("buildFieldOp — the write path's set-vs-clear boundary (#158)", () => {
	it("builds a set op for a value", () => {
		expect(buildFieldOp("separator", "|")).toEqual({
			op: "set",
			path: ["separator"],
			value: "|",
		});
	});
	it("builds an unset op for NO value — the field re-inherits the base", () => {
		expect(buildFieldOp("ast")).toEqual({ op: "unset", path: ["ast"] });
	});
	it("sets falsy values without collapsing them into clears", () => {
		// `false` and 0 are WRITES, not clears — only an absent value clears.
		expect(buildFieldOp("require_line_content", false)).toEqual({
			op: "set",
			path: ["require_line_content"],
			value: false,
		});
		expect(buildFieldOp("context_lines", 0)).toEqual({
			op: "set",
			path: ["context_lines"],
			value: 0,
		});
	});
});
