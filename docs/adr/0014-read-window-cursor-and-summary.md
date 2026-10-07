# ADR-0014 — A read window is a line range, and the response says which one it served

> **Status**: Accepted (2026-10-05; decisions #238/#239, spec #245, map #234)

## Problem Statement

The `line_numbers` switch (#244) can strip the `:lineNumber` suffix
from row markers, and `grep` then returns bare anchors with no numbers attached.
A model that wants the rest of a function had only numeric `offset`/`limit`: it
could say *twelve lines*, but not *from this anchor to that anchor*, and it had
to guess how far a line number had drifted since the read.

The window's own summary had the mirror-image problem. Three places assembled
it — the read card's footer (`src/render/read-card.ts`), the renderer's
pagination hint (`src/domain/session/file-view.ts`, `formatPaginationHint`), and
a regex that stripped the footer before appending a byte-truncation notice
(`src/tools/tool-read.ts`) — so the text tail, the JSON envelope and the web
card could each describe a different window. The wording also changed shape
depending on which path produced it (`[Showing lines …]`, `[End of file - total
N lines.]`, `(Omitted K lines…)`), and the numbering switch never reached the
JSON channel at all.

Finally, `resume` silently won over `offset`/`limit` when a caller passed both:
the ignored arguments looked honoured.

## Decision

1. **`offset` and `limit` each accept a positive integer or an anchor.** An
   anchor names the first / the last served line, so the window is a **closed**
   range; `limit` as an anchor means "stop at this line", as a number it means
   "this many rows". Numbers and anchors may be mixed — all four combinations
   are legal. An **inverted range is the only new hard reject**
   (`[E_BAD_SHAPE]`); a start-only window keeps today's default (whole file,
   then the byte budget). `offset` is exclusive of nothing: the anchor's own
   line is the window's first line.

2. **One sentence, computed once by the host.** The tail is
   `[Lines X-Y of N. End of file.]`,
   `[Lines X-Y of N. Use offset="<anchor of line Y>" to continue.]`, or
   `[Lines X-Y of N. Omitted K lines. Use read {resume: "rs-…"} to continue.]`
   when the byte budget cut the window. Numeric out-of-range keeps its advisory
   wording; an empty file keeps its synthetic row and its own notice. `X`/`Y`
   are always **file** line numbers (the same ledger as the anchors) and the
   `line_numbers` switch does not touch this sentence. Text, JSON and the web
   card read the same source: the host projects `window: {start, end,
   totalLines}` into `presentationMeta` and the model-side JSON value, and the
   client renders from it instead of refolding the rows.

3. **Cursor failures reuse the served gate** (`probeLines`, the read-only probe
   the edit pipeline already uses): an anchor that is not live → `[E_STALE]`;
   any served-state cause (never served, line moved, line changed) →
   `[E_RANGE_UNVERIFIED]`. `[E_RANGE_STALE]` stays reserved for the checksum /
   version-guard case, which is exactly how `edit` reports it, so both tools
   speak one vocabulary (`anchor-pipeline.ts` "four causes, one code"). A pasted
   `line#hash` marker → `[E_BAD_REF]`; any other malformed value →
   `[E_BAD_SHAPE]`. Read does **not** echo and serve on failure — the model still
   holds the markers it passed.

4. **`resume` and `offset`/`limit` are mutually exclusive.** Passing a token
   together with either cursor is `[E_RESUME_CONFLICT]`; the token already names
   a byte/time window and the two continuations are different axes.

5. **An empty file is a real serve.** `window: {start: 1, end: 1, totalLines: 1}`
   with the synthetic empty row and `[File is empty. Use edit to insert
   content.]`, so a client can tell "empty" from "beyond the end". An
   out-of-range request emits no `window` at all (nothing was served).

## Consequences

- Continuation no longer depends on the numbering switch: the "more to come"
  sentence carries an anchor, which survives renumbering, while the byte-budget
  sentence still carries a `resume` token — segment continuation and window
  continuation stay distinct, per ADR-0013.
- The three tails collapse into one assembly point (`assembleServedRead` in
  `src/tools/tool-read.ts`). A fourth tail shape has to be added there or not at
  all; the renderer no longer appends sentences of its own.
- Inheriting the edit pipeline's probe means read's failures are read-only: no
  served rows are written and no anchors are minted when a cursor is rejected.
- Two JSON additions, no removals: `window: {start, end, totalLines}` and
  `continuation` (the resume token, as before). `offset` reports the resolved
  start line, so a caller that passed an anchor can see where it landed.
- `[E_RESUME_CONFLICT]` joins `[E_RESUME_GONE]` / `[E_RESUME_BAD]` /
  `[E_RESUME_TOOL]`, and all four are now listed in the README error-code table
  (`test/core/error-codes.test.ts` keeps that table and `src/` interlocked).

## Alternatives Considered

- **Keep numeric-only cursors and require `line_numbers: true`.** Rejected: it
  makes change ① unusable — the default-off switch would leave grep's anchors
  unreachable as cursors.
- **Accept a pasted `line#hash` / `<anchor>:<line>` row as a cursor.** Rejected:
  `[E_BAD_REF]` already defines that shape as a mistake for edit, and a cursor is
  no different.
- **Report `end` as the last line requested rather than served.** Rejected: after
  a byte-budget cut the two differ, and only the served bound tells the truth.
- **Have the client assemble the tail from the rows it holds.** Rejected: a
  sparse window's row count is not the window, and three channels would drift
  again — the failure this ADR exists to remove.
- **Let `resume` keep priority over `offset`/`limit`.** Rejected: silently
  ignoring arguments is how the drift went unnoticed; a conflict is cheap to
  report and impossible to misread.

## References

- Decision tickets #238 (cursor semantics) and #239 (summary shape); spec and
  implementation #245; map #234.
- ADR-0013 (segmentation and `resume`), ADR-0009 (lazy anchors).
- `docs/anchor-entry-contract.md` §6 for the measured probe reasons.
