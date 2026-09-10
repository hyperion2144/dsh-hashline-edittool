/**
 * The hashline grep card body: a self-drawn card carrying a file tab bar, one
 * `行号:锚点` gutter column and per-row highlight marks (issue #92 / ADR-0005).
 *
 * WHY SELF-DRAWN (not the primitives' `ReadBlock`/`SearchBlock`): this card's
 * model puts the highlight offsets INSIDE each row, and no shipped primitive
 * accepts them — `ReadBlockLine.text` is a plain string whose colouring comes
 * from an internal, unexported tokenizer, and neither primitive exposes an
 * inline-span hook. Highlighting is the point of this card, so the layout is
 * vendored (the same call the edit card made for its gutter in #71) and the card
 * deliberately drops syntax colouring: the edit/write cards have none either.
 *
 * Data comes ONLY from the persisted structured meta — the model-facing text is
 * never parsed, and no matching runs here (the host computed the spans).
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import type { GrepCardModel, GrepRowMeta } from "./types.js";
import { grepGutterLabel, highlightSegments } from "./models.js";
import type { GrepCardLabels } from "./labels.js";

const CSS_TEXT = [
	".dshl-grep-block{--dsl-grep-line-height:22px;position:relative;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:12px}",
	// Tab bar + copy share one row: the tabs scroll, the button never does.
	".dshl-grep-head{display:flex;align-items:flex-end;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
	".dshl-grep-tabs{display:flex;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}",
	".dshl-grep-tab{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);border-bottom:2px solid transparent;margin-bottom:-1px}",
	".dshl-grep-tab:hover{color:var(--dsw-alias-label-primary)}",
	".dshl-grep-tab:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
	".dshl-grep-tabActive{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-info-primary)}",
	".dshl-grep-copyButton{flex:none;background-color:transparent;border:none;padding:0 12px 6px;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13)}",
	".dshl-grep-body{padding:12px 14px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden}",
	".dshl-grep-line{min-height:var(--dsl-grep-line-height);white-space:pre;display:flex}",
	".dshl-grep-gutter{flex:none;padding-right:14px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}",
	".dshl-grep-content{white-space:pre}",
	// The mark's own `color` is overridden deliberately: the UA sheet paints
	// `mark` with a light background AND black text, which is unreadable in dark
	// themes. The line's colour is inherited instead.
	".dshl-grep-mark{background-color:var(--dsw-alias-state-warn-tertiary);color:inherit;border-radius:2px}",
	".dshl-grep-expand{display:block;width:100%;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left}",
	".dshl-grep-expand:hover{color:var(--dsw-alias-label-secondary)}",
	".dshl-grep-empty{padding:12px 14px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
	".dshl-grep-footer{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/grep-card.css";

/** Install the grep sheet once (same tagged style-tag contract as ToolRow). */
export function ensureGrepStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

const css = {
	block: "dshl-grep-block",
	head: "dshl-grep-head",
	tabs: "dshl-grep-tabs",
	tab: "dshl-grep-tab",
	tabActive: "dshl-grep-tabActive",
	copyButton: "dshl-grep-copyButton",
	body: "dshl-grep-body",
	line: "dshl-grep-line",
	gutter: "dshl-grep-gutter",
	content: "dshl-grep-content",
	mark: "dshl-grep-mark",
	expand: "dshl-grep-expand",
	empty: "dshl-grep-empty",
	footer: "dshl-grep-footer",
} as const;


/** One row's content, with every highlighted occurrence wrapped in `<mark>`. */
function rowContent(row: GrepRowMeta): ReactNode {
	const segments = highlightSegments(row.text, row.spans);
	if (segments.length === 0) return "";
	return segments.map((segment, index) =>
		segment.hit
			? jsx_("mark", { className: css.mark, key: index, children: segment.text })
			: segment.text,
	);
}

export interface GrepCardProps {
	model: GrepCardModel;
	labels: GrepCardLabels;
	maxLines?: number | undefined;
	className?: string | undefined;
}

/**
 * Render a settled grep result as the hashline search card.
 * @param props - see {@link GrepCardProps}.
 * @returns the card element.
 */
export function GrepCard({ model, labels, maxLines = 16, className }: GrepCardProps): ReactNode {
	ensureGrepStyles();

	const [active, setActive] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const baseId = useId();

	const files = model.files;
	// Stay on a valid tab even if a re-render hands us a shorter result.
	const activeIndex = files.length === 0 ? 0 : Math.min(active, files.length - 1);
	const rows = files[activeIndex]?.rows ?? [];

	const counts = useMemo(() => {
		let shown = 0;
		for (const file of files) {
			for (const row of file.rows) if (row.match === true) shown += 1;
		}
		return { shown, total: model.total, files: files.length };
	}, [files, model.total]);

	const display = useMemo(
		() => rows.map((row) => ({ key: row.number, gutter: grepGutterLabel(row), row })),
		[rows],
	);
	// One shared gutter column: the widest label sets the width for every row
	// (monospace font → `ch` is exact), so all content cells share one edge.
	const gutterWidth = Math.max(8, ...display.map((entry) => entry.gutter.length));

	const onSelect = useCallback((index: number) => {
		setActive(index);
		// Mirrors the edit card: switching tabs resets the fold and the copy flash.
		setExpanded(false);
		setCopied(false);
	}, []);

	const onCopy = useCallback(() => {
		if (copied) return;
		// The rows' own text — no gutter, no mark artifacts.
		void writeClipboard(rows.map((row) => row.text).join("\n")).then((ok) => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1000);
		});
	}, [copied, rows]);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent) => {
			if (files.length < 2) return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			const step = event.key === "ArrowRight" ? 1 : -1;
			onSelect((activeIndex + step + files.length) % files.length);
		},
		[activeIndex, files.length, onSelect],
	);

	const onToggle = useCallback(() => setExpanded((value) => !value), []);

	if (files.length === 0) {
		return jsx_("div", {
			className: `${css.block} ${className ?? ""}`.trim(),
			"data-grep": "empty",
			children: jsx_("div", { className: css.empty, children: labels.noResults }),
		});
	}

	const hidden = display.length - maxLines;
	const capped = hidden > 0 && !expanded;
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	const head = capped ? display.slice(0, headLines) : display;
	const tail = capped ? display.slice(display.length - tailLines) : [];

	const rowEl = (entry: (typeof display)[number], index: number) =>
		jsx_("div", {
			key: `${entry.key}-${index}`,
			className: css.line,
			children: [
				jsx_("span", {
					className: css.gutter,
					style: { minWidth: `${gutterWidth}ch` },
					"aria-hidden": true,
					children: entry.gutter,
				}),
				jsx_("span", { className: css.content, children: rowContent(entry.row) }),
			],
		});

	const tabId = (index: number) => `${baseId}-tab-${index}`;
	const panelId = `${baseId}-panel`;

	return jsx_("div", {
		className: `${css.block} ${className ?? ""}`.trim(),
		"data-grep": "matches",
		children: [
			jsx_("div", {
				className: css.head,
				children: [
					// A single-match result keeps its one tab (the requirement is
					// "keep the tab, there is just one"), so the bar has no
					// single-file branch — only fewer buttons.
					jsx_("div", {
						className: css.tabs,
						role: "tablist",
						"aria-label": labels.tablist,
						onKeyDown,
						children: files.map((file, index) =>
							jsx_("button", {
								key: index,
								id: tabId(index),
								type: "button",
								role: "tab",
								title: file.path,
								className: `${css.tab} ${index === activeIndex ? css.tabActive : ""}`.trim(),
								"aria-selected": index === activeIndex,
								"aria-controls": panelId,
								tabIndex: index === activeIndex ? 0 : -1,
								onClick: () => onSelect(index),
								children: file.path,
							}),
						),
					}),
					jsx_("button", {
						type: "button",
						className: css.copyButton,
						onClick: onCopy,
						children: copied ? labels.copied : labels.copy,
					}),
				],
			}),
			jsx_("div", {
				className: css.body,
				id: panelId,
				role: "tabpanel",
				"aria-labelledby": tabId(activeIndex),
				children: [
					...head.map(rowEl),
					...(hidden > 0
						? [
								jsx_("button", {
									type: "button",
									className: css.expand,
									"aria-expanded": expanded,
									"aria-label": expanded ? labels.collapseAria : labels.expandAria(hidden),
									onClick: onToggle,
									children: expanded ? labels.collapse : labels.expand(hidden),
								}),
							]
						: []),
					...tail.map(rowEl),
				],
			}),
			jsx_("div", {
				className: css.footer,
				children: `└ ${labels.summary(counts.shown, counts.total, counts.files, model.truncated)}`,
			}),
		],
	});
}
