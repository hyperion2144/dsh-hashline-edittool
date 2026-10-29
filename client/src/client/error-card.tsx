/**
 * The error card (map #137 / spec #146): a failed call drawn as structured
 * facts instead of raw I/O — the code as a red chip, the message, the echo
 * context in a monospace block folded at the grep card's cap, and the hint
 * line. The model is a pure projection of the persisted `meta.error` (or the
 * legacy `block.content` synthesis); the text is never re-parsed here.
 */
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { css } from "./css.js";
import type { ErrorCardModel } from "./types.js";
import type { ErrorCardLabels } from "./labels.js";
import { DEFAULT_WRAP_STATE, nextWrapState, wrapStateProps } from "./wrap.js";
import type { WrapState } from "./wrap.js";
import { WrapToggleButton } from "./wrap-button.js";

/** The context block folds at the same cap the grep card folds its rows. */
const CONTEXT_MAX_LINES = 16;

/**
 * One structured failure, whole. `role="alert"` so a screen reader announces
 * the failure the folded row only dots — `announce: false` drops the role for
 * the multi-file partial-failure card (#247), whose failure BANNER already owns
 * the one alert: a tab switch must not re-announce the same failure.
 */
export function ErrorCard({ model, labels, className, announce = true }: { model: ErrorCardModel; labels: ErrorCardLabels; className?: string; announce?: boolean }): ReactNode {
	// The wrap switch (#373): the error card's own state, never persisted. It
	// only exists when the card HAS a context block to fold.
	const [wrap, setWrap] = useState<WrapState>(DEFAULT_WRAP_STATE);
	const onToggleWrap = useCallback(() => setWrap((value) => nextWrapState(value)), []);
	const contextLines = model.context === undefined ? [] : model.context.split("\n");
	const overflow = contextLines.length - CONTEXT_MAX_LINES;
	const visible = overflow > 0 ? contextLines.slice(0, CONTEXT_MAX_LINES) : contextLines;
	return jsx_("div", {
		className: className === undefined ? css.errorCard : `${css.errorCard} ${className}`,
		...(announce ? { role: "alert" } : {}),
		children: [
			jsx_("div", {
				className: css.errorHead,
				children: [
					jsx_("span", { className: css.errorDot, "aria-hidden": true }),
					jsx_("code", { className: css.errorCode, children: model.code }),
					model.path !== undefined ? jsx_("span", { className: css.errorPath, children: model.path }) : null,
					// The wrap switch (#373). The error card has no tab strip, so the
					// button rides the head row itself — and only when there IS a
					// context block to fold.
					model.context !== undefined
						? jsx_(WrapToggleButton, {
								state: wrap,
								onToggle: onToggleWrap,
								label: labels.wrapToggle,
								className: css.errorWrap,
							})
						: null,
				],
			}),
			jsx_("div", { className: css.errorCardMessage, children: model.message }),
			model.context !== undefined
				? jsx_("pre", {
						className: css.errorContext,
						...wrapStateProps(wrap),
						children:
							visible.join("\n") + (overflow > 0 ? `\n${labels.moreLines(overflow)}` : ""),
					})
				: null,
			model.hint !== undefined
				? jsx_("div", {
						className: css.errorHint,
						children: [
							jsx_("span", { className: css.errorHintLabel, children: labels.hintLabel }),
							model.hint,
						],
					})
				: null,
		],
	});
}
