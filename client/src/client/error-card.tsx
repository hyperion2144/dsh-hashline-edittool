/**
 * The error card (map #137 / spec #146): a failed call drawn as structured
 * facts instead of raw I/O — the code as a red chip, the message, the echo
 * context in a monospace block folded at the grep card's cap, and the hint
 * line. The model is a pure projection of the persisted `meta.error` (or the
 * legacy `block.content` synthesis); the text is never re-parsed here.
 */
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { css } from "./css.js";
import type { ErrorCardModel } from "./types.js";

/** The context block folds at the same cap the grep card folds its rows. */
const CONTEXT_MAX_LINES = 16;

/**
 * One structured failure, whole. `role="alert"` so a screen reader announces
 * the failure the folded row only dots.
 */
export function ErrorCard({ model, className }: { model: ErrorCardModel; className?: string }): ReactNode {
	const contextLines = model.context === undefined ? [] : model.context.split("\n");
	const overflow = contextLines.length - CONTEXT_MAX_LINES;
	const visible = overflow > 0 ? contextLines.slice(0, CONTEXT_MAX_LINES) : contextLines;
	return jsx_("div", {
		className: className === undefined ? css.errorCard : `${css.errorCard} ${className}`,
		role: "alert",
		children: [
			jsx_("div", {
				className: css.errorHead,
				children: [
					jsx_("span", { className: css.errorDot, "aria-hidden": true }),
					jsx_("code", { className: css.errorCode, children: model.code }),
					model.path !== undefined ? jsx_("span", { className: css.errorPath, children: model.path }) : null,
				],
			}),
			jsx_("div", { className: css.errorCardMessage, children: model.message }),
			model.context !== undefined
				? jsx_("pre", {
						className: css.errorContext,
						children:
							visible.join("\n") + (overflow > 0 ? `\n… +${overflow} more line(s)` : ""),
					})
				: null,
			model.hint !== undefined
				? jsx_("div", {
						className: css.errorHint,
						children: [
							jsx_("span", { className: css.errorHintLabel, children: "Hint:" }),
							model.hint,
						],
					})
				: null,
		],
	});
}
