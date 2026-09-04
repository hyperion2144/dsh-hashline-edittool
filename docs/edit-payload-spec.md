# Spec — Upstream cherry-picks + merged `edit` payload with `op` semantics

> Status: **Superseded in part by `dynamic-hashline-spec.md`** — authoritative for the 0.4.x `edit` payload shape (op semantics, edits array, per-item path). The 0.5/v2.0 dynamic-anchor contract (variable-length Base62 anchors, no `line#hash`, no Shift blocks, optional `line_numbers`) is governed by [`dynamic-hashline-spec.md`](./dynamic-hashline-spec.md); where the two conflict, that spec wins.
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
    - Our variant uses **named fields** (`anchor_start` / `anchor_end` / `lines` / `op`)
      and **explicit op semantics** (`ins` / `del` / `replace`):
      - `op: "ins"` — insert `lines` after the `anchor_start` line. `anchor_start` is
        required; `anchor_end` is forbidden; `lines` is required and non-empty.
      - `op: "del"` — delete the `anchor_start` line, or the `anchor_start..anchor_end` range
        if `anchor_end` is given. `anchor_start` is required; `lines` is forbidden.
      - `op: "replace"` — replace the `anchor_start` line, or the `anchor_start..anchor_end`
        range if `anchor_end` is given, with `lines`. `anchor_start` is required;
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
      description: "Edit semantic. `ins` inserts after `anchor_start`; `del` deletes the anchor_start..anchor_end range (single line when `anchor_end` is omitted); `replace` swaps the anchor_start..anchor_end range with `lines`.",
    },
    anchor_start: {
      type: "string",
      required: true,
      description: "Anchor of the FIRST line of the range. A `<line>#<hash>` marker (e.g. `12#ve7`) copied from a read/grep/diff row — never hand-written or bare hashes. For `op: ins`, the inserted lines land AFTER this line; for `del` and `replace`, this is the first line of the affected range.",
    anchor_end: {
      type: "string",
      description: "Anchor of the LAST line of the range. When omitted, the edit targets just the `anchor_start` line. Forbidden for `op: ins`; REQUIRED for `op: replace` (a single-line replace passes the same anchor twice).",
    lines: {
      type: "array",
      items: { type: "string" },
      description: "Lines to insert (for `ins`) or replace with (for `replace`). Required and must be non-empty for `ins` and `replace`. Forbidden for `del`.",
    },
  },
}
```

### 3.2 `op` semantics — exhaustive

| `op`     | `anchor_start` | `anchor_end` | `lines`            | Behaviour |
| -------- | -------------- | ------------ | ------------------ | --------- |
| `ins`    | ✓ required     | ✗ forbidden  | ✓ required, `≥ 1`  | Insert `lines` **after** the `anchor_start` line. The `anchor_start` line itself is preserved. |
| `del`    | ✓ required     | optional (default = `anchor_start`) | ✗ forbidden | Delete the `anchor_start` line, or the `anchor_start..anchor_end` range if `anchor_end` is given. |
| `replace`| ✓ required     | ✓ required   | ✓ required, `≥ 1`  | Swap the `anchor_start..anchor_end` range with `lines`; a single-line replace passes the same anchor twice (`anchor_start === anchor_end`). |

Validation rules (in `execute`, after schema soft-validates the schema shape):

- If `op === "ins"` and `anchor_end` is set → not rejected (lenient): a warning is emitted — `edits[i].op:"ins" ignores anchor_end — ins inserts after anchor_start; drop the field.`
- If `op === "del"` and `lines` is set → accepted and IGNORED (issue #69): deletion is defined by the anchors alone; no warning, no rejection.
- If `op === "replace"` and `anchor_end` is missing → `[E_MISSING_ANCHOR_END] edits[i].op:"replace" requires BOTH anchor_start and anchor_end — replace always swaps a whole range; for a single-line replace pass the same anchor twice (anchor_start === anchor_end). To insert lines, use op:"ins".`
- If `op === "replace"` and `lines` is missing or empty → `[E_BAD_SHAPE] edits[i].op:"replace" requires a non-empty "lines" array of strings. Use op:"del" to delete.`
  (An edit that replaces with `[""]` is distinct from `op:"del"`: the line
  still exists in the file, just empty. The `anchor_start..anchor_end` range
  shrinks by 0 if single-line.)
- If `op === "ins"` and `lines` is missing or empty → `[E_BAD_SHAPE] edits[i].op:"ins" requires a non-empty "lines" array of strings to insert.`

### 3.3 Edit application order and Shift blocks

The Shift block behaviour (per the existing `line#hash` spec at
`docs/line-hashline-spec.md`) is preserved. Each `ins` / `del` /
`replace` edit within the `edits` array produces its own Shift block
when the net line-count change is non-zero, in the same `Shift:
lines > N shift by +K` format the model already chains against.

**Snapshot-concurrency (0.4).** Every hunk in one `edit` call resolves its
`anchor_start` / `anchor_end` against the **same original file snapshot**, so
all hunks may use ORIGINAL anchors — there is no manual `newLine#oldHash`
chaining. Hunks whose row ranges overlap on that snapshot are rejected up
front with `[E_BATCH_CONFLICT]` (replace/del × replace/del overlap; two `ins`
at the same anchor line; an `ins` whose anchor line lies inside a
replace/del range). Non-overlapping hunks apply atomically, in ONE pass from
the back, and remain all-or-nothing.

The `Shift:` blocks map each hunk's ORIGINAL range to its FINAL position
(e.g. `Shift: edits[1] lines 5..6 moved to lines 7..9 (+2)`), and the diff
rows carry final line numbers + hashes throughout — the model chains the
next edit by reading the Shift block, never by shifting coordinates.

`ins` adds `lines.length` lines below the `anchor_start` line; the
`anchor_start` line itself does not move, but every line below it does —
the Shift block quantifies that for the chain.

`del` removes the `anchor_start..anchor_end` range (or just the
`anchor_start` line when `anchor_end` is omitted). Lines below close up.

`replace` swaps the `anchor_start..anchor_end` range for `lines`; when the
net line count changes, the Shift block quantifies the shift for the chain.

Edits in the same `edits` array apply atomically against the original
snapshot described above — the 0.3-era `applySequence` evolving-content
order is gone.

### 3.4 Tool description (model-facing) and prompt text

`EDIT_DESCRIPTION` (in `src/prompts.ts`):

> Apply one or more edits atomically: each item is `{op: ins|del|replace, anchor_start, anchor_end?, lines?}`; anchors are `<line>#<hash>` copied from read/grep/diff rows, never line content. Items resolve against one file snapshot — overlapping ranges are rejected (`[E_BATCH_CONFLICT]`).

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
`anchor_start` + `anchor_end`; omitting `anchor_end` means single-line, no
defaulting. A single-line `del` becomes `{op: "del", anchor_start: "12#ve7"}`;
a single-line `replace` becomes `{op: "replace", anchor_start: "12#ve7",
anchor_end: "12#ve7", lines: ["new"]}`.

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
    anchor_start: string;            // required: anchor of first line
    anchor_end?: string;             // optional: anchor of last line (required for replace)
    lines?: string[];                // required for ins/replace; forbidden for del
  }>;
}
```

JSON example, replace one line with two:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "replace", "anchor_start": "3#abc", "anchor_end": "3#abc", "lines": ["new line 1", "new line 2"] }
  ]
}
```

JSON example, insert after line 5:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "ins", "anchor_start": "5#xyz", "lines": ["inserted"] }
  ]
}
```

JSON example, delete lines 10-12:

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "del", "anchor_start": "10#abc", "anchor_end": "12#xyz" }
  ]
}
```

JSON example, multi-edit single call (all hunks resolve against the same
original snapshot; overlapping ranges are rejected; applied atomically):

```json
{
  "path": "src/foo.ts",
  "edits": [
    { "op": "del",   "anchor_start": "10#abc", "anchor_end": "10#abc" },
    { "op": "replace", "anchor_start": "15#xyz", "lines": ["new", "values"] }
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
| `src/contract.ts` | T5: schema one-liners. New `EditItemParams` with `op` / `anchor_start` / `anchor_end?` / `lines?`. Update `EditParams` to `{ path, edits }`. Remove `BatchItemParams` + `BatchEditParams` + `assertBatchEditRequest`. Keep `assertEditRequest` but it now validates the merged `edits` array. |
| `src/constants.ts` | `BATCH_EDIT_MAX_ITEMS` → `EDITS_MAX_ITEMS` (same default 32). |
| `src/prompts.ts` | New `EDIT_DESCRIPTION` + `EDIT_GUIDANCE` (mentions `op` field). Remove `BATCH_EDIT_DESCRIPTION` + `BATCH_EDIT_GUIDANCE`. |
| `src/guidance/resolve.ts` + `materialize.ts` | Drop `tool:batch_edit` section; add nothing new (the `edit` section covers both). |
| `src/tool-edit.ts` | Apply the new contract: each `edits[i]` has `op` / `anchor_start` / `anchor_end?` / `lines?`; map `op` to existing pipeline ops (insert / remove / replace) via a new `applyOneEdit` helper that returns the structured value. No more `batch_edit` seam. |
| `src/tool-batch-edit.ts` | **Deleted.** |
| `test/core/edit-engine.e2e.test.ts` | Update tests: edit payloads use `op`/`anchor_start`/`anchor_end`/`lines`; no more `remove_from`/`remove_to`. |
| `test/core/replace-response.test.ts` | Update shape expectations. |
| `test/core/replace-normalize.test.ts` | Update shape expectations. |
| `test/core/hashline-strict-input.test.ts` | Update `E_BARE_HASH_PREFIX` etc. message expectations to match the terse T5 wording. |
| `test/support/fixtures.ts` | Update `wrapTool` to handle the new `edit` shape (single item, `op` field). Remove `batchEditTool` from `setupIntegrationTest`. |
| `test/core/presentation.test.ts` | Update edit / batch_edit tests: drop `batch_edit` test, update `edit` test to assert the new `op` / `anchor_start` / `anchor_end` / `lines` shape. |
| `test/core/line-hashline.test.ts` | Update edit / shift tests to use `op` form. |
| `README.md` + `README.zh.md` | Update install matrix; remove `batch_edit` row from Tools table; update Quick Start example; update the per-op tool description. |
| `CHANGELOG.md` | New `[Unreleased]` block: T1+T2+T5 cherry-picks; merged `edit` payload with `op` field; `batch_edit` removed. |
| `docs/line-hashline-spec.md` | Superseded instead of updated (2026-08-30, issue #6): kept as the 0.3-era historical record with a "Superseded by `edit-payload-spec.md`" header. |
| `docs/absorption-plan.md` | (Not needed — this spec replaces the absorption plan in spirit.) |

## 7. Test plan

| Test | Asserts |
| --- | --- |
| `edit.op: "ins"` | `lines: ["a"]` after `anchor_start` line N inserts at position N+1; the anchor line itself is unchanged; Shift block shows the +1 below. |
| `edit.op: "ins"` with `anchor_end` set | Not rejected (lenient): warning `edits[i].op:"ins" ignores anchor_end — ins inserts after anchor_start; drop the field.` |
| `edit.op: "ins"` with empty `lines` | Reject: `[E_BAD_SHAPE] edits[i].op:"ins" requires a non-empty "lines" array of strings to insert.` |
| `edit.op: "del"` single line | `anchor_start` line is removed; Shift block shows the -1 below. |
| `edit.op: "del"` range | `anchor_start..anchor_end` lines are removed; Shift block shows the -range. |
| `edit.op: "del"` with `lines` set | Accepted; `lines` is IGNORED (issue #69) — deletion is defined by `anchor_start..anchor_end` alone. |
| `edit.op: "replace"` single line | `anchor_start` line is replaced with `lines` (both anchors passed); no Shift block (net line count 0). |
| `edit.op: "replace"` range | `anchor_start..anchor_end` lines are replaced with `lines`; Shift block if `lines.length !== range.length`. |
| `edit.op: "replace"` with empty `lines` | Reject: `[E_BAD_SHAPE] edits[i].op:"replace" requires a non-empty "lines" array of strings. Use op:"del" to delete.` |
| `edit.op: "replace"` with `lines: [""]` | Accepted: the line becomes empty (still exists in the file). |
| `edit` with mixed `edits` (ins + del + replace) | All hunks resolve against the same original snapshot (overlaps rejected); each produces its own Shift block. |
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
     `op` / `anchor_start` / `anchor_end` / `lines`.
   - The schema description is informative enough that a model that
     reads the tool schema will use the new shape.
   - The old field names (`from` / `to` / `remove_from` / `remove_to` /
     `replacement_text`) are rejected as unknown fields
     (`additionalProperties: false`), with the spec + prompt section as
     the recovery path.
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