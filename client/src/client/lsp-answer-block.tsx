/**
 * The card body for an `lsp` answer that has no rows (#397 review).
 *
 * A hover, an action list and a raw `request` JSON share one frame because
 * they share one problem: the answer is TEXT, not this file's lines, so the
 * read card had nothing to draw and the row degraded to raw input/output. The
 * frame follows the diagnostics card (same surface, same rhythm), and the body
 * is the three shapes the model can carry — one component, one stylesheet, so
 * the three cannot drift apart.
 *
 * Rendering data comes ONLY from the structured meta.
 *
 * @module dsh-hashline-edittool-client/lsp-answer-block
 */
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import type { LspAnswerModel } from "./types.js";

const CSS_TAG_ID = "dsh-hashline-edittool-client/lsp-answer.css";

const CSS_TEXT = [
	// Same surface as the diagnostics card: one card look across the plugin.
	".dshl-lsp-answer{position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:12px}",
	// The answer's identity: which file it speaks about. Weak colour — the body
	// is the content, this is the label.
	".dshl-lsp-answer-head{padding:8px 14px 0;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary);word-break:break-all}",
	".dshl-lsp-answer-body{padding:8px 14px 12px;font:var(--dsw-font-markdown-code-block);overflow-x:auto}",
	// Hover contents arrive as markdown-ish prose with fenced code; wrapping is
	// what keeps a long type signature readable instead of a horizontal scroll.
	".dshl-lsp-answer-text{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}",
	".dshl-lsp-action{display:flex;align-items:baseline;gap:10px;min-height:22px;line-height:22px}",
	".dshl-lsp-action-title{white-space:pre-wrap}",
	".dshl-lsp-action-kind{color:var(--dsw-alias-label-tertiary)}",
	".dshl-lsp-answer-empty{color:var(--dsw-alias-label-secondary)}",
].join("\n");

/** Install the answer sheet once (same tagged style-tag contract as the other cards). */
function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

const css = {
	block: "dshl-lsp-answer",
	head: "dshl-lsp-answer-head",
	body: "dshl-lsp-answer-body",
	text: "dshl-lsp-answer-text",
	action: "dshl-lsp-action",
	actionTitle: "dshl-lsp-action-title",
	actionKind: "dshl-lsp-action-kind",
	empty: "dshl-lsp-answer-empty",
};

/** The labels this body needs, resolved in the reader's language. */
export interface LspAnswerLabels {
	/** What an empty action list says. */
	readonly noActions: string;
}

export interface LspAnswerBlockProps {
	readonly model: LspAnswerModel;
	readonly labels: LspAnswerLabels;
}

export function LspAnswerBlock({ model, labels }: LspAnswerBlockProps): ReactNode {
	ensureStyles();
	const head =
		model.path === undefined
			? null
			: jsx_("div", { className: css.head, children: jsx_("span", { children: model.path }) });
	if (model.kind === "actions") {
		return jsx_("div", {
			className: css.block,
			children: [
				head,
				jsx_("div", {
					className: css.body,
					children:
						model.actions.length === 0
							? jsx_("div", { className: css.empty, children: model.note ?? labels.noActions })
							: model.actions.map((action, index) =>
									jsx_("div", {
										key: `${index}:${action.title}`,
										className: css.action,
										children: [
											jsx_("span", { className: css.actionTitle, children: action.title }),
											action.kind === undefined
												? null
												: jsx_("span", { className: css.actionKind, children: action.kind }),
										],
									}),
								),
				}),
			],
		});
	}
	return jsx_("div", {
		className: css.block,
		children: [
			head,
			jsx_("div", {
				className: css.body,
				children: jsx_("pre", { className: css.text, children: model.text }),
			}),
		],
	});
}
