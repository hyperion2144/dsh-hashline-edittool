---
title: "ADR-0041: The format pass inherits anchors like an edit"
type: decision
status: Accepted
date: 2026-11-19
issue: 442
supersedes: ""
---

# ADR-0041: The format pass inherits anchors like an edit

## Context

The auto-format branch of `edit` treated a formatter's output as a fresh
file: it produced the post-format anchors with a whole-file assignment
(`lineHashesPure(finalResult)`), then built the served window and the
format section on those values. That violated ADR-0006 in two ways:

- **Cost.** A whole-file assignment ran on every formatting edit — the
  #437 audit measured 63 ms at 10k mostly-unique lines on this machine
  (275–392 ms for collision-heavy content), all of it on the edit hot
  path, and all of it discarded for window rows (see the next point).
- **A second allocation family.** Whole-file assignment picks slots in
  file order; the persisted store allocates by arrival history. The two
  disagree on repeated-content lines — the `2t` reshuffle mechanism
  ADR-0006 was written to end. The response stayed correct only because
  `buildServedRowsFromDiff` minted the window through the store and
  overwrote the recomputed values in place: inheritance by masking, not
  by construction. And a format output with no positional diff against
  the pre-edit text (a full revert) skipped the mint entirely, leaving
  the store describing the pre-format content until the next access
  realigned it.

`write`'s format section had the smaller sibling of the same flaw: its
eligibility gate recomputed a whole-file assignment for `preCallHashes`
when the auto-read preview had already served the exact per-line anchors
the model received.

## Decision

- The format step is an EDIT of the file. `edit`'s engine advances the
  persisted state through the same hunk-aware transform a normal edit
  uses (`updateAnchorsAfterEdit`): old = the post-edit pre-format text,
  new = the formatter's output, hunks = the bounded-Myers diff of exactly
  that change (`hunksBetween`). Unchanged lines shift by arithmetic;
  replaced lines release through the full three-part discipline
  (`released` lines → `releaseLines` → `releaseAnchors`); fresh lines
  mint against the live set ∪ the session's release pool.
- `updateAnchorsAfterEdit` gains a `mint` gate. A normal edit mints
  every hunk-new line (the response serves them all); the format pass
  passes its eligibility gate, so a formatter-invented line the model
  never saw stays `""` — not minted, never served (ADR-0019's rule,
  unchanged).
- A degraded in-hunk pairing during the format transform drains its
  alignment notice into THIS response's warnings — `applyOne`'s drain
  (the only other one) already ran, and the format step is the last
  transform, so nothing may leak to the next call (#442 review).
- `write`'s eligibility gate reads the preview's served anchors where they
  cover the model content; a TRUNCATED preview (a resume window) pads the
  uncovered lines with `""` — never eligible, because the model was shown
  no anchor for them — and only a caller with no preview at all falls back
  to the pure whole-file assignment. The rowless confirmation mode returns
  before the gate's input is even built. The gate's question is "does the
  line's pre-call anchor live in the served set" — answered with the
  anchors the model actually received, not a second family's opinion.

The rule this leaves behind: **there is exactly one anchor family per
file — the persisted store's.** Pure, content-derived whole-file
assignment (`lineHashesPure`) serves transient previews and nothing on a
hot path that already holds served anchors.
