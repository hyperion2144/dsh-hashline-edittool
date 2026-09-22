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
	HashlineUndoRow,
	HashlineWriteRow,
} from "./tool-row.js";
import { HashlineSettingsCard } from "./settings-card.js";
import type { ClientCtx } from "./types.js";

/** Locale namespace of the conversation seat the shipped tool views use. */
const CONVERSATION_NS = "conversation";

/** Required services: the slot registry is the only hard dependency left —
 * 0.1.7 took the settings scope service away (forms arrive as slot props). */
export const inject = ["slots"];

/**
 * The settings entry id, spelled identically in both halves — the join key.
 * 0.1.7 addresses settings by the profile ENTRY id (= the patch row id = the
 * package name), not by a registered namespace: the host half exports
 * HASHLINE_ENTRY_ID with this exact value.
 */

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

/**
 * Registers the hashline UNDO row.
 *
 * `undo_last_edit` already answers with the diff of the revert — the host hands
 * over `{card: "diff", diffs}` — but nothing registered the row, so the web drew
 * the default view and an undo looked like raw input/output. It borrows the edit
 * row for the same reason `ast_edit` does: a revert IS a diff, and one
 * implementation of what a diff row looks like means a fix to one is a fix to
 * all of them.
 */
const undoToolview = {
	name: "hashline-undo-toolview",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("tool.call.toolview", () =>
			ctx.slots.register(
				{ name: "tool.call.toolview", key: "undo_last_edit", locale: CONVERSATION_NS, priority: -1 },
				HashlineUndoRow,
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
 * The plugins page renders a bundle's configuration on the bundle's page
 * through the keyed `plugins.bundle.config` slot, indexing entries by the
 * bundle's package name. The 0.1.7 page hands each entry
 * `{ view, form }` as OWNER PROPS — the card reads and writes ONLY through
 * `form` (snapshot state + path-op mutate); it must not add its own
 * `settings.describe` reader, because the client's cold-boot read budget
 * stays pinned by a platform test.
 */

/** The bundle's package name — the key the manager indexes this entry by. */
const BUNDLE_PACKAGE_NAME = "dsh-hashline-edittool";

const settingsCard = {
	name: "hashline-settings-card",
	inject: ["slots"],
	apply(ctx: ClientCtx) {
		ctx.slots.inject("plugins.bundle.config", () =>
			ctx.slots.register(
				{
					name: "plugins.bundle.config",
					key: BUNDLE_PACKAGE_NAME,
					locale: CONVERSATION_NS,
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
	ctx.plugin(undoToolview);
	ctx.plugin(grepToolview);
	ctx.plugin(writeToolview);
	ctx.plugin(astToolviews);
	ctx.plugin(settingsCard);
}
