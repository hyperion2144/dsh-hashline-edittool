/**
 * The bounded-store budgets exposed as plugin settings (issue #179 / #180):
 *
 * - the `store` subtree validates three numeric ranges, each in MiB / entries / lines;
 * - `.volatile()` is on the outermost node, exactly like `ast` and `lsp`;
 * - no defaults are baked in, so unset semantics fall back to host-side constants
 *   (the consumer side lives in `src/infra/constants.ts`).
 *
 * The schema only pins the boundary contract; the runtime aggregation that turns
 * these overrides into the actual store budgets belongs to the host-side wiring,
 * which is why this file is paired with `applyEffective`-style tests rather than
 * end-to-end store tests.
 *
 * Note on the rejection contract (changed with issue #179 / #180): the root
 * schema is intentionally NOT `.loose()` — see the comment on
 * `HashlineSettingsSchema` in `src/config.ts` for the full schemastery trace.
 * Out-of-range or wrong-type writes now THROW with a path-prefixed
 * `ValidationError` (e.g. `$.store.max_bytes_mb expected number >= 8 but got
 * 7`) which the dsh settings surface reports instead of silently dropping the
 * whole `store` subtree. Unset fields still resolve to `undefined` — the
 * 恢复默认 button relies on that, and the per-field case in `store` is still
 * preserved (only the WHOLE subtree drop is gone).
 */
import { describe, expect, it } from "vitest";
import {
	applyEffective,
	HashlineSettingsSchema,
	checkStoreBudget,
	resolveSettings,
	type StoreBudgetWarn,
} from "../../src/config.js";

function isValidationError(error: unknown): boolean {
	// schemastery tags its errors with a hidden symbol; importing the class
	// would couple the test to private internals, so we duck-type the message
	// (the schema builds `$.<path> <inner-message>` — the `$.` prefix is
	// the contract the dsh settings surface renders).
	return (
		error instanceof Error &&
		error.name === "ValidationError" &&
		/\$\./.test(error.message)
	);
}

describe("the store-budget schema (#179 — settings surface for #180)", () => {
	it("accepts the documented shape at every documented value", () => {
		const resolved = resolveSettings(
			HashlineSettingsSchema({
				store: { max_bytes_mb: 64, max_paths: 5000, max_lines: 300_000 },
			}),
		);
		expect(resolved?.store?.max_bytes_mb).toBe(64);
		expect(resolved?.store?.max_paths).toBe(5000);
		expect(resolved?.store?.max_lines).toBe(300_000);
	});

	it("accepts the upper boundary of each range", () => {
		// The hard cap on each field — 2048 MiB / 100000 paths / 10 M rows.
		const resolved = resolveSettings(
			HashlineSettingsSchema({
				store: { max_bytes_mb: 2048, max_paths: 100000, max_lines: 10_000_000 },
			}),
		);
		expect(resolved?.store?.max_bytes_mb).toBe(2048);
		expect(resolved?.store?.max_paths).toBe(100000);
		expect(resolved?.store?.max_lines).toBe(10_000_000);
	});

	it("accepts the lower boundary of each range", () => {
		// The floor prevents users from disabling the persistent store by accident:
		// 8 MiB catches even an empty path table's overhead, 100 paths catches a
		// single-project bootstrap, 10 K rows catches the most minimal file read.
		const resolved = resolveSettings(
			HashlineSettingsSchema({
				store: { max_bytes_mb: 8, max_paths: 100, max_lines: 10_000 },
			}),
		);
		expect(resolved?.store?.max_bytes_mb).toBe(8);
		expect(resolved?.store?.max_paths).toBe(100);
		expect(resolved?.store?.max_lines).toBe(10_000);
	});

	it("throws a path-prefixed ValidationError just below the byte floor (7 MiB)", () => {
		// 7 < 8 — the floor exists so a user cannot accidentally configure a
		// smaller budget than the store can spend on its own index pages. The
		// root schema is no longer loose, so the bad field surfaces as a typed
		// error rather than a silent whole-subtree drop.
expect(() =>
			HashlineSettingsSchema({
				store: { max_bytes_mb: 7, max_paths: 5000, max_lines: 300_000 },
			}),
).toThrowError(/\$\.store\.max_bytes_mb/);
	});

	it("throws just above the byte ceiling (2049 MiB)", () => {
		expect(() =>
			HashlineSettingsSchema({
				store: { max_bytes_mb: 2049, max_paths: 5000, max_lines: 300_000 },
			}),
		).toThrowError(/\$\.store\.max_bytes_mb.*expected.*<=.*2048/);
	});

	it("throws just below the path floor (99) and just above the ceiling (100001)", () => {
		expect(() =>
			HashlineSettingsSchema({ store: { max_bytes_mb: 64, max_paths: 99, max_lines: 300_000 } }),
		).toThrowError(/\$\.store\.max_paths.*expected.*>=.*100/);
		expect(() =>
			HashlineSettingsSchema({
				store: { max_bytes_mb: 64, max_paths: 100001, max_lines: 300_000 },
			}),
		).toThrowError(/\$\.store\.max_paths.*expected.*<=.*100000/);
	});

	it("throws just below the row floor (9999 lines)", () => {
		expect(() =>
			HashlineSettingsSchema({
				store: { max_bytes_mb: 64, max_paths: 5000, max_lines: 9999 },
			}),
		).toThrowError(/\$\.store\.max_lines.*expected.*>=.*10000/);
	});

	it("throws just above the row ceiling (10000001 lines)", () => {
		expect(() =>
			HashlineSettingsSchema({
				store: { max_bytes_mb: 64, max_paths: 5000, max_lines: 10_000_001 },
			}),
		).toThrowError(/\$\.store\.max_lines.*expected.*<=.*10000000/);
	});

	it("still preserves unknown keys (legacy `hash_length` survives the loose removal)", () => {
		// The unknown-key contract is independent of `.loose()` — the object
		// resolver's `merge(result, data)` branch runs in both cases. A
		// regression here would silently drop legacy settings on every reload.
const resolved = resolveSettings(
			HashlineSettingsSchema({ hash_length: 4, store: { max_bytes_mb: 64 } } as never),
		);
		expect(
			(resolved as unknown as { hash_length?: number })?.hash_length,
		).toBe(4);
		expect(resolved?.store?.max_bytes_mb).toBe(64);
	});
	it("treats absent fields as undefined (no defaults baked into the schema)", () => {
		// The card's 恢复默认 button relies on this: unset = fall back to the
		// host-side constant. If the schema started emitting defaults, the unset
		// op would look like a deliberate choice and the override would never clear.
		// Partial store: the present field sticks, the absent ones are undefined
		// (resolution is per-field, not whole-or-nothing).
		const partial = resolveSettings(HashlineSettingsSchema({ store: { max_bytes_mb: 96 } }));
		expect(partial?.store?.max_bytes_mb).toBe(96);
		expect(partial?.store?.max_paths).toBeUndefined();
		expect(partial?.store?.max_lines).toBeUndefined();
	});

	it("does not bake defaults into the documented fields", () => {
		// The 恢复默认 button relies on this: when no field is named, the
		// field-specific readers must see `undefined` (fall back to the
		// host-side constant). If the schema emitted 64/5000/300000 here,
		// the unset op would look indistinguishable from a deliberate choice
		// and the override would never clear.
		const partial = resolveSettings(HashlineSettingsSchema({ store: {} }));
		expect(partial?.store?.max_bytes_mb).toBeUndefined();
		expect(partial?.store?.max_paths).toBeUndefined();
		expect(partial?.store?.max_lines).toBeUndefined();
	});
});

describe("checkStoreBudget — the host-side validator (#179 / #180 second line)", () => {
	it("classifies `undefined` as unset (NOT an error)", () => {
		// Unset is the legitimate "fall back to host-side constant" signal,
		// shared by the schema and the validator. Treating it as an error
		// would make every fresh install log a warning at boot.
		expect(checkStoreBudget("max_bytes_mb", undefined)).toEqual({ kind: "unset" });
		expect(checkStoreBudget("max_paths", undefined)).toEqual({ kind: "unset" });
		expect(checkStoreBudget("max_lines", undefined)).toEqual({ kind: "unset" });
	});

	it("accepts values inside the range", () => {
		expect(checkStoreBudget("max_bytes_mb", 64)).toEqual({ kind: "valid", value: 64 });
		expect(checkStoreBudget("max_paths", 5000)).toEqual({ kind: "valid", value: 5000 });
		expect(checkStoreBudget("max_lines", 300_000)).toEqual({ kind: "valid", value: 300_000 });
	});

	it("accepts the boundary values", () => {
		expect(checkStoreBudget("max_bytes_mb", 8)).toEqual({ kind: "valid", value: 8 });
		expect(checkStoreBudget("max_bytes_mb", 2048)).toEqual({ kind: "valid", value: 2048 });
		expect(checkStoreBudget("max_paths", 100)).toEqual({ kind: "valid", value: 100 });
		expect(checkStoreBudget("max_paths", 100000)).toEqual({ kind: "valid", value: 100000 });
		expect(checkStoreBudget("max_lines", 10000)).toEqual({ kind: "valid", value: 10000 });
		expect(checkStoreBudget("max_lines", 10_000_000)).toEqual({
			kind: "valid",
			value: 10_000_000,
		});
	});

	it("rejects values just outside the range and carries the bad value back", () => {
		// The received value travels in the result so the warning can name it
		// verbatim — `NaN` for non-numeric input, the original number otherwise.
		expect(checkStoreBudget("max_bytes_mb", 7)).toEqual({
			kind: "out_of_range",
			received: 7,
		});
		expect(checkStoreBudget("max_bytes_mb", 2049)).toEqual({
			kind: "out_of_range",
			received: 2049,
		});
		expect(checkStoreBudget("max_paths", 99)).toEqual({ kind: "out_of_range", received: 99 });
		expect(checkStoreBudget("max_paths", 100001)).toEqual({
			kind: "out_of_range",
			received: 100001,
		});
		expect(checkStoreBudget("max_lines", 9999)).toEqual({
			kind: "out_of_range",
			received: 9999,
		});
		expect(checkStoreBudget("max_lines", 10_000_001)).toEqual({
			kind: "out_of_range",
			received: 10_000_001,
		});
	});

	it("rejects non-integer values (carries NaN so the warning is type-shaped)", () => {
		// Float values and non-numbers pass through here when a direct
		// `applyEffective` call bypasses the schema — the validator must still
		// reject them rather than silently treat the input as unset.
		expect(checkStoreBudget("max_bytes_mb", 64.5)).toEqual({
			kind: "out_of_range",
			received: 64.5,
		});
		expect(checkStoreBudget("max_bytes_mb", "64")).toEqual({
			kind: "out_of_range",
			received: NaN,
		});
		expect(checkStoreBudget("max_bytes_mb", null)).toEqual({
			kind: "out_of_range",
			received: NaN,
		});
	});
});

describe("StoreBudgetWarn — the warning-sink contract", () => {
	it("is a one-string-per-field function", () => {
		// The contract: a function from string to void, one call per offending
		// field. Tests below assert what the install layer would have passed
		// to ctx.logger.warn by capturing the messages a spy receives.
		const sink: StoreBudgetWarn = () => undefined;
		expect(typeof sink).toBe("function");
	});
});

describe("applyEffective — the second line of defence for #179 / #180", () => {
	// applyEffective is the host's `apply(rootCtx, config)` hand-off. The
	// direct writes below simulate the non-schema write paths the install
	// layer's `onWarn` hook is meant to catch: a hand-edited settings.yaml
	// whose value was reset by the schema's silent drop, or a future code
	// path that bypasses the schema entirely.
	it("warns when one store-budget field is below the floor", () => {
		const messages: string[] = [];
		applyEffective({ store: { max_bytes_mb: 7, max_paths: 5000, max_lines: 300_000 } }, {
			onWarn: (message) => messages.push(message),
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("max_bytes_mb");
		expect(messages[0]).toContain("7");
		expect(messages[0]).toContain("8");
		expect(messages[0]).toContain("2048");
		expect(messages[0]).toContain("MiB");
		// The fallback constant is named so the operator can verify what
		// the runtime will use until the bad write is corrected.
		expect(messages[0]).toContain("64");
	});

	it("warns when one store-budget field is above the ceiling", () => {
		const messages: string[] = [];
		applyEffective({ store: { max_bytes_mb: 64, max_paths: 100001, max_lines: 300_000 } }, {
			onWarn: (message) => messages.push(message),
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("max_paths");
		expect(messages[0]).toContain("100001");
		expect(messages[0]).toContain("100000");
	});

	it("warns for each offending field in a single apply (one message per field)", () => {
		// The contract is "one message per offending field", not "one message
		// per apply" — a single bad write might carry multiple bad fields
		// and the operator needs each one NAMED to find them all.
		const messages: string[] = [];
		applyEffective(
			{ store: { max_bytes_mb: 7, max_paths: 99, max_lines: 10_000_001 } },
			{ onWarn: (message) => messages.push(message) },
		);
		expect(messages).toHaveLength(3);
		expect(messages.some((m) => m.includes("max_bytes_mb"))).toBe(true);
		expect(messages.some((m) => m.includes("max_paths"))).toBe(true);
		expect(messages.some((m) => m.includes("max_lines"))).toBe(true);
	});

	it("does NOT warn for absent (unset) fields — they fall back to the host-side constant", () => {
		// Unset is the legitimate "use the default" signal, NOT a warning
		// condition. Treating it as one would log a warning at every fresh
		// install, which is the silent-spam this contract was designed to
		// prevent.
		const messages: string[] = [];
		applyEffective({ store: { max_bytes_mb: 64 } }, {
			onWarn: (message) => messages.push(message),
		});
		expect(messages).toEqual([]);
	});

	it("does NOT warn for in-range values", () => {
		const messages: string[] = [];
		applyEffective(
			{ store: { max_bytes_mb: 64, max_paths: 5000, max_lines: 300_000 } },
			{ onWarn: (message) => messages.push(message) },
		);
		expect(messages).toEqual([]);
	});

	it("does NOT warn when settings has no `store` subtree at all", () => {
		const messages: string[] = [];
		applyEffective({ separator: "|" }, { onWarn: (message) => messages.push(message) });
		expect(messages).toEqual([]);
	});

	it("does NOT throw on out-of-range values when no onWarn is wired", () => {
		// The onWarn hook is OPTIONAL: tests that don't care about the
		// warning sink can omit it. applyEffective must still apply the
		// snapshot, fall back to defaults for the bad field, and NOT throw
		// — the host is not supposed to crash because of a bad settings
		// write that the schema already swallowed.
		expect(() =>
			applyEffective({ store: { max_bytes_mb: 7, max_paths: 5000, max_lines: 300_000 } }),
		).not.toThrow();
	});

	it("does NOT warn for legacy unknown keys (e.g. `hash_length: 4`)", () => {
		// The unknown-key contract is independent of this hook: the
		// schema's merge step carries them through, and the validator
		// only looks at the three known budget fields.
		const messages: string[] = [];
		applyEffective(
			{ hash_length: 4, store: { max_bytes_mb: 64 } } as never,
			{ onWarn: (message) => messages.push(message) },
		);
		expect(messages).toEqual([]);
	});
});