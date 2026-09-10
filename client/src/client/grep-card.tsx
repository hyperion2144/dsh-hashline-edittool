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

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { IconEllipsisOutline16, Menu, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import type { GrepCardModel, GrepRowMeta } from "./types.js";
import { foldTabs, grepGutterLabel, highlightSegments } from "./models.js";
import type { GrepCardLabels } from "./labels.js";

const CSS_TEXT = [
	".dshl-grep-block{--dsl-grep-line-height:22px;position:relative;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:12px}",
	// Tab bar + copy share one row. The strip never scrolls sideways: the tabs
	// that do not fit are folded into the overflow menu by the component.
	".dshl-grep-head{display:flex;align-items:flex-end;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
	".dshl-grep-tabs{display:flex;flex:1 1 auto;min-width:0;overflow:hidden}",
	".dshl-grep-tab{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);border-bottom:2px solid transparent;margin-bottom:-1px}",
	".dshl-grep-tab:hover{color:var(--dsw-alias-label-primary)}",
	".dshl-grep-tab:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
	".dshl-grep-tabActive{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-info-primary)}",
	".dshl-grep-copyButton{flex:none;background-color:transparent;border:none;padding:0 12px 6px;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13)}",
	".dshl-grep-moreButton{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-bottom:2px}",
	".dshl-grep-moreButton:hover{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}",
	".dshl-grep-moreButton:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
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

/**
 * Width the overflow trigger occupies on the tab strip's row, gap included
 * (28px button + the head's 8px gap). The fold reserves it only once the strip
 * genuinely overflows.
 */
const TAB_OVERFLOW_RESERVE = 36;

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
	moreButton: "dshl-grep-moreButton",
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

	// --- tab strip folding ---------------------------------------------------
	// The strip keeps its width instead of scrolling: unmeasured tabs render
	// once so their natural widths can be read (they are `flex:none`, so an
	// overflowing strip still reports every width), then the fold decides which
	// tabs stay and which move into the overflow menu.
	const widthsRef = useRef(new Map<string, number>());
	const tabsRef = useRef<HTMLDivElement | null>(null);
	const [stripWidth, setStripWidth] = useState(0);
	const [, bumpWidths] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);

	const widths = files.map((file) => widthsRef.current.get(file.path) ?? 0);
	const measured = widths.every((width) => width > 0);
	const fold = measured
		? foldTabs(widths, stripWidth, TAB_OVERFLOW_RESERVE, activeIndex)
		: { visible: files.map((_, index) => index), folded: [] as number[] };
	const rendered = fold.visible;


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

	// Track the strip's usable width (`clientWidth` excludes its own padding).
	useLayoutEffect(() => {
		const element = tabsRef.current;
		if (element === null) return;
		setStripWidth(element.clientWidth);
	});
	useEffect(() => {
		const element = tabsRef.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setStripWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	});

	// Read every tab's natural width while they are all mounted. Only the
	// unmounted (already-folded) case is skipped: `measured` stays true from the
	// cached widths, so the strip settles after one measuring pass.
	useLayoutEffect(() => {
		if (measured) return;
		const element = tabsRef.current;
		if (element === null) return;
		let changed = false;
		for (const node of Array.from(element.querySelectorAll<HTMLElement>("[data-tab-index]"))) {
			const index = Number(node.dataset.tabIndex);
			const file = files[index];
			if (file === undefined) continue;
			const width = node.offsetWidth;
			if (width > 0 && widthsRef.current.get(file.path) !== width) {
				widthsRef.current.set(file.path, width);
				changed = true;
			}
		}
		if (changed) bumpWidths((value) => value + 1);
	});

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
					// single-file branch — only fewer buttons. Tabs that do not fit
					// are not scrolled to: they move into the overflow menu.
					jsx_("div", {
						className: css.tabs,
						role: "tablist",
						"aria-label": labels.tablist,
						ref: tabsRef,
						onKeyDown,
						children: rendered.map((index) => {
							const file = files[index]!;
							return jsx_("button", {
								key: file.path,
								id: tabId(index),
								type: "button",
								role: "tab",
								"data-tab-index": index,
								title: file.path,
								className: `${css.tab} ${index === activeIndex ? css.tabActive : ""}`.trim(),
								"aria-selected": index === activeIndex,
								"aria-controls": panelId,
								tabIndex: index === activeIndex ? 0 : -1,
								onClick: () => onSelect(index),
								children: file.path,
							});
						}),
					}),
					// Overflow: the tabs that did not fit, listed in a portal menu so the
					// card's own clipping never crops it.
					...(fold.folded.length > 0
						? [
								jsx_(Menu, {
									key: "overflow",
									open: menuOpen,
									onClose: () => setMenuOpen(false),
									portal: true,
									align: "end",
									items: fold.folded.map((index) => ({
										id: String(index),
										label: files[index]!.path,
									})),
									onSelect: (id: string) => {
										setMenuOpen(false);
										onSelect(Number(id));
									},
									anchor: jsx_("button", {
										type: "button",
										className: css.moreButton,
										"aria-haspopup": "menu",
										"aria-expanded": menuOpen,
										"aria-label": labels.more,
										title: labels.more,
										onClick: () => setMenuOpen((value) => !value),
										children: jsx_(IconEllipsisOutline16, { size: 14 }),
									}),
								}),
							]
						: []),
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
