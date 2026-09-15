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
	StateDot,
	diffTotals,
	IconBrowseOutline16,
	IconSearchOutline16,
	IconEditOutline16,
	IconInspectOutline12,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { DiffBlockProps } from "@deepseek-ai/dsh-client-ui-primitives";
import { css, ensureToolRowStyles } from "./css.js";
import { diffBlockLabels, readCardLabels } from "./labels.js";
import { diffCardModel, grepCardModel, lspCardModel, readCardModel, toolRowModel, writeCardModel } from "./models.js";
import { GrepCard } from "./grep-card.js";
import { ReadCard } from "./read-card.js";
import { LspDiagBlock } from "./lsp-block.js";
import { DiffRowsBlock } from "./diff-block.js";
import { grepCardLabels, lspBlockLabels } from "./labels.js";
import type { ToolCallBlock, ToolViewProps } from "./types.js";
import { diagCapsulesFromMeta } from "./models.js";
import type { DiagCapsuleMeta } from "./types.js";

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
	bodyRaw: string | null;
	output: string | null;
	errorSummary: string | null;
	read: ReturnType<typeof readCardModel>;
	diff: ReturnType<typeof diffCardModel>;
	grep: ReturnType<typeof grepCardModel>;
	/** The `lsp` diagnostics card, drawn by our own block (see `LspDiagBlock`). */
	lsp: ReturnType<typeof lspCardModel>;
	/** #131: inline diagnostics capsules, one per written file ([] = none). */
	diag: readonly DiagCapsuleMeta[];
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
 * One inline diagnostics capsule (#131): a small severity-tinted pill under
 * the card body — red when any error was reported, yellow when warnings
 * only (story 13). Clicking it expands the SAME diagnostics block the `lsp`
 * card draws (story 14), fed by the persisted rows rather than parsed prose.
 * A clean write has no capsule at all, because the meta carries none.
 */
function DiagCapsule({ capsule, t }: { capsule: DiagCapsuleMeta; t: ToolViewProps["t"] }): ReactNode {
	const [open, setOpen] = useState(false);
	const labels = useMemo(() => lspBlockLabels(t), [t]);
	// Counts come from the severity CODES beside each message — the same rule
	// the `lsp` stat uses — never from parsing an "error: …" label apart.
	let errors = 0;
	let warnings = 0;
	let other = 0;
	for (const row of capsule.rows) {
		const codes = row.severities.length > 0 ? row.severities : row.messages.map(() => 0);
		for (const code of codes) {
			if (code === 1) errors += 1;
			else if (code === 2) warnings += 1;
			else other += 1;
		}
	}
	const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
	const text = [
		errors > 0 ? plural(errors, "error", "errors") : "",
		warnings > 0 ? plural(warnings, "warning", "warnings") : "",
		other > 0 ? plural(other, "diagnostic", "diagnostics") : "",
	]
		.filter((part) => part !== "")
		.join(" · ");
	return jsx_("div", {
		className: css.diagWrap,
		children: [
			jsx_("button", {
				type: "button",
				className: css.diagCapsule,
				"data-severity": errors > 0 ? "error" : "warning",
				"aria-expanded": open,
				onClick: () => setOpen((value) => !value),
				children: [jsx_("span", { className: css.diagDot, "aria-hidden": true }), text],
			}),
			open &&
				jsx_(LspDiagBlock, {
					model: { path: capsule.path, rows: capsule.rows },
					labels,
					maxLines: 16,
				}),
		],
	});
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
	bodyRaw,
	output,
	errorSummary,
	read,
	diff,
	grep,
	lsp,
	diag,
	state,
	filePath,
	onOpenFile,
	inspect,
}: ToolRowProps): ReactNode {
	ensureToolRowStyles();
	const [expanded, setExpanded] = useState(false);
	const readLabels = useMemo(() => readCardLabels(t), [t]);
	const diffLabels = useMemo(() => diffBlockLabels(t), [t]);
	const readBody = read ?? null;
	const grepBody = grep ?? null;
	const lspBody = lsp ?? null;
	const grepLabels = useMemo(() => grepCardLabels(t), [t]);
	const lspLabels = useMemo(() => lspBlockLabels(t), [t]);
	const diffBody = diff ?? null;
	const outputText = output ?? null;
	// `lsp` first: it owns its body outright (frame included), so the read body
	// never sees diagnostic rows masquerading as lines of a file.
	const card = lspBody ?? diffBody ?? grepBody ?? readBody;
	const expandable = bodyRaw != null || outputText !== null || card !== null;
	const open = expanded && expandable;
	const bodyText = useMemo(
		() => (open && card === null && bodyRaw != null ? formatToolBody(bodyRaw) : null),
		[bodyRaw, card, open],
	);
	const status = stateStatus(state, t);
	const failureLine = state === "error" ? (errorSummary ?? null) : null;
	const summaryText = failureLine ?? summary;
	// The diagnostics stat, shaped like the diff stat next to it (`+3 -1`): the
	// count comes from the severity CODES the host put beside each message, never
	// from parsing an "error: …" label back apart.
	const lspStat = useMemo(() => {
		if (lspBody === null) return null;
		let errors = 0;
		let warnings = 0;
		let other = 0;
		for (const row of lspBody.rows) {
			// A row without codes still carries messages (an older payload): count
			// them as plain diagnostics rather than dropping them from the total.
			const codes = row.severities.length > 0 ? row.severities : row.messages.map(() => 0);
			for (const code of codes) {
				if (code === 1) errors += 1;
				else if (code === 2) warnings += 1;
				else other += 1;
			}
		}
		if (errors + warnings + other === 0) return null;
		// Words rather than glyphs: the suffix sits next to a file path in a row a
		// reader scans, and `2 errors · 1 warning` needs no legend.
		const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
		return [
			errors > 0 ? plural(errors, "error", "errors") : "",
			warnings > 0 ? plural(warnings, "warning", "warnings") : "",
			other > 0 ? plural(other, "diagnostic", "diagnostics") : "",
		]
			.filter((part) => part !== "")
			.join(" · ");
	}, [lspBody]);
	// The SAME stat for INLINE diagnostics (#131): the edit/write rows carry
	// capsules, not an lsp body, and a folded row should say `+1 -1 · 1 error`
	// the same way. Counts come from the severity codes beside each message.
	const diagStat = useMemo(() => {
		if (diag.length === 0) return null;
		let errors = 0;
		let warnings = 0;
		let other = 0;
		for (const capsule of diag) {
			for (const row of capsule.rows) {
				const codes = row.severities.length > 0 ? row.severities : row.messages.map(() => 0);
				for (const code of codes) {
					if (code === 1) errors += 1;
					else if (code === 2) warnings += 1;
					else other += 1;
				}
			}
		}
		if (errors + warnings + other === 0) return null;
		const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
		return [
			errors > 0 ? plural(errors, "error", "errors") : "",
			warnings > 0 ? plural(warnings, "warning", "warnings") : "",
			other > 0 ? plural(other, "diagnostic", "diagnostics") : "",
		]
			.filter((part) => part !== "")
			.join(" · ");
	}, [diag]);
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
	// The suffix is the diff stat BESIDE the diagnostics stat (`+1 -1 · 1 error`):
	// a folded row that hides a fresh error made the reader expand to learn it.
	// `summarySuffix` (anchor hints) used to sit to the left of the `??` — a prop
	// with no producer is a switch the next change can flip back on (issue #127).
	const suffix =
		failureLine === null
			? [diffStat, lspStat ?? diagStat].filter((part) => part !== null).join(" · ") || null
			: null;
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
									className: css.summarySuffix,
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
								: lspBody !== null
									? jsx_(LspDiagBlock, {
										model: lspBody,
										labels: lspLabels,
										maxLines: 16,
									})
									: readBody !== null
									? jsx_(ReadCard, {
										model: readBody,
										labels: readLabels,
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
						// #131: the inline diagnostics capsules sit UNDER the card body —
						// one per written file, absent for clean edits.
						diag.length > 0 &&
							jsx_("div", {
								className: css.diagWrap,
								children: diag.map((capsule, index) =>
									jsx_(DiagCapsule, { key: `${capsule.path}:${index}`, capsule, t }),
								),
							}),
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
export function HashlineReadRow({ toolName, block, cwd, home, openFile, inspect, t, titleOverride, icon }: ToolViewProps & { readonly titleOverride?: string; readonly icon?: ReactNode }): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const read = readCardModel(block, cwd, home);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: icon ?? jsx_(IconBrowseOutline16, { size: 14 }),
		// `titleOverride` is how a tool that WEARS this row says its own name. Without
		// it the title falls back to the variant's label, which is right for `read`
		// and wrong for everything borrowing it.
		title: titleOverride === undefined ? t(model.titleKey) : titleOverride,
		summary: model.summary,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read,
		diag: [],
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
export function HashlineEditRow({ toolName, block, cwd, home, openFile, inspect, t, titleOverride }: ToolViewProps & { readonly titleOverride?: string }): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const diff = diffCardModel(block);
	// #131: inline diagnostics, present only when a push arrived in the window.
	// Running calls carry no meta, so the capsule appears only once settled.
	const diag = diagCapsulesFromMeta("kind" in block ? block.meta : undefined);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconEditOutline16, { size: 14 }),
		title: titleOverride === undefined ? t(model.titleKey) : titleOverride,
		summary: model.summary,
		// ALWAYS the diff stat, never the anchor hints.
		//
		// The hints were passed here whenever the call carried bare anchors — which is
		// exactly when `require_line_content` is OFF — and an anchor hint beats the
		// diff stat in the row's own precedence. So a setting about whether a MODEL
		// re-states the lines it touches decided what a READER saw: `@oN @6I @4E` with
		// it off, `-3 +1` with it on, for the same edit. The title answers "what did
		// this change", and that answer does not depend on the switch.
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		grep: null,
		diff,
		diag,
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
	// #131: a write reports diagnostics exactly like an edit does.
	const diag = diagCapsulesFromMeta("kind" in block ? block.meta : undefined);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconEditOutline16, { size: 14 }),
		title: t(model.titleKey),
		summary: model.summary,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		grep: null,
		diff,
		diag,
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
export function HashlineGrepRow({ toolName, block, cwd, home, openFile, inspect, t, titleOverride }: ToolViewProps & { readonly titleOverride?: string }): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	const grep = grepCardModel(block);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconSearchOutline16, { size: 14 }),
		// `titleOverride` lets `ast_grep` wear this row under its own name: the card
		// data is grep-shaped (files/rows/spans), so the drawing is identical and
		// only the label differs.
		title: titleOverride === undefined ? t(model.titleKey) : titleOverride,
		summary: model.summary,
		// The shipped search row draws no raw-input body: a search has a card or
		// nothing, and an error body already arrives through `output`.
		bodyRaw: null,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		diff: null,
		diag: [],
		grep,
		state: model.state,
		filePath: model.filePath,
		onOpenFile: openFile,
		inspect,
	});
}

// ---------------------------------------------------------------------------
// The AST tools and `lsp` get their OWN rows, not the read/edit ones.
//
// Registering `ast_grep` AS `HashlineReadRow` was reuse taken one step too far.
// The row a read draws is right — same `line:anchor| content` rows — but the
// TITLE is derived from `variant`, and `variant` is `read` for anything that
// wears this component. So an AST search announced itself as 读取, an AST edit as
// 编辑, and `lsp` had no row at all and fell through to raw input/output.
//
// Reusing the ROW is the point; reusing the IDENTITY is the mistake. These pass a
// title of their own into the same composition, which is what "reuse the component"
// should have meant the first time.
// ---------------------------------------------------------------------------

/** `ast_grep` — STRUCTURAL SEARCH, and it wears the GREP row on purpose:
 * `presentationMeta` emits the same `files/rows/spans` shape `grep` does, so the
 * search card — gutter, anchors, highlight — draws it directly. Delegating to the
 * READ row instead was the bug: the read card wants `hashlines`, got none, and
 * fell through to raw input/output.
 * The label is uppercase and the icon is the search icon, matching `grep`.
 */
export function HashlineAstGrepRow(props: ToolViewProps): ReactNode {
	return HashlineGrepRow({ ...props, titleOverride: "AST_GREP" });
}

/** `ast_edit` — structural rewrite. Draws the edit diff card, announces itself. */
export function HashlineAstEditRow(props: ToolViewProps): ReactNode {
	return HashlineEditRow({ ...props, titleOverride: "AST_EDIT" });
}

/** `undo_last_edit` — a revert IS a diff, so it wears the edit card. */
export function HashlineUndoRow(props: ToolViewProps): ReactNode {
	return HashlineEditRow({ ...props, titleOverride: "UNDO" });
}

/**
 * `lsp` — semantic operations.
 *
 * It draws its OWN body, exactly as the edit card does with `DiffRowsBlock`: the
 * rows carry two kinds of text (the source line and a server's diagnostics of it)
 * and the read primitive can only draw plain strings, while replacing the
 * primitive's body outright lost its frame and copy button. A vendored block with
 * its own stylesheet and the shared `TabStrip` head keeps both.
 */
export function HashlineLspRow({ toolName, block, cwd, home, openFile, inspect, t }: ToolViewProps): ReactNode {
	const model = toolRowModel(toolName, block, cwd, home);
	// The diagnostics rows are drawn by our own block below, so the read/grep/diff
	// bodies stay out of it — this row owns its body.
	const lsp = lspCardModel(block);
	return jsx_(ToolRow, {
		t,
		variant: model.variant,
		toolName,
		icon: jsx_(IconBrowseOutline16, { size: 14 }),
		title: "LSP",
		summary: model.summary,
		bodyRaw: model.bodyRaw,
		output: model.output,
		errorSummary: model.errorSummary,
		read: null,
		grep: null,
		diff: null,
		lsp,
		// The lsp row IS the diagnostics card; a second capsule would duplicate it.
		diag: [],
		state: model.state,
		filePath: undefined,
		onOpenFile: openFile,
		inspect,
	});
}

