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
	};
}
