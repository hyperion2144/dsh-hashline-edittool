/**
 * Assembling the `FormattingOptions` a formatting request carries.
 *
 * The cascade is (G1; default flipped by #336): `.editorconfig` when
 * `format.editorconfig` is on (the default) — then the document-whitespace
 * heuristic, then the JSON-ish default.
 * The cascade composes PER KEY: a project that names only `indent_style` keeps
 * the file's own `tabSize` verdict. This module is the ONE place that knows
 * the order; the `format` tool and the automatic path both come here.
 *
 * @module dsh-hashline-edittool/lsp/format/options
 */
import type { FileIO } from "../../infra/fs-bridge.js";
import { workspaceCwd } from "../../infra/workspace.js";
import { readIndentFromEditorconfig } from "../editorconfig.js";
import { DEFAULT_INDENT_OPTIONS, inferIndentOptions, type IndentOptions } from "./indent.js";

/**
 * The effective options for one file.
 *
 * @param io - the file bridge (read-only: `.editorconfig` lookups).
 * @param absolutePath - the file about to be formatted.
 * @param text - the file's LF-normalized text (the heuristic's witness).
 * @param editorconfigEnabled - the `format.editorconfig` setting, read once
 *   by the caller so a format request cannot see a mid-flight settings flip.
 */
export async function resolveIndentOptions(
	io: Pick<FileIO, "readText">,
	absolutePath: string,
	text: string,
	editorconfigEnabled: boolean,
): Promise<IndentOptions> {
	const heuristic = inferIndentOptions(text);
	if (!editorconfigEnabled) return heuristic;
	let fromConfig: Partial<IndentOptions>;
	try {
		fromConfig = (await readIndentFromEditorconfig(io, absolutePath, workspaceCwd())) ?? {};
	} catch {
		// An unreadable config is a fallback, never a format failure.
		fromConfig = {};
	}
	return {
		insertSpaces: fromConfig.insertSpaces ?? heuristic.insertSpaces,
		tabSize: fromConfig.tabSize ?? heuristic.tabSize,
	};
}

/** The options when there is no text to ask (a brand-new empty file). */
export function defaultIndentOptions(): IndentOptions {
	return DEFAULT_INDENT_OPTIONS;
}

