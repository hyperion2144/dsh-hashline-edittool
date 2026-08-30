# ADR-0002 — Multi-file `edit` schema contract (top-level + per-item `path`)

> **Status**: Accepted (issue #37 spec locked 2026-08-30, see also wayfinder map issue #36 and parent bug issue #35). Implementation PR comes after wayfinder tickets #38 (concurrency + atomicity + undo) and #39 (response shape + same-file conflict) close.

## Problem Statement

From the user's perspective, the `edit` tool contract claims to support "multi-file edits in one call" via per-item `path`, but the implementation silently ignores that field. Issue #35 documents the symptom: an `edit({path, edits:[…]})` invocation with mixed per-item `path` values produces a misleading `[E_STALE_ANCHOR]` whose echo line shows the wrong file's content. There is no public spec to point at — only the schema description ("per-item `path` overrides the top-level `path` for this edit only") and a `hasTopLevelPath = true` hardcoded constant.

A caller writing a multi-file batch today cannot reliably predict the tool's behavior: would a per-item `path` differing from the top-level be honored, ignored, or reported as a conflict? The schema doc and the runtime disagree, and the only test in `test/core/presentation.test.ts` asserts only `expect(combined).toBeDefined();`.

## Solution

Spell out, in one canonical place, what the schema means and what runtime will accept:

- **Top-level `path`**: a single-file default. Optional iff every item carries its own `path`. Otherwise required.
- **Per-item `path`**: that item's file. When set, replaces the top-level default **for that item only**. When unset, the item inherits the top-level default.
- **Auto-fold normalizer**: if `item.path === topLevelPath`, `item.path` is treated as absent (no error, no special path).
- **No conflict**: a per-item `path` that differs from the top-level is not an error — it is the file that item will edit. Two items in one batch with two different paths edit two different files orthogonally.
- **Validation locus**: `assertEditRequest` enforces the only invariant that isn't already covered by the schema — when top-level `path` is absent, every item must carry a `path`.

The canonical description lives on `editsSchema.description`. `pathSchema.description` is a brief pointer; per-item `path` `description` is a one-liner that delegates to the canonical spec. This minimizes drift between the three places the public contract is currently scattered.

## User Stories

1. As a **model** invoking `edit`, I want to know when `path` is required vs optional, so that I can produce concise tool calls (omit `path` when I'm sending per-item `path` on every edit).
2. As a **model** invoking `edit`, I want per-item `path` semantics to be unambiguous ("each item with `path` edits that file; top-level is the default, not a mandate"), so that I don't second-guess multi-file batches and don't read a difference from top-level as a "conflict".
3. As a **model**, I want a normalizer specified for `item.path === topLevelPath` (auto-folded to absent), so that I know redundancy is graceful, not an error.
4. As a **model or caller**, I want `[E_BAD_SHAPE]` text to give me the exact fix hint ("when top-level `path` is omitted, every item must carry a `path`" — and only this case), so that I can recover from my own mistakes without guessing.
5. As a **maintainer**, I want the contract in one place (`editsSchema.description` is the canonical home), so that documentation drift between the three descriptions is minimized.
6. As a **maintainer**, I want `additionalProperties: false` enforced on the three schemas, so that spurious fields are rejected at the schema layer rather than carried silently to the engine.
7. As a **script caller** (CI / wrapper using `edit`), I want `edit({path, edits:[…]})` to continue to work unchanged, so that I don't have to refactor existing scripts when the contract changes.
8. As an **edit-engine implementer** (downstream of this ADR), I want `assertEditRequest`'s target behavior pinned down, so that I have a precise failure mode to surface before I write the engine-level dispatcher.

## Implementation Decisions

The following is the **target contract state** — descriptions of what should hold after the implementation PR. The implementation PR is out of scope for this ADR (it lands after wayfinder tickets #38 and #39 close).

### D1 — Schema field shape

Three field shapes stabilized:

- **Top-level `path`** (parameter of `edit`):
  - Type: `string`. Optional iff every item in `edits` carries its own `path`. Otherwise required.
  - Removed effect: the prior hard-throw on top-level absent that lived next to `assertEditRequest` is replaced by the conditional in [D5](#d5--assert-check-relaxation).

- **Per-item `path`** (property of each item in `edits`):
  - Type: `string`. Optional. Always means "the file for this item" when present.
  - Behavior: read first, fall back to top-level `path` when absent.
  - Auto-fold: when `item.path === topLevelPath`, treat as absent (see [D4](#d4--normalizer)).

- **Top-level `edits`** (parameter of `edit`): unchanged from 0.4 shape — `items: EditItemParams[]` with `op`, `anchor_start`, `anchor_end?`, `lines?`, and `path?`.

### D2 — Schema descriptor places

Three `description` strings, with the canonical text on the top-level `edits` schema:

- `editsSchema.description` — canonical. ~5–8 sentences covering:
  - top-level `path` is a default for single-file callers, becomes optional when every item carries `path`
  - per-item `path` is each item's file; differs from top-level is orthogonal, not a conflict
  - auto-fold normalizer when `item.path === topLevelPath`
  - the only `[E_BAD_SHAPE]` case: top-level absent + any item missing `path`
  - pointer to "see also" the next bullet.

- `pathSchema.description` — short. ~2 sentences: identifies that `path` is the file or default file for the call.

- Per-item `path` `description` — one-liner: `"The file this edit applies to. When unset, the top-level \`path\` is used. See \`editsSchema.description\` for the full multi-file contract."`

### D3 — `additionalProperties: false`

Three schemas receive `additionalProperties: false`:

- `editItemSchema` (`src/contract.ts:308-319` family)
- `editsSchema`
- `pathSchema`

Rationale: spurious tool-call fields reaching the engine have been the proximate cause of past bugs in this plugin's family. Reject at the schema layer instead of letting them pass through.

### D4 — Normalizer

When `item.path === topLevelPath` and both are non-empty, set `item.path = undefined` before passing items to the engine. The normalizer is **explicit** in the `editsSchema.description` text — "this is an explicit normalization, not a silent override" — so that future readers do not confuse this folding with the #35 failure mode (which was silent dropping of `path` when its content was different from top-level).

The normalizer lives either in `assertEditRequest` (after the [D5](#d5--assert-check-relaxation) shape check), or as a pass right before `PreparedItem[]` construction in `tool-edit.ts` — the ADR does not bind the implementation site, only the behavior.

### D5 — Assert check relaxation

The current behavior in `assertEditRequest`-family code that throws when top-level `path` is empty is replaced by:

```text
when top-level `path` is omitted:
  - throw [E_BAD_SHAPE] "when top-level `path` is omitted, every item must carry a `path`"
                 unless every item in `edits` has its own `path`
```

This is the only validation added. No other validation moves from "implicit" to "explicit" — the relax of D1 is the only schema-shape change.

### D6 — Out-of-scope decisions deferred to other ADRs

- **Atomicity / concurrency / undo semantics** → ADR-0003 (forthcoming, locked at issue #38).
- **Response shape and same-file-twice conflict semantics** → ADR-0004 (forthcoming, locked at issue #39).

These three ADRs together form the multi-file `edit` design packet.

## Testing Decisions

### TD1 — What makes a good test

External behavior: given a request shape passed to `assertEditRequest`, the validation accepts or throws the documented `[E_BAD_SHAPE]`, and the normalizer (if applicable) returns items with `path === undefined` for folded cases. Tests must not assert on engine-side dispatch (that is the responsibility of ADRs 0003 and 0004).

### TD2 — Test surface

- **Primary module**: a new test file at `test/core/multi-file-schema-contract.test.ts` (or in the existing `test/core/contract.test.ts` if one already exists; this ADR uses the new file by default). The test calls `assertEditRequest` directly with a request shape — no engine wiring, no `setupIntegrationTest`.
- **Secondary**: the strengthened `test/core/presentation.test.ts:173-208` case from issue #35 turns green against the post-#38 + #39 implementation, not against this ADR alone. It does NOT move into this test file.

### TD3 — Cases

Each case asserts the documented behavior in isolation:

1. `topLevelPath` set, all items unset or have the same `path` → accepted; items unchanged.
2. `topLevelPath` set, items have a different per-item `path` → accepted; each item keeps its per-item `path`.
3. `topLevelPath` set, an item's `path` equals `topLevelPath` → accepted; that item's `path` is normalized to `undefined`.
4. `topLevelPath` absent, all items have their own `path` → accepted (each gets its own file).
5. `topLevelPath` absent, any item without `path` → throws `[E_BAD_SHAPE]` with the documented message.
6. Spurious fields (`foo: 'bar'`) on the item or top-level request → rejected at schema layer (`additionalProperties: false`).
7. `topLevelPath` set, an item's `path === topLevelPath`, another item's `path === "other"` → accepted; one item normalizes, the other keeps its override.

### TD4 — Prior art

Test patterns similar to this ADR already live in `test/core/hashline.apply.test.ts` and `test/core/hashline.resolve.test.ts`, which exercise boundary cases of the schema layer directly. The new test file follows the same shape: small `it()` blocks per case, `expect()` for the success / failure mode.

## Out of Scope

- **Engine-level multi-file dispatch** (`runFileEdits` refactor, per-file grouping, `commit()` accepting multiple files). Lives behind wayfinder ticket #38 and ADR-0003.
- **Response shape for multi-file batches**. Lives behind wayfinder ticket #39 and ADR-0004.
- **Implementation PR for this ADR's changes**. The schema-shape change in [D1](#d1--schema-field-shape) and the descriptions in [D2](#d2--schema-descriptor-places) belong in a single small PR, but that PR lands only after #38 / #39 close, because the contract decisions there affect engine behavior that interact with schema validation.
- **Any change to single-file behavior**. Single-file calls continue to work as in 0.4.
- **Cross-mode multi-file (line-anchor + AST simultaneously)**. Out of scope per wayfinder map #36's `Out of scope`.

## Further Notes

- **Q4 framing correction**: during the issue #37 grilling, the original "Q4 — what error to throw on a top-level vs per-item mismatch?" was reframed by the maintainer as "different `path` values mean different files, not a conflict". That reframing became this ADR's [D1](#d1--schema-field-shape) second bullet and is the reason `editsSchema.description` must say "default, not mandate" — to forestall the same misreading in a future reader.
- **No `additionalProperties: false` regression risk**: existing tool calls in the wild use only the documented fields. Spurious fields should never have been honored; if any have, they will become errors — that's intended.
- **Backwards compat**: `edit({path, edits:[…]})` continues to accept the same shape; only the validation rule on top-level `path` becomes permissive (optional iff items cover).
