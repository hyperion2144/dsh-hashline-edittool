/**
 * Hashline settings — namespace, schema, live snapshot, and wiring into the
 * hash shape.
 *
 * Settings live under the `hashline` namespace of the dsh settings service
 * (persisted to ~/.dsh/settings.yaml by the settings-file layer). As a
 * fallback — and as the ONLY path when the deployment has no settings
 * service (e.g. a minimal smoke profile) — the same file is read directly
 * so `separator` / `hash_length` / `output_format` always take effect:
 *
 * ```yaml
 * hashline:
 *   separator: ":"        # column separator (default ":")
 *   hash_length: 3        # anchor hash length, 1..6 (default 3; space = 62^len)
 *   output_format: text   # "text" (hashline rows) | "json" (pure JSON)
 * ```
 *
 * Precedence: the registered settings service (live getter + settings/updated)
 * > defaults. There is NO direct settings.yaml fallback: file access happens
 * only inside the settings provider's own load/persist, never around it.
 * @module dsh-hashline-edittool/config
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { applyHashlineShape } from "./hashline/hash-assign.js";
import { rebuildEditSurfaces } from "./domain/edit/edit-rebuild.js";
import { getAstClient } from "./ast/client.js";
import {
	HASH_STORE_MAX_BYTES,
	HASH_STORE_MAX_PATHS,
	HASH_STORE_MAX_ROWS,
} from "./infra/constants.js";
export const HASHLINE_SETTINGS_NAMESPACE = "hashline";

/**
 * The plugin's profile entry id — the settings join key on BOTH halves.
 *
 * dsh 0.1.7 addresses settings by the Loader ENTRY id (our patch row id,
 * identical to the package name), not by a registered namespace: the client
 * card binds `ctx.configForms.get(entryId)` with this key, and the legacy
 * migration writes into this entry.
 */
export const HASHLINE_ENTRY_ID = "dsh-hashline-edittool";

export interface HashlineSettings {
	separator?: string;
	output_format?: "text" | "json";
	context_lines?: number;
	/** When true, edit anchors are `{ anchor, line }` declaration pairs (default false). */
	require_line_content?: boolean;
	/**
	 * The AST capability's namespace entry.
	 *
	 * **Default off**: AST is additive, and with it off `read`/`edit` behave
	 * exactly as they did before it existed. `languages` narrows the master
	 * switch — an absent entry means enabled, so turning the master on turns a
	 * language on until someone says otherwise.
	 */
	ast?: {
		enabled?: boolean;
		languages?: Record<string, { enabled?: boolean } | undefined>;
	};
	/**
	 * Language servers the user NAMED, keyed by language.
	 *
	 * A command that cannot be found is NOT rejected here — it is reported by the
	 * status surface, so a typo stays visible and fixable instead of silently
	 * dropping the language back to a heuristic scan.
	 */
lsp?: {
		servers?: Record<string, string | undefined>;
		/**
		 * Automatic diagnostics after a write (issue #131). When true (default),
		 * edit / ast_edit / write / undo_last_edit deliver the language server's
		 * diagnostics for the written file back to the model: inline on the tool
		 * result when a push arrives within the inline window (1s), otherwise injected
		 * at the next natural model step. A write never starts a server and never
		 * fails because of diagnostics — this switch only governs the delivery.
		 */
		auto_diagnostics?: boolean;
	};
	/**
	 * Bounded-anchor-store budgets exposed by issue #179 / #180.
	 *
	 * Unset on a per-field basis falls back to the host-side constants
	 * (`src/infra/constants.ts`); the schema does NOT bake defaults in, because
	 * the card's "恢复默认" semantics are an unset op, not a write op. The
	 * three fields are tuned to different runaway shapes — bytes catch large
	 * files, path count catches tree-walks, row count catches "a few huge
	 * files served many lines each" — and lowering any of them really does
	 * evict on the next scan.
	 */
	store?: {
		/** Total library byte budget, in MiB (8–2048; default 64). */
		max_bytes_mb?: number;
		/** Path-count ceiling, in entries (100–100000; default 5000). */
		max_paths?: number;
		/** `anchor_lines` row ceiling, in lines (10000–10000000; default 300000). */
		max_lines?: number;
	};
}
/** Permissive schema — unknown keys tolerated so newer versions don't break older builds. */

export const HashlineSettingsSchema: z<HashlineSettings> = z
	.object({
		// Every field is .volatile(): dsh 0.1.7 keeps the plugin instance mounted
		// while only these change, handing `apply` live references instead of
		// plain values (read them through resolveSettings at use time).
		separator: z.string().min(1).max(4).volatile(),
		output_format: z.union(["text", "json"]).volatile(),
		context_lines: z.number().min(0).max(20).volatile(),
		require_line_content: z.boolean().volatile(),
		// The volatile mark sits on the OUTERMOST node of each live-editable
		// subtree only: schemastery requires a volatile field to have a fixed
		// path with no enclosing volatile, and every descendant of a volatile
		// node is already live (isVolatilePath walks ancestors) — so the
		// children here carry NO mark of their own.
		ast: z
			.object({
				enabled: z.boolean(),
				languages: z.dict(z.object({ enabled: z.boolean() })),
			})
			.volatile(),
		// Named servers, by language. A dict rather than a list of objects on
		// purpose: it matches the shape of `ast.languages`, and "which server
		// does typescript use" is the question being asked. Sibling of `ast` —
		// the pre-0.1.7 schema accidentally nested this INSIDE `ast` (masked by
		// the `as unknown as` cast); the type and the YAML reader always had it
		// top-level, so the schema now agrees with both (#155).
		lsp: z
			.object({
				servers: z.dict(z.string()),
				auto_diagnostics: z.boolean(),
			})
			.volatile(),
		// Bounded-store budgets (#179 / #180). `.volatile()` sits on the outermost
		// node only — same rule the `ast` and `lsp` subtrees follow, because
		// schemastery requires a volatile field to sit on a fixed path with no
		// enclosing volatile. No defaults are baked in: unset means "use the
		// host-side constant"; the card's 恢复默认 button sends an unset op, and
		// a write here would look identical to a deliberate choice.
		store: z
			.object({
				max_bytes_mb: z.number().min(8).max(2048),
				max_paths: z.number().min(100).max(100000),
				max_lines: z.number().min(10000).max(10000000),
			})
			.volatile(),
	}) as unknown as z<HashlineSettings>;
	//
	// Why this root is intentionally NOT `.loose()` — and why that still keeps
	// the legacy `hash_length` key accepted (#155 / spec §7).
	//
	// Verified against `@deepseek-ai/schemastery`'s `Schema.resolve`
	// (node_modules/@deepseek-ai/schemastery/src/index.ts, the `try { ... }
	// catch (error) { if (!schema.meta.loose) throw error; return
	// [schema.meta.default] }` block at the bottom of `Schema.resolve`):
	//
	//     try {
	//         return callback(data, schema, options, strict)
	//     } catch (error) {
	//         if (!schema.meta.loose) throw error
	//         return [schema.meta.default]
	//     }
	//
	// `.loose()` makes the ROOT swallow EVERY descendant throw and substitute
	// the schema's `meta.default` (an object → `{}`). Concretely: writing
	// `store.max_bytes_mb = 7` causes the `store` subtree to fail validation,
	// the throw bubbles up to the root resolver, the root's loose catches it,
	// and the entire settings object becomes `{}` — `store`, legacy keys, and
	// all. That silent drop was issue #179's reported symptom.
	//
	// Two pieces of the contract that DO survive the removal:
	//
	//  1. The legacy `hash_length` key is accepted because the `object`
	//     resolver merges unknown keys into the result via
	//     `if (!strict) merge(result, data)` — this branch runs even WITHOUT
	//     `.loose()`. An empirical probe (`{hash_length: 4}` through the same
	//     schema shape with `.loose()` removed) returns `{hash_length: 4}`
	//     unchanged: the unknown key reaches the output, no throw.
	//
	//  2. Out-of-range or wrong-type writes now THROW with a path-prefixed
	//     `ValidationError` (`$.store.max_bytes_mb expected number >= 8 but
	//     got 7`), which the dsh settings surface reports instead of
	//     swallowing. This is the schema-level half of the "越界要报错"
	//     contract.
	//
	// The other half — defence-in-depth in `applyEffective` — runs even if a
	// future caller bypasses the schema, and is implemented by the
	// `STORE_BUDGETS` / `checkStoreBudget` helpers below with an `onWarn`
// callback that the install layer wires to `ctx.logger.warn`.

/**
 * The bounded-store budgets (#179 / #180), with the same ranges the schema
 * enforces on the wire.
 *
 * Defined once so the host-side validator, the settings card's draft check,
 * and the schema itself stay in lock-step — a divergence becomes a single
 * edit, not three. The fallback is the host-side constant the runtime uses
 * when no override is set; the unit is what the card and the warning render.
 */
export interface StoreBudgetRange {
	/** The settings key under `settings.store.<field>`. */
	readonly field: "max_bytes_mb" | "max_paths" | "max_lines";
	/** The two-segment path the card's mutate op sends. */
	readonly path: readonly ["store", "max_bytes_mb" | "max_paths" | "max_lines"];
	/** Inclusive lower bound, matching the schema's `z.number().min(...)`. */
	readonly min: number;
	/** Inclusive upper bound, matching the schema's `z.number().max(...)`. */
	readonly max: number;
	/** The unit the card shows next to the number and the warning names. */
	readonly unit: string;
	/** The host-side constant this falls back to when unset (issue #180). */
	readonly fallback: number;
}

export const STORE_BUDGETS: readonly StoreBudgetRange[] = [
	// max_bytes_mb is the only field whose unit is NOT the same as its
	// backing constant: HASH_STORE_MAX_BYTES is in bytes, the setting is in
	// MiB. The arithmetic is local — done once, here — so a unit change has
	// a single owner.
	{ field: "max_bytes_mb", path: ["store", "max_bytes_mb"], min: 8, max: 2048, unit: "MiB", fallback: HASH_STORE_MAX_BYTES / (1024 * 1024) },
	{ field: "max_paths", path: ["store", "max_paths"], min: 100, max: 100000, unit: "个", fallback: HASH_STORE_MAX_PATHS },
	{ field: "max_lines", path: ["store", "max_lines"], min: 10000, max: 10000000, unit: "行", fallback: HASH_STORE_MAX_ROWS },
];

/**
 * The outcome of validating one store-budget field.
 *
 * `unset` is NOT an error — it is the wire shape of "the user has not named
 * this field", and the runtime falls back to `range.fallback` (a host-side
 * constant, NOT a per-user value). `valid` carries the integer to use.
 * `out_of_range` carries the bad value back so the warning can name it
 * verbatim, including `NaN` for non-numeric input that the schema would
 * otherwise have swallowed.
 */
export type StoreBudgetCheck =
	| { readonly kind: "unset" }
	| { readonly kind: "valid"; readonly value: number }
	| { readonly kind: "out_of_range"; readonly received: number };

/**
 * Classify one store-budget field against its range. Pure on purpose — the
 * card's draft check, `applyEffective`'s defence-in-depth, and the schema
 * itself share the same predicate through this function.
 */
export function checkStoreBudget(
	field: StoreBudgetRange["field"],
	raw: unknown,
): StoreBudgetCheck {
	const range = STORE_BUDGETS.find((entry) => entry.field === field);
	if (range === undefined) return { kind: "unset" };
	if (raw === undefined) return { kind: "unset" };
	if (typeof raw !== "number" || !Number.isInteger(raw)) {
		// schemastery drops non-integer / non-number values via the loose
		// root, but a direct call to `applyEffective` (or a future code path
		// that bypasses the schema) can still surface one. Hand the warning
		// `NaN` so the message stays type-shaped.
		return { kind: "out_of_range", received: typeof raw === "number" ? raw : NaN };
	}
	if (raw < range.min || raw > range.max) {
		return { kind: "out_of_range", received: raw };
	}
	return { kind: "valid", value: raw };
}

/**
 * The warning sink for `applyEffective`. The install layer wires this to
 * `ctx.logger.warn`; tests pass a spy to assert what would have been logged.
 * The function shape (one string per offending field) is the contract: the
 * message MUST name the field, the received value, the allowed range, and
 * the constant the runtime falls back to. That minimum is what makes a
 * silent drop loud enough to investigate.
 */
export type StoreBudgetWarn = (message: string) => void;
// The read side of the settings surface lives in `infra/settings`: this module
// validates, wires the dsh subscription, and PUSHES each applied snapshot down.
// Keeping the snapshot here would pin `config` above every capability, and any
// module that only wanted to READ the config had to look up to the entry plane.
export {
	getEffectiveConfig,
	isAstEnabled,
	isAstLanguageEnabled,
	astDisabledLanguages,
	lspConfiguredServers,
	isAutoDiagnosticsEnabled,
	isJsonOutput,
} from "./infra/settings.js";
export type { EffectiveHashlineConfig, OutputFormat } from "./infra/settings.js";
import {
	defaultEffectiveConfig,
	getEffectiveConfig,
	setEffectiveSnapshot,
	type EffectiveHashlineConfig,
} from "./infra/settings.js";

/**
 * Validate + apply a settings object onto the effective config and hash shape.
 *
 * The optional `options.onWarn` is the defence-in-depth hook for the
 * bounded-store budgets (#179 / #180): the schema already THROWS for
 * out-of-range values (see the comment on `HashlineSettingsSchema`), but
 * every direct `applyEffective` call — tests, future re-entry points, or a
 * loader that hands us a pre-validated config — still needs to NAME the bad
 * field, the value it received, the allowed range, and the host-side constant
 * it falls back to. The install layer wires `onWarn` to `ctx.logger.warn`;
 * tests pass a spy to assert what would have been logged.
 */
export function applyEffective(
	settings: HashlineSettings | undefined,
	options: { readonly onWarn?: StoreBudgetWarn } = {},
): void {
	// Defaults come from the snapshot module, so an apply with absent fields
	// resets to the built-in contract rather than to the previous apply.
	const defaults = defaultEffectiveConfig();
	//
	// Store-budget scan (#179 / #180, second line of defence).
	//
	// The schema's path-prefixed throw is the loud path; this loop is the
	// quiet one. It runs on every apply regardless of how the schema
	// behaved, so an out-of-range value that slipped past a future code path
	// (or was hand-edited into settings.yaml and re-loaded by a path that
	// bypassed the schema) is still named explicitly with the field, the
	// value, the range, and the fallback constant. Unset is NOT warned —
	// it is the legitimate "use the host-side constant" signal.
	//
	const onWarn = options.onWarn;
	if (onWarn !== undefined) {
		const store = settings?.store;
		if (store !== undefined) {
			for (const range of STORE_BUDGETS) {
				const result = checkStoreBudget(range.field, store[range.field]);
				if (result.kind === "out_of_range") {
					onWarn(
						`dsh-hashline-edittool: settings.store.${range.field} = ${result.received} out of range ${range.min}–${range.max} ${range.unit}; falling back to ${range.fallback} ${range.unit}`,
					);
				}
			}
		}
	}
const sep =
		typeof settings?.separator === "string" && settings.separator.length > 0
			? settings.separator
: defaults.separator;
	const fmt =
		settings?.output_format === "json" ? "json" : defaults.outputFormat;
	const nctx =
		typeof settings?.context_lines === "number" &&
		Number.isInteger(settings.context_lines) &&
		settings.context_lines >= 0 &&
		settings.context_lines <= 20
			? settings.context_lines
			: defaults.contextLines;
	const requireLine =
		typeof settings?.require_line_content === "boolean"
			? settings.require_line_content
			: defaults.requireLineContent;
	// The edit tool's model-facing schema depends on this flag: when it
	// FLIPS, live agents' edit surfaces must be disposed and re-registered
	// so the next model step sees the new parameter set (issue #75/#76).
	const astOn =
		typeof settings?.ast?.enabled === "boolean" ? settings.ast.enabled : defaults.astEnabled;
	// Disabled languages are keyed with a `!` prefix so one Set carries both
	// "explicitly off" and (by absence) "inherit the master switch".
	const astLangs = new Set<string>();
	for (const [id, entry] of Object.entries(settings?.ast?.languages ?? {})) {
		if (entry !== undefined && entry.enabled === false) astLangs.add(`!${id}`);
	}
	// Named language servers, language -> command. Not validated against the
	// filesystem: a path that does not exist is reported by the status surface
	// rather than refused here, because refusing would make a typo unresolvable
	// from the UI that has to show it.
	const lspServers = new Map<string, string>();
	for (const [id, command] of Object.entries(settings?.lsp?.servers ?? {})) {
		if (typeof command === "string" && command.trim() !== "") lspServers.set(id, command.trim());
	}
	// Default ON: an absent entry means the automatic delivery runs. Only an
	// explicit `false` turns it off, mirroring how `ast.enabled` treats absence.
	const autoDiag =
		typeof settings?.lsp?.auto_diagnostics === "boolean"
			? settings.lsp.auto_diagnostics
			: defaults.autoDiagnostics;
	const prev = getEffectiveConfig();
	const flagChanged = prev.requireLineContent !== requireLine;
	const astChanged = prev.astEnabled !== astOn;
	const next: EffectiveHashlineConfig = {
		separator: sep,
		outputFormat: fmt,
		contextLines: nctx,
		requireLineContent: requireLine,
		astEnabled: astOn,
		astLanguages: astLangs,
		lspServers: lspServers,
		autoDiagnostics: autoDiag,
	};
	setEffectiveSnapshot(next);
	applyHashlineShape({ separator: sep, contextLines: nctx });
	if (flagChanged) rebuildEditSurfaces();
	if (astChanged && !astOn) {
		// Only the ARENA release is left of the AST switch's side effects.
		//
		// It used to rebuild both tool surfaces, because both carried AST
		// parameters whose existence had to follow the setting. Neither does now —
		// structure moved to `ast_grep` / `lsp`, whose surfaces do not vary — so
		// the rebuild was machinery for a change that can no longer happen.
		//
		// The release still matters: an explicit "off" should free the arena now
		// rather than at the next idle timeout. It can hold up to 2 GiB, and the
		// user asked for it to stop. Dropping references frees nothing — only
		// terminate does.
void getAstClient().dispose();
	}
}

/** Default settings.yaml location (same file the dsh settings layer uses). */
/** Default settings.yaml location: $DSH_HOME when set, else ~/.dsh. */
export function settingsYamlPath(): string {
	const dshHome = process.env.DSH_HOME;
	const base = dshHome && dshHome.length > 0 ? dshHome : join(homedir(), ".dsh");
	return join(base, "settings.yaml");
}

/**
 * Minimal YAML extractor for the `hashline:` section:
 *
 * ```yaml
 * hashline:
 *   separator: "|"
 *   hash_length: 4
 *   output_format: json
 * ```
 *
 * Handles quoted/unquoted scalars and `#` comments; anything unexpected
 * falls back to that key being unset (defaults apply). Separately exported
 * for tests.
 */
export function parseSettingsYaml(text: string): HashlineSettings {
	const out: HashlineSettings = {};
	let inSection = false;
	// The `ast` entry is the one nested value. Without this branch the flat
	// fallback would drop it silently — the switch would appear to save and do
	// nothing, which is worse than refusing it.
	let inAst = false;
	let astLanguage: string | undefined;
	const astLangs: Record<string, { enabled?: boolean }> = {};
	// The `lsp` entry is nested too, and for the same reason: the flat fallback
	// would drop it silently and a named server would appear to save and do
	// nothing.
	let inLsp = false;
	const lspServers: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (!inSection) {
			if (/^hashline:\s*(#.*)?$/.test(line)) {
				inSection = true;
			}
			continue;
		}
		if (!/^\s/.test(line) && line.trim() !== "") break; // next top-level key

		// --- the `ast` sub-tree ---
		const astTop = /^ {2}ast:\s*(#.*)?$/.exec(line);
		if (astTop !== null) {
			inAst = true;
			astLanguage = undefined;
			continue;
		}
		if (inAst) {
			// Four levels: `ast:` → `enabled` / `languages:` → `<id>:` → `enabled`.
			const langEnabled = /^ {8}enabled:\s*(.*)$/.exec(line);
			if (langEnabled !== null && astLanguage !== undefined) {
				const v = langEnabled[1]!.trim();
				if (v === "true") astLangs[astLanguage] = { enabled: true };
				else if (v === "false") astLangs[astLanguage] = { enabled: false };
				continue;
			}
			const langName = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(#.*)?$/.exec(line);
			if (langName !== null) {
				astLanguage = langName[1]!;
				continue;
			}
			const child = /^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
			if (child !== null) {
				if (child[1] === "enabled") {
					const v = child[2]!.trim();
					if (v === "true") out.ast = { ...out.ast, enabled: true };
					else if (v === "false") out.ast = { ...out.ast, enabled: false };
				}
				// `languages:` is just a container; its children carry the values.
				continue;
			}
			if (/^ {2}\S/.test(line)) inAst = false; // dedented: leave the sub-tree
			else continue;
		}

		// --- the `lsp` sub-tree ---
		// Three levels: `lsp:` → `servers:` → `<id>:` <command>.
		const lspTop = /^ {2}lsp:\s*(#.*)?$/.exec(line);
		if (lspTop !== null) {
			inLsp = true;
			continue;
		}
		if (inLsp) {
			const entry = /^ {6}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
			if (entry !== null) {
				// Quoted or bare, with a trailing comment stripped: a command is a
				// path, and paths contain spaces, so quotes are worth honouring.
				const value = entry[2]!.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
				if (value !== "") lspServers[entry[1]!] = value;
				continue;
			}
			if (/^ {4}servers:\s*(#.*)?$/.test(line)) continue; // container only
			// The delivery switch sits beside `servers` at FOUR-space indent; the
			// six-space matcher above only names SERVER ENTRIES, so the switch is
			// read here — a value inside the 6-char regex would parse a language
			// literally named `auto_diagnostics` as a server command.
			const autoDiag = /^ {4}auto_diagnostics:\s*(.*)$/.exec(line);
			if (autoDiag !== null) {
				const v = autoDiag[1]!.replace(/\s+#.*$/, "").trim();
				if (v === "true") out.lsp = { ...out.lsp, auto_diagnostics: true };
				else if (v === "false") out.lsp = { ...out.lsp, auto_diagnostics: false };
				continue;
			}
			if (/^ {2}\S/.test(line)) inLsp = false; // dedented: leave the sub-tree
			else continue;
		}

		const m = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1]!;
		let value = m[2]!.trim();
		value = value.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
		if (value === "") continue;
		if (key === "separator") out.separator = value;
		else if (key === "output_format") {
			if (value === "json" || value === "text") {
				out.output_format = value;
			}
		}
		// NOTE: legacy `hash_length` key is parsed but ignored (v2.0 variable-length).
		else if (key === "context_lines") {
			const n = Number(value);
			if (Number.isInteger(n) && n >= 0 && n <= 20) out.context_lines = n;
		}
		else if (key === "require_line_content") {
			if (value === "true") out.require_line_content = true;
			else if (value === "false") out.require_line_content = false;
		}
	}
	if (Object.keys(astLangs).length > 0) {
		out.ast = { ...out.ast, languages: astLangs };
	}
	if (Object.keys(lspServers).length > 0) {
		out.lsp = { ...out.lsp, servers: lspServers };
	}
	return out;
}



/**
 * Unwrap one volatile config reference (`.get()`), passing plain values
 * through unchanged.
 *
 * dsh 0.1.7 hands volatile fields to `apply` as live references so a change
 * never remounts the plugin; tests and plain compositions may hand the same
 * fields as ordinary values. Both shapes are first-class — duck-typing the
 * `get` member beats importing the runtime's ref type into a plugin.
 */
function unwrapVolatile(value: unknown): unknown {
	if (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { get?: unknown }).get === "function"
	) {
		return (value as { get(): unknown }).get();
	}
	return value;
}

/**
 * Structurally unwrap a whole config: volatile refs → plain values, deeply,
 * unknown keys carried along (the schema is loose). Field-level validation
 * is NOT done here — `applyEffective` owns that contract, exactly as it
 * always has for provider-published sections.
 */
function deepUnwrap(value: unknown): unknown {
	const plain = unwrapVolatile(value);
	if (plain !== null && typeof plain === "object") {
		if (Array.isArray(plain)) return plain.map(deepUnwrap);
		return Object.fromEntries(
			Object.entries(plain).map(([key, child]) => [key, deepUnwrap(child)]),
		);
	}
	return plain;
}

/**
 * Resolve the plugin's Config (volatile refs or plain values) into a plain
 * settings object for `applyEffective`. `undefined` in, `undefined` out —
 * absent config means built-in defaults.
 */
export function resolveSettings(config: unknown): HashlineSettings | undefined {
	if (config === null || typeof config !== "object") return undefined;
	return deepUnwrap(config) as HashlineSettings;
}

/**
 * Wire the plugin's Config into the effective settings snapshot.
 *
 * dsh 0.1.7: settings live in the profile's plugin configuration. The loader
 * resolves our `Config` schema and hands the result to `apply(ctx, config)`;
 * every field is `.volatile()`, so values arrive as live references — read
 * them at use time, never cache the raw section.
 *
 * Re-apply on `settings/document-updated`: the event is not per-entry
 * filtered host-side, so any revision bump re-reads OUR refs — cheap and
 * idempotent — and `applyEffective` lands the change (including the
 * `require_line_content` surface rebuild and the AST arena release).
 */
export function installHashlineSettings(ctx: Context, config: unknown): void {
// Defence-in-depth for #179 / #180: every reapply runs the store-budget
	// validator and forwards each miss to `ctx.logger.warn`, so even a value
	// even a value that slipped past the schema (a hand-edited settings.yaml,
	// a future write path that bypasses validation) is still NAMED with the
	// field, the received value, the allowed range, and the constant the
	// runtime falls back to. The schema already throws for bad values; this
	// hook is the second line of defence.
	const onWarn: StoreBudgetWarn = (message) => ctx.logger.warn(message);
	const reapply = (): void => {
		applyEffective(resolveSettings(config), { onWarn });
	};
	reapply();
	// `settings/document-updated` is declared in @deepseek-ai/dsh-settings'
	// type space, which this plugin deliberately does not depend on — the
	// runtime event bus is string-keyed, so subscribe through the same
	// duck-typed seam the optional services (agentPresets, webServer) use.
	// cordis still tracks the subscription as an effect of this context.
	(ctx as unknown as { on(name: string, listener: () => void): () => void }).on(
		"settings/document-updated",
		reapply,
	);
}