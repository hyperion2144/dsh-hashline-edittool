/**
 * The hashline grep card body: a self-drawn card carrying a file tab strip, one
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
 * The tab strip itself is the SHARED `TabStrip` (issue #96) — the diff cards use
 * the same one, so the two card families cannot drift apart again.
 *
 * Data comes ONLY from the persisted structured meta — the model-facing text is
 * never parsed, and no matching runs here (the host computed the spans).
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { TAB_STRIP_COPY_CLASS, TabStrip } from "./tab-strip.js";
import type { GrepCardModel, GrepRowMeta } from "./types.js";
import { grepGutterLabel, highlightSegments } from "./models.js";
import type { GrepCardLabels } from "./labels.js";

const CSS_TEXT = [
	".dshl-grep-block{--dsl-grep-line-height:22px;position:relative;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:12px}",
	// The tab bar itself is the shared `TabStrip` (issue #96); only the body
	// chrome below belongs to this card.
	".dshl-grep-body{padding:12px 14px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden}",
	".dshl-grep-line{min-height:var(--dsl-grep-line-height);white-space:pre;display:flex}",
	".dshl-grep-gutter{flex:none;padding-right:14px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}",
	".dshl-grep-content{white-space:pre}",
	// The highlighter yellow is hard-coded because the theme has no yellow token
	// (its only warm family is amber, whose lightest tier reads as cream, not
	// yellow). The text colour is forced dark for the same reason the UA's own
	// `mark` pairing is overridden: dark-on-yellow stays readable in BOTH themes,
	// whereas an inherited (light, under the dark theme) text colour would not.
	".dshl-grep-mark{background-color:#ffe066;color:#1f1f1f;border-radius:2px}",
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

	const panelId = `${baseId}-panel`;

	return jsx_("div", {
		className: `${css.block} ${className ?? ""}`.trim(),
		"data-grep": "matches",
		children: [
			jsx_(TabStrip, {
				paths: files.map((file) => file.path),
				activeIndex,
				onSelect,
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
				className: css.body,
				id: panelId,
				role: "tabpanel",
				"aria-labelledby": `${baseId}-tab-${activeIndex}`,
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
