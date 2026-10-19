/**
 * The manual `format` tool's model-facing description. Kept beside the
 * transaction it describes (`manual-format.ts`) so the contract and the code
 * cannot drift apart silently.
 *
 * @module dsh-hashline-edittool/domain/format/prompts
 */

/** `format`'s tool description — what it does, what it costs, what it refuses. */
export const FORMAT_DESCRIPTION = [
	"Format a file through its language server (LSP textDocument/formatting).",
	"Pass `range: { start, end }` to format only the lines between two SERVED anchors",
	"(both bounds must be anchors this session served; middle lines may be unserved) —",
	"omit `range` for the whole file. The write lands once and is undo-able via",
	"`undo_last_edit`; no diagnostics push is triggered. The server may cold-start",
	"(up to 15 s) and the request budget is 10 s. Refuses honestly instead of",
	"guessing: `[E_LSP_NO_SERVER]` when no server is running or startable for the",
	"file's language, `[E_FORMAT_UNSUPPORTED]` when the server has no formatting",
	"provider, `[E_RANGE_UNVERIFIED]`/`[E_STALE]` when a bound anchor is not served.",
	"The reply lists the formatter-changed rows with fresh anchors (rows whose",
	"pre-format lines were never served show a blank anchor). Indentation follows",
	"the file itself, or `.editorconfig` when `format.editorconfig` is on.",
].join(" ");
