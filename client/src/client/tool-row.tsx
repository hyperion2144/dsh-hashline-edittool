/**
 * The hashline read/edit tool views.
 *
 * `ToolRow` mirrors the shipped `dsh-client-ui-tool` row composition (collapsed
 * DisclosureRow + expandable card body) with the branches the read/edit keys
 * reach: the read card, the diff card, and the raw input/output fallback. The
 * card bodies themselves ARE the primitives (`ReadBlock`/`DiffBlock`), so
 * colors, fonts, spacing and interaction match the built-in cards exactly —
 * the only hashline difference is the read card's `<line>:<anchor>` gutter and
 * the edit row's caption-styled anchor hints.
 */

import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { jsx as jsx_ } from "react/jsx-runtime";
import {
	DisclosureRow,
	DiffBlock,
	ReadBlock,
	StateDot,
	diffTotals,
	IconBrowseOutline16,
	IconSearchOutline16,
	IconEditOutline16,
	IconInspectOutline12,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { DiffBlockProps, ReadBlockProps } from "@deepseek-ai/dsh-client-ui-primitives";
import { css, ensureToolRowStyles } from "./css.js";
import { diffBlockLabels, readBlockLabels } from "./labels.js";
import { diffCardModel, editAnchorHints, grepCardModel, readCardModel, toolRowModel, writeCardModel } from "./models.js";
import { GrepCard } from "./grep-card.js";
import { DiffRowsBlock } from "./diff-block.js";
import { grepCardLabels } from "./labels.js";
import type { ToolCallBlock, ToolViewProps } from "./types.js";

/** Join class names (tiny clsx stand-in; `clsx` is not a module-table word). */
function cx(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

/** Leading cell per run state: StateDot for error/stopped, the variant icon otherwise. */
function leadingFor(state: string, icon: ReactNode): ReactNode {
	if (state === "error") return jsx_(StateDot, { state: "error" });
	if (state === "stopped") return jsx_(StateDot, { state: "warning" });
	return icon;
}

/** Visually hidden run-state label (StateDot and the sweep are both aria-hidden). */
function stateStatus(state: string, t: ToolViewProps["t"]): string | null {
	if (state === "running") return t("row.running");
	if (state === "error") return t("row.failed");
	if (state === "stopped") return t("row.stopped");
	return null;
}

interface ToolRowProps {
	t: ToolViewProps["t"];
	variant: "read" | "edit" | "write" | "grep";
	toolName: string;
	icon: ReactNode;
	title: string;
	summary: string;
	/** Caption-styled extra suffix (hashline anchor hints); null draws none. */
	summarySuffix: string | null;
	bodyRaw: string | null;
	output: string | null;
	errorSummary: string | null;
	read: ReturnType<typeof readCardModel>;
	diff: ReturnType<typeof diffCardModel>;
	grep: ReturnType<typeof grepCardModel>;
	state: "running" | "ok" | "error" | "stopped";
	filePath: string | undefined;
	onOpenFile: ((path: string) => void) | undefined;
	inspect: (() => void) | undefined;
}

/** Format one argument payload for the generic input body. */
function formatToolBody(argsRaw: string): string | null {
	if (argsRaw === "") return null;
	try {
		return JSON.stringify(JSON.parse(argsRaw), null, 2);
	} catch {
		return argsRaw;
	}
}

/**
 * The shared row: collapsed DisclosureRow with the file link (or summary),
 * optional caption suffix (diff stat / anchor hints), and the expanded card
 * body. Structure and classes follow the shipped ToolRow; the terminal,
 * search, web, ask-question, and code branches are unreachable for the
 * read/edit keys and are omitted.
 */
function ToolRow({
	t,
	variant,
	toolName,
	icon,
	title,
	summary,
	summarySuffix,
	bodyRaw,
	output,
	errorSummary,
	read,
	diff,
	grep,
	state,
	filePath,
	onOpenFile,
	inspect,
}: ToolRowProps): ReactNode {
	ensureToolRowStyles();
	const [expanded, setExpanded] = useState(false);
	const readLabels = useMemo(() => readBlockLabels(t), [t]);
	const diffLabels = useMemo(() => diffBlockLabels(t), [t]);
	const readBody = read ?? null;
	const grepBody = grep ?? null;
	const grepLabels = useMemo(() => grepCardLabels(t), [t]);
	const diffBody = diff ?? null;
	const outputText = output ?? null;
	const card = diffBody ?? grepBody ?? readBody;
	const expandable = bodyRaw != null || outputText !== null || card !== null;
	const open = expanded && expandable;
	const bodyText = useMemo(
		() => (open && card === null && bodyRaw != null ? formatToolBody(bodyRaw) : null),
		[bodyRaw, card, open],
	);
	const status = stateStatus(state, t);
	const failureLine = state === "error" ? (errorSummary ?? null) : null;
	const summaryText = failureLine ?? summary;
	const diffStat = useMemo(() => {
		if (diffBody === null) return null;
		if (diffBody.rows !== undefined) {
			const added = diffBody.rows.filter((row) => row.kind === "+").length;
			const removed = diffBody.rows.filter((row) => row.kind === "-").length;
			return `+${added} -${removed}`;
		}
		const { added, removed } = diffTotals(diffBody.diffs as never);
		return `+${added} -${removed}`;
	}, [diffBody]);
	const suffix = failureLine === null ? (summarySuffix ?? diffStat) : null;
	const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null;
	const toggleExpand = () => {
		setExpanded((value) => !value);
	};
	const openFile = (event: ReactMouseEvent) => {
		event.stopPropagation();
		if (filePath !== undefined) onOpenFile?.(filePath);
	};
	const fileLinkKeyDown = (event: ReactKeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") event.stopPropagation();
	};
	return jsx_("div", {
		className: css.root,
		"data-variant": variant,
		"data-tool": toolName,
		"data-state": state,
		children: [
			status !== null &&
				jsx_("span", { className: css.visuallyHidden, children: status }),
			jsx_(DisclosureRow, {
				rowClassName: css.row,
				leadingClassName: css.leading,
				titleClassName: css.title,
				chevronClassName: css.chevron,
				icon: leadingFor(state, icon),
				title,
				open,
				expandable,
				expandOnRowClick: true,
				keepContentWhenOpen: true,
				onToggle: toggleExpand,
				collapsedContent:
					summaryText !== "" &&
					jsx_("span", {
						children: [
							jsx_("span", { className: css.sep, "aria-hidden": true }),
							fileLink
								? jsx_("button", {
										type: "button",
										className: css.fileLink,
										onClick: openFile,
										onKeyDown: fileLinkKeyDown,
										children: summaryText,
									})
								: jsx_("span", {
										className: cx(css.summary, failureLine !== null && css.errorSummary),
										children: summaryText,
									}),
							suffix !== null &&
								jsx_("span", {
									className: cx(
										summarySuffix !== null ? css.anchorHints : css.summarySuffix,
										suffix === diffStat && css.diffStat,
									),
									children: suffix,
								}),
						],
					}),
				children: jsx_("div", {
					className: css.bodyWrap,
					children: [
						diffBody !== null
							? diffBody.rowGroups !== undefined
								? // Per-file groups with the shared tab strip (issue #82 → #96).
								  jsx_(DiffRowsBlock, {
										path: diffBody.path,
										rows: diffBody.rowGroups[0]?.rows ?? [],
										groups: diffBody.rowGroups,
										tablistLabel: title,
										labels: diffLabels,
										maxLines: 8,
										className: css.diffBody,
								  })
							: diffBody.rows !== undefined
								? // Structured rows from the persisted meta: the forked block
								  // draws the `行号:锚点` gutter (issue #71). The single-file case keeps
								  // its own one tab (issue #96), synthesised from `path` + `rows`.
								  jsx_(DiffRowsBlock, {
										path: diffBody.path,
										rows: diffBody.rows,
										tablistLabel: title,
										labels: diffLabels,
										maxLines: 8,
										className: css.diffBody,
								  })
								: jsx_(DiffBlock, {
										diffs: diffBody.diffs as unknown as DiffBlockProps["diffs"],
										labels: diffLabels,
										maxLines: 8,
										className: css.diffBody,
									})
							: grepBody !== null
								? jsx_(GrepCard, {
									model: grepBody,
									labels: grepLabels,
									maxLines: 16,
									className: css.readBody,
								})
								: readBody !== null
									? jsx_(ReadBlock, {
										label: readBody.label,
										// ReadBlock draws its gutter cell verbatim, so the precomposed
										// `<line>:<anchor>` string rides the number field (the shipped
										// number type stays `number`, hence the structural cast).
										lines: readBody.lines as unknown as ReadBlockProps["lines"],
										totalLines: readBody.totalLines,
										lang: readBody.lang,
										labels: readLabels,
										maxLines: 8,
										className: css.readBody,
									})
								: jsx_("div", {
										className: css.ioCard,
										children: [
											bodyText !== null &&
												jsx_("div", {
													className: css.ioSection,
													children: [
														jsx_("span", { className: css.ioLabel, children: t("row.input") }),
														jsx_("span", { className: css.ioText, children: bodyText }),
													],
												}),
											bodyText !== null && outputText !== null &&
												jsx_("span", { className: css.ioDivider, "aria-hidden": true }),
											outputText !== null &&
												jsx_("div", {
													className: css.ioSection,
													children: [
														jsx_("span", { className: css.ioLabel, children: t("row.output") }),
														jsx_("span", {
															className: css.ioText,
															"data-error": state === "error" || undefined,
															children: outputText,
														}),
													],
												}),
										],
									}),
						inspect !== undefined &&
							jsx_("button", {
								type: "button",
								className: css.inspectButton,
								onClick: inspect,
								children: [jsx_(IconInspectOutline12, {}), t("row.inspect")],
							}),
					],
				}),
			}),
		],
	});
}

/**
 * The hashline read view: identical to the shipped read row, with the card
 * model rendering `<line>:<anchor>` gutter cells from the persisted
 * `hashlines` meta. Without hashline data it degrades to the exact shipped
 * presentation (bare numbers, or the generic input/output body).
 */
export function HashlineReadRow({ toolName, block, cwd, home, openFile, inspect, t }: ToolViewProps): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const read = readCardModel(block, cwd, home);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconBrowseOutline16, { size: 14 }),
		title: t(model.titleKey),
		summary: model.summary,
		summarySuffix: null,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read,
		grep: null,
		diff: null,
		state: model.state,
		filePath: model.filePath,
		onOpenFile: openFile,
		inspect,
	});
}

/**
 * The hashline edit view: the applied multi-hunk diff card (persisted
 * `meta.diffs`, accepted by the web narrowDiffs contract) plus caption-styled
 * anchor hints — the anchors the model addressed the edit with, read back from
 * the call's own `edits[].anchor_start`. Non-hashline calls fall back to the
 * shipped behavior (intended diff while running, generic body otherwise).
 */
export function HashlineEditRow({ toolName, block, cwd, home, openFile, inspect, t }: ToolViewProps): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const diff = diffCardModel(block);
	const anchors = useMemo(() => editAnchorHints(callArgsRaw(block)), [block]);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconEditOutline16, { size: 14 }),
		title: t(model.titleKey),
		summary: model.summary,
		summarySuffix: anchors.length > 0 ? `@${anchors.join(" @")}` : null,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		grep: null,
		diff,
		state: model.state,
		filePath: model.filePath,
		onOpenFile: openFile,
		inspect,
	});
}

/**
 * The hashline write view: the write card with the SAME `行号:锚点` gutter the
 * edit card draws, fed by the shadow's structured `meta.diffRows` (one row per
 * file line, carrying its line number and anchor). A create renders as
 * all-addition rows; an overwrite renders the applied diff rows. Without
 * structured rows the card degrades to the built-in intended diff.
 */
export function HashlineWriteRow({ toolName, block, cwd, home, openFile, inspect, t }: ToolViewProps): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const diff = writeCardModel(block);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconEditOutline16, { size: 14 }),
		title: t(model.titleKey),
		summary: model.summary,
		summarySuffix: null,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		grep: null,
		diff,
		state: model.state,
		filePath: model.filePath,
		onOpenFile: openFile,
		inspect,
	});
}

/**
 * The hashline grep view: the search card the requirement asks for — a file
 * tab bar (one tab even for a single match), a `行号:锚点` gutter and the
 * pattern highlighted inside each row, fed by the persisted structured meta
 * (ADR-0005). Running calls, errors and pre-0.4.4 logs without `rows` fall
 * back to the shipped presentation (generic body), and the row chrome mirrors
 * the shipped search row: the search icon, the Grep title and the pattern as
 * the summary.
 */
export function HashlineGrepRow({ toolName, block, cwd, home, openFile, inspect, t }: ToolViewProps): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const grep = grepCardModel(block);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconSearchOutline16, { size: 14 }),
		title: t(model.titleKey),
		summary: model.summary,
		summarySuffix: null,
		// The shipped search row draws no raw-input body: a search has a card or
		// nothing, and an error body already arrives through `output`.
		bodyRaw: null,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		diff: null,
		grep,
		state: model.state,
		filePath: model.filePath,
		onOpenFile: openFile,
		inspect,
	});
}

/** The paired call head's raw args (running calls carry their own). */
function callArgsRaw(block: ToolCallBlock): string {
	return ("kind" in block ? block.call?.argsRaw : block.argsRaw) ?? "";
}
