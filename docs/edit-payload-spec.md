# Spec — Upstream cherry-picks + merged `edit` payload with `op` semantics

> Status: **Draft** — awaiting review before implementation begins.
> Scope: (a) cherry-pick the non-breaking upstream T1+T2+T5 fixes into the
> current line#hash codebase, (b) adopt a stronger version of upstream T3
> (merged `edit` payload) that **removes `batch_edit` and adds an `op`
> field** to distinguish `ins` / `del` / `replace` semantics with stricter
> `lines`-required rules.

## 1. Goal

Two distinct tracks in one commit-set:

1. **Adopt the small upstream fixes** that landed between `dcc5fb6` (our
   fork base) and `d66754b` (upstream HEAD, v0.3.0) — specifically the
   three non-breaking ticket-bundles T1, T2, T5 from the upstream
   `absorb/t1..t7` series. These are correctness and UX wins; they do
   **not** change the model contract.

2. **Then break** with the upstream T3 (`535e582` absorb/t3-payload),
   but **improve on it**:
    - Upstream T3 replaces `edit` + `batch_edit` with a single
      `edit({path, edits:[[hash, hash, text]]})` — 3-tuples with
      positional meaning (from, to, text).
    - Our variant uses **named fields** (`from` / `to` / `lines` / `op`)
      and **explicit op semantics** (`ins` / `del` / `replace`):
      - `op: "ins"` — insert `lines` after the `from` line. `from` is
        required; `to` is forbidden; `lines` is required and non-empty.
      - `op: "del"` — delete the `from` line, or the `from..to` range
        if `to` is given. `from` is required; `lines` is forbidden.
      - `op: "replace"` — replace the `from` line, or the `from..to`
        range if `to` is given, with `lines`. `from` is required;
        `lines` is required and **must be non-empty** (use `del` to
        delete).

   The user contract becomes: a single `edit` tool with an `edits` array;
   one `batch_edit` tool is removed entirely.

## 2. Background — the upstream contract

`pi-better-edit@6a9cefca` (upstream v1.1.4) introduced:

```
edit({ path, edits: Array<[fromHash, toHash, text]> })
```

`absorb/t3-payload` in the upstream project adopted the same.
Our fork base (`dcc5fb6`) predates this. We will cherry-pick + improve.

The upstream contract loses:
- Explicit semantics per edit (replacement vs insert vs delete)
- Distinction between "delete this line" and "replace this line with
  empty" — the only way to delete is `[hash, hash, ""]`, which is
  awkward for the model and leaves room for the `[E_WOULD_EMPTY]`
  class of errors the old `edit` tool had to defend against.

Our variant keeps the single-tool, multi-edit shape but adds the `op`
field plus a strict `lines` requirement. The model always knows
intuitively what each edit is doing; the runtime never has to guess.

## 3. Detailed contract

### 3.1 Tool shape

The `edit` tool description and parameter schema become:

```ts
defineTool({
  name: "edit",
  description: EDIT_DESCRIPTION,  // updated copy — see §3.4
  parameters: {
    path: pathSchema,
    edits: {
      type: "array",
      required: true,
      description: "Ordered list of edits to apply atomically. ...",  // see §3.4
      items: editItemSchema,
    },
    // (no more remove_from / remove_to; per-item now)
    ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
  },
  output: { schema, render, presentationMeta },
  presentCall, presentResult,
  execute: ...
});
```

`editItemSchema`:

```ts
{
  type: "object",
  required: true,
  additionalProperties: false,
  properties: {
    op: {
      type: "string",
      required: true,
      enum: ["ins", "del", "replace"],
      description: "Edit semantic. `ins` inserts after `from`; `del` deletes the from..to range; `replace` replaces the from..to range with `lines`.",
    },
    from: {
      type: "string",
      required: true,
      description: "Anchor of the FIRST line of the range. `<line>#<hash>` (e.g. `12#ve7`) or bare 3-char hash when the file is unchanged above. For `op: ins`, the inserted lines land AFTER this line; for `del` and `replace`, this is the first line of the affected range.",
    },
    to: {
      type: "string",
      description: "Anchor of the LAST line of the range. If omitted, the edit targets just the `from` line. Forbidden for `op: ins`.",
    },
    lines: {
      type: "array",
      items: { type: "string" },
      description: "Lines to insert (for `ins`) or replace with (for `replace`). Required and must be non-empty for `ins` and `replace`. Forbidden for `del`.",
    },
  },
}
```

### 3.2 `op` semantics — exhaustive

| `op`     | `from` | `to`    | `lines`            | Behaviour |
| -------- | ------ | ------- | ------------------ | --------- |
| `ins`    | ✓ required | ✗ forbidden | ✓ required, `≥ 1` | Insert `lines` **after** the `from` line. The `from` line itself is preserved. |
| `del`    | ✓ required | optional (default = `from`) | ✗ forbidden | Delete the `from` line, or the `from..to` range if `to` is given. |
| `replace`| ✓ required | optional (default = `from`) | ✓ required, `≥ 1` | Replace the `from` line, or the `from..to` range if `to` is given, with `lines`. |

Validation rules (in `execute`, after schema soft-validates the schema shape):

- If `op === "ins"` and `to` is set → `[E_BAD_SHAPE] op:"ins" does not accept "to".`
- If `op === "del"` and `lines` is set (or `lines: []` empty array) → `[E_BAD_SHAPE] op:"del" does not accept "lines".`
- If `op === "replace"` and `lines` is missing or empty → `[E_BAD_SHAPE] op:"replace" requires a non-empty "lines" array. Use op:"del" to delete.`
- If `op === "replace"` and `lines` is `[""]` (one empty string) → accepted; the result is the empty line.
  (An edit that replaces with `[""]` is distinct from `op:"del"`: the line
  still exists in the file, just empty. The `from..to` range shrinks by
  0 if single-line.)
- If `op === "ins"` and `lines` is missing or empty → `[E_BAD_SHAPE] op:"ins" requires a non-empty "lines" array.`

### 3.3 Edit application order and Shift blocks

The Shift block behaviour (per the existing `line#hash` spec at
`docs/line-hashline-spec.md`) is preserved. Each `ins` / `del` /
`replace` edit within the `edits` array produces its own Shift block
when the net line-count change is non-zero, in the same `Shift:
lines > N shift by +K` format the model already chains against.

`ins` adds `lines.length` lines below the `from` line; the `from` line
itself does not move, but every line below it does. The Shift block
quantifies that for the chain.

`del` removes `|to - from| + 1` lines (or 1 if `to` is omitted). Lines
below close up.

`replace` keeps the line count the same as the number of `lines`
inserted. If `|to - from| + 1 !== lines.length`, lines shift below.

Edits in the same `edits` array are applied **in order** against
evolving content (each edit sees the file state after the previous
edit). This is the existing `applySequence` behaviour — preserve it.

### 3.4 Tool description (model-facing) and prompt text

`EDIT_DESCRIPTION` (in `src/prompts.ts`):

> Apply one or more edits to a text file in a single atomic call. Each
> item in `edits` carries an `op` (`ins` / `del` / `replace`), a `from`
> anchor, an optional `to` anchor (for range edits), and the `lines` to
> insert or replace with. `ins` adds `lines` after the `from` line; `del`
> removes the from..to range; `replace` swaps the from..to range with
> `lines`. Pass `<line>#<hash>` (e.g. `12#ve7`) for both `from` and
> `to`; a bare 3-char hash is accepted only when the file is unchanged
> above. The post-edit response includes a `Shift:` block per hunk
> describing how absolute line numbers below the edit moved; chain the
> next edit by reading the Shift block — `newLine=<N>#<oldHash>` from
> the next unchanged diff row (if rendered), or read for fresh
> anchors. A stale or never-served range is hard-rejected
> (`[E_STALE_ANCHOR]` / `[E_RANGE_UNSERVED]`) with a read-format echo
> that counts as a fresh serve.

`EDIT_GUIDANCE` bullets updated to remove references to a separate
`batch_edit` tool; the merged `edit` is explained in terms of `edits:[]`.

`BATCH_EDIT_*` removed (no more prompt sections or guidance).

`tool:grep` (added in 0.3) and `tool:read` / `tool:undo_last_edit`
unchanged.

### 3.5 `batch_edit` is removed

- `src/tool-batch-edit.ts` deleted.
- `src/contract.ts`:
  - `BATCH_EDIT_MAX_ITEMS` constant (in `src/constants.ts`) repurposed as
    `EDITS_MAX_ITEMS` (the per-call cap on `edits.length`, same default
    32).
  - `BatchItemParams` removed.
  - `EditParams` shape updated to `{ path, edits }`.
  - `BatchEditParams` removed.
  - `assertBatchEditRequest` removed.
  - `normalizeFilePath` still runs on the per-item `path` (or on the
    top-level `path` when no per-item `path` is given — see §3.6).

### 3.6 `path` resolution

The top-level `path` is the default; per-item `path` overrides for
multi-file edits in one call. If both the top-level and per-item
`path` are present, the per-item wins. If neither, `[E_BAD_SHAPE]
edits[i] requires a "path" string.` (matches the old `batch_edit`
behaviour).

### 3.7 Interaction with `remove_to === ""` (legacy)

The legacy `edit.remove_to === undefined` / `remove_to === ""` →
defaults to `remove_from` behaviour is **gone**. The new contract uses
`from` + `to`; omitting `to` means single-line, no defaulting. A
single-line `del` becomes `{op: "del", from: "12#ve7"}`; a single-line
`replace` becomes `{op: "replace", from: "12#ve7", lines: ["new"]}`.

This is a **deliberate break** from the line#hash upgrade. The previous
"omit remove_to = single line" default was implicit; the new contract
makes it explicit per `op`. The model now states its intent
unambiguously. The prompt-section text makes this clear.

## 4. Background — the small upstream fixes (T1, T2, T5)

These are **non-breaking** and ship in the same commit set. The
rationale + test plan mirror the upstream tickets verbatim.

### 4.1 T1 — Whitespace-insensitive canon (ADR-0005)

- `src/hashline/hash-assign.ts`:
  - `canon()` now strips `[ \t\r\n]+` (not just `\r` + `trimEnd()`).
  - Export `CANON_VERSION = 2` so the snapshot cache invalidates
    correctly.
  - `getCanon(cache, line)` memoizes per call. Both `lineHashesPure` and
    `mapStableHashes` use it.
- `src/hash-store.ts`: cache version bump; `getCanon` is the only
  canon function the snapshot store depends on.

**Why it matters**: today a reformat that only changes trailing
whitespace rotates anchors. T1 makes the hashline content-identity
robust to whitespace-only diffs, which is what the model expects from
"the same line" semantically.

### 4.2 T2 — Orphaned serve healing (ADR-0008)

- `src/session-view.ts`:
  - `_mergeServedRows` builds an internal `Map<hash, position>` as it
    scans the existing array; when the same hash appears at a second
    position, the older position is nulled.
  - Both `recordServed` and `recordServedTruncated` short-circuit on
    "no change" writes.
- `src/hashline/anchor-pipeline.ts`:
  - `verifyServedRange` uses **candidate-span enumeration** when
    `startPositions.length` or `endPositions.length` is not exactly 1.
    For each `s ∈ startPositions × e ∈ endPositions`, it checks
    `served[s..e] === fileHashes[startLine..endLine]`. If exactly one
    candidate matches, it's accepted. If multiple match, the closest to
    `startLine-1` is accepted. If none, the existing `E_RANGE_UNVERIFIED`
    fires — but the error message now says "A full read will re-sync
    the served mirror" instead of "a boundary anchor that cannot be
    verified is never guessed at", which is more action-oriented.

**Why it matters**: today a partial re-serve (e.g. only lines 1-10
re-served after a 50-line edit) leaves a stale `hashAt(20)` on
`hashline-of-the-edited-line`, which `verifyServedRange` rejects with
`E_RANGE_UNVERIFIED`. T2 makes the model robust to partial serves via
"eager heal" + "candidate-span match".

### 4.3 T5 — Terse notices + lean prompts

- `src/edit-engine.ts`: `[E_NOOP_LOOP]` notices and rejects use the
  terse `identical edit (A → B in file) no-op'd twice; range already
  has this text. Resend will reject.` format.
- `src/hashline/anchor-pipeline.ts`: `[E_STALE_ANCHOR]` and
  `[E_AMBIGUOUS_ANCHOR]` use `Re-read for fresh anchors.` instead of
  the long `The file content has changed since those anchors were
  read. Call read() to get fresh anchors, then copy the 3-char HASH
  …` boilerplate.
- `[E_BAD_REF]`, `[E_BAD_OP]`, `[E_INVALID_PATCH]`,
  `[E_BARE_HASH_PREFIX]` similarly trimmed.
- `src/contract.ts` schema one-liners shortened (e.g. `pathSchema`,
  `removeFromSchema`, `removeToSchema` descriptions now 1 line each).

**Why it matters**: model-facing output is shorter per rejection, so
the next edit prompt has more room for the actual code context.
Zed's "terse notices" was a UX study; the upstream benchmark shows
~10% token reduction on chained-edit sessions.

## 5. Schema shape — `edit` parameter

```ts
{
  path: string;                  // optional default path
  edits: Array<{
    op: "ins" | "del" | "replace";  // required
    from: string;                    // required: anchor of first line
    to?: string;                     // optional: anchor of last line
    lines?: string[];                // required for ins/replace; forbidden for del
  }>;
}
```

JSON example, replace one line with two:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "from": "3#abc", "to": "3#abc", "lines": ["new line 1", "new line 2"] }
  ]
}
```

JSON example, insert after line 5:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "ins", "from": "5#xyz", "lines": ["inserted"] }
  ]
}
```

JSON example, delete lines 10-12:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "del", "from": "10#abc", "to": "12#xyz" }
  ]
}
```

JSON example, multi-edit single call (apply in order; each `edits[i]`
sees the file state after `edits[i-1]`):

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "del",   "from": "10#abc", "to": "10#abc" },
    { "op": "replace", "from": "15#xyz", "lines": ["new", "values"] }
  ]
}
```

## 6. Implementation map (per file)

| File | Change |
| --- | --- |
| `src/hashline/hash-assign.ts` | T1: `canon()` strips `[ \t\r\n]+`; export `CANON_VERSION = 2`; introduce `getCanon(cache, line)`; both `lineHashesPure` and `mapStableHashes` use it. |
| `src/hash-store.ts` | T1: cache version bumps on `CANON_VERSION` change. |
| `src/session-view.ts` | T2: `_mergeServedRows` builds a `Map<hash, position>` and nulls the older position on hash collision. `recordServed` / `recordServedTruncated` short-circuit no-op writes. |
| `src/hashline/anchor-pipeline.ts` | T2: `verifyServedRange` candidate-span enumeration. T5: terse `[E_STALE_ANCHOR]`, `[E_AMBIGUOUS_ANCHOR]`, `[E_BAD_REF]`, `[E_BAD_OP]`, `[E_INVALID_PATCH]`, `[E_BARE_HASH_PREFIX]` notices. |
| `src/edit-engine.ts` | T5: terse `[E_NOOP_LOOP]` notices. |
| `src/contract.ts` | T5: schema one-liners. New `EditItemParams` with `op` / `from` / `to?` / `lines?`. Update `EditParams` to `{ path, edits }`. Remove `BatchItemParams` + `BatchEditParams` + `assertBatchEditRequest`. Keep `assertEditRequest` but it now validates the merged `edits` array. |
| `src/constants.ts` | `BATCH_EDIT_MAX_ITEMS` → `EDITS_MAX_ITEMS` (same default 32). |
| `src/prompts.ts` | New `EDIT_DESCRIPTION` + `EDIT_GUIDANCE` (mentions `op` field). Remove `BATCH_EDIT_DESCRIPTION` + `BATCH_EDIT_GUIDANCE`. |
| `src/guidance/resolve.ts` + `materialize.ts` | Drop `tool:batch_edit` section; add nothing new (the `edit` section covers both). |
| `src/tool-edit.ts` | Apply the new contract: each `edits[i]` has `op` / `from` / `to?` / `lines?`; map `op` to existing pipeline ops (insert / remove / replace) via a new `applyOneEdit` helper that returns the structured value. No more `batch_edit` seam. |
| `src/tool-batch-edit.ts` | **Deleted.** |
| `test/core/edit-engine.e2e.test.ts` | Update tests: edit payloads use `op`/`from`/`to`/`lines`; no more `remove_from`/`remove_to`. |
| `test/core/replace-response.test.ts` | Update shape expectations. |
| `test/core/replace-normalize.test.ts` | Update shape expectations. |
| `test/core/hashline-strict-input.test.ts` | Update `E_BARE_HASH_PREFIX` etc. message expectations to match the terse T5 wording. |
| `test/support/fixtures.ts` | Update `wrapTool` to handle the new `edit` shape (single item, `op` field). Remove `batchEditTool` from `setupIntegrationTest`. |
| `test/core/presentation.test.ts` | Update edit / batch_edit tests: drop `batch_edit` test, update `edit` test to assert the new `op` / `from` / `to` / `lines` shape. |
| `test/core/line-hashline.test.ts` | Update edit / shift tests to use `op` form. |
| `README.md` + `README.zh.md` | Update install matrix; remove `batch_edit` row from Tools table; update Quick Start example; update the per-op tool description. |
| `CHANGELOG.md` | New `[Unreleased]` block: T1+T2+T5 cherry-picks; merged `edit` payload with `op` field; `batch_edit` removed. |
| `docs/line-hashline-spec.md` | Update the `edit` contract section: `op` field, `from` / `to` semantics, no more `batch_edit`. |
| `docs/absorption-plan.md` | (Not needed — this spec replaces the absorption plan in spirit.) |

## 7. Test plan

| Test | Asserts |
| --- | --- |
| `edit.op: "ins"` | `lines: ["a"]` after `from` line N inserts at position N+1; `from..N` is unchanged; Shift block shows the +1 below. |
| `edit.op: "ins"` with `to` set | Reject: `[E_BAD_SHAPE] op:"ins" does not accept "to".` |
| `edit.op: "ins"` with empty `lines` | Reject: `[E_BAD_SHAPE] op:"ins" requires a non-empty "lines" array.` |
| `edit.op: "del"` single line | `from` line is removed; Shift block shows the -1 below. |
| `edit.op: "del"` range | `from..to` lines are removed; Shift block shows the -range. |
| `edit.op: "del"` with `lines` set | Reject: `[E_BAD_SHAPE] op:"del" does not accept "lines".` |
| `edit.op: "replace"` single line | `from` line is replaced with `lines`; no Shift block (net line count 0). |
| `edit.op: "replace"` range | `from..to` lines are replaced with `lines`; Shift block if `lines.length !== range.length`. |
| `edit.op: "replace"` with empty `lines` | Reject: `[E_BAD_SHAPE] op:"replace" requires a non-empty "lines" array. Use op:"del" to delete.` |
| `edit.op: "replace"` with `lines: [""]` | Accepted: the line becomes empty (still exists in the file). |
| `edit` with mixed `edits` (ins + del + replace) | All applied in order; each produces its own Shift block. |
| `edit` with no top-level `path` and per-item `path` | Per-item `path` wins; the file used by each edit matches the per-item path. |
| `edit` with neither top-level nor per-item `path` | Reject: `[E_BAD_SHAPE] edits[i] requires a "path" string.` |
| T1: whitespace-only reformat | Before T1: hash rotates, anchor rejects. After T1: hash stable, edit succeeds. |
| T2: orphaned serve | After T1+T2: a partial re-serve doesn't reject the next edit; `verifyServedRange` accepts via candidate-span enumeration when there is exactly one matching span. |
| T5: terse notices | `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` / `[E_NOOP_LOOP]` / `[E_BAD_REF]` messages are the new short forms. |
| `batch_edit` removed | `setupIntegrationTest` no longer exposes `batchEditTool`; the old `batch_edit` integration tests are removed or rewritten as `edit({edits:[...]})` tests. |

## 8. Rollout

1. Land this spec for review (this PR — docs only).
2. PR A — **Cherry-pick T1+T2+T5** (commit-set, non-breaking):
   - Apply upstream's `51dc62d` (T1), `26ee6d4` (T2), `8627b1b` (T5)
     as three independent commits against the current `line#hash` main.
   - Each commit: `npm run typecheck && npm test`.
   - Update CHANGELOG under `[Unreleased]`.
3. PR B — **Merged `edit` payload with `op` field** (breaking):
   - Update `src/contract.ts` (schema + types).
   - Update `src/tool-edit.ts` (apply each `op`).
   - Delete `src/tool-batch-edit.ts`.
   - Update `src/prompts.ts`, `src/guidance/*` (drop `tool:batch_edit`,
     update `tool:edit` description).
   - Update tests in `test/core/edit-engine.e2e.test.ts`,
     `test/core/replace-response.test.ts`,
     `test/core/hashline-strict-input.test.ts`,
     `test/core/presentation.test.ts`,
     `test/core/line-hashline.test.ts`,
     `test/support/fixtures.ts`.
   - Update `README.md` + `README.zh.md` (Tools table, Quick Start,
     correctness-in-edge-cases section, install matrix).
   - Update `CHANGELOG.md` with a new `[0.4.0]` block.
4. Bump version: `0.2.2` → `0.4.0` (minor bump — model contract change).
   The contract change is `edit.remove_from` / `edit.remove_to` →
   `edit.edits[i].{op, from, to?, lines?}` plus the removal of
   `batch_edit`. This is observable to any model that has been
   trained against the old shape.

## 9. Risks and open questions

1. **T1 whitespace-insensitive canon is a hash identity change.** Any
   pre-existing snapshot row that was stored with the old `canon`
   (`trimEnd()` only) is fine — `CANON_VERSION=2` invalidates them.
   Confirmed in upstream: 674/674 tests pass after T1.
2. **T2 candidate-span match changes rejection behavior.** Today a
   multi-candidate span falls through to `E_RANGE_UNVERIFIED`; T2 picks
   the closest match. This is a *correctness* improvement (it is what
   the model meant) but a *behavior* change. If a user pinned on the
   old behavior they will see fewer `E_RANGE_UNVERIFIED` rejections
   after T2.
3. **The merged `edit` payload is a model break.** Models trained
   against `remove_from` / `remove_to` / `replacement_text` will emit
   the old shape. Mitigations:
   - The new `EDIT_DESCRIPTION` in the prompt section is explicit about
     `op` / `from` / `to` / `lines`.
   - The schema description is informative enough that a model that
     reads the tool schema will use the new shape.
   - For one release cycle, we can soft-reject the old shape with a
     clear `[E_BAD_SHAPE] edit was refactored; use {op, from, lines?}`.
4. **Bumping to 0.4.0 is correct.** Anything model-observable is a
   minor-version bump per `CLAUDE.md` guidance. T1+T2+T5 individually
   could ship as 0.3.x (no model break), but bundling them with the
   `edit` payload change is cleaner in a single release. We split
   T1+T2+T5 into a separate PR (A) so the model break is isolated.

## 10. References

- **Upstream cherry-picks** (parent commits):
  - `51dc62d` — T1: whitespace-insensitive canon (ADR-0005)
  - `26ee6d4` — T2: orphaned serve healing (ADR-0008)
  - `8627b1b` — T5: terse notices + lean prompts
  - `46c0dd0` — T4: arch purity + DebouncedPreview (NOT included; out of scope)
  - `535e582` — T3: merged edit payload (basis for §3; we diverge with named fields + `op` semantics)
- **Upstream ADR list**: `docs/absorption-plan.md` (upstream); `docs/adr/0001-guidance-override-files.md` (this fork)
- **Current line#hash spec** this extends: `docs/line-hashline-spec.md`