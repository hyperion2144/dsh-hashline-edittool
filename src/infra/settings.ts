/**
 * The effective-config snapshot, and nothing else.
 *
 * The read side of the settings surface used to live in `config.ts`, beside
 * the schema and the dsh subscription wiring. That pinned `config` ABOVE every
 * capability (it must reach `domain/edit/edit-rebuild` and `ast/client`), so
 * any module that only wanted to READ the effective config — `ast/install-route`,
 * `lsp/auto-diag`, `domain/edit/prompts`, `guidance/resolve` — had to look UP
 * to the entry plane for a plain value.
 *
 * The split is now: this module OWNS the snapshot and the getters (bottom
 * tier); `config.ts` owns the schema, validates, and pushes each applied
 * snapshot down here via `setEffectiveSnapshot`. Readers below the entry plane
 * take `../infra/settings.js` (or `./settings.js` from within infra) and never
 * see the entry plane.
 *
 * @module dsh-hashline-edittool/infra/settings
 */

import { RESPONSE_BUDGET_DEFAULT, RESPONSE_BUDGET_MIN, RESPONSE_BUDGET_MAX } from "./constants.js";

export type OutputFormat = "text" | "json";

export interface EffectiveHashlineConfig {
	separator: string;
	outputFormat: OutputFormat;
	contextLines: number;
	/** Declared line-content mode: edit anchors are `{ anchor, line }` pairs. */
	requireLineContent: boolean;
	/** Per-response char budget (ADR-0013): see `RESPONSE_BUDGET_*`. */
	maxResponseChars: number;
	/**
	 * `grep` builds its candidate list with ripgrep, so `.gitignore` / `.ignore` rules
	 * apply and build output never reaches the read budget (default true). Off searches
	 * what the plugin's own walk sees: the whole tree minus hidden entries and
	 * `node_modules` — which is also the fallback whenever rg cannot be resolved.
	 */
	grepRespectGitignore: boolean;
	/** AST capability master switch (see `HashlineSettings.ast`). */
	astEnabled: boolean;
	/** Per-language narrowing, from `ast.languages.<id>.enabled`. */
	astLanguages: ReadonlySet<string>;
	/**
	 * Language -> command for servers the user NAMED, from `lsp.servers.<id>`.
	 *
	 * Intent, kept separate from what discovery FINDS: a named server is not a
	 * running one, and an entry can point at a command that does not exist — a
	 * fact the card reports rather than an error the setting rejects.
	 */
	lspServers: ReadonlyMap<string, string>;
	/**
	 * Whether a write delivers the language server's diagnostics back to the
	 * model (issue #131). Default ON — the feature is opt-out.
	 */
	autoDiagnostics: boolean;
}

const DEFAULT_CONFIG: EffectiveHashlineConfig = {
	separator: ":",
	outputFormat: "text",
	contextLines: 3,
	requireLineContent: false,
	astEnabled: false,
	astLanguages: new Set<string>(),
	lspServers: new Map<string, string>(),
	autoDiagnostics: true,
	grepRespectGitignore: true,
	maxResponseChars: RESPONSE_BUDGET_DEFAULT,
};

let effective: EffectiveHashlineConfig = { ...DEFAULT_CONFIG };

/**
 * Replace the effective snapshot. Called by the entry plane after it validates
 * a settings commit; never by readers.
 *
 * @param next - the new snapshot; copied so later caller mutations cannot leak in.
 */
export function setEffectiveSnapshot(next: EffectiveHashlineConfig): void {
	effective = { ...next };
}

/** Effective runtime config (module singleton; defaults = current contract). */
export function getEffectiveConfig(): EffectiveHashlineConfig {
	return { ...effective };
}

/** Whether the AST capability is on (structural summaries, symbol reads). */
export function isAstEnabled(): boolean {
	return effective.astEnabled;
}

/**
 * Whether AST work may touch a language.
 *
 * The master switch is the gate; a per-language entry only narrows it. An
 * absent entry therefore means enabled — "turn AST on" should not also
 * require visiting every language row.
 */
export function isAstLanguageEnabled(id: string): boolean {
	if (!effective.astEnabled) return false;
	const entry = effective.astLanguages;
	return !entry.has(`!${id}`);
}

/** The languages explicitly turned off, for the card and for diagnostics. */
export function astDisabledLanguages(): string[] {
	return [...effective.astLanguages].filter((key) => key.startsWith("!")).map((key) => key.slice(1));
}

/**
 * The language servers the user NAMED, by language.
 *
 * Intent only. Whether the command exists, and whether a server is running,
 * are facts that belong to the status report — this answers "which server did
 * the user ask for", which is what discovery needs to honour `configured`.
 *
 * @returns a copy; mutating it does not change the effective config.
 */
export function lspConfiguredServers(): ReadonlyMap<string, string> {
	return new Map(effective.lspServers);
}

/**
 * Whether a successful write delivers the language server's diagnostics back
 * to the model (issue #131). Default ON; `lsp.auto_diagnostics: false` opts out.
 */
export function isAutoDiagnosticsEnabled(): boolean {
	return effective.autoDiagnostics;
}


/**
 * The effective per-response char budget, re-clamped defensively: the config
 * layer already clamps + warns, so an out-of-range value here means the
 * snapshot was written by something that bypassed it.
 */
export function responseBudget(): number {
	const v = effective.maxResponseChars;
	if (!Number.isFinite(v) || v < RESPONSE_BUDGET_MIN || v > RESPONSE_BUDGET_MAX) {
		const clamped = Number.isFinite(v)
			? Math.min(RESPONSE_BUDGET_MAX, Math.max(RESPONSE_BUDGET_MIN, v))
			: RESPONSE_BUDGET_DEFAULT;
		console.warn(
			`[hashline] max_response_chars ${v} out of range [${RESPONSE_BUDGET_MIN}, ${RESPONSE_BUDGET_MAX}]; clamped to ${clamped}.`,
		);
		return clamped;
	}
	return v;
}
export function isJsonOutput(): boolean {
	return effective.outputFormat === "json";
}

/** A fresh copy of the built-in defaults, for validators that reset absent fields. */
export function defaultEffectiveConfig(): EffectiveHashlineConfig {
	return { ...DEFAULT_CONFIG };
}
