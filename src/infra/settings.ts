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

import {
	DEFAULT_LSP_IDLE_TIMEOUT_MS,
	LSP_IDLE_TIMEOUT_MAX_MS,
	LSP_IDLE_TIMEOUT_MIN_MS,
	RESPONSE_BUDGET_DEFAULT,
	RESPONSE_BUDGET_MIN,
	RESPONSE_BUDGET_MAX,
} from "./constants.js";

export type OutputFormat = "text" | "json";

/**
 * The tri-state automatic-formatting switch (#315): `off` never formats,
 * `full` always asks for the whole document, `range` formats what changed
 * (falling back per `formatFallbackFullFile`). Legacy boolean configs
 * migrate through `normalizeAutoFormatMode`.
 */
export type AutoFormatMode = "off" | "full" | "range";

/**
 * Map one raw `format.auto` value onto the mode enum (#315): legacy
 * `true` → `full`, `false` → `off`; the three strings pass through;
 * anything else falls back (the same defensive default every other field
 * applies when a bypassing caller writes garbage).
 */
export function normalizeAutoFormatMode(value: unknown, fallback: AutoFormatMode): AutoFormatMode {
	if (value === true || value === "full") return "full";
	if (value === false || value === "off") return "off";
	if (value === "range") return "range";
	return fallback;
}

/**
 * How much of a successful `write` the model sees afterwards (`write.preview`,
 * map #354): `full` re-reads the file and serves every written row, `diff`
 * renders an update as a unified diff, `confirmation` returns the one-line
 * confirmation and serves nothing.
 */
export type WritePreviewMode = "full" | "diff" | "confirmation";

/**
 * Map one raw `write.preview` value onto the mode enum. Anything but a known
 * literal falls back — the same defensive default every other field applies
 * when a caller bypasses the schema.
 */
export function normalizeWritePreviewMode(
	value: unknown,
	fallback: WritePreviewMode,
): WritePreviewMode {
	if (value === "full") return "full";
	if (value === "diff") return "diff";
	if (value === "confirmation") return "confirmation";
	return fallback;
}

export interface EffectiveHashlineConfig {
	separator: string;
	outputFormat: OutputFormat;
	contextLines: number;
	/** Declared line-content mode: edit anchors are `{ anchor, line }` pairs. */
	requireLineContent: boolean;
	/**
	 * Whether model-facing rows carry the file line number (`<anchor>:<line>`).
	 *
	 * The USER'S switch (issue #244): it lives in the plugin's settings card, not
	 * in a tool parameter, so the agent can never turn its own line numbers on.
	 * It governs every row the model reads — read / grep / edit /
	 * undo_last_edit, plus the write preview, `ast_grep` and `lsp`. Default
	 * OFF: the anchor alone is the address, and the line number is a hint the
	 * user asks for when they want to see it.
	 */
	lineNumbers: boolean;
	/** Per-response char budget (ADR-0013): see `RESPONSE_BUDGET_*`. */
	maxResponseChars: number;
	/**
	 * How much of a successful `write` the model sees afterwards
	 * (`write.preview`, map #354). Default `diff`: an update comes back as the
	 * unified diff; `full` restores the whole-file echo, `confirmation` returns
	 * one line and serves nothing.
	 */
	writePreview: WritePreviewMode;
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
	/**
	 * How long a language server may sit unused before it is reclaimed (#306).
	 *
	 * 0 means "never reclaim" — the same contract as the AST worker's idle
	 * window, and the reason the value is read at USE time rather than
	 * captured when the server starts.
	 */
	lspIdleTimeoutMs: number;
	/**
	 * HOW write/edit/ast_edit offer the final content to a running language
	 * server for formatting before it is written (#315, amending map #275's
	 * G3 boolean). Default OFF — an edit must never surprise the model with
	 * re-indented text. `range` degrades only through
	 * `formatFallbackFullFile`.
	 */
	autoFormatMode: AutoFormatMode;
	/**
	 * Whether a `range` formatting attempt that the server cannot serve may
	 * degrade to the whole document (#315). Default OFF: the range refusal
	 * stands — silence on the automatic path, an explicit error on the
	 * manual `format` tool.
	 */
	formatFallbackFullFile: boolean;
	/**
	 * Whether `FormattingOptions` prefer a project `.editorconfig` over the
	 * document-whitespace heuristic (map #275, G1). Default ON since #336:
	 * a checked-in project standard outranks the file heuristic; an explicit
	 * false opts out.
	 */
	editorconfig: boolean;
}

const DEFAULT_CONFIG: EffectiveHashlineConfig = {
	separator: ":",
	outputFormat: "text",
	contextLines: 3,
	requireLineContent: false,
	lineNumbers: false,
	astEnabled: false,
	astLanguages: new Set<string>(),
	lspServers: new Map<string, string>(),
	autoDiagnostics: true,
	lspIdleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS,
	autoFormatMode: "off",
	formatFallbackFullFile: false,
	editorconfig: true,
	grepRespectGitignore: true,
	maxResponseChars: RESPONSE_BUDGET_DEFAULT,
	writePreview: "diff",
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
 * The idle window before a language server is reclaimed (#306).
 *
 * Re-clamped defensively, like `responseBudget`: the schema refuses an
 * out-of-range value, but the snapshot can also be written by a caller that
 * bypasses it. 0 is a legal value and means "never reclaim".
 */
export function lspIdleTimeoutMs(): number {
	const v = effective.lspIdleTimeoutMs;
	if (!Number.isFinite(v) || v < LSP_IDLE_TIMEOUT_MIN_MS || v > LSP_IDLE_TIMEOUT_MAX_MS) {
		const clamped = Number.isFinite(v)
			? Math.min(LSP_IDLE_TIMEOUT_MAX_MS, Math.max(LSP_IDLE_TIMEOUT_MIN_MS, v))
			: DEFAULT_LSP_IDLE_TIMEOUT_MS;
		console.warn(
			`[hashline] lsp.idle_timeout_ms ${v} out of range [${LSP_IDLE_TIMEOUT_MIN_MS}, ${LSP_IDLE_TIMEOUT_MAX_MS}]; clamped to ${clamped}.`,
		);
		return clamped;
	}
	return v;
}

/**
 * The tri-state automatic-formatting mode (#315; `format.auto`). Default
 * OFF — edits must not change shape uninvited.
 */
export function autoFormatMode(): AutoFormatMode {
	return effective.autoFormatMode;
}

/**
 * Whether an unservable range-formatting attempt may degrade to the whole
 * document (#315; `format.fallback_full_file`, default OFF).
 */
export function formatFallbackFullFile(): boolean {
	return effective.formatFallbackFullFile;
}

/**
 * `format.editorconfig`; default ON since #336, an explicit false opts
 * out and the file-heuristic fallback applies).
 */
export function isEditorconfigEnabled(): boolean {
	return effective.editorconfig;
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

/**
 * Whether row markers carry the file line number (the user's `line_numbers`
 * setting; default OFF).
 *
 * The single entry every renderer reads. The tool parameter that used to
 * steer this was removed in #244 — a call still carrying `line_numbers` is
 * rejected as an unknown field, with a hint pointing at the setting.
 */
export function lineNumbersEnabled(): boolean {
	return effective.lineNumbers;
}
export function isJsonOutput(): boolean {
	return effective.outputFormat === "json";
}

/**
 * How much of a successful `write` the model sees afterwards (`write.preview`,
 * map #354). Read at CALL time: the mode is a user switch that hot-reloads,
 * and the tool surface itself never changes with it.
 */
export function writePreviewMode(): WritePreviewMode {
	return effective.writePreview;
}

/** A fresh copy of the built-in defaults, for validators that reset absent fields. */
export function defaultEffectiveConfig(): EffectiveHashlineConfig {
	return { ...DEFAULT_CONFIG };
}
