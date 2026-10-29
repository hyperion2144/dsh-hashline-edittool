/**
 * The wrap switch's button and its sheet (#373).
 *
 * ONE control, ONE sheet, FIVE card kinds. The read card, the search card, the diff
 * family (edit / write / undo / ast_edit / format), the diagnostics card and
 * the error card all draw code-ish text, and all five scroll sideways for a long
 * line. This module owns everything the switch changes:
 *
 *  - the button (the strip's own icon-button language: 28×28, a 14px glyph),
 *  - the two states' rules, and
 *  - the gutter pin that keeps the anchor column from folding.
 *
 * WHY ONE SHEET. Five card kinds with five copies of the same two rules is five
 * chances to spell "wrap" differently. Here the rules live once and name the
 * five bodies; a card that wants the switch says so by carrying the attribute,
 * and a card that does not simply never gets it.
 *
 * The STATE lives in the card (a `useState` per card, never persisted) and
 * travels to the stylesheet as one attribute — see {@link ./wrap.js}.
 *
 * @module dsh-hashline-edittool-client/wrap-button
 */
import { jsx as jsx_ } from "react/jsx-runtime";
import type { ReactNode } from "react";
import { IconNowrapFillMedium, IconWrapLinesOutlineMedium } from "@deepseek-ai/dsh-client-ui-primitives";
import { WRAP_BUTTON_CLASS, wrapButtonShape } from "./wrap.js";
import type { WrapState } from "./wrap.js";

const CSS_TEXT = [
	// The button: the tab strip's own icon-button language — 28×28, a 14px
	// glyph, chrome only on hover — so the switch does not read as a foreign
	// control next to the overflow trigger.
	".dshl-wrap-button{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-bottom:2px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
	".dshl-wrap-button:hover{color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-interactive-bg-hover)}",
	".dshl-wrap-button:focus-visible{outline:1px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
	// The glyph already says which way the switch is; the colour only says the
	// mode is live.
	".dshl-wrap-button[aria-pressed=true]{color:var(--dsw-alias-label-primary)}",
	//
	// WRAPPING ON (the default). The line folds inside the card and the card
	// stops scrolling sideways. One rule per card body, and the cards differ
	// only in the class their body wears.
	".dshl-read-body[data-wrap=on]{overflow-x:hidden}",
	".dshl-read-body[data-wrap=on] .dshl-read-line{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:break-word}",
	".dshl-grep-body[data-wrap=on]{overflow-x:hidden}",
	".dshl-grep-body[data-wrap=on] .dshl-grep-content{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:break-word}",
	".dshl-diff-body[data-wrap=on]{overflow-x:hidden}",
	".dshl-diff-body[data-wrap=on] .dshl-diff-content{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:break-word}",
	".dshl-lsp-body[data-wrap=on]{overflow-x:hidden}",
	// The diagnostics cell does not shrink on its own (`flex:0 0 auto`): the
	// source line and its messages have to be allowed to take the row's width
	// before they can fold.
	".dshl-lsp-body[data-wrap=on] .dshl-lsp-code{flex:1 1 auto;min-width:0}",
	".dshl-lsp-body[data-wrap=on] .dshl-lsp-src{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:break-word}",
	// The error card's echo block is its own `<pre>`: it carries the attribute
	// itself, because it is the only text the card folds.
	".dshl-errorContext[data-wrap=on]{overflow-x:hidden;white-space:pre-wrap;overflow-wrap:break-word}",
	// The auto-format section is part of the diff card, so its headers fold
	// with the diff rows — a clipped header would be worse than a folded one.
	".dshl-diff-body[data-wrap=on] .dshl-fmt-head{white-space:pre-wrap;overflow-wrap:break-word}",
	".dshl-diff-body[data-wrap=on] .dshl-fmt-loc{white-space:pre-wrap;overflow-wrap:break-word}",
	//
	// THE ANCHOR COLUMN NEVER FOLDS. It is a fixed-width cell, and a folded
	// marker would drift away from the line it addresses. The gutter keeps its
	// own `pre` in both states, whatever the code beside it does.
	".dshl-read-gutter,.dshl-grep-gutter,.dshl-diff-gutter-line,.dshl-lsp-gutter{white-space:pre}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/wrap.css";

/** Install the switch's sheet once (same tagged style-tag contract as ToolRow). */
export function ensureWrapStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

export interface WrapToggleButtonProps {
	/** The card's current state. */
	state: WrapState;
	/** Flip the state — the card owns it. */
	onToggle: () => void;
	/** The localized name of the control (also its tooltip). */
	label: string;
	/** An extra class the card adds for its own placement. */
	className?: string | undefined;
}

/**
 * Draw the wrap switch's button.
 *
 * The button is a toggle, so it announces the STATE it is in (`aria-pressed`)
 * rather than the action it offers — and the glyph is that state's own
 * picture, so a reader who never reads the tooltip still sees which way it is.
 *
 * @param props - the state, the flip, and the control's name.
 * @returns the button element.
 */
export function WrapToggleButton({
	state,
	onToggle,
	label,
	className,
}: WrapToggleButtonProps): ReactNode {
	ensureWrapStyles();
	const shape = wrapButtonShape(state);
	return jsx_("button", {
		type: "button",
		className: className === undefined ? WRAP_BUTTON_CLASS : `${WRAP_BUTTON_CLASS} ${className}`,
		"aria-pressed": shape.pressed,
		"aria-label": label,
		title: label,
		onClick: onToggle,
		children: jsx_(shape.icon === "wrap" ? IconWrapLinesOutlineMedium : IconNowrapFillMedium, {
			size: 14,
		}),
	});
}
