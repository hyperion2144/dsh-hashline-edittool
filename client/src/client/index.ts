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

import { HashlineEditRow, HashlineGrepRow, HashlineReadRow, HashlineWriteRow } from "./tool-row.js";
import type { ClientCtx } from "./types.js";

/** Locale namespace of the conversation seat the shipped tool views use. */
const CONVERSATION_NS = "conversation";

/** Required services: the client slot registry. */
export const inject = ["slots"];

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
 * Mount the whole hashline card surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientCtx): void {
	ctx.plugin(readToolview);
	ctx.plugin(editToolview);
	ctx.plugin(grepToolview);
	ctx.plugin(writeToolview);
}
