/**
 * The shared file tab strip: one tab per file, tabs that do not fit folded into
 * an overflow menu instead of scrolling or wrapping (issue #96).
 *
 * Extracted from the grep card (issue #92), which proved the behaviour; the diff
 * cards (edit / write) now share the SAME strip, so the two families cannot drift
 * apart again. What stays per-card is only what is genuinely different: the row
 * rendering inside the body (grep rows carry highlight spans, diff rows carry a
 * `+`/`-` marker and colour) and the footer wording.
 *
 * The strip is CONTROLLED: the owning card owns the active index (it also
 * decides which rows to render) and passes it in. The strip owns everything
 * about the strip itself — measuring, folding, the overflow trigger and menu,
 * keyboard switching and the aria wiring.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { IconEllipsisOutline16, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import { foldTabs } from "./models.js";

/**
 * Width the overflow trigger occupies on the strip's row, gap included
 * (28px button + the head's 8px gap). The fold reserves it only once the strip
 * genuinely overflows.
 */
export const TAB_OVERFLOW_RESERVE = 36;

const CSS_TEXT = [
	// Head row: the strip takes the width, the trailing slot (copy) never shrinks.
	".dshl-tabstrip-head{display:flex;align-items:flex-end;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
	".dshl-tabstrip{display:flex;flex:1 1 auto;min-width:0;overflow:hidden}",
	".dshl-tabstrip-tab{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);border-bottom:2px solid transparent;margin-bottom:-1px}",
	".dshl-tabstrip-tab:hover{color:var(--dsw-alias-label-primary)}",
	".dshl-tabstrip-tab:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
	".dshl-tabstrip-tabActive{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-info-primary)}",
	".dshl-tabstrip-more{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-bottom:2px}",
	".dshl-tabstrip-more:hover{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}",
	".dshl-tabstrip-more:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
	".dshl-tabstrip-copy{flex:none;background-color:transparent;border:none;padding:0 12px 6px;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13)}",
	".dshl-tabstrip-copy:hover{color:var(--dsw-alias-label-primary)}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/tab-strip.css";

/** Install the shared strip sheet once (same tagged style-tag contract as ToolRow). */
export function ensureTabStripStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

const css = {
	head: "dshl-tabstrip-head",
	strip: "dshl-tabstrip",
	tab: "dshl-tabstrip-tab",
	tabActive: "dshl-tabstrip-tabActive",
	more: "dshl-tabstrip-more",
	copy: "dshl-tabstrip-copy",
} as const;

/**
 * Class a card puts on its own copy button so it sits in the strip's head row.
 * Exported as a class (not a component) because the copy behaviour — which text,
 * and the `copied` flash — belongs to the card that owns the rows.
 */
export const TAB_STRIP_COPY_CLASS = css.copy;

/** Localized chrome the strip needs (both keys already exist in the locale). */
export interface TabStripLabels {
	/** Accessible name of the tab list (the owning tool's title). */
	tablist: string;
	/** Accessible name of the overflow trigger (`common.more`). */
	more: string;
}

export interface TabStripProps {
	/** One tab per file, in display order; labels are these paths. */
	paths: readonly string[];
	/** Index of the tab being shown (owned by the card). */
	activeIndex: number;
	/** Tab selection; the card switches its body and resets its own state. */
	onSelect: (index: number) => void;
	labels: TabStripLabels;
	/** Id of the body element the tabs control (`aria-controls`). */
	panelId: string;
	/**
	 * Id prefix for the tab ids. Pass the card's own id so the body can point
	 * `aria-labelledby` at the active tab; the strip generates one when omitted.
	 */
	idPrefix?: string | undefined;
	/**
	 * Copy button, rendered raw at the trailing end of the head row — pass a
	 * `<button className={TAB_STRIP_COPY_CLASS}>` so it picks up the row styling.
	 */
	copy?: ReactNode;
}

/**
 * Render the head row: the file tabs (folded to the available width) plus an
 * optional trailing copy button.
 * @param props - see {@link TabStripProps}.
 * @returns the head row element.
 */
export function TabStrip({
	paths,
	activeIndex,
	onSelect,
	labels,
	panelId,
	idPrefix,
	copy,
}: TabStripProps): ReactNode {
	ensureTabStripStyles();

	const generatedId = useId();
	const baseId = idPrefix ?? generatedId;
	const widthsRef = useRef(new Map<string, number>());
	const stripRef = useRef<HTMLDivElement | null>(null);
	const [stripWidth, setStripWidth] = useState(0);
	const [, bumpWidths] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);

	// The strip keeps its width instead of scrolling: unmeasured tabs render once
	// so their natural widths can be read (they are `flex:none`, so an overflowing
	// strip still reports every width), then the fold decides which tabs stay and
	// which move into the overflow menu.
	const widths = paths.map((path) => widthsRef.current.get(path) ?? 0);
	const measured = widths.every((width) => width > 0);
	const fold = measured
		? foldTabs(widths, stripWidth, TAB_OVERFLOW_RESERVE, activeIndex)
		: { visible: paths.map((_, index) => index), folded: [] as number[] };

	// Track the strip's usable width (`clientWidth` excludes its own padding).
	useLayoutEffect(() => {
		const element = stripRef.current;
		if (element === null) return;
		setStripWidth(element.clientWidth);
	});
	useEffect(() => {
		const element = stripRef.current;
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
		const element = stripRef.current;
		if (element === null) return;
		let changed = false;
		for (const node of Array.from(element.querySelectorAll<HTMLElement>("[data-tab-index]"))) {
			const index = Number(node.dataset.tabIndex);
			const path = paths[index];
			if (path === undefined) continue;
			const width = node.offsetWidth;
			if (width > 0 && widthsRef.current.get(path) !== width) {
				widthsRef.current.set(path, width);
				changed = true;
			}
		}
		if (changed) bumpWidths((value) => value + 1);
	});

	const onSelectIndex = useCallback(
		(index: number) => {
			setMenuOpen(false);
			onSelect(index);
		},
		[onSelect],
	);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent) => {
			if (paths.length < 2) return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			const step = event.key === "ArrowRight" ? 1 : -1;
			// Arrow keys walk EVERY file, folded ones included: selecting a folded
			// tab pins it back into the visible run.
			onSelectIndex((activeIndex + step + paths.length) % paths.length);
		},
		[activeIndex, onSelectIndex, paths.length],
	);

	const tabId = (index: number) => `${baseId}-tab-${index}`;

	return jsx_("div", {
		className: css.head,
		children: [
			// A single-file card keeps its one tab: there is no single-file branch,
			// only fewer buttons.
			jsx_("div", {
				className: css.strip,
				role: "tablist",
				"aria-label": labels.tablist,
				ref: stripRef,
				onKeyDown,
				children: fold.visible.map((index) => {
					const path = paths[index]!;
					return jsx_("button", {
						key: path,
						id: tabId(index),
						type: "button",
						role: "tab",
						"data-tab-index": index,
						title: path,
						className: `${css.tab} ${index === activeIndex ? css.tabActive : ""}`.trim(),
						"aria-selected": index === activeIndex,
						"aria-controls": panelId,
						tabIndex: index === activeIndex ? 0 : -1,
						onClick: () => onSelectIndex(index),
						children: path,
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
							items: fold.folded.map((index) => ({ id: String(index), label: paths[index]! })),
							onSelect: (id: string) => onSelectIndex(Number(id)),
							anchor: jsx_("button", {
								type: "button",
								className: css.more,
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
			copy ?? null,
		].filter((node) => node !== null),
	});
}
