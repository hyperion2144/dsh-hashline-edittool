/**
 * The `lsp` diagnostics card body.
 *
 * Two kinds of text sit on one row and they must not read alike: the SOURCE LINE
 * is the file (and the thing an anchor addresses), while each DIAGNOSTIC is a
 * server's opinion of that file. Keeping them in separate fields is what lets
 * this drawer give them separate weights — the line in the code face at normal
 * weight, its diagnostics indented under it inside a red rule, one per line.
 *
 * Derived from the persisted meta, never from the model-facing text: the card is
 * a projection of facts (`@module dsh-hashline-edittool-client`, ADR-0005), and
 * parsing `↳` lines back out of the prose would put two renderers on one answer.
 *
 * @module dsh-hashline-edittool-client/lsp-card
 */
import type { ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { css } from "./css.js";
import type { LspCardModel } from "./types.js";

/**
 * Draw the diagnostics rows.
 *
 * @param props - the card model and the maximum number of ROWS to draw.
 * @returns the card body.
 */
export function LspCard({ model, maxLines }: { readonly model: LspCardModel; readonly maxLines: number }): ReactNode {
	const shown = model.rows.slice(0, maxLines);
	const hidden = model.rows.length - shown.length;
	return jsx_("div", {
		className: css.lspBody,
		children: [
			...shown.flatMap((row) => {
				const children: ReactNode[] = [
					jsx_("div", {
						className: css.lspRow,
						children: [
							// The gutter cell is the anchor marker, drawn verbatim — the same
							// `<anchor>:<line>` a read shows, so the row is directly editable.
							jsx_("span", { className: css.lspGutter, children: `${row.hash}:${row.number}` }),
							jsx_("span", { className: css.lspSrc, children: row.text === "" ? " " : row.text }),
						],
					}),
				];
				if (row.messages.length > 0) {
					children.push(
						jsx_("div", {
							className: css.lspDiags,
							children: row.messages.map((message, index) =>
								jsx_("div", { className: css.lspDiag, children: message, key: `${row.number}-${index}` }),
							),
						}),
					);
				}
				return children;
			}),
			hidden > 0
				? jsx_("div", { className: css.lspMore, children: `… ${hidden} more line(s)` })
				: null,
		],
	});
}
