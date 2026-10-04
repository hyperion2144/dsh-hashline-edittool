# ADR-0009 — Sparse lazy anchors: allocate only for model-visible lines

> **Status**: Implemented (maintainer direction on PR #169 review, 2026-09-23; landed in PR #169 the same day — sparse rows, lazy allocation, the per-file grep skip removed, dense rows migrating 1:1).

## Problem Statement

The anchor lifecycle allocates anchors for EVERY line of a file at the first
serve (`assignAnchors` over all lines), then maintains that dense array
through edits (diff-inherit) and external changes. The model only ever SEES a
subset: read's window rows, grep's match+context rows, lsp's symbol rows,
ast's rows, edit's diff rows.

The cost of allocating for unseen lines is not hypothetical:

- **grep** held the whole file's anchor array plus lineKeys plus the text —
  for a 4 MiB file that is 12–16 MiB, which is why `GREP_MAX_FILE_BYTES`
  (4 MiB) hard-skips large files: users grepping logs or generated bundles
  get NO results for exactly the files where they grep most.
- **read** materializes the full array to serve a window.
- The size gates that paper over this (`GREP_MAX_FILE_BYTES`,
  `AST_SUMMARY_MIN_TOTAL_LINES`' sibling gates) are the report surface of
  issue #162's class of problems.

Worse, the dense model's correctness depends on allocation ORDER: the
per-content cursor gives identical lines distinct anchors by their position
among same-content lines. Any allocation made against a SUBSET of the file
(the #151/P1 lesson: grep-derived or response-derived anchors) disagrees with
the full-file allocation — a silently wrong-line binding.

## Decision

**Anchors are allocated lazily, per line, only when a tool SERVES that line
to the model — and uniqueness is guaranteed by the file's persisted
allocated-anchor set, not by whole-file pre-allocation.**

- Every tool (read, grep, lsp, ast_grep, ast_edit, edit) allocates anchors
  for exactly the rows it renders. grep allocates for match rows AND context
  rows — everything the model sees.
- Allocation happens ONLY for rows the response actually returns. A response
  is segmented to its budget FIRST (ADR-0013); rows cut from the returned
  segment carry no anchor and are allocated when a later segment, a `resume`,
  or a fresh read actually returns them. No mechanism may allocate ahead of
  the response — an anchor the model never saw is a silent binding, and this
  ADR's whole point is that bindings are earned by being seen.
- The per-path state is a sparse map `line → (anchor, contentKey)`,
  persisted in the hash-store (a dedicated row family). Allocation probes
  from the content key with the file's persisted allocated-anchor set as the
  used-set; the `(path, anchor)` uniqueness is enforced by an index.
- An allocated anchor is bound to its line's content (contentKey): when the
  file changes, served lines whose content survived keep their anchors at
  their new positions; served lines whose content changed release theirs and
  reallocate when served again. The #151/P1 class of order-dependent
  mis-binding is structurally impossible: the anchor names the line, not an
  allocation order.
- Lines the model has never served have no anchor. Editing one is rejected
  by the existing served-state gate (read first, then edit) — the same flow
  that governs stale anchors today.
- Whole-file dense allocation (`assignAnchors`), the diff-inheritance machinery,
  and the E_ANCHOR_STATE_POISONED heal paths retire with the dense model.

## Consequences

- Memory for anchors is O(model-visible lines), not O(file). grep on a 4 MiB
  file no longer allocates ~100k anchors; `GREP_MAX_FILE_BYTES`'s hard skip
  is removed (large files are searchable).
- Two spellings of one file (8.3 short names on Windows) allocate two
  distinct sparse states — same as today's dense state, no worse.
- The dense `string[]` that tools index today becomes a per-line accessor;
  the served-state gate (`recordServed` / the E_NOT_OBSERVED flow) is
  unchanged.
- Migration: existing dense persisted rows expand 1:1 into the sparse map
  (no anchors are lost or re-minted on upgrade).

## Amendments

**2026-10-04, #215** — the Decision is unchanged; one constraint is now
explicit. Allocation happens ONLY for rows the response actually returns: the
response is segmented to its budget first (ADR-0013), and rows cut from the
returned segment carry no anchor until a later segment, a `resume`, or a fresh
read returns them. "Everything the model sees" is therefore exact, not
aspirational — no mechanism may allocate ahead of the response, and the
served-state gate this ADR relied on is now the persisted per-session served
set rather than an in-memory mirror (ADR-0006, amended).

This states the DESIGN the map is implementing: the echo path and the grep path
still allocate a whole planned window before assembling their response, and are
brought into line with it by the implementation tickets on map #214.

## Alternatives Considered

- **Subset allocation against a throwaway used-set** (hash only the returned lines): anchors disagree with the full-file allocation for duplicate content — the model's anchor resolves to a DIFFERENT line at edit time. Rejected.
- **Raise/parametrize the size gates** (#162's interim fix, shipped in PR #169's first pass): keeps large files unsearchable. Superseded within the same PR by this ADR's implementation.
- **Keep the dense model and stream the file** (no anchor arrays at all):
  rows would carry line numbers without anchors, so nothing is editable
  until a read — strictly worse than the sparse model, which keeps served
  rows editable.

## References

- Amended: [#215](https://github.com/hyperion2144/dsh-hashline-edittool/issues/215) (allocation ordered after response segmentation)
- Related: [ADR-0006](0006-anchor-lifecycle-inheritance.md) (the lifecycle gate this ADR's allocation feeds), [ADR-0010](0010-bounded-anchor-storage.md) (the store the sparse map lives in), [ADR-0013](0013-streaming-segmented-responses.md) (the segmentation that decides what is returned)
