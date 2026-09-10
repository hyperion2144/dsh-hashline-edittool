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
