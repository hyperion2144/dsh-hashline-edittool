/**
 * Public surface of the LSP formatting layer.
 *
 * One barrel so consumers (`lsp` tool, edit engine, settings card wiring)
 * import one specifier; the modules stay split by concern — capability
 * reading, request classification, edit application, option assembly.
 *
 * @module dsh-hashline-edittool/lsp/format
 */
export {
	E_FORMAT_UNSUPPORTED,
	FormatEditError,
	FormatUnsupportedError,
} from "./errors.js";
export { detectFormattingCapability, type FormattingCapability } from "./capability.js";
export { applyTextEdits, type LspTextEdit, type TextShape } from "./text-edits.js";
export {
	DEFAULT_INDENT_OPTIONS,
	inferIndentOptions,
	type IndentOptions,
} from "./indent.js";
export {
	defaultIndentOptions,
	resolveIndentOptions,
} from "./options.js";
export {
	requestFormatting,
	requestRangeFormatting,
	type FormatRange,
	type FormattingClient,
} from "./requests.js";
