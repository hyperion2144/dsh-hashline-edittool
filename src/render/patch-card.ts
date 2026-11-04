/**
 * The projection from committed patch operations to the two channels that
 * describe them: the model's unified diff and the web card's structured rows.
 *
 * Both are derived from the SAME `FileEditResult` the commit wrote, exactly as
 * `edit` derives its own — a second diff algorithm would eventually disagree
 * with the anchors the store recorded, and the disagreement would only ever be
 * visible as "the card shows an anchor the model cannot use".
 *
 * @module dsh-hashline-edittool/patch-card
 */

import { contextLinesCfg } from "../hashline/hash-assign.js";
import { replacedOriginalRanges, type FileEditResult } from "../domain/edit/edit-engine.js";
import { renderFileDiffGroup } from "../domain/edit/edit-response.js";
import type { LocalizedText } from "./wire-text.js";
import { genDiff, type DiffBlock } from "./edit-diff.js";
import {
	computeHunkDiffs,
	diffRowsFromBlocks,
	type EditCardDiffRow,
	type FileDiff,
} from "./edit-card.js";
import type { CommittedOperation } from "../domain/patch/commit.js";

/**
 * One tab's payload: the file, its rows, and what the section DID to it (#401).
 *
 * `kind` is the card's one typed fact about a section: a change set is the only
 * tool that both adds and removes files in one call, and the tab strip has to
 * name that outcome (a removed file's label is struck through, a rename's tab
 * says which path became which).
 */
export interface PatchCardGroup {
  path: string;
  rows: EditCardDiffRow[];
  kind: "added" | "modified" | "renamed" | "deleted";
  /** A rename's SOURCE path, display spelling — the tab body names both ends. */
  from?: string;
}

/** The patch's card data: one diff per file, plus per-file structured rows. */
export interface PatchCardData {
  diffs: FileDiff[];
  diffRowGroups: PatchCardGroup[];
}

/** The label a card and the model text use for one operation's file. */
export function operationLabel(operation: CommittedOperation): string {
  // The DISPLAY spelling, never the canonical absolute path: the card's tab and
  // the model's diff header name the file the way the caller wrote it.
  return operation.destination ?? operation.path;
}

/**
 * The one-letter status a change-set result uses.
 *
 * `A` added, `M` modified (an update, or a move that also edited), `D` deleted.
 * A pure move still reads `M` — the file's content is unchanged but the path is
 * not, and that is exactly what the arrow after it says.
 */
export function operationLetter(operation: CommittedOperation): string {
	if (operation.kind === "add") return "A";
	if (operation.kind === "delete") return "D";
	return "M";
}

/** One line of `Success. Updated the following files:` — `M old -> new` for a move. */
export function operationLine(operation: CommittedOperation): string {
	const letter = operationLetter(operation);
	if (operation.kind === "move" && operation.destination !== undefined) {
		return `${letter} ${operation.path} -> ${operation.destination}`;
	}
	return `${letter} ${operation.path}`;
}

/**
 * One operation's tab: the path, the rows, and the section outcome.
 *
 * EVERY completed operation gets a tab, including the shapes that carry no
 * servable anchors. A `new` file was never served, so its `+` rows have blank
 * gutters; a pure move and a `remove` are tabs with no rows at all — no LINE
 * changed — and their tabs say so in a sentence (see `PatchCardGroup.kind`).
 * Before this rule the anchor-less shapes vanished into a single shared tab,
 * which is how a three-file patch rendered as one.
 */
function tabFor(
  operation: CommittedOperation,
  lineNumbers: boolean,
): { path: string; blocks: DiffBlock[]; kind: PatchCardGroup["kind"]; from?: string } | undefined {
  if (operation.status !== "completed") return undefined;
  const path = operationLabel(operation);
  if (operation.kind === "move") {
    // A rename changed the PATH: the tab draws a sentence naming both ends,
    // with the hunks (if the move carried any) under it.
    const moved = operation.file;
    return {
      path,
      blocks: moved === undefined ? [] : genDiffFor(moved, path, lineNumbers).blocks,
      kind: "renamed",
      from: operation.path,
    };
  }
  if (operation.kind === "delete") {
    // A removal has no rows to draw: quoting the text it took away would say
    // "content changed" about a file that no longer exists. The tab carries
    // the delete card's sentence instead.
    return { path, blocks: [], kind: "deleted" };
  }
  const kind = operation.kind === "add" ? "added" : "modified";
  const file = operation.file;
  if (file !== undefined) {
    return { path, blocks: genDiffFor(file, path, lineNumbers).blocks, kind };
  }
  const change = operation.changes?.[0];
  if (change === undefined) return { path, blocks: [], kind };
  return {
    path,
    blocks: genDiff(
      change.before ?? "",
      change.after,
      contextLinesCfg(),
      // #416: the creation's rows carry the anchors the create path minted AND
      // served — the model can edit the file it just created without a re-read.
      operation.servedHashes ?? [],
      [],
      lineNumbers,
      { path },
    ).blocks,
    kind,
  };
}

function genDiffFor(file: FileEditResult, path: string, lineNumbers: boolean) {
  return genDiff(
    file.originalNormalized,
    file.result,
    contextLinesCfg(),
    file.resultHashes,
    file.originalHashes,
    lineNumbers,
    { path, changedRanges: replacedOriginalRanges(file.hunkShifts) },
  );
}

/**
 * The model-visible diff groups, one per completed operation that has rows.
 *
 * A tab with no rows (a pure move) is not emitted here: the model text is
 * the anchor channel, and a move has no new anchors to hand back.
 *
 * @param operations - every operation, in patch order.
 * @param lineNumbers - whether the user's line-number switch is on.
 * @returns `{path, text}` pairs in operation order; a group with no rows is
 *   omitted rather than emitted empty.
 */
export function renderPatchDiffGroups(
  operations: readonly CommittedOperation[],
  lineNumbers: boolean,
): { path: string; text: string }[] {
  const groups: { path: string; text: string }[] = [];
  for (const operation of operations) {
    const tab = tabFor(operation, lineNumbers);
    if (tab === undefined || tab.blocks.length === 0) continue;
    groups.push({
      path: tab.path,
      text: renderFileDiffGroup(tab.path, tab.blocks, lineNumbers),
    });
  }
  return groups;
}

/**
 * The card's data: `diffs` for the fallback diff block and `diffRowGroups`
 * for the tab strip — one group per completed operation, always.
 *
 * A creation renders as its whole new text (the write card's create form); a
 * pure move is a row-less tab whose sentence names both paths; a removal is a
 * row-less tab that says the file is gone. NO section is ever drawn as a diff
 * of text it took away — `-` rows are the edit card's vocabulary, and a file
 * that no longer exists has no lines to show.
 *
 * @param operations - every operation, in patch order.
 * @param lineNumbers - whether the user's line-number switch is on.
 * @returns the card payload (both arrays always present, possibly empty).
 */
export function buildPatchCard(
  operations: readonly CommittedOperation[],
  lineNumbers: boolean,
): PatchCardData {
  const diffs: FileDiff[] = [];
  const diffRowGroups: PatchCardGroup[] = [];
  for (const operation of operations) {
    if (operation.status !== "completed") continue;
    // A removal contributes NO diff: its tab (below) carries the sentence, not
    // the text the removal took away.
    if (operation.kind !== "delete") {
      for (const change of operation.changes ?? []) {
        const path = operationLabel(operation);
        if (change.before === null) {
          diffs.push({ path, oldText: null, newText: change.after });
          continue;
        }
        if (change.after === "") {
          diffs.push({ path, oldText: change.before, newText: "" });
          continue;
        }
        diffs.push(...computeHunkDiffs(path, change.before, change.after));
      }
    }
    const tab = tabFor(operation, lineNumbers);
    if (tab === undefined) continue;
    diffRowGroups.push({
      path: tab.path,
      rows: diffRowsFromBlocks(tab.blocks),
      kind: tab.kind,
      ...(tab.from === undefined ? {} : { from: tab.from }),
    });
  }
  return { diffs, diffRowGroups };
}

/**
 * The folded row's title, as the wire carries it (issue 375: a key + params,
 * resolved by the client in the reader's language).
 *
 * Three wordings, three keys — an empty patch and a stopped one each say so,
 * and the file count belongs to the ordinary success. A template with a
 * conditional cannot express that, and the count would render as a stray
 * `0 files` on the other two.
 *
 * @param files - how many operations the call carried.
 * @param stopped - whether the commit stopped before finishing.
 * @returns the wire text for the row title.
 */
export function patchRowTitle(files: number, stopped: boolean): LocalizedText {
	if (files === 0) return { key: "row.title.apply_patch.empty" };
	if (stopped) return { key: "row.title.apply_patch.stopped" };
	return { key: "row.title.apply_patch.files", params: { files } };
}
