# ADR-0015 — A partially failed multi-file edit shows its failures beside its successes

> **Status**: Accepted (2026-10-05; decisions #240, prototype #241, spec #247, map #234)

## Problem Statement

A multi-file `edit` is a batch of per-file transactions (ADR-0003): one file can
land while another is rejected, and the **call** succeeded. The canonical value
says so — `success[]` beside `fail[]` — but the web row is drawn from
`presentationMeta` alone, and `presentationMeta` projected only the successes.

The failure was invisible by construction in the client:

- `client/src/client/tool-row.tsx` selects the card with
  `const card = errorBody ?? lspBody ?? diffBody ?? grepBody ?? readBody;` — and
  `errorBody` is `meta.error`, which by design exists only when the whole call
  changed nothing. On a partial failure there is no `meta.error`, so the error
  card is never even built.
- `const failureLine = state === "error" ? (errorSummary ?? null) : null` — at
  least one file landed, so the row state is `ok` and the summary line stays on
  the success path.

What the user saw was the successful diffs and no trace of the files that failed:
no path, no code, no reason — not even in the row's summary text. The model, in
the same call, is told everything (`fail[]` plus one prose block per failed file).

The fix also had to survive two host-side traps, both unreported before the spec:

1. `presentationMeta` projected the successes from a branch that only ran when
   there were diffs, so a call whose **only** successful file was a whole-file
   no-op would have dropped the failures with the missing diff.
2. The per-file failure code was read from the **last** `[E_*]` literal in the
   message — but a rejection keeps its ±3 echo verbatim, so an echoed source line
   carrying a literal (this repository's own test fixtures do) could hijack the
   code the card displays.

## Decision

1. **`presentationMeta` gains a parallel `failures` channel.** One entry per
   failed file, in input order: `{ path, code?, message, context?, hint? }` —
   `ErrorMeta` with `path` required and `code` optional, declared **once** in
   `src/infra/error-result.ts` (`FileFailureMeta`) so the per-file and the
   whole-call channel cannot drift apart. An empty list emits no key (the
   lossless-JSON contract: never `{ failures: undefined }`).

2. **`error` and `failures` are mutually exclusive and together exhaustive.**
   `error` means the call changed nothing; `failures` means at least one file
   landed and at least one did not. All-fail emits `error` only (its aggregate
   already names every path in `context`); all-success emits neither. No derived
   counts: the card computes "N of M files failed" from `diffRowGroups.length` +
   `failures.length`, so a count can never disagree with the list beside it.

3. **One fold for both channels.** A per-file `code` is the **head** `[E_*]` of
   the inner failure (never a later literal — trap 2), `message` is the inner
   text with that code removed, and `context` carries the echo block, cut at the
   same seam the whole-call error uses (`splitErrorText`). `hint` stays optional
   and byte-identical to `ErrorMeta`; an edit failure carries no hint today, and
   the field exists so the day one does, the card already renders it.

4. **The card shows failures as first-class tabs.** The tab strip gets one tab
   per failed file (red dot), its panel shows that file's `ErrorCard`, and a
   banner above the strip reads "N of M files failed" with each failed path
   clickable through to its tab. The banner owns the single `role="alert"`
   (`ErrorCard` grew an opt-out so a partial card does not announce twice), and
   the row's summary line carries the first failed path plus the count — while
   the row itself stays a **success**, because changes were applied.

5. **A zero-row group is a legal diff group.** A whole-file no-op produces a
   group with no rows; refusing that group used to null the entire tab array,
   which took the successful tabs down along with the failures.

## Consequences

- The channel is additive. The model-side `value` (text prose and the JSON
  `{ ok, success, fail }` envelope) is untouched, and a client that ignores
  `failures` degrades to exactly today's card rather than breaking.
- `meta.error`'s meaning is now testable and documented: it is the "this call
  changed nothing" channel. `CONTEXT.md` says so next to the new "Partial
  failure" entry.
- Both client channels narrow defensively: a malformed failure entry is dropped,
  a malformed diff row still refuses the row array — degradation, never a crash.
- `presentationMeta` now mirrors four `value` shapes (mixed, all-fail,
  all-success, no-op-only); the spec's test list pins all four, plus an echo
  fixture whose echoed body carries a code literal.
- One more thing for `src/tools/tool-edit.ts` to keep in sync with the value: the
  projection reads `v.success` / `v.fail`, which is why `failures` is computed
  from the completions rather than re-derived from the meta it is writing.

## Alternatives Considered

- **Reuse `meta.error` with a "partial" flag.** Rejected: the row state derives
  from `hasMetaError`, so an error channel would paint a successful call red and
  hide the success tabs — which are the point of the card.
- **Fold the failures into `diffRowGroups` as a special row kind.** Rejected:
  rows are diff rows (`+`/`-` carrying anchors); a failure has no rows at all,
  and the client's row validator would have to learn a second meaning.
- **Add `partial: { failed, total }` counts to meta.** Rejected: derived data
  that can drift from the list it describes, for a string the card can compose.
- **Fix it in the client alone, reading the value's `fail[]`.** Rejected: the
  edit row's priority handler takes the call over and `presentationMeta` is the
  only structured channel the web row receives (ADR-0004 draws that boundary).

## References

- Decision tickets #240 (channel) and #241 (card shape), specification #247;
  map #234.
- ADR-0003 (per-file atomicity, N undo slots), ADR-0004 (`fail[]`'s shape and the
  alignment baseline).
- `docs/web-ui-structured-views-spec.md` — superseded; its edit section is
  annotated in place rather than rewritten.
