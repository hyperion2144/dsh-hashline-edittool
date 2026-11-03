/**
 * The patch's operation vocabulary.
 *
 * A parsed section is not yet an operation: `kind` names the EFFECT the patch
 * asks for (`add` / `update` / `delete` / `move`), never the section keyword,
 * and every later stage — preflight, commit, the model text, the card — speaks
 * in operations because that is the unit the caller's contract reports on
 * (`operation 2 (delete src/dead.ts, patch line 18)`).
 *
 * The mapping is the whole of this module: it is pure, it never touches the
 * filesystem, and it exists so the three stages cannot disagree about what
 * section N became.
 *
 * @module dsh-hashline-edittool/patch/plan
 */

import type { PatchSection } from "./types.js";

/** The four effects a patch can have on the tree. */
export type PatchOperationKind = "add" | "update" | "delete" | "move";

/**
 * One section, flattened into the unit the caller sees.
 *
 * `index` is the operation's 0-based position in patch order — it is what a
 * refusal line and a stopped-commit line quote back to the model.
 */
export interface PatchOperation {
  /** 0-based position in patch order. */
  index: number;
  /** The effect, not the section keyword. */
  kind: PatchOperationKind;
  /** The section's own path, as the model spelled it. */
  path: string;
  /** A `move`'s destination, as the model spelled it. */
  destination?: string;
  /** 1-indexed input line of the section header. */
  line: number;
  /** The section this operation came from (its hunks and content live here). */
  section: PatchSection;
}

/** Section keyword → effect. The one place the two vocabularies meet. */
const KIND_BY_SECTION = {
  file: "update",
  new: "add",
  move: "move",
  remove: "delete",
} as const satisfies Record<PatchSection["kind"], PatchOperationKind>;

/**
 * Flatten parsed sections into operations, in patch order.
 *
 * Nothing here validates: a section that cannot become a usable operation is
 * preflight's refusal to make, and it has the filesystem facts (and the input
 * line) that a refusal needs.
 *
 * @param sections - the parser's output, in input order.
 * @returns one operation per section, indexed by position.
 */
export function operationsFromSections(
  sections: readonly PatchSection[],
): PatchOperation[] {
  return sections.map((section, index) => ({
	index,
	kind: KIND_BY_SECTION[section.kind],
	path: section.path,
	...(section.destination !== undefined
	  ? { destination: section.destination }
	  : {}),
	line: section.lineNumber,
	section,
  }));
}
