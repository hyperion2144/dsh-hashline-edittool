/**
 * The hashline diff card body: the official `DiffBlock` projection re-drawn
 * from the persisted structured rows (`presentationMeta.diffRows`) with a
 * `行号:锚点` gutter — the same difference the read card carries.
 *
 * This is a vendored fork of the official DiffBlock (same classes, same
 * collapse math, same footer, same copy semantics) because the primitive's
 * API has no gutter column. The styling is the official DiffBlock.module.css
 * verbatim under a static `dshl-diff-` namespace, plus the ReadBlock gutter
 * cell so both cards share one gutter look. Rendering data comes ONLY from
 * the structured meta — the model-facing text is never parsed.
 *
 * PER-ROW STRUCTURE (#131 field feedback). The body used to be TWO column
 * blocks — every window's markers in one element, every code line in
 * another — and a mouse drag that started in the anchor column swallowed the
 * WHOLE column. Each drawn row is now ONE flex container (anchor cell +
 * content cell), so the DOM order matches the visual order and a drag is an
 * ordinary continuous text selection: the rows you drag across are exactly
 * the rows you get, anchors and their lines together.
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { ErrorCard } from "./error-card.js";
import { diffCardGroups } from "./models.js";
import { markerColumnCh } from "./read-meta.js";
import { TAB_STRIP_COPY_CLASS, TabStrip } from "./tab-strip.js";
import type { DiffBlockLabels } from "./labels.js";
import type { DiffRowGroup, DiffRowMeta, ErrorCardModel, FileFailureMeta } from "./types.js";

interface FoldLabels {
	collapseAria: string;
	expandAria: (hidden: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
}

/**
 * The shared head-tail fold control, vendored: the official FoldToggle is
 * internal to the primitives package (not exported), but the shipped diff
 * card's expand/collapse row is exactly this markup.
 */
function FoldToggle({ className, expanded, hidden, labels, onToggle }: {
	className: string | undefined;
	expanded: boolean;
	hidden: number;
	labels: FoldLabels;
	onToggle: () => void;
}): ReactNode {
	return jsx_("button", {
		type: "button",
		className,
		"aria-expanded": expanded,
		"aria-label": expanded ? labels.collapseAria : labels.expandAria(hidden),
		onClick: onToggle,
		children: expanded ? labels.collapse : labels.expand(hidden),
	});
}

const CSS_TEXT = [
	".dshl-diff-block{--dsl-diff-radius:12px;--dsl-diff-line-height:22px;position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsl-diff-radius)}",
	// PER-ROW (#131 field report): one flex row per drawn line — anchor cell +
	// content cell in DOM order, so a drag is an ordinary continuous text
	// selection. The old two-block layout (whole window's anchors in one block,
	// code in another) let a drag from the anchor column swallow the whole
	// column.
	".dshl-diff-body{padding:12px 14px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden}",
	".dshl-diff-row{display:flex}",
	".dshl-diff-line{min-height:var(--dsl-diff-line-height);white-space:pre;display:flex}",
	// The anchor cell: width via `--dshl-gutter-w` (set inline on the body, in
	// `ch` of the font declared HERE — `ch` measures this element's own font).
	// Selectable on purpose: a reader who drags into it wants the anchors.
	".dshl-diff-gutter-line{flex:0 0 auto;box-sizing:content-box;width:var(--dshl-gutter-w);padding:0 14px;text-align:right;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary);white-space:pre;overflow:hidden}",
	".dshl-suppress-anchor-select .dshl-diff-gutter-line{user-select:none}",
	".dshl-diff-content{flex:1 1 auto;white-space:pre}",
	".dshl-diff-gap{color:var(--dsw-alias-label-tertiary)}",
	".dshl-diff-del{color:var(--dsw-alias-state-error-primary)}",
	".dshl-diff-add{color:var(--dsw-alias-state-success-primary)}",
	".dshl-diff-ctx{color:var(--dsw-alias-label-secondary)}",
	".dshl-diff-expand{flex:1 1 auto;display:block;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left}",
	".dshl-diff-expand:hover{color:var(--dsw-alias-label-secondary)}",
	".dshl-diff-footer{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
	// #247: the partial-failure banner + the failure tab's panel. The banner is
	// the card's ONE alert; the error card inside a failure tab is the same
	// component the whole-call failure uses, with its role dropped (announce).
	".dshl-diff-failBanner{margin:12px 14px 0;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}",
	".dshl-diff-failHead{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xs-13)}",
	".dshl-diff-failRow{align-items:center;gap:6px;display:flex;flex-wrap:wrap;min-width:0}",
	".dshl-diff-failDot{border-radius:50%;background:var(--dsw-alias-state-error-primary);width:7px;height:7px;flex:none}",
	".dshl-diff-failCode{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:4px;padding:1px 6px}",
	".dshl-diff-failPath{background:transparent;border:none;padding:0;font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline;text-decoration-style:dotted}",
	".dshl-diff-failPath:hover{color:var(--dsw-alias-label-primary)}",
	".dshl-diff-failMessage{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
	".dshl-diff-panel{padding:12px 14px}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/diff-block.css";

/** Install the diff sheet once (same tagged style-tag contract as ToolRow). */
export function ensureDiffStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

const css = {
	block: "dshl-diff-block",
	body: "dshl-diff-body",
	row: "dshl-diff-row",
	line: "dshl-diff-line",
	gutterLine: "dshl-diff-gutter-line",
	content: "dshl-diff-content",
	gap: "dshl-diff-gap",
	del: "dshl-diff-del",
	add: "dshl-diff-add",
	ctx: "dshl-diff-ctx",
	expand: "dshl-diff-expand",
	footer: "dshl-diff-footer",
	panel: "dshl-diff-panel",
	failBanner: "dshl-diff-failBanner",
	failHead: "dshl-diff-failHead",
	failRow: "dshl-diff-failRow",
	failDot: "dshl-diff-failDot",
	failCode: "dshl-diff-failCode",
	failPath: "dshl-diff-failPath",
	failMessage: "dshl-diff-failMessage",
} as const;

/** Localized chrome (DiffBlockLabels shape). */
export interface DiffRowsLabels {
	copy: string;
	copied: string;
	collapseAria: string;
	expandAria: (hidden: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
	files: (count: number) => string;
	/** Accessible name of the overflow trigger (`common.more`). */
	more: string;
}

/**
 * The gutter label of one row — ONE cell carrying marker + number + anchor:
 * `-21:C7` for removed lines (the pre-edit anchor, stale but informative),
 * `+21:h2` for added lines (the served chained-edit anchor), `20:Cg` for
 * context. The marker never separates from the number:anchor pair.
 */
function gutterLabel(row: DiffRowMeta): string {
	if (row.kind === "-") {
		return row.hash !== "" ? `-${row.lineNumber}:${row.hash}` : `-${row.lineNumber}`;
	}
	if (row.kind === "+") {
		return row.hash !== "" ? `+${row.lineNumber}:${row.hash}` : `+${row.lineNumber}`;
	}
	return row.hash !== "" ? `${row.lineNumber}:${row.hash}` : `${row.lineNumber}`;
}

interface DisplayRow {
	kind: "del" | "add" | "ctx" | "gap";
	gutter: string;
	text: string;
	/** The diff class for the anchor and content cells (del/add/ctx); gap draws bare. */
	rowClass: string;
}

/**
 * Flatten the structured rows into display rows: gutter labels and hunk gaps.
 *
 * There is NO in-body path row any more (issue #96): the tab strip always
 * carries the file identity, so a second copy inside the body was pure
 * repetition — the same call the grep card made in #92.
 */
function buildDisplayRows(rows: readonly DiffRowMeta[]): DisplayRow[] {
	const out: DisplayRow[] = [];
	let prevNew: number | null = null;
	for (const row of rows) {
		if (row.kind !== "-" && prevNew !== null && row.lineNumber > prevNew + 1) {
			out.push({ kind: "gap", gutter: "", text: "⋯", rowClass: css.gap });
		}
		if (row.kind === "-") {
			out.push({ kind: "del", gutter: gutterLabel(row), text: row.text, rowClass: css.del });
		} else if (row.kind === "+") {
			out.push({ kind: "add", gutter: gutterLabel(row), text: row.text, rowClass: css.add });
			prevNew = row.lineNumber;
		} else {
			out.push({ kind: "ctx", gutter: gutterLabel(row), text: row.text, rowClass: css.ctx });
			prevNew = row.lineNumber;
		}
	}
	return out;
}

/** The diff text a reader copies: the shown rows minus the anchor column. */
function copyText(rows: readonly DisplayRow[]): string {
	return rows
		.map((row) => {
			if (row.kind === "del") return `- ${row.text}`;
			if (row.kind === "add") return `+ ${row.text}`;
			return row.text;
		})
		.join("\n");
}

/** One tab of the strip: a successful file's rows, or a failed file's error. */
type DiffTab =
	| { kind: "diff"; path: string; rows: readonly DiffRowMeta[] }
	| { kind: "error"; path: string; failure: FileFailureMeta };

/** The rows a failure tab would have had — it draws an error card instead. */
const EMPTY_ROWS: readonly DiffRowMeta[] = [];

/**
 * A failure entry as the error card's model. `code` is optional in the persisted
 * shape but the card's chip is not: an entry without one shows the same literal
 * the LEGACY synthesis path uses ("ERROR") rather than inventing a code.
 */
function errorCardOf(failure: FileFailureMeta): ErrorCardModel {
	return {
		code: failure.code ?? "ERROR",
		message: failure.message,
		path: failure.path,
		...(failure.context !== undefined ? { context: failure.context } : {}),
		...(failure.hint !== undefined ? { hint: failure.hint } : {}),
	};
}

export interface DiffRowsBlockProps {
	path: string;
	rows: readonly DiffRowMeta[];
	/**
	 * Per-file groups. Any count >= 1 renders one tab per file (issue #96: the
	 * single-file case keeps its tab); when absent the card synthesises one group
	 * from `path` + `rows` — which is also what a pre-0.4.4 session log needs,
	 * since historical single-file metas carry no `diffRowGroups` at all.
	 */
	groups?: readonly DiffRowGroup[] | undefined;
	/**
	 * Failed files of a PARTIALLY failed multi-file call (#247): each one gets
	 * its own tab after the successful files, plus a row in the banner above the
	 * strip. The count summary is derived from these — the host adds no derived
	 * field to the persisted meta.
	 */
	failures?: readonly FileFailureMeta[] | undefined;
	/** Accessible name of the tab list (the owning tool's title). */
	tablistLabel: string;
	labels: DiffRowsLabels;
	maxLines?: number | undefined;
	className?: string | undefined;
}

/**
 * Render the applied edit as a diff surface with ONE anchor cell per row
 * carrying marker + number + anchor (`-21:C7` / `+21:h2` / `20:Cg`): removed
 * lines keep their pre-edit anchor, added and context lines carry the served
 * post-edit anchor (the chained-edit currency).
 */
export function DiffRowsBlock({
	path,
	rows,
	groups,
	failures,
	tablistLabel,
	labels,
	maxLines = 16,
	className,
}: DiffRowsBlockProps): ReactNode {
	ensureDiffStyles();

	// issue #96: ONE tab per file, always — a single-file card keeps its tab
	// (there is no single-file branch, only fewer tabs). A missing `groups` (the
	// single-file meta channel, and every pre-0.4.4 log) synthesises one group so
	// the strip has exactly one source of truth.
	const fileGroups = useMemo<readonly DiffRowGroup[]>(
		() => diffCardGroups(path, rows, groups ?? null),
		[groups, path, rows],
	);
	// #247: the strip carries EVERY file the call touched — the successful ones
	// from the persisted row groups, then one tab per failed file. The host keeps
	// input order (successes first), so the tab row, the banner and the count
	// summary agree without a derived field in the meta.
	const tabs = useMemo<readonly DiffTab[]>(
		() => [
			...fileGroups.map((group): DiffTab => ({ kind: "diff", path: group.path, rows: group.rows })),
			...(failures ?? []).map((failure): DiffTab => ({ kind: "error", path: failure.path, failure })),
		],
		[failures, fileGroups],
	);
	const failureList = failures ?? [];
	const [activeTab, setActiveTab] = useState(0);
	const activeIndex = Math.min(activeTab, tabs.length - 1);
	const active = tabs[activeIndex];
	const activeFailure = active?.kind === "error" ? active.failure : null;
	const activeRows = active?.kind === "diff" ? active.rows : EMPTY_ROWS;
	const baseId = useId();
	const panelId = `${baseId}-panel`;

	const display = useMemo(() => buildDisplayRows(activeRows), [activeRows]);
	// One shared anchor-cell width, sized from the data by the same helper the
	// read card uses — the four cards must not invent four widths for the same
	// content.
	const gutterWidth = markerColumnCh(display.map((row) => row.gutter));
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const onCopy = useCallback(() => {
		if (copied) return;
		void writeClipboard(copyText(display)).then((ok) => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1000);
		});
	}, [copied, display]);

	const onToggle = useCallback(() => setExpanded((value) => !value), []);

	const onSelect = useCallback((index: number) => {
		setActiveTab(index);
		// Switching tabs resets the fold and the copy flash (as the grep card does).
		setExpanded(false);
		setCopied(false);
	}, []);

	const added = activeRows.filter((row) => row.kind === "+").length;
	const removed = activeRows.filter((row) => row.kind === "-").length;

	const hidden = display.length - maxLines;
	const capped = hidden > 0 && !expanded;
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	const head = capped ? display.slice(0, headLines) : display;
	const tail = capped ? display.slice(display.length - tailLines) : [];

	return jsx_("div", {
		className: `${css.block} ${className ?? ""}`.trim(),
		"data-diff": "",
		children: [
			// #247: the failure banner sits ABOVE the strip — one row per failed file
			// (dot + code + path + the message's first line) and the ONE `role="alert"`
			// of the card. Clicking a path selects that file's tab instead of repeating
			// the error card here.
			...(failureList.length > 0
				? [
						jsx_("div", {
							key: "failures",
							className: css.failBanner,
							role: "alert",
							children: [
								jsx_("div", {
									className: css.failHead,
									children: `${failureList.length} of ${tabs.length} files failed`,
								}),
								...failureList.map((failure, offset) =>
									jsx_("div", {
										key: failure.path,
										className: css.failRow,
										children: [
											jsx_("span", { className: css.failDot, "aria-hidden": true }),
											failure.code !== undefined
												? jsx_("code", { className: css.failCode, children: failure.code })
												: null,
											jsx_("button", {
												type: "button",
												className: css.failPath,
												onClick: () => onSelect(fileGroups.length + offset),
												children: failure.path,
											}),
											jsx_("span", {
												className: css.failMessage,
												children: failure.message.split("\n")[0] ?? "",
											}),
										],
									}),
								),
							],
						}),
					]
				: []),
			jsx_(TabStrip, {
				paths: tabs.map((tab) => tab.path),
				// The failed files' tabs carry the error tone (red dot + red path).
				errorIndexes: tabs.flatMap((tab, index) => (tab.kind === "error" ? [index] : [])),
				activeIndex,
				onSelect,
				labels: { tablist: tablistLabel, more: labels.more },
				panelId,
				idPrefix: baseId,
				copy: jsx_("button", {
					type: "button",
					className: TAB_STRIP_COPY_CLASS,
					onClick: onCopy,
					children: copied ? labels.copied : labels.copy,
				}),
			}),
			activeFailure !== null
				? jsx_("div", {
						className: css.panel,
						id: panelId,
						role: "tabpanel",
						"aria-labelledby": `${baseId}-tab-${activeIndex}`,
						children: jsx_(ErrorCard, {
							model: errorCardOf(activeFailure),
							// The banner above already announced the failure; switching to
							// its tab must not re-announce the same card.
							announce: false,
						}),
					})
				: jsx_("div", {
						className: css.body,
						id: panelId,
						role: "tabpanel",
						"aria-labelledby": `${baseId}-tab-${activeIndex}`,
						style: { "--dshl-gutter-w": `${gutterWidth}ch` } as never,
						children: [
							// PER-ROW: one flex container per drawn line — anchor cell + content
							// cell in DOM order, so a drag is an ordinary continuous text
							// selection (the rows you drag across, anchors and lines together).
							// Each cell takes its ROW's class too: a removed line's `-21:C7` is
							// red and an added line's `+21:h2` is green, the way the shipped
							// diff card drew them. The fold toggle spans the full row.
							...head.map((row, index) => foldRow(row, index)),
							// The fold toggle stays rendered whenever rows are hidden OR the fold
							// is open — otherwise an opened fold could never be closed again.
							...(hidden > 0
								? [
										jsx_("div", {
											key: "fold-row",
											className: css.row,
											children: [
												// Empty anchor cell: keeps the toggle indented to the code
												// column instead of drifting into the anchor lane.
												jsx_("span", { className: css.gutterLine, "aria-hidden": true }),
												jsx_(FoldToggle, {
													className: css.expand,
													expanded,
													hidden,
													labels,
													onToggle,
												}),
											],
										}),
									]
								: []),
							...tail.map((row, index) => foldRow(row, index)),
						],
					}),
			jsx_("div", {
				className: css.footer,
				children: `└ +${added} -${removed} · ${labels.files(fileGroups.length)}`,
			}),
		],
	});

/**
 * One drawn diff row: a flex container with the anchor cell + the content
 * cell, in DOM order (per-row drag semantics, #131 field feedback).
 */
function foldRow(row: DisplayRow, index: number): ReactNode {
	return jsx_("div", {
		key: index,
		className: css.row,
		children: [
			jsx_("span", {
				className: `${css.gutterLine} ${row.rowClass}`.trim(),
				children: row.gutter,
			}),
			jsx_("span", {
				className: `${css.content} ${row.rowClass}`.trim(),
				children: row.text,
			}),
		],
	});
}
}
