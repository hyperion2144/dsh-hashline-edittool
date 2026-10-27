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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	STORE_BUDGET_SPECS,
	LSP_IDLE_SPEC,
	buildFieldOp,
	controllerSnapshot,
	formFace,
	NOT_READY_SNAPSHOT,
	requestedView,
	readFormatFlags,
	readLspIdleMs,
	readWritePreview,
	settingsSummaryText,
	validateStoreBudgetDraft,
	validateLspIdleDraft,
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

describe("readWritePreview (map #354) — the three-way echo switch", () => {
	const withWrite = (write: unknown): ConfigFormSnapshot => ({ ...READY, value: { ...READY.value, write } });

	it("keeps every mode — `diff` must not fall back to `full` (#365)", () => {
		expect(readWritePreview(withWrite({ preview: "diff" }))).toBe("diff");
		expect(readWritePreview(withWrite({ preview: "confirmation" }))).toBe("confirmation");
		expect(readWritePreview(withWrite({ preview: "full" }))).toBe("full");
	});

	it("falls back to the host default (diff) for absent or malformed values", () => {
		expect(readWritePreview(READY)).toBe("diff");
		expect(readWritePreview(withWrite(undefined))).toBe("diff");
		expect(readWritePreview(withWrite({ preview: "sideways" }))).toBe("diff");
	});
});

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
	it("builds a two-segment set op for a nested leaf (#179 — store budgets)", () => {
		expect(buildFieldOp(["store", "max_bytes_mb"], 64)).toEqual({
			op: "set",
			path: ["store", "max_bytes_mb"],
			value: 64,
		});
		expect(buildFieldOp(["store", "max_paths"], 5000)).toEqual({
			op: "set",
			path: ["store", "max_paths"],
			value: 5000,
		});
		expect(buildFieldOp(["store", "max_lines"], 300000)).toEqual({
			op: "set",
			path: ["store", "max_lines"],
			value: 300000,
		});
	});
	it("builds a two-segment unset op — 恢复默认 button (#179)", () => {
		// The card's reset button fires three unsets at once; each one carries
		// the same two-segment path shape the schema lives under.
		expect(buildFieldOp(["store", "max_bytes_mb"])).toEqual({
			op: "unset",
			path: ["store", "max_bytes_mb"],
		});
		expect(buildFieldOp(["store", "max_paths"])).toEqual({
			op: "unset",
			path: ["store", "max_paths"],
		});
		expect(buildFieldOp(["store", "max_lines"])).toEqual({
			op: "unset",
			path: ["store", "max_lines"],
		});
	});
	it("still accepts a bare string for the existing top-level call sites", () => {
		// Backward compatibility: nothing in `writeField` or the AST / core
		// controls had to change shape; the only addition is the array form.
		expect(buildFieldOp("separator", "|")).toEqual({
			op: "set",
			path: ["separator"],
			value: "|",
		});
		expect(buildFieldOp("separator")).toEqual({ op: "unset", path: ["separator"] });
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

describe("STORE_BUDGET_SPECS — the card's mirror of the host schema (#179 / #180)", () => {
	it("names the three fields in the documented order", () => {
		// The order matters: the card's three inputs are rendered against
		// this list, and a regression that reorders the array would silently
		// swap which input carries which range.
		expect(STORE_BUDGET_SPECS.map((entry) => entry.field)).toEqual([
			"max_bytes_mb",
			"max_paths",
			"max_lines",
		]);
	});

	it("matches the host-side schema ranges exactly", () => {
		// The divergence hazard: the host side (src/config.ts) and the
		// client side (this file) declare the same ranges independently. A
		// regression on either side would let a value through that the
		// other rejects. The host tests assert the schema throws for these
		// boundaries; this test is the corresponding client assertion.
		expect(STORE_BUDGET_SPECS[0]).toMatchObject({ min: 8, max: 2048, unit: "MiB" });
		expect(STORE_BUDGET_SPECS[1]).toMatchObject({ min: 100, max: 100000, unit: "个" });
		expect(STORE_BUDGET_SPECS[2]).toMatchObject({ min: 10000, max: 10000000, unit: "行" });
	});

	it("uses the two-segment path shape the mutate op expects", () => {
		// Each spec's `path` MUST be the array form — the card's onBlur
		// handler forwards it to `buildFieldOp(path, value)`, which only
		// treats a string as a single-segment path. A regression that
		// returned a bare `"store.max_bytes_mb"` would break the write.
		for (const spec of STORE_BUDGET_SPECS) {
			expect(spec.path).toEqual(["store", spec.field]);
		}
	});
});

describe("validateStoreBudgetDraft — the card's first line of defence", () => {
	it("treats empty input as `unset` (the legitimate 'restore default' signal)", () => {
		// Empty input is the same signal as the 恢复默认 button: clear the
		// override, let the host-side constant take over. NOT an error.
		for (const spec of STORE_BUDGET_SPECS) {
			expect(validateStoreBudgetDraft(spec, "")).toEqual({ kind: "unset" });
			expect(validateStoreBudgetDraft(spec, "   ")).toEqual({ kind: "unset" });
		}
	});

	it("treats whitespace-only input the same as empty", () => {
		// A user typing and then deleting back to whitespace would otherwise
		// land in the `error` branch on `Number.parseInt("") = NaN`.
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "  \t ")).toEqual({ kind: "unset" });
	});

	it("accepts values inside the range and returns the parsed integer", () => {
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "64")).toEqual({
			kind: "valid",
			value: 64,
		});
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[1], "5000")).toEqual({
			kind: "valid",
			value: 5000,
		});
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[2], "300000")).toEqual({
			kind: "valid",
			value: 300000,
		});
	});

	it("accepts the boundary values", () => {
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "8")).toEqual({ kind: "valid", value: 8 });
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "2048")).toEqual({ kind: "valid", value: 2048 });
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[1], "100")).toEqual({ kind: "valid", value: 100 });
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[1], "100000")).toEqual({
			kind: "valid",
			value: 100000,
		});
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[2], "10000")).toEqual({
			kind: "valid",
			value: 10000,
		});
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[2], "10000000")).toEqual({
			kind: "valid",
			value: 10000000,
		});
	});

	it("rejects values just below the floor with a Chinese error", () => {
		const result = validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "7");
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("8");
			expect(result.message).toContain("2048");
			expect(result.message).toContain("MiB");
			expect(result.message).toContain("超出允许范围");
		}
	});

	it("rejects values just above the ceiling with a Chinese error", () => {
		const result = validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "2049");
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("超出允许范围");
		}
	});

	it("rejects non-numeric input (does NOT silently treat it as unset)", () => {
		// The user typed "abc". The OLD behaviour: NaN → fails the integer
		// check → falls into the unset path → writeField with no value →
		// the override silently clears. The NEW behaviour: an error
		// message renders below the input and mutate is NOT called.
		const result = validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "abc");
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("整数");
		}
	});

	it("rejects float input (the schema is integer-only)", () => {
		// parseInt("64.5") = 64, but the schema's `z.number()` accepts only
		// integers — the validator must reject the literal text, not parse
		// past the dot and call the value valid.
		const result = validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "64.5");
		expect(result.kind).toBe("error");
	});

	it("rejects negative input", () => {
		// The HTML `min` attribute prevents this in practice, but a typed
		// paste bypasses the spinner; the validator must still refuse.
		expect(validateStoreBudgetDraft(STORE_BUDGET_SPECS[0], "-1").kind).toBe("error");
	});
});

describe("readFormatFlags (#315) — tri-state auto, legacy booleans, fallback", () => {
	const snapshotWith = (format: unknown): ConfigFormSnapshot => ({
		...READY,
		value: { ...READY.value, format },
	});

	it("defaults to auto off / editorconfig on / no fallback when the subtree is absent (old logs)", () => {
		expect(readFormatFlags(READY)).toEqual({ auto: "off", editorconfig: true, fallback: false });
	});

	it("maps legacy booleans: true → full, false → off", () => {
		expect(readFormatFlags(snapshotWith({ auto: true, editorconfig: true }))).toEqual({
			auto: "full",
			editorconfig: true,
			fallback: false,
		});
		expect(readFormatFlags(snapshotWith({ auto: false, editorconfig: false }))).toEqual({
			auto: "off",
			editorconfig: false,
			fallback: false,
		});
	});

	it("passes the enum through, with the fallback switch", () => {
		expect(readFormatFlags(snapshotWith({ auto: "range", fallback_full_file: true, editorconfig: true }))).toEqual({
			auto: "range",
			editorconfig: true,
			fallback: true,
		});
		expect(readFormatFlags(snapshotWith({ auto: "full" }))).toEqual({
			auto: "full",
			editorconfig: true,
			fallback: false,
		});
		expect(readFormatFlags(snapshotWith({ auto: "off" }))).toMatchObject({ auto: "off" });
	});

	it("ignores garbage values instead of coercing them", () => {
		expect(readFormatFlags(snapshotWith({ auto: "yes", editorconfig: 1 }))).toEqual({
			auto: "off",
			editorconfig: false,
			fallback: false,
		});
		expect(readFormatFlags(snapshotWith("on"))).toEqual({ auto: "off", editorconfig: true, fallback: false });
	});
});

describe("the card's 格式化 group (#315) — wiring pinned against the source", () => {
	const cardSource = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "settings-card.tsx"),
		"utf8",
	);

	it("renders the tri-state mode control, the fallback switch, and writes the format subtree wholesale", () => {
		expect(cardSource).toContain("自动格式化（write / edit / ast_edit 后）");
		expect(cardSource).toContain("范围不可用时回退全文");
		expect(cardSource).toContain("读取 .editorconfig");
		// Every write carries ALL THREE keys: a partial write would clear a sibling.
		expect(cardSource).toContain(
			'writeField("format", { auto: mode, editorconfig: formatFlags.editorconfig, fallback_full_file: formatFlags.fallback })',
		);
		expect(cardSource).toContain(
			'writeField("format", { auto: formatFlags.auto, editorconfig: formatFlags.editorconfig, fallback_full_file: checked })',
		);
		expect(cardSource).toContain(
			'writeField("format", { auto: formatFlags.auto, editorconfig: checked, fallback_full_file: formatFlags.fallback })',
		);
	});
});

describe("the card's 语言服务器 group (#306) — wiring pinned against the source", () => {
	const cardSource = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "settings-card.tsx"),
		"utf8",
	);

	it("writes the lsp subtree as LEAF ops, so the idle window survives", () => {
		// The whole-subtree write is what dropped the idle window: it replaced
		// the whole `lsp` object, and the new key was not in it. A leaf op
		// carries its own path, so the siblings are left alone.
		expect(cardSource).toContain('writeField(["lsp", "auto_diagnostics"], checked)');
		expect(cardSource).toContain('writeField(["lsp", "servers"], servers)');
		expect(cardSource).not.toContain('writeField("lsp", {');
	});
	it("renders the idle window input and writes it as a leaf op", () => {
		expect(cardSource).toContain("空闲回收");
		expect(cardSource).toContain("LSP_IDLE_SPEC.path");
	});
});

describe("LSP_IDLE_SPEC — the card's mirror of the host schema (#306)", () => {
	it("matches the host-side schema ranges exactly", () => {
		// The divergence hazard: the host side (`src/config.ts`) and the client
		// side declare the same range independently. The host tests assert the
		// schema throws at these boundaries; this is the client counterpart.
		expect(LSP_IDLE_SPEC).toMatchObject({ min: 0, max: 3_600_000, defaultMs: 300_000 });
	});
	it("uses the two-segment path shape the mutate op expects", () => {
		// The card's onBlur handler forwards it to `buildFieldOp(path, value)`,
		// which only treats a string as a single-segment path.
		expect(LSP_IDLE_SPEC.path).toEqual(["lsp", "idle_timeout_ms"]);
	});
});

describe("validateLspIdleDraft — the card's first line of defence (#306)", () => {
	it("treats empty input as `unset` (the legitimate 'restore default' signal)", () => {
		expect(validateLspIdleDraft("")).toEqual({ kind: "unset" });
		expect(validateLspIdleDraft("   ")).toEqual({ kind: "unset" });
	});
	it("accepts 0 — the 'never reclaim' value", () => {
		expect(validateLspIdleDraft("0")).toEqual({ kind: "valid", value: 0 });
	});
	it("accepts values inside the range and the boundaries", () => {
		expect(validateLspIdleDraft("300000")).toEqual({ kind: "valid", value: 300000 });
		expect(validateLspIdleDraft("3600000")).toEqual({ kind: "valid", value: 3600000 });
	});
	it("rejects values just outside the range with a Chinese error", () => {
		const over = validateLspIdleDraft("3600001");
		expect(over.kind).toBe("error");
		if (over.kind === "error") {
			expect(over.message).toContain("超出允许范围");
		}
		const under = validateLspIdleDraft("-1");
		expect(under.kind).toBe("error");
	});
	it("rejects non-numeric input (does NOT silently treat it as unset)", () => {
		const result = validateLspIdleDraft("abc");
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect(result.message).toContain("整数");
		}
	});
});

describe("readLspIdleMs — the card's view of the window (#306)", () => {
	const snapshotWith = (lsp: unknown): ConfigFormSnapshot => ({
		...READY,
		value: { ...READY.value, lsp },
	});

	it("reports an absent subtree as undefined (the host constant applies)", () => {
		expect(readLspIdleMs(READY)).toBeUndefined();
		expect(readLspIdleMs(snapshotWith({}))).toBeUndefined();
	});
	it("reads an explicit value, 0 included", () => {
		expect(readLspIdleMs(snapshotWith({ idle_timeout_ms: 60_000 }))).toBe(60_000);
		expect(readLspIdleMs(snapshotWith({ idle_timeout_ms: 0 }))).toBe(0);
	});
	it("ignores garbage values instead of coercing them", () => {
		expect(readLspIdleMs(snapshotWith({ idle_timeout_ms: "300000" }))).toBeUndefined();
		expect(readLspIdleMs(snapshotWith("on"))).toBeUndefined();
	});
});
