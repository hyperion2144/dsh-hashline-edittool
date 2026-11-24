---
title: "ADR-0044: `op` is the only authority — a field belonging to another op is ignored, not refused"
type: decision
status: Accepted
date: 2026-11-24
issue: 452
supersedes: ""
---

# ADR-0044: `op` is the only authority

## Context

The #452 report: a model filled fields belonging to several ops at once, and
`edit` answered `[E_BAD_SHAPE]` — `op:"sed"` does not take `anchor_after`. That
answer was correct under the contract as written, but the contract had no
single rule behind it. Measured against `assertEditItem`, the `op` × field
matrix carried **four different verdicts**:

| field | `ins` | `del` | `replace` | `sed` |
| --- | --- | --- | --- | --- |
| `anchor_after` | required | refused | refused | refused |
| `anchor_start` | refused | required | required | required |
| `anchor_end` | refused | optional | optional | optional |
| `lines` | required | **ignored** | required | **refused** |
| `pattern` / `replacement` / `flags` | **silently ignored** | **silently ignored** | **silently ignored** | required |

Three of those were deliberate and each had a pinning test: the anchor-field
refusal, `lines` ignored on `del` (#69 user feedback), `lines` refused on
`sed`. The fourth — `pattern` / `replacement` / `flags` silently ignored on
every non-`sed` op — **was never decided by anyone**. It is a side effect of
the engine reading those fields only when `op === "sed"`.

The result was inverted. A caller who wrote `pattern` next to `op:"replace"`
believed it had asked for a regex substitution and got a literal one — the
more dangerous silent drop — and nothing said a word. A caller who wrote
`lines` next to `op:"sed"` believed it had asked for a substitution and got a
regex rewrite — the safer mistake — and was refused.

## Decision

**`op` is the only authority.** A field that is known to belong to a different
op is IGNORED, and the item is then validated completely against the op that
was named.

Supporting decisions:

- **Ignoring is never silent.** Every ignored field is named in the file's
  `warnings`, in the shape
  `[E_BAD_SHAPE] edits[0] "anchor_start" is ignored: op:"ins" takes "anchor_after"`.
  The precedent is the missing-`path` autocorrect, which already reports
  `[E_BAD_SHAPE] Autocorrected: …` through the same channel.
- **A missing required field is still refused.** `{op:"ins", anchor_start,
  lines}` with no `anchor_after` stays `[E_BAD_SHAPE]`, and the message still
  points at `anchor_after`. That refusal is the mechanism that breaks the
  `replace` habit; it is not weakened by this ADR.
- **Unknown keys, misspelled keys, unknown ops and invalid targets are still
  errors.** `additionalProperties: false` is untouched. The distinction is
  *known field, wrong op* (ignored) versus *not a field at all* (refused).
- **No value becomes a special placeholder.** `anchor_after: "x"` is ignored
  because `op` says it is not the anchor, not because `"x"` means anything.

### Why the anchor fields are included

The first draft of this decision kept the anchor-field refusal, on the theory
that an anchor decides *which lines move* and ignoring one is guessing. That
reasoning does not survive contact with the case it was meant to protect:

- `op:"ins"` already determines that `anchor_after` is the anchor. Ignoring a
  stray `anchor_start` is not a guess — it is executing the op that was named.
- The habit-breaking mechanism is the *missing* `anchor_after` refusal, which
  this ADR keeps. A caller who sends only `anchor_start` with `op:"ins"` still
  gets told, in the same words as before, that `ins` takes `anchor_after`.

So the anchor fields follow the same rule as the content fields, and the
matrix collapses to one verdict per cell: **required / optional / ignored**.

## Consequences

- The `op` × field matrix has exactly three verdicts. A reader no longer has
  to remember which of four rules applies to which cell.
- A model that over-fills a shared parameter table gets its edit applied and a
  warning naming the field, instead of a retry loop that teaches it nothing
  about which field was wrong.
- The warning channel is the model's only signal that a field was dropped, so
  the wording must name both the field and the op that owns it. A warning that
  says only "ignored" would be worse than the refusal it replaces.
- `del` + `lines` keeps its #69 behaviour (ignored, **no** warning): that
  decision was made for a different reason — the model carries `lines` over
  from a copy-pasted `replace` — and adding a warning there would re-open a
  settled question.

## Alternatives considered

- **Refuse everything, uniformly.** Make `pattern` / `replacement` / `flags`
  on a non-`sed` op an error too, so the matrix is uniformly strict. This also
  removes the inconsistency, and it is the honest fallback if the warning
  channel proves too easy to miss. Rejected because it turns a harmless
  over-fill into a retry, which is the exact cost #452 reports.
- **Ignore silently, everywhere.** Rejected: a silent drop is what made the
  `pattern`-on-`replace` case dangerous in the first place. The warning is the
  whole point.
- **Keep the anchor fields strict and relax only the content fields.**
  Rejected for the reason recorded above: the strictness protects nothing that
  the missing-field refusal does not already protect.

## References

- Issue [#452](https://github.com/hyperion2144/dsh-hashline-edittool/issues/452)
- [ADR-0002](0002-edit-multi-file-schema.md) D3 — `additionalProperties: false`
  (unchanged; this ADR governs *known* fields, not unknown ones)
- [ADR-0012](0012-lines-line-array.md) — `lines` is a line array
- `docs/edit-payload-spec.md` — the historical payload record (its op table is
  superseded; the current contract lives in `src/contract/contract.ts`)
