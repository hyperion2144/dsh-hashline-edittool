/**
 * The hashline `read` card — entirely ours: the frame, the tab row, the gutter,
 * the fold and the syntax colouring. No shipped primitive is mounted inside it.
 *
 * WHY THE COLOURING IS ALSO OURS. The shipped `ReadBlock` colours its lines with
 * an internal, unexported shiki instance, so no card of ours could borrow it —
 * and mounting that component to get colours would put a second card's DOM,
 * banner, gutter and fold inside this one. `highlight.ts` therefore scans the
 * lines itself, and this sheet paints the classes it produces from the theme's
 * own `--dsw-alias-*` tokens, which is where every code surface in the product
 * reads its colours from.
 *
 * ONE ROW MODEL. A read window is a list of line records, and every part of this
 * card — markers, code, fold — is derived from that one list. The marker column
 * and the code column cannot disagree about which row is which, because they are
 * two renderings of the same slice.
 *
 * @module dsh-hashline-edittool-client/read-card
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { TAB_STRIP_COPY_CLASS, TabStrip } from "./tab-strip.js";
import { TOKEN_CLASS, grammarFor, grammarForPath, tokenizeLines } from "./highlight.js";
import type { Token } from "./highlight.js";
import { foldWindow, markerColumnCh, readCardMeta } from "./read-meta.js";
import type { ReadCardLabels } from "./labels.js";
import type { ReadCardModel } from "./types.js";

const CSS_TEXT = [
	// The frame: the diff and diagnostics cards' own declarations, so the cards
	// cannot drift apart.
	".dshl-read{--dsl-read-radius:12px;--dsl-read-line-height:22px;position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsl-read-radius)}",
	// PER-ROW (issue 131 field report): one flex row per drawn line — anchor cell +
	// code cell in DOM order, so a drag is an ordinary continuous text selection.
	// The old two-block layout let a drag from the anchor column swallow the
	// whole column.
	".dshl-read-body{padding:12px 0;overflow-x:auto;overflow-y:hidden;font:var(--dsw-font-markdown-code-block)}",
	".dshl-read-row{display:flex}",
	// The anchor cell width comes from `--dshl-read-gutter-w` (set inline on the
	// body, in `ch` of the font declared HERE — `ch` measures this element's own
	// font). The LEFT padding is the card's own inset; the RIGHT padding is the
	// gap to the code. The marker cell is SELECTABLE, deliberately: a reader who
	// drags into it wants the `行号:锚点`. (It was `user-select: none` — that is a
	// hit-testing hint, not a filter, so it silently took the anchors away from
	// every copy that started in the code.)
	".dshl-read-gutter{flex:0 0 auto;box-sizing:content-box;width:var(--dshl-read-gutter-w);padding:0 14px;text-align:right;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
	".dshl-read-marker,.dshl-read-gap{display:block;height:var(--dsl-read-line-height);line-height:var(--dsl-read-line-height);white-space:nowrap;overflow:hidden}",
	".dshl-read-line{min-height:var(--dsl-read-line-height);line-height:var(--dsl-read-line-height);white-space:pre}",
	// The fold is ours: one row of the code column, drawn only when the window is
	// capped, in the same place the shipped card put its own.
	".dshl-read-fold{flex:1 1 auto;display:block;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-markdown-code-block);text-align:left}",
	".dshl-read-fold:hover{color:var(--dsw-alias-label-secondary)}",
	".dshl-read-footer{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
	".dshl-read-meta{display:flex;gap:12px}",
	// Syntax classes. Every colour is a theme token, so both themes are honoured
	// without a second sheet — the token sheet is the palette, not this file.
	".dshl-hl-comment{color:var(--dsw-alias-label-tertiary);font-style:italic}",
	".dshl-hl-string{color:var(--dsw-alias-state-success-primary)}",
	".dshl-hl-number{color:var(--dsw-alias-state-warn-primary)}",
	".dshl-hl-keyword{color:var(--dsw-alias-state-business-primary)}",
	".dshl-hl-literal{color:var(--dsw-alias-state-business-primary)}",
	".dshl-hl-type{color:var(--dsw-alias-brand-primary)}",
	".dshl-hl-function{color:var(--dsw-alias-state-error-primary)}",
	".dshl-hl-tag{color:var(--dsw-alias-state-error-primary)}",
	".dshl-hl-property{color:var(--dsw-alias-label-secondary)}",
	".dshl-hl-punctuation{color:var(--dsw-alias-label-secondary)}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/read-card.css";

/** Install the read sheet once (same tagged style-tag contract as ToolRow). */
function ensureReadStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

export interface ReadCardProps {
	model: ReadCardModel;
	labels: ReadCardLabels;
	className?: string | undefined;
}

/** One code line, painted from the tokens the scanner produced. */
function lineNodes(tokens: readonly Token[], key: string): ReactNode {
	return jsx_("div", {
		className: "dshl-read-line",
		key,
		children: jsx_("span", {
			children:
				tokens.length === 0
					? " "
					: tokens.map((token, index) =>
							jsx_("span", { className: TOKEN_CLASS[token.kind], key: index, children: token.text }),
						),
		}),
	});
}

/** The row cap, matching the window this card has always drawn. */
const MAX_LINES = 8;

/**
 * Draw the hashline read card.
 * @param props - the card model and its localized chrome.
 * @returns the card element.
 */
export function ReadCard({ model, labels, className }: ReadCardProps): ReactNode {
	ensureReadStyles();

	const baseId = useId();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const rows = model.rows;
	const lines = useMemo(() => rows.map((row) => row.text), [rows]);
	// The hint is `meta.lang` when the tool set one, and the extension otherwise:
	// the card owns a path either way, so a meta without `lang` still colours.
	const grammar = useMemo(() => grammarFor(model.lang) ?? grammarForPath(model.path), [model.lang, model.path]);
	const painted = useMemo(() => tokenizeLines(lines, grammar), [lines, grammar]);

	// The window the card draws: head half, a fold, tail half — two renderings of
	// one slice, which is why the columns cannot disagree.
	const view = foldWindow(rows.length, MAX_LINES, expanded);
	const hidden = view.hidden;
	const head = view.head.map((index) => ({ row: rows[index], tokens: painted[index] ?? [] }));
	const tail = view.tail.map((index) => ({ row: rows[index], tokens: painted[index] ?? [] }));

	const onToggle = useCallback(() => setExpanded((value) => !value), []);
	const onCopy = useCallback(() => {
		if (copied) return;
		void writeClipboard(lines.join("\n")).then((ok) => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1000);
		});
	}, [copied, lines]);

	const panelId = `${baseId}-panel`;
	const meta = readCardMeta(model, labels);
	// The column sizes itself to the markers this window actually draws.
	const gutterCh = markerColumnCh([...head, ...tail].map(({ row }) => row.gutter));

	return jsx_("div", {
		className: `dshl-read ${className ?? ""}`.trim(),
		"data-read-card": "",
		children: [
			jsx_(TabStrip, {
				paths: [model.label],
				activeIndex: 0,
				onSelect: () => undefined,
				labels: { tablist: labels.tablist, more: labels.more },
				panelId,
				idPrefix: baseId,
				copy: jsx_("button", {
					type: "button",
					className: TAB_STRIP_COPY_CLASS,
					onClick: onCopy,
					children: copied ? labels.copied : labels.copy,
				}),
			}),
			jsx_("div", {
				id: panelId,
				role: "tabpanel",
				"aria-labelledby": `${baseId}-tab-0`,
				className: "dshl-read-body",
				style: { "--dshl-read-gutter-w": `${gutterCh}ch` } as never,
				// PER-ROW (issue 131 field report): one flex row per drawn line — anchor cell
				// + code cell in DOM order, so a drag is an ordinary continuous text
				// selection: the rows you drag across, anchors and lines together.
				children: [
					...head.map(({ row, tokens }) =>
						jsx_("div", {
							className: "dshl-read-row",
							key: `h${row.number}`,
							children: [
								jsx_("span", { className: "dshl-read-gutter", "aria-hidden": true, children: row.gutter }),
								lineNodes(tokens, `h${row.number}`),
							],
						}),
					),
					hidden > 0 && !expanded
						? jsx_("div", {
								className: "dshl-read-row",
								key: "fold-row",
								children: jsx_("button", {
									type: "button",
									className: "dshl-read-fold",
									"aria-expanded": expanded,
									"aria-label": expanded ? labels.collapseAria : labels.expandAria(hidden),
									onClick: onToggle,
									children: expanded ? labels.collapse : labels.expand(hidden),
								}),
						})
						: null,
					...tail.map(({ row, tokens }) =>
						jsx_("div", {
							className: "dshl-read-row",
							key: `t${row.number}`,
							children: [
								jsx_("span", { className: "dshl-read-gutter", "aria-hidden": true, children: row.gutter }),
								lineNodes(tokens, `t${row.number}`),
							],
						}),
					),
				],
			}),
			meta.length > 0
				? jsx_("div", {
						className: "dshl-read-footer",
						children: jsx_("span", {
							className: "dshl-read-meta",
							children: meta.map((part, index) => jsx_("span", { key: index, children: part })),
						}),
					})
				: null,
		],
	});
}
