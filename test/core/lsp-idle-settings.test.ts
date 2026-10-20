/**
 * The language-server idle window as a plugin setting (issue #306):
 *
 * - `lsp.idle_timeout_ms` is a number in [0, 3600000], READ AT USE TIME — a
 *   change must take effect without a restart, because the value is a
 *   volatile setting and the server may be running for hours;
 * - 0 means "never reclaim" — the same contract as the AST worker's idle
 *   window (`src/ast/client.ts`), and the reason the lower bound is 0 and
 *   not 1;
 * - the schema bakes NO default in, so an absent field falls back to the
 *   host-side constant (`DEFAULT_LSP_IDLE_TIMEOUT_MS`);
 * - a whole-subtree write of `lsp` DROPS the field, which is why the card
 *   writes it as a LEAF op (the client-side test pins that).
 */
import { describe, expect, it, vi } from "vitest";
import { HashlineSettingsSchema, applyEffective, resolveSettings } from "../../src/config.js";
import { lspIdleTimeoutMs } from "../../src/infra/settings.js";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS, LSP_IDLE_TIMEOUT_MAX_MS } from "../../src/infra/constants.js";

describe("the idle-window schema (#306)", () => {
	it("accepts the documented value", () => {
		const resolved = resolveSettings(HashlineSettingsSchema({ lsp: { idle_timeout_ms: 300_000 } }));
		expect(resolved?.lsp?.idle_timeout_ms).toBe(300_000);
	});

	it("accepts 0 — the 'never reclaim' value", () => {
		// 0 is a legal window, not a missing one: it says the server stays for
		// the whole session. The floor is 0 for that reason.
		const resolved = resolveSettings(HashlineSettingsSchema({ lsp: { idle_timeout_ms: 0 } }));
		expect(resolved?.lsp?.idle_timeout_ms).toBe(0);
	});

	it("accepts the upper boundary", () => {
		const resolved = resolveSettings(
			HashlineSettingsSchema({ lsp: { idle_timeout_ms: LSP_IDLE_TIMEOUT_MAX_MS } }),
		);
		expect(resolved?.lsp?.idle_timeout_ms).toBe(LSP_IDLE_TIMEOUT_MAX_MS);
	});

	it("throws a path-prefixed ValidationError just below the floor", () => {
		expect(() => HashlineSettingsSchema({ lsp: { idle_timeout_ms: -1 } })).toThrowError(
			/\$\.lsp\.idle_timeout_ms/,
		);
	});

	it("throws just above the ceiling", () => {
		expect(() =>
			HashlineSettingsSchema({ lsp: { idle_timeout_ms: LSP_IDLE_TIMEOUT_MAX_MS + 1 } }),
		).toThrowError(/\$\.lsp\.idle_timeout_ms.*expected.*<=.*3600000/);
	});

	it("treats an absent field as undefined (no default baked into the schema)", () => {
		// The card's 恢复默认 button relies on this: unset = fall back to the
		// host-side constant. A baked default would make the unset op look
		// like a deliberate choice and the override would never clear.
		const resolved = resolveSettings(HashlineSettingsSchema({ lsp: { auto_diagnostics: true } }));
		expect(resolved?.lsp?.idle_timeout_ms).toBeUndefined();
	});

	it("drops the field when the whole subtree is written without it", () => {
		// The fact the card's write path has to respect: a whole-subtree write
		// does not carry unknown-to-the-writer siblings along. The card
		// therefore writes `lsp.servers` / `lsp.auto_diagnostics` /
		// `lsp.idle_timeout_ms` as LEAF ops.
		const resolved = resolveSettings(
			HashlineSettingsSchema({ lsp: { servers: {}, auto_diagnostics: true } }),
		);
		expect(resolved?.lsp?.idle_timeout_ms).toBeUndefined();
	});
});

describe("the idle window reaches the runtime (#306)", () => {
	it("publishes the configured window", () => {
		applyEffective({ lsp: { idle_timeout_ms: 1_000 } });
		expect(lspIdleTimeoutMs()).toBe(1_000);
	});

	it("publishes 0 as 'never reclaim'", () => {
		applyEffective({ lsp: { idle_timeout_ms: 0 } });
		expect(lspIdleTimeoutMs()).toBe(0);
	});

	it("falls back to the host constant when the field is absent", () => {
		applyEffective({ lsp: { auto_diagnostics: true } });
		expect(lspIdleTimeoutMs()).toBe(DEFAULT_LSP_IDLE_TIMEOUT_MS);
	});

	it("resets to the host constant on an apply with no lsp subtree", () => {
		applyEffective({ lsp: { idle_timeout_ms: 1_000 } });
		applyEffective(undefined);
		expect(lspIdleTimeoutMs()).toBe(DEFAULT_LSP_IDLE_TIMEOUT_MS);
	});

	it("clamps a value that bypassed the schema, and says so", () => {
		// Defence in depth: the schema throws for an out-of-range write, but a
		// hand-edited settings.yaml (or a future write path that skips the
		// schema) can still land one here. The reader clamps and NAMES the
		// bad value rather than letting the manager act on it.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			applyEffective({ lsp: { idle_timeout_ms: 10_000_000 } });
			expect(lspIdleTimeoutMs()).toBe(LSP_IDLE_TIMEOUT_MAX_MS);
			expect(warn).toHaveBeenCalled();
			expect(String(warn.mock.calls[0]?.[0])).toContain("lsp.idle_timeout_ms");
		} finally {
			warn.mockRestore();
		}
	});
});
