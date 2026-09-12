/**
 * dsh-hashline-edittool-client — browser half (served as `<pkg>/client.js`).
 *
 * Registers keyed `tool.call.toolview` entries for the `read`, `edit`, `grep`
 * and `write` wire tool names at `priority: -1`: the slot ledger shadows by ascending priority
 * (lowest renders; same key + same priority throws), so the explicit -1
 * deterministically takes over the shipped read/edit/grep/write rows without
 * anything. Plugin unload unwinds the registrations through the caller's fiber —
 * the shipped rows render again, i.e. disabling the plugin leaves no residue.
 *
 * The bundle is built as a closure factory (`window.__ModuleLoader__.load`)
 * whose externals (`react`, `react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`) resolve through the loader module
 * table's platform seed words — the same singletons the shell and the shipped
 * tool views use, so card visuals share one instance of every primitive.
 */

import {
	HashlineAstEditRow,
	HashlineAstGrepRow,
	HashlineEditRow,
	HashlineGrepRow,
	HashlineLspRow,
	HashlineReadRow,
	HashlineWriteRow,
} from "./tool-row.js";
import { HashlineSettingsCard } from "./settings-card.js";
import type { ClientCtx } from "./types.js";

/** Locale namespace of the conversation seat the shipped tool views use. */
const CONVERSATION_NS = "conversation";

/** Required services: the slot registry plus the settings scope we write through. */
export const inject = ["slots", "settingsScope"];

/** The settings namespace, spelled identically in both halves — it is the join key. */
const SETTINGS_NAMESPACE = "hashline";

/** Registers the hashline read conversation row (priority -1 takeover). */
const readToolview = {
	name: "hashline-read-toolview",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("tool.call.toolview", () =>
			ctx.slots.register(
				{ name: "tool.call.toolview", key: "read", locale: CONVERSATION_NS, priority: -1 },
				HashlineReadRow,
			),
		);
	},
};

/** Registers the hashline edit conversation row (priority -1 takeover). */
const editToolview = {
	name: "hashline-edit-toolview",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("tool.call.toolview", () =>
			ctx.slots.register(
				{ name: "tool.call.toolview", key: "edit", locale: CONVERSATION_NS, priority: -1 },
				HashlineEditRow,
			),
		);
	},
};

/** Registers the hashline grep conversation row (priority -1 takeover). */
const grepToolview = {
	name: "hashline-grep-toolview",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("tool.call.toolview", () =>
			ctx.slots.register(
				{ name: "tool.call.toolview", key: "grep", locale: CONVERSATION_NS, priority: -1 },
				HashlineGrepRow,
			),
		);
	},
};

/** Registers the hashline write conversation row (priority -1 takeover). */
const writeToolview = {
	name: "hashline-write-toolview",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("tool.call.toolview", () =>
			ctx.slots.register(
				{ name: "tool.call.toolview", key: "write", locale: CONVERSATION_NS, priority: -1 },
				HashlineWriteRow,
			),
		);
	},
};

/**
 * The AST tools, rendered by the rows that already exist.
 *
 * `ast_grep` returns the SAME `line:anchor:content` rows a `read` does and
 * `ast_edit` IS an edit, so both are the existing components registered under a
 * second key — no new component, no second stylesheet, no second channel.
 * That is what "reuse the rendering" buys: one implementation of what a row
 * looks like, and one place to fix it when it is wrong.
 *
 * `lsp` is deliberately NOT listed. Its result is a symbol list, and dressing
 * that in a read card would mean inventing a mapping the data does not have;
 * the platform default renders it, and `render` already gives the model the
 * text it needs.
 */
const astToolviews = {
	name: "hashline-ast-toolviews",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		for (const [key, Row] of [
			["ast_grep", HashlineAstGrepRow],
			["ast_edit", HashlineAstEditRow],
			// `lsp` had NO row at all, so its calls fell through to raw input/output.
			["lsp", HashlineLspRow],
		] as const) {
			ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register(
					{ name: "tool.call.toolview", key, locale: CONVERSATION_NS, priority: -1 },
					Row,
				),
			);
		}
	},
};

/**
 * The plugin-configuration card.
 *
 * The Host half already registers the `hashline` namespace, and the tab keys
 * its cards on the namespace, so the two halves pair up with no host change.
 * The card reads and writes ONLY through the bound scope: the cookbook's hard
 * constraint is that it must not add its own `settings.describe` reader,
 * because the client's cold-boot read budget is pinned by a platform test.
 */
const settingsCard = {
	name: "hashline-settings-card",
	inject: ["slots", "settingsScope"],
	apply(ctx: ClientCtx) {
		const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
		ctx.slots.inject("settings.plugin.item", () =>
			ctx.slots.register(
				{
					name: "settings.plugin.item",
					key: SETTINGS_NAMESPACE,
					locale: CONVERSATION_NS,
					inject: () => ({ scope }),
				},
				HashlineSettingsCard,
			),
		);
	},
};

/**
 * Mount the whole hashline card surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientCtx): void {
	ctx.plugin(readToolview);
	ctx.plugin(editToolview);
	ctx.plugin(grepToolview);
	ctx.plugin(writeToolview);
	ctx.plugin(astToolviews);
	ctx.plugin(settingsCard);
}
