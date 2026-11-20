/**
 * The manual `format` tool's model-facing description. Kept beside the
 * transaction it describes (`manual-format.ts`) so the contract and the code
 * cannot drift apart silently.
 *
 * @module dsh-hashline-edittool/domain/format/prompts
 */

/** `format`'s tool description: purpose plus one contract sentence (#447); the refusal honesty lives in the guidance section. */
export const FORMAT_DESCRIPTION =
  "Format a file through its language server, keeping the anchors of unchanged lines stable. " +
  "Pass `range` to format only the lines between two served anchors, or omit it for the whole file; the write lands once and is undo-able via `undo_last_edit`.";
