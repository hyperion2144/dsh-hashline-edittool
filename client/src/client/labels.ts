/**
 * Localized chrome labels for the read/diff cards, resolved through the
 * conversation locale seat (`locale: "conversation"` registration) — the same
 * keys the shipped tool views use, so the wording matches the built-in cards
 * in every locale.
 */

/** Read-card chrome labels (ReadBlockLabels shape). */
export interface ReadBlockLabels {
	window: (shown: number, total: number) => string;
	copy: string;
	copied: string;
	collapseAria: string;
	expandAria: (hidden: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
}

/** Diff-card chrome labels (DiffBlockLabels shape). */
export interface DiffBlockLabels {
	copy: string;
	copied: string;
	collapseAria: string;
	expandAria: (hidden: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
	files: (count: number) => string;
	/** Accessible name of the overflow trigger (falls back to `common.more`). */
	more: string;
}

type TBench = (key: string, params?: Record<string, unknown>) => string;

/** Build localized read-card chrome labels. */
export function readBlockLabels(t: TBench): ReadBlockLabels {
	return {
		window: (shown, total) => t("read.window", { shown, total }),
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("read.collapseAria"),
		expandAria: (count) => t("read.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("read.expandRest", { count }),
	};
}

/**
 * Chrome labels for the hashline read card: the shipped read card's own words
 * plus the tab row's. `copy` / `copied` serve the tab's copy button; the fold
 * reuses the same `read.*` expansion wording the shipped card used.
 */
export interface ReadCardLabels extends ReadBlockLabels, TabStripLabels {
	/** Accessible name of the tab list (the read tool's title). */
	tablist: string;
	/** Accessible name of the overflow trigger (`common.more`). */
	more: string;
}

/** Build localized read-card chrome labels. */
export function readCardLabels(t: TBench): ReadCardLabels {
	return {
		...readBlockLabels(t),
		// The shipped locale carries no `read.card`; the tool title is the one
		// localized word that names this tab list (the same key the grep card uses).
		tablist: t("tool.title.read"),
		// `more` is a `common` namespace key — no new locale key is added.
		more: t("more"),
	};
}

/** Build localized diff-card chrome labels. */
export function diffBlockLabels(t: TBench): DiffBlockLabels {
	return {
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("diff.collapseAria"),
		expandAria: (count) => t("diff.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("diff.expandRest", { count }),
		files: (count) => t(count === 1 ? "diff.files.one" : "diff.files.other", { count }),
		// `more` is a `common` namespace key — no new locale key is added.
		more: t("more"),
	};
}

import type { LspBlockLabels } from "./lsp-block.js";
import type { TabStripLabels } from "./tab-strip.js";

/**
 * Diagnostics-card chrome labels (`lsp`).
 *
 * `tablist` and `more` are the `TabStrip`'s chrome, whose accessibility names
 * cannot be empty; the rest reuses the keys the read card already ships, so the
 * same three words do not get a second locale entry.
 */
export function lspBlockLabels(t: TBench): LspBlockLabels {
	return {
		tablist: t("lsp.title"),
		more: t("more"),
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("read.collapseAria"),
		expandAria: (count) => t("read.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("read.expandRest", { count }),
		summary: (lines, messages) => t("lsp.diagnostics.summary", { lines, messages }),
	};
}

/** Grep-card chrome labels (reuses the shipped search-card keys). */
export interface GrepCardLabels {
	copy: string;
	copied: string;
	collapseAria: string;
	expandAria: (hidden: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
	/** Empty-result wording (`search.noResults`). */
	noResults: string;
	/** Result line for the footer: `search.matches` / `search.matches.truncated`. */
	summary: (shown: number, total: number, files: number, truncated: boolean) => string;
	/** Accessible name of the file tab list. */
	tablist: string;
	/** Accessible name of the overflow trigger (falls back to `common.more`). */
	more: string;
}

/** Build localized grep-card chrome labels. */
export function grepCardLabels(t: TBench): GrepCardLabels {
	return {
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("search.collapseAria"),
		expandAria: (count) => t("search.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("search.expandRest", { count }),
		noResults: t("search.noResults"),
		summary: (shown, total, files, truncated) =>
			t(truncated ? "search.matches.truncated" : "search.matches", { shown, total, files }),
		// The shipped locale carries no `search.card`; the tool title is the one
		// localized word that names this tab list.
		tablist: t("tool.title.grep"),
		// `more` is a `common` namespace key, which the lookup chain consults
		// after the entry namespace misses — no new locale key is added.
		more: t("more"),
	};
}
