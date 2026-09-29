# ADR-0012 — `lines` is a line array: one element, one line

> **Status**: Accepted (issue [#198](https://github.com/hyperion2144/dsh-hashline-edittool/issues/198), maintainer direction, 2026-09-28 — implemented in the same change).

## Problem Statement

The `edit` payload's `lines` array was flattened to a string the moment it left the
tool boundary (`replacement_text`), and that string surface spends ONE character on
two different meanings: `""` is the delete range (`parseText("") === []`), while the
all-blank families are spelled with newlines alone (`"\n"` is one blank line, `"\n\n"`
is two). `join("\n")` therefore collapsed every all-blank array onto the wrong side of
the boundary:

- `[""]` — contract: the line becomes **empty** — arrived as **zero** lines: `replace`
  silently DELETED the line, and `ins` inserted nothing at all (`[E_OP_INS] … inserted
  0 line(s)`, reported as a noop).
- `["",""]` arrived as **one** blank line — a silently lost line, no warning.

The same report exposed a second, independent defect. A diff's removal row took its
anchor from the text diff's own alignment, which is head-first; with two identical
adjacent lines it named the LATER twin — the survivor — while the engine had spliced
the FIRST one out. The row then carried the surviving line's anchor and old line
number, and the targeted line's anchor never appeared in the diff at all.

## Decision

**In `lines`, one element IS one line.** Only an element that itself carries a newline
becomes several (CRLF / CR / LF each fold to one break — the read line space of
ADR-0008). No input may change the line count silently.

1. **The array→string bridge is made lossless rather than removed.** `encodeText` is
   `parseText`'s inverse on the array surface: one element is one line, an element's
   own newline breaks it, and only the all-blank family needs the explicit
   `"\n".repeat(n)` spelling. Every other array is unchanged by the round trip, so the
   string surface keeps its meaning and `op: "del"` keeps `""` as the ONLY spelling of
   "no lines".
2. **Every array→text join goes through it**: the tool payload (`preparedItem`), the
   legacy single-edit path, the noop-loop payload key, and `resolveIns`'s second join —
   "anchor line + inserted lines" is itself an all-blank array exactly when both are
   empty.
3. **A removal row is attributed from the ENGINE's record, not from the text
   alignment.** The renderer is handed the original ranges the batch's hunks covered
   (`HunkShift` satisfies the render-owned `ChangedOriginalRange` structurally, so the
   render layer imports nothing from the domain), and a removal row takes the earliest
   line in them still unclaimed that carries its content. A row no range matches keeps
   the walk's own number; a whole-file `write` / `undo` diff has no hunks, passes
   nothing, and is unchanged.

## Consequences

- `[""]` clears the line (it still exists), `["",""]` is two blank lines, `["\n"]` is
  two blank lines (the element's own newline breaks it), and an absent or empty `lines`
  stays the legacy "no lines" spelling used by `op: "del"` and the legacy string input.
- The two half-contracts that already existed in tests — `applyEdit` on
  `content_lines: [""]` clears, `parseText("")` deletes — no longer disagree at the
  seam between them.
- Removal rows and the anchor state agree **by construction**: the lines a diff calls
  removed are the lines whose anchors that same edit released (ADR-0006 / ADR-0009).
- Cost: one `splitLines(oldContent)` per render that actually carries hunk ranges —
  the same order as the per-line anchor array the edit already holds.
- `ChangedOriginalRange` is owned by the render layer; the domain names it only as a
  structural type (the same direction `domain/` already imports `genDiff` in). If a
  third layer ever needs it, its canonical home is `src/contract/` — recorded at
  review time (#198), deliberately not moved in this change.

## Alternatives Considered

- **Carry the array all the way into the engine (retire `replacement_text`).**
  Rejected: the string spelling is a shipped input surface (the legacy
  `{remove_from, remove_to, replacement_text}` form and its `[E_BAD_SHAPE]` messages),
  so the engine must keep accepting it; a lossless bridge buys the array semantics
  without a second internal currency.
- **Change `parseText("")` to mean one empty line.** Rejected: `""` is the delete
  marker the whole `del` path and the legacy spelling are built on, and its own tests
  pin it. The ambiguity belongs to the encoding, not to the string reader.
- **Change the diff's alignment to tail-first.** Rejected: which direction is right
  depends on what the engine did (`ins` keeps its FIRST line — #151), so no global
  direction is correct. The engine's own range is the authority.
- **Derive "removed" from anchors that disappeared.** Rejected: anchors are
  content-derived, so a freed anchor can be re-minted for an inserted line within the
  same edit — absence from the result is not proof of removal.
