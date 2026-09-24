# ADR-0011 — Bounded alignment: prefix/suffix trimming, a heap-derived threshold, and blocked DP

> **Status**: Implemented (spec [#184](https://github.com/hyperion2144/dsh-hashline-edittool/issues/184); decision ticket [#182](https://github.com/hyperion2144/dsh-hashline-edittool/issues/182), evidence in [#181](https://github.com/hyperion2144/dsh-hashline-edittool/issues/181); implementation in [#180](https://github.com/hyperion2144/dsh-hashline-edittool/issues/180)).

## Problem Statement

`alignPreserved` maps old anchors onto new line numbers by aligning two
`contentKey` sequences (one per line) with a **full** LCS dynamic-programming
table: `8 · (m+1) · (n+1)` bytes, no band, no window, no early exit. It has two
callers with very different input sizes:

- the **hunk** segment of an edit — bounded by the edit's own range, normally tiny;
- **`ensureState`'s whole-file realign** — `m` is the number of *allocated*
  entries and `n` the file's line count, so a fully-allocated 10,000-line file
  requests a 10,000 × 10,000 table.

Measured on Node 26.5, in isolated child processes with a bounded heap:

| m = n | DP table | heap cap | outcome |
| ---: | ---: | ---: | --- |
| 1,000 | 8 MB | 256 MB | OK (9 ms) |
| 10,000 | 800 MB | 256 MB | **SIGABRT** (`CALL_AND_RETRY_LAST`, frame `Builtins_ArrayFrom`) |
| 10,000 | 800 MB | 1024 MB | OK (800 ms, 770 MB heap) |
| 50,000 | 20 GB | any | **SIGABRT** (`Ineffective mark-compacts near heap limit`) |
| 100,000 | 80 GB | any | **SIGABRT** |

V8 fails the pre-allocation by **aborting the process** — not a catchable
`RangeError`, so no `try`/`catch` anywhere in the plugin can save the session.
Time is `Θ(m·n)` (2 k = 29 ms, 5 k = 171 ms, 10 k = 736 ms), and the
replaced-line ratio does not change the table size: `m·n` is the only term that
decides it.

This path is **orthogonal** to store growth ([ADR-0010](0010-bounded-anchor-storage.md)):
it is pure heap allocation, so bounding the store leaves it fully reachable — a
10,000-line file read once is enough.

## Decision

Alignment gets three layers of protection, applied in this order:

1. **Common prefix/suffix trimming.** Both arguments are `contentKey` sequences,
   so the unchanged head and tail are stripped in `O(min(m,n))` with zero
   semantic risk — those elements pair up identically by construction. A typical
   external change (a few edited lines, context intact) collapses `m·n` from
   `O(file²)` to `O(change²)`, so most real alignments never reach the threshold.
2. **A heap-derived threshold:** `effective = min(5×10⁷, floor(heapLimit / 32))`,
   i.e. the table may not exceed roughly a quarter of the available heap
   (`8·m·n` bytes). The value that took effect is logged once per process. A fixed
   constant alone was rejected: 400 MB of DP still aborts a process running with
   a 256 MB heap (measured).
3. **Blocked (windowed) DP above the threshold:** the remaining sequences are cut
   into blocks sized so the per-block table stays inside `effective`, each block
   is aligned internally, and blocks are paired by similarity. The memory bound is
   therefore "block size squared" — a number the implementation states and a test
   can pin.

When similarity is so low that blocking would preserve nothing meaningful, the
alignment returns an empty mapping. That is a **last resort**: it means every
anchor the session holds for that file is gone, so the tool layer drains a
one-shot, model-visible notice — one plain line naming the action (`re-read the
file`). No new error code: the edit is not refused, the anchors are simply gone,
and the model is told once rather than at every later call.

The threshold check lives **inside** the aligner, not at the `updateAnchorsAfterEdit`
entry point: guarding only the edit path leaves `ensureState`'s whole-file realign
unprotected, and that is the path a large read walks.

`alignPreservedBounded` is exported, and the budget can be pinned from tests
(`setEffectiveDpBudgetForTests`), because production call sites pass no options —
without that seam the degraded branch would only be reachable by allocating
hundreds of megabytes in a test.

## Consequences

- No input can produce an allocation larger than `effective · 8 B` plus copies of
  the two input sequences, so the fatal-abort path is closed by construction
  rather than by hoping the heap is big enough.
- Typical edits keep **≥ 99 %** of anchors (measured at 1 k / 10 k / 50 k lines
  with 1 % of lines changed: 99.50 % / 99.00 % / 99.01 %); a whole-file change with
  an unchanged tail keeps 100 %. Pinned by tests.
- Above the threshold the outcome degrades gracefully: blocked alignment keeps
  most anchors for a shifted file, and the empty-mapping fallback costs a
  re-read — announced, not silent.
- Alignment is now three code paths instead of one, so it carries its own tests:
  trimming equivalence, blocked-vs-full agreement on small inputs, keep-rate
  floors, the fallback, and a child-process regression proving 50 k × 50 k returns
  inside a 256 MB heap instead of aborting.
- The standing rule is preserved: **losing anchors is always preferable to
  killing the session**, and losing them is never silent when the model is the
  one holding them.

## Alternatives Considered

- **`Int32Array` (or otherwise halving the cell size)** — rejected: it moves the
  wall from 50 k lines to ~70 k; 80 GB is still 40 GB.
- **Myers `O(NP)` banded DP as the main path** (the research recommendation) —
  rejected in favour of blocked DP: after trimming, the remaining inputs are small
  in the common case, blocked alignment is far easier to reason about and to test,
  and a hand-written Myers would need its own correctness proof for a marginal
  keep-rate gain.
- **Raising the heap (`--max-old-space-size`)** — rejected: the plugin cannot
  dictate the host process's heap, and the pathological inputs are unbounded.
- **A pre-flight size check in the caller** — rejected: `ensureState`'s realign is
  the dangerous caller, and a caller-side guard duplicates the condition in every
  current and future call site.
- **Refusing to align whole files above some line count** — rejected: it throws
  away anchors for the common "read a big file, then the file changed elsewhere"
  case, which trimming and blocking handle cheaply.

## References

- Decision ticket: [#182](https://github.com/hyperion2144/dsh-hashline-edittool/issues/182)
- Evidence: [#181](https://github.com/hyperion2144/dsh-hashline-edittool/issues/181) (report at `/tmp/alignpreserved-oom-report.md`; experiments under `.tmp/oom-experiments/`)
- Spec: [#184](https://github.com/hyperion2144/dsh-hashline-edittool/issues/184)
- Related: [ADR-0009](0009-sparse-lazy-anchors.md) (the sparse anchor state this alignment maintains), [ADR-0010](0010-bounded-anchor-storage.md) (the orthogonal store-side bound)
