/**
 * The `lsp` diagnostics card body — OURS, the way the diff card is ours.
 *
 * Two kinds of text share a row and must not read alike: the SOURCE LINE is the
 * file (and the thing an anchor addresses), while each DIAGNOSTIC is a server's
 * opinion of that file. The read primitive draws body lines from plain strings,
 * so it cannot give the two different weights — and replacing its body outright
 * was worse: the frame and the copy button belong to IT, and the card came back
 * chrome-less.
 *
 * This is the third option, the one the diff card already took: a vendored
 * component with its own stylesheet and its own head row (the shared `TabStrip`,
 * which is where the file identity and the copy button live). Styling follows the
 * diff card's own declarations so the two cards cannot drift apart.
 *
 * Rendering data comes ONLY from the structured meta (`messages` beside the
 * line), never from the model-facing `↳` prose.
 *
 * @module dsh-hashline-edittool-client/lsp-block
 */
import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { TAB_STRIP_COPY_CLASS, TabStrip } from "./tab-strip.js";
import type { TabStripLabels } from "./tab-strip.js";
import { markerColumnCh } from "./read-meta.js";
import type { LspCardModel, LspRowMeta } from "./types.js";

const CSS_TEXT = [
	// Same frame as the diff card: one card look across the plugin.
	".dshl-lsp-block{--dsl-lsp-radius:12px;position:relative;margin:16px 0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsl-lsp-radius)}",
	// PER-ROW (#131 field report): one flex row per drawn line — anchor cell +
	// content cell (source line + its diagnostics block) in DOM order, so a drag
	// is an ordinary continuous text selection.
	".dshl-lsp-body{padding:8px 14px 12px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden}",
	".dshl-lsp-row{display:flex;align-items:flex-start}",
	".dshl-lsp-line{display:flex;min-height:22px;white-space:pre}",
	// The anchor cell: width via `--dshl-gutter-w` (set inline on the body, in `ch`
	// of the font declared HERE — `ch` measures this element's own font),
	// right-aligned with a right inset so the source is not glued to the marker.
	// Selectable on purpose (see the read card).
	".dshl-lsp-gutter{flex:0 0 auto;box-sizing:content-box;width:var(--dshl-gutter-w);padding:0 14px 0 0;text-align:right;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
	".dshl-lsp-code{flex:0 0 auto}",
	".dshl-lsp-src{white-space:pre}",
	// The diagnostics: indented under their line, behind a red rule, ONE ROW EACH —
	// 22px per diagnostic, with no vertical margin or padding of its own, because the
	// marker column counts these rows: any extra height here is a drift between the
	// markers and the lines they belong to.
	".dshl-lsp-diags{margin:0 0 0 26px;padding:0 0 0 10px;border-left:2px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}",
	".dshl-lsp-diag{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;min-height:22px;line-height:22px}",
	".dshl-lsp-expand{display:block;width:100%;padding:0;border:none;background-color:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left}",
	".dshl-lsp-expand:hover{color:var(--dsw-alias-label-secondary)}",
	".dshl-lsp-footer{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary)}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/lsp-block.css";

/** Install the diagnostics sheet once (same tagged style-tag contract). */
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
	block: "dshl-lsp-block",
	body: "dshl-lsp-body",
	row: "dshl-lsp-row",
	line: "dshl-lsp-line",
	gutter: "dshl-lsp-gutter",
	gutterLine: "dshl-lsp-gutter-line",
	code: "dshl-lsp-code",
	src: "dshl-lsp-src",
	diags: "dshl-lsp-diags",
	diag: "dshl-lsp-diag",
	expand: "dshl-lsp-expand",
	footer: "dshl-lsp-footer",
} as const;

/** Localized chrome for the diagnostics card. */
export interface LspBlockLabels extends TabStripLabels {
	/** Accessible name of the copy button. */
	copy: string;
	/** Announced while the copy flash is showing. */
	copied: string;
	/** `N line(s) with diagnostics` — the footer's count. */
	summary: (lines: number, messages: number) => string;
	collapse: string;
	expand: (hidden: number) => string;
	collapseAria: string;
	expandAria: (hidden: number) => string;
}

export interface LspDiagBlockProps {
	model: LspCardModel;
	labels: LspBlockLabels;
	maxLines: number;
}

/**
 * Draw the diagnostics card.
 *
 * @param props - the card model, its labels, and the row cap before folding.
 * @returns the card element.
 */
export function LspDiagBlock({ model, labels, maxLines }: LspDiagBlockProps): ReactNode {
	ensureStyles();
	const panelId = useId();
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const rows = model.rows;
	const hidden = rows.length - maxLines;
	const capped = hidden > 0 && !expanded;
	const headLines = Math.ceil(maxLines / 2);
	const tailLines = maxLines - headLines;
	const shown = useMemo(() => {
		if (!capped) return rows;
		return [...rows.slice(0, headLines), null, ...rows.slice(rows.length - tailLines)];
	}, [capped, headLines, rows, tailLines]);

	// PER-ROW: the anchor cell travels WITH its row — no cross-row alignment to
	// maintain, so the old markerLines placeholder scheme is gone. The width is
	// still shared across the card via `--dshl-gutter-w`.
	const gutterWidth = markerColumnCh(rows.map((row) => markerOf(row)));
	const messageCount = rows.reduce((total, row) => total + row.messages.length, 0);

	const onCopy = useCallback(() => {
		if (copied) return;
		void writeClipboard(copyText(rows)).then((ok) => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1000);
		});
	}, [copied, rows]);

	return jsx_("div", {
		className: css.block,
		children: [
			// The strip is the block's FIRST CHILD, exactly as the diff card mounts it:
			// it owns the head row, its tab list is `flex:1`, and that is what pins the
			// copy button to the trailing corner. A wrapper of our own made the strip a
			// shrunk flex item, and the button sat right after the last tab instead.
			jsx_(TabStrip, {
				paths: [model.path],
				activeIndex: 0,
				onSelect: () => undefined,
				labels: labels,
				panelId,
				copy: jsx_("button", {
					type: "button",
					className: TAB_STRIP_COPY_CLASS,
					onClick: onCopy,
					"aria-label": labels.copy,
					children: copied ? labels.copied : labels.copy,
				}),
			}),
			jsx_("div", {
				id: panelId,
				className: css.body,
				style: { "--dshl-gutter-w": `${gutterWidth}ch` } as never,
				children: [
					// PER-ROW (#131 field feedback): one flex row per drawn line — anchor
					// cell + content cell (source line and its diagnostics block) in DOM
					// order, so a drag is an ordinary continuous text selection. The
					// expand/collapse buttons span their full row.
						...shown.map((row, index) => {
							if (row === null) {
								return jsx_("button", {
									type: "button",
									className: css.expand,
									key: `gap-${index}`,
									"aria-expanded": false,
									"aria-label": labels.expandAria(hidden),
									onClick: () => setExpanded(true),
									children: `${labels.expand(hidden)}`,
								});
							}
							return jsx_("div", {
								key: `row-${row.number}-${index}`,
								className: css.row,
								children: [
									jsx_("div", { className: css.gutter, "aria-hidden": true, children: markerOf(row) }),
									jsx_("div", { className: css.code, children: rowNodes(row) }),
								],
							});
						}),
						expanded && hidden > 0
							? jsx_("button", {
									type: "button",
									className: css.expand,
									"aria-expanded": true,
									"aria-label": labels.collapseAria,
									onClick: () => setExpanded(false),
									children: labels.collapse,
								})
							: null,
					jsx_("div", { className: css.footer, children: labels.summary(rows.length, messageCount) }),
				],
			}),
		],
	});
}

/** The marker a row's gutter shows: `<line>:<anchor>`, the edit address. */
function markerOf(row: LspRowMeta): string {
	return row.hash !== "" ? `${row.number}:${row.hash}` : `${row.number}`;
}

/** One source line, then its diagnostics indented under it — the markers live in
 * the gutter column, not here. */
function rowNodes(row: LspRowMeta): ReactNode[] {
	const out: ReactNode[] = [
		jsx_("div", {
			className: css.line,
			children: jsx_("span", { className: css.src, children: row.text === "" ? " " : row.text }),
		}),
	];
	if (row.messages.length > 0) {
		out.push(
			jsx_("div", {
				className: css.diags,
				children: row.messages.map((message, index) =>
					jsx_("div", { className: css.diag, key: index, children: message }),
				),
			}),
		);
	}
	return out;
}

/**
 * What the reader copies: the rows as SHOWN — each source line followed by its
 * diagnostics, indented the way the card draws them, gutter excluded.
 *
 * Copying only the source lines was the first version, and it silently dropped
 * every message: the card shows two kinds of text, so its copy has to carry both
 * or the button lies about what is on screen.
 */
function copyText(rows: readonly LspRowMeta[]): string {
	return rows
		.flatMap((row) => [row.text, ...row.messages.map((message) => `   ↳ ${message}`)])
		.join("\n");
}
