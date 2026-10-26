/**
 * The `rename` row: a small card of per-pair outcomes (renamed / failed) plus
 * what the store moved. It follows the family's chrome (`DisclosureRow` + the
 * shared body frame) so it reads like the other hashline tools, and the
 * structured `meta.rename` is projected by {@link renameCardModel} — the
 * component never parses model text.
 *
 * @module dsh-hashline-edittool-client/rename-card
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { DisclosureRow, IconEditOutlineMedium } from "@deepseek-ai/dsh-client-ui-primitives";
import { css } from "./css.js";
import { renameCardModel, errorCardModel } from "./models.js";
import { ErrorCard } from "./error-card.js";
import type { ToolViewProps } from "./types.js";

const rowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "minmax(0, 1fr) max-content",
	gap: "2px 12px",
	padding: "8px 14px",
	borderTop: "0.5px solid var(--dsw-alias-border-l2)",
};
const pairStyle: CSSProperties = {
	fontFamily: "var(--ds-font-family-code)",
	fontSize: "12px",
	color: "var(--dsw-alias-label-primary)",
	overflowWrap: "anywhere",
};
const arrowStyle: CSSProperties = {
	color: "var(--dsw-alias-label-tertiary)",
};
const statusStyle: CSSProperties = {
	fontSize: "12px",
	color: "var(--dsw-alias-label-secondary)",
	whiteSpace: "nowrap",
};
const failedStyle: CSSProperties = {
	...statusStyle,
	color: "var(--dsw-alias-state-error-primary)",
};
const detailStyle: CSSProperties = {
	gridColumn: "1 / -1",
	fontFamily: "var(--ds-font-family-code)",
	fontSize: "11px",
	color: "var(--dsw-alias-label-tertiary)",
	overflowWrap: "anywhere",
};

/**
 * Render the `rename` card.
 * @param props - the standard tool-view owner props.
 * @returns the disclosure row, or a plain "Rename" row while it is running.
 */
export function HashlineRenameRow({ block, cwd, home }: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(false);
	const error = errorCardModel(block);
	const model = renameCardModel(block, cwd, home);
	const expandable = error !== null || model !== null;
	const title = error !== null ? "Rename failed" : model?.title ?? "Rename";
	const summary = error !== null ? error.message : model?.summary ?? "";
	const body =
		error !== null
			? jsx_(ErrorCard, { model: error })
			: model === null
				? null
				: jsx_("div", {
						className: css.ioCard,
						children: model.rows.map((row, index) =>
							jsx_("div", {
								key: `${row.from}:${index}`,
								style: rowStyle,
								children: [
									jsx_("span", {
										style: pairStyle,
										children: [
											row.from,
											row.to === undefined
												? null
												: jsx_("span", { style: arrowStyle, children: " -> " }),
											row.to ?? null,
										],
									}),
									jsx_("span", {
										style: row.status === "failed" ? failedStyle : statusStyle,
										children: row.status === "failed" ? "failed" : "renamed",
									}),
									row.detail === ""
										? null
										: jsx_("span", { style: detailStyle, children: row.detail }),
								],
							}),
						),
					});
	return jsx_("div", {
		className: css.root,
		"data-tool": "rename",
		children: jsx_(DisclosureRow, {
			rowClassName: css.row,
			leadingClassName: css.leading,
			titleClassName: css.title,
			chevronClassName: css.chevron,
			icon: jsx_(IconEditOutlineMedium, { size: 14 }),
			title,
			open: open && expandable,
			expandable,
			expandOnRowClick: true,
			keepContentWhenOpen: true,
			onToggle: () => setOpen((value) => !value),
			collapsedContent:
				summary === ""
					? null
					: jsx_("span", {
							children: [
								jsx_("span", { className: css.sep, "aria-hidden": true }),
								jsx_("span", { className: css.summary, children: summary }),
							],
						}),
			children: jsx_("div", { className: css.bodyWrap, children: body }),
		}),
	});
}
