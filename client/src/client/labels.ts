/**
 * Localized chrome labels for the read/diff/search/lsp/delete/error cards.
 *
 * Every word comes from the plugin's OWN vocabulary namespace (`hashline.card`,
 * see {@link ./locale.js}) through the `t` seat the slot host binds to a
 * registration's `locale` declaration. The keys are that namespace's key union,
 * so a label naming a key the dictionary does not carry is a COMPILE error — the
 * four holes the shipped `conversation` seat left (`diff.files.one`, `lsp.title`,
 * …) cannot come back.
 */
import type { CardLocaleKey } from "./locale.js";
import type { WireText } from "./types.js";

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
	/** Accessible name of the overflow trigger. */
	more: string;
}

/**
 * The translator seat: the host's `t`, narrowed to this namespace's keys.
 *
 * The host's own `t` takes any string, so it satisfies this narrower type;
 * the narrowing is what turns a typo'd key into a compile error.
 */
type TBench = (key: CardLocaleKey, params?: Record<string, unknown>) => string;

/**
 * The wrap switch's chrome: ONE word, shared by every card that draws it
 * (#373).
 *
 * The switch is the same control in five places, so its name is ONE key in ONE
 * namespace — not five keys that happen to say the same thing.
 */
export interface WrapLabels {
	/** The toggle's accessible name and tooltip. */
	wrapToggle: string;
}

/** Build the wrap switch's chrome. */
export function wrapLabels(t: TBench): WrapLabels {
	return { wrapToggle: t("wrap.toggle") };
}

/**
 * The diff card's chrome: the shipped diff card's own words PLUS the wrap
 * switch's (#373).
 *
 * The shipped `DiffBlock` keeps the shipped shape — it has no switch — but
 * the extra word is harmless there and the card needs it.
 */
export interface DiffCardLabels extends DiffBlockLabels, WrapLabels {}

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
export interface ReadCardLabels extends ReadBlockLabels, TabStripLabels, WrapLabels {
	/** Accessible name of the tab list (the read tool's title). */
	tablist: string;
	/** Accessible name of the overflow trigger. */
	more: string;
	/**
	 * The lossy footnote (#375): a LEGACY meta carries the English sentence
	 * as a string (rendered verbatim), a current one a key + params (resolved by
	 * `t()`). The host cannot read the reader's language (#369), so the wire
	 * carries facts and this renders them.
	 */
	lossyNote: (note: string | WireText) => string;
}

/** Build localized read-card chrome labels. */
export function readCardLabels(t: TBench): ReadCardLabels {
	return {
		...readBlockLabels(t),
		...wrapLabels(t),
		// The tool title is the one localized word that names this tab list
		// (the same key the grep card uses).
		tablist: t("row.title.read"),
		more: t("more"),
		// #375: the lossy footnote — a legacy string verbatim, a wire key
		// through the vocabulary.
		lossyNote: (note) => {
			if (typeof note === "string") return note;
			// A note that carries no key is not a note: the card shows nothing.
			if (typeof note?.key !== "string") return "";
			return t(note.key, note.params);
		},
	};
}

/** Build localized diff-card chrome labels. */
export function diffBlockLabels(t: TBench): DiffCardLabels {
	return {
		...wrapLabels(t),
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("diff.collapseAria"),
		expandAria: (count) => t("diff.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("diff.expandRest", { count }),
		files: (count) => t(count === 1 ? "diff.files.one" : "diff.files.other", { count }),
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
		...wrapLabels(t),
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
export interface GrepCardLabels extends WrapLabels {
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
	/** The outline footer's line: an outline is not a match count. */
	outline: (count: number) => string;
	/** Accessible name of the file tab list. */
	tablist: string;
	/** Accessible name of the overflow trigger. */
	more: string;
}

/** Build localized grep-card chrome labels. */
export function grepCardLabels(t: TBench): GrepCardLabels {
	return {
		...wrapLabels(t),
		copy: t("copy"),
		copied: t("copied"),
		collapseAria: t("search.collapseAria"),
		expandAria: (count) => t("search.expandAria", { count }),
		collapse: t("collapse"),
		expand: (count) => t("search.expandRest", { count }),
		noResults: t("search.noResults"),
		summary: (shown, total, files, truncated) =>
			t(truncated ? "search.matches.truncated" : "search.matches", { shown, total, files }),
		outline: (count) => t("search.outline", { count }),
		// The tool title is the one localized word that names this tab list.
		tablist: t("row.title.grep"),
		more: t("more"),
	};
}

/**
 * The delete card's own words — the five that were hardcoded English.
 *
 * The card's TITLE and its three per-path STATUSES: the model layer owns the
 * paths and the reclaim details, never the words in front of them.
 */
export interface DeleteCardLabels {
	/** The collapsed row's title when the call succeeded. */
	title: string;
	/** The collapsed row's title when the call failed. */
	failedTitle: string;
	/** The per-path status of a path that could not be deleted. */
	statusFailed: string;
	/** The per-path status of a path that was deleted. */
	statusDeleted: string;
	/** The per-path status of a path that was already gone. */
	statusAbsent: string;
}

/** Build the delete card's own labels. */
export function deleteCardLabels(t: TBench): DeleteCardLabels {
	return {
		title: t("delete.title"),
		failedTitle: t("delete.failedTitle"),
		statusFailed: t("delete.status.failed"),
		statusDeleted: t("delete.status.deleted"),
		statusAbsent: t("delete.status.absent"),
	};
}

/**
 * The rename card's own words — the four that were hardcoded English.
 *
 * The card's TITLE and its two per-pair STATUSES: the model layer owns the
 * paths and the migrated details, never the words in front of them.
 */
export interface RenameCardLabels {
	/** The collapsed row's title when the call succeeded. */
	title: string;
	/** The collapsed row's title when the call failed. */
	failedTitle: string;
	/** The per-path status of a pair that could not be renamed. */
	statusFailed: string;
	/** The per-path status of a pair that was renamed. */
	statusRenamed: string;
}

/** Build the rename card's own labels. */
export function renameCardLabels(t: TBench): RenameCardLabels {
	return {
		title: t("rename.title"),
		failedTitle: t("rename.failedTitle"),
		statusFailed: t("rename.status.failed"),
		statusRenamed: t("rename.status.renamed"),
	};
}

/**
 * The error card's own labels.
 *
 * Only the LABEL before the hint is chrome: the hint's text is the model's own
 * words (the model channel speaks English), so it is rendered verbatim.
 */
export interface ErrorCardLabels extends WrapLabels {
	/** The label in front of the hint line. */
	hintLabel: string;
	/** The folded context echo's tail: how many lines the fold hides. */
	moreLines: (count: number) => string;
}

/** Build the error card's labels. */
export function errorCardLabels(t: TBench): ErrorCardLabels {
	return {
		...wrapLabels(t),
		hintLabel: t("error.hintLabel"),
		moreLines: (count) => t("error.moreLines", { count }),
	};
}
