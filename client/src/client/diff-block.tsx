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
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import type { DiffBlockLabels } from "./labels.js";
import type { DiffRowMeta } from "./types.js";

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
	".dshl-diff-copyButton{position:absolute;top:8px;right:12px;z-index:1;background-color:transparent;border:none;padding:0;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13)}",
	".dshl-diff-body{padding:12px 14px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden}",
	".dshl-diff-line{min-height:var(--dsl-diff-line-height);white-space:pre;display:flex}",
	// Gutter: the ReadBlock gutter cell, so both cards share one look. It is
	// chrome, not content — excluded from text selection like the read card's.
	".dshl-diff-gutter{flex:none;min-width:64px;padding-right:14px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}",
	".dshl-diff-content{white-space:pre}",
	".dshl-diff-path{color:var(--dsw-alias-label-primary);font-weight:600;padding-right:56px}",
	".dshl-diff-gap{color:var(--dsw-alias-label-tertiary)}",
	".dshl-diff-del::before{content:'- ';color:var(--dsw-alias-state-error-primary)}",
	".dshl-diff-del{color:var(--dsw-alias-state-error-primary)}",
	".dshl-diff-add::before{content:'+ ';color:var(--dsw-alias-state-success-primary)}",
	".dshl-diff-add{color:var(--dsw-alias-state-success-primary)}",
	".dshl-diff-ctx{color:var(--dsw-alias-label-secondary)}",
	".dshl-diff-expand{display:block;width:100%;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left}",
	".dshl-diff-expand:hover{color:var(--dsw-alias-label-secondary)}",
	".dshl-diff-footer{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
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
	copyButton: "dshl-diff-copyButton",
	body: "dshl-diff-body",
	line: "dshl-diff-line",
	gutter: "dshl-diff-gutter",
	content: "dshl-diff-content",
	path: "dshl-diff-path",
	gap: "dshl-diff-gap",
	del: "dshl-diff-del",
	add: "dshl-diff-add",
	ctx: "dshl-diff-ctx",
	expand: "dshl-diff-expand",
	footer: "dshl-diff-footer",
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
}

/** The gutter label of one row. Removed lines keep their pre-edit number only — their anchors are stale. */
function gutterLabel(row: DiffRowMeta): string {
	if (row.kind === "-") return `${row.lineNumber}`;
	return row.hash !== "" ? `${row.lineNumber}:${row.hash}` : `${row.lineNumber}`;
}

interface DisplayRow {
	kind: "del" | "add" | "ctx" | "gap" | "path";
	gutter: string;
	text: string;
	/** The diff class for the content cell (del/add/ctx); gap/path draw bare. */
	rowClass: string;
}

/** Flatten the structured rows: path header, gutter labels, hunk gaps. */
function buildDisplayRows(path: string, rows: readonly DiffRowMeta[]): DisplayRow[] {
	const out: DisplayRow[] = [{ kind: "path", gutter: "", text: path, rowClass: css.path }];
	let prevNew: number | null = null;
	for (const row of rows) {
		if (row.kind !== "-" && prevNew !== null && row.lineNumber > prevNew + 1) {
			out.push({ kind: "gap", gutter: "", text: "⋯", rowClass: css.gap });
		}
		if (row.kind === "-") {
			out.push({ kind: "del", gutter: gutterLabel(row), text: row.text, rowClass: css.del });
		} else {
			out.push({ kind: "ctx", gutter: gutterLabel(row), text: row.text, rowClass: css.ctx });
			prevNew = row.lineNumber;
		}
	}
	return out;
}

/** The diff text a reader copies: the shown rows minus the gutter column. */
function copyText(rows: readonly DisplayRow[]): string {
	return rows
		.map((row) => {
			if (row.kind === "del") return `- ${row.text}`;
			if (row.kind === "add") return `+ ${row.text}`;
			return row.text;
		})
		.join("\n");
}

export interface DiffRowsBlockProps {
	path: string;
	rows: readonly DiffRowMeta[];
	labels: DiffRowsLabels;
	maxLines?: number | undefined;
	className?: string | undefined;
}

/**
 * Render the applied edit as a diff surface with a `行号:锚点` gutter: added
 * and context rows carry the served post-edit anchor (the chained-edit
 * currency), removed rows keep their pre-edit number.
 */
export function DiffRowsBlock({ path, rows, labels, maxLines = 16, className }: DiffRowsBlockProps): React.ReactNode {
	ensureDiffStyles();
	const display = useMemo(() => buildDisplayRows(path, rows), [path, rows]);
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

	const added = rows.filter((row) => row.kind === "+").length;
	const removed = rows.filter((row) => row.kind === "-").length;

	const hidden = display.length - maxLines;
	const capped = hidden > 0 && !expanded;
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	const head = capped ? display.slice(0, headLines) : display;
	const tail = capped ? display.slice(display.length - tailLines) : [];

	const rowEl = (row: DisplayRow, index: number) =>
		jsx_("div", {
			key: index,
			className: `${css.line} ${row.rowClass}`,
			children: [
				jsx_("span", { className: css.gutter, "aria-hidden": true, children: row.gutter }),
				jsx_("span", { className: css.content, children: row.text }),
			],
		});

	return jsx_("div", {
		className: `${css.block} ${className ?? ""}`,
		"data-diff": "",
		children: [
			jsx_("button", { type: "button", className: css.copyButton, onClick: onCopy, children: copied ? labels.copied : labels.copy }),
			jsx_("div", { className: css.body, children: [...head.map(rowEl), ...(hidden > 0 ? [jsx_(FoldToggle, { className: css.expand, expanded, hidden, labels, onToggle })] : []), ...tail.map(rowEl)] }),
			jsx_("div", { className: css.footer, children: `└ +${added} -${removed} · ${labels.files(1)}` }),
		],
	});
}
