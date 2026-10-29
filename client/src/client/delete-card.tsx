/**
 * The `delete` row: a small card of per-path outcomes (deleted / already
 * absent / failed) plus the logical reclaim summary. It follows the family's
 * chrome (`DisclosureRow` + the shared body frame) so it reads like the other
 * hashline tools, and the structured `meta.delete` is projected by
 * {@link deleteCardModel} — the component never parses model text.
 *
 * @module dsh-hashline-edittool-client/delete-card
 */
import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import { DisclosureRow, IconEditOutlineMedium } from "@deepseek-ai/dsh-client-ui-primitives";
import { css } from "./css.js";
import { deleteCardModel, errorCardModel } from "./models.js";
import type { CardText, DeleteCardRow } from "./models.js";
import { ErrorCard } from "./error-card.js";
import { deleteCardLabels, errorCardLabels } from "./labels.js";
import type { ToolViewProps } from "./types.js";

const rowStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "minmax(0, 1fr) max-content",
	gap: "2px 12px",
	padding: "8px 14px",
	borderTop: "0.5px solid var(--dsw-alias-border-l2)",
};
const pathStyle: CSSProperties = {
	fontFamily: "var(--ds-font-family-code)",
	fontSize: "12px",
	color: "var(--dsw-alias-label-primary)",
	overflowWrap: "anywhere",
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
 * Render the `delete` card.
 * @param props - the standard tool-view owner props.
 * @returns the disclosure row, or a plain "Delete" row while it is running.
 */
export function HashlineDeleteRow({ block, cwd, home, t }: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(false);
	const error = errorCardModel(block);
	const model = deleteCardModel(block, cwd, home);
	// The card's own words come from the vocabulary namespace; the MODEL layer
	// owns the paths and the reclaim details, never the words in front of them.
	const labels = useMemo(() => deleteCardLabels(t), [t]);
	const errorLabels = useMemo(() => errorCardLabels(t), [t]);
	const expandable = error !== null || model !== null;
	const title = error !== null ? labels.failedTitle : labels.title;
	// #375: the summary and the reclaim details are words + counts, so the
	// model layer names the wording and the client renders it in the reader's
	// language. A failure's own message stays verbatim (the model's channel).
	const renderText = (part: CardText): string =>
		part.kind === "literal" ? part.text : t(part.key, part.params);
	const detailText = (row: DeleteCardRow): string => {
		const parts = row.detail.map(renderText);
		if (row.error !== undefined) parts.unshift(row.error);
		return parts.join(" · ");
	};
	const summary =
		error !== null ? error.message : (model?.summary ?? []).map(renderText).join(" · ");
	const body =
		error !== null
			? jsx_(ErrorCard, { model: error, labels: errorLabels })
			: model === null
				? null
				: jsx_("div", {
						className: css.ioCard,
						children: model.rows.map((row, index) =>
							jsx_("div", {
								key: `${row.path}:${index}`,
								style: rowStyle,
								children: [
									jsx_("span", { style: pathStyle, children: row.path }),
									jsx_("span", {
										style: row.status === "failed" ? failedStyle : statusStyle,
										children:
											row.status === "failed"
												? labels.statusFailed
												: row.status === "deleted"
													? labels.statusDeleted
													: labels.statusAbsent,
									}),
									detailText(row) === ""
										? null
										: jsx_("span", { style: detailStyle, children: detailText(row) }),
								],
							}),
						),
					});
	return jsx_("div", {
		className: css.root,
		"data-tool": "delete",
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
