// GENERATED from src/wire/keys.ts by scripts/sync-wire.mjs — edit the SOURCE, never this file (ADR-0040).
/**
 * The wire key contract — the SINGLE SOURCE of the keys the host may put on
 * the wire as `{ key, params }` text (ADR-0026, ADR-0040).
 *
 * This file is the one hand-maintained copy. The client's acceptance gate is
 * a BUILD-TIME PROJECTION of it (`client/scripts/sync-wire.mjs` copies it to
 * `client/src/wire/keys.generated.ts`), so the keys that travel the wire and
 * the keys the client accepts cannot drift apart — the old mechanism was a
 * test scraping host source files, and the scrape missed whole modules
 * (`patch-card.ts`'s three keys were invisible to it).
 *
 * Pure data: no imports, so both toolchains (root tsc, client esbuild/vitest)
 * consume it directly.
 *
 * @module dsh-hashline-edittool/wire/keys
 */

/**
 * The card-side shape of one host text: the stable KEY of a wording plus the
 * values that fill its template. The client resolves both through its own
 * `t()`, in the language the reader chose (ADR-0026 decision 1).
 */
export interface WireLocalizedText {
	/** The vocabulary key the client resolves (`hashline.card`). */
	readonly key: string;
	/** The values that fill the key's template. */
	readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * The keys the HOST may put on the wire. The list IS the contract:
 * a key the host sends but this list lacks must fail LOUDLY (a test scrapes
 * the host's key literals and compares them to this list), and a key the
 * client's gate refuses is a bug in the projection, never a silent drop.
 */
export const WIRE_TEXT_KEYS = {
	"read.lossy": true,
	"row.title.read": true,
	"row.title.read.window": true,
	"row.title.read.window.truncated": true,
	"row.title.read.total": true,
	// #386: the host's grep row carries the COUNTS, not the row's own word —
	// `row.title.grep` is NOT a wire key (the grep card's tab list names
	// itself with it in the client's own vocabulary), but a meta that still
	// carries it is REFUSED, and the row keeps its own label.
	"row.title.grep.stats": true,
	"row.title.grep.stats.limit": true,
	"row.title.grep.stats.budget": true,
	"row.title.grep.stats.limit_budget": true,
	"row.title.lsp.nav.stats": true,
	"row.title.edit": true,
	"row.title.write": true,
	"row.title.apply_patch": true,
	"row.title.apply_patch.files": true,
	"row.title.apply_patch.stopped": true,
	"row.title.apply_patch.empty": true,
	// #377: the language-server routes' texts. The host names the wording; the
	// card resolves it in the reader's language.
	"lsp.status.noSubprocessSeam": true,
	"lsp.status.noClient": true,
	"lsp.status.serverNotStarted": true,
	"lsp.status.serverStarting": true,
	"lsp.row.canInstall": true,
	"lsp.row.noBuiltinCommand": true,
	"lsp.row.selfInstall": true,
	"lsp.install.noCommand": true,
	"lsp.install.noCommandForPlatform": true,
	"lsp.install.exitCode": true,
	"lsp.install.npmOkButMissing": true,
	"lsp.install.doneBuiltinDir": true,
	"lsp.install.doneOwnToolchain": true,
} as const;

/** Every wire key's exact name. */
export type WireTextKeyName = keyof typeof WIRE_TEXT_KEYS;
