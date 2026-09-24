/**
 * The settings card's registration-free seam: which view the manager page's
 * props select, the summary one-liner, and the controller face the card
 * drives at bundle level (#171).
 *
 * The JSX wiring (summary → one line, page → the form) and the slot
 * registration (name `plugins.bundle.config`, key `dsh-hashline-edittool`,
 * inject `["slots", "configForms"]`) are component/build concerns — the
 * registration is pinned by `scripts/verify-bundle.mjs` against the exact
 * shipped artifact, the same split the tool rows made: text-deciding logic
 * here, visuals real-machine.
 *
 * @module dsh-hashline-edittool/client/test/settings-card
 */
import { describe, expect, it, vi } from "vitest";
import {
	buildFieldOp,
	controllerSnapshot,
	formFace,
	NOT_READY_SNAPSHOT,
	requestedView,
	settingsSummaryText,
} from "../src/client/settings-model.js";
import type { ConfigForm, ConfigFormSnapshot } from "../src/client/types.js";

function fakeForm(snapshot: ConfigFormSnapshot): ConfigForm & { listeners: Array<() => void>; mutateCalls: unknown[][] } {
	const listeners: Array<() => void> = [];
	const mutateCalls: unknown[][] = [];
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.push(listener);
			return () => {
				const at = listeners.indexOf(listener);
				if (at >= 0) listeners.splice(at, 1);
			};
		},
		set: async () => true,
		unset: async () => true,
		mutate: async (ops, revision) => {
			mutateCalls.push([ops, revision]);
			return true;
		},
		listeners,
		mutateCalls,
	};
}

const READY: ConfigFormSnapshot = {
	status: "ready",
	value: { separator: "|" },
	base: {},
	user: {},
	revision: 7,
	writable: true,
	mode: "host",
};

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

describe("the controller face (#171) — the card's own settings source", () => {
	it("reads through to the form's snapshot", () => {
		const form = fakeForm(READY);
		expect(formFace(form).getSnapshot()).toBe(READY);
	});

	it("forwards subscriptions and their disposers", () => {
		const form = fakeForm(READY);
		const face = formFace(form);
		const listener = vi.fn();
		const off = face.subscribe(listener);
		expect(form.listeners).toHaveLength(1);
		form.listeners[0]!();
		expect(listener).toHaveBeenCalledTimes(1);
		off();
		expect(form.listeners).toHaveLength(0);
	});

	it("writes the built path-op through mutate, revision and all", async () => {
		const form = fakeForm(READY);
		const face = formFace(form);
		await expect(face.mutate([buildFieldOp("separator", "|")], 7)).resolves.toBe(true);
		expect(form.mutateCalls).toEqual([[
			[{ op: "set", path: ["separator"], value: "|" }],
			7,
		]]);
	});

	it("renders the not-ready snapshot when the slot injected no controller", () => {
		// The bundle page hands `{ view }` and no form; a deployment that never
		// served the namespace must degrade to the gate, not crash.
		expect(controllerSnapshot(undefined)).toBe(NOT_READY_SNAPSHOT);
		expect(NOT_READY_SNAPSHOT.status).toBe("unavailable");
		expect(NOT_READY_SNAPSHOT.writable).toBe(false);
	});

	it("renders the controller's own snapshot once it is injected", () => {
		const face = formFace(fakeForm(READY));
		expect(controllerSnapshot(face)).toBe(READY);
	});
});
