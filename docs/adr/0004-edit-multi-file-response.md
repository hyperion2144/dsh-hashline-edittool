# ADR-0004 — Multi-file `edit` response shape & same-file-twice semantics

> **Status**: Accepted (issue #39 spec locked 2026-08-30; ADRs 0002 + 0003 already merged; #35 regression test PR #41 still red until implementation lands). Implementation PR lands after this ADR merges; #39 closes upon merge.

## Problem Statement

From the user's perspective, the `edit` tool today is single-file with a structured return value that includes `before`/`after` whole-file content (a dsh-tool-fs compatibility carry-over that the model in this DSH environment does not actually consume — see ADR-0004 §"0.4 EditCanonicalValue 实际用途" below). When multi-file dispatch lands (per ADR-0003), two questions become unavoidable:

- What does the agent see when one `edit({path, edits:[…]})` call touches N files with mixed success/failure?
- When two items in one batch target the same `absolutePath`, is that a conflict or a sub-batch?

The current code (`src/edit-response.ts` `buildBatchResult` line 286-383) is single-file only and cannot represent per-file failure.

## Solution

Multi-file response is a single tool-call value that **aggregates the per-file results of N independent single-file edit runs**. The shape is `{success: Array<PerFileResult>, fail: Array<PerFileFail>}`:

- **`success[i]`** is the per-file structured result: the 0.4 `EditCanonicalValue` **with `before`/`after` removed** and **a new `diff` field added** (anchor-keyed, mirror of read's `lines`).
- **`fail[i]`** is a new per-file failure shape (`{path, error: {code, message, modelText, echoRows?}}`) that 0.4 did not need because 0.4 failed by throwing.

Same-file-twice in one batch is **auto-merged into that file's sub-batch** and processed by the existing 0.4 single-file path. Within the sub-batch, 0.4's existing `[E_BATCH_CONFLICT]` behavior (overlapping anchors → noop-on-conflict or row-overlap rejection) is preserved unchanged.

## User Stories

1. As a **model** invoking `edit`, I want each file in a multi-file call to behave exactly like a separate single-file edit, so that my mental model "multi-file = N concurrent single-file edits" is honored.
2. As a **model**, I want partial success reported explicitly — successful files' results and failed files' errors in the same response — so that I can decide what to retry.
3. As a **model**, I want per-file `diff` in the response so I don't have to re-read the file to know what changed; the anchor-keyed map is a tighter signal than the prose `modelText`.
4. As a **maintainer**, I want per-file entry to be a *trimmed* version of the existing 0.4 canonical value (drop `before`/`after`, add `diff`), not a brand-new shape, so that the test surface and code surface stay close.
5. As a **script caller**, I want `success[i]` to carry enough structured fields (added/removed/firstChangedLine/lastChangedLine/noop/hints/warnings) to support automation without parsing the modelText.

## Implementation Decisions

The following is the **target contract state** — what holds after the implementation PR lands.

### D1 — `success[i]` shape (per-file result)

```jsonc
{
  "ok": true,
  "path": "b1.txt",
  "diff": {                                 // anchor-keyed; mirror of read's `lines`
    "-2#BPc": "old line content",            // removed / pre-change
    "+2#BPc": "new line content",            // added / post-change
    " 3#ZvS": "unchanged line"                // context (no +/- prefix)
  },
  "added": 1,
  "removed": 1,
  "firstChangedLine": 2,
  "lastChangedLine": 2,
  "hints": ["edits[0]: line 2 moved to line 2 (0)"],
  "warnings": [],
  "noop": false,
  "modelText": "ANCHOR:FILELINE — ...\n 1#...: a\n-2#...: beta\n+2#...: B1!\n 3#...: c\n\nSuccessfully edited in b1.txt. Added 1 line(s), removed 1 line(s)."
}
```

This is the 0.4 `EditCanonicalValue` minus `before`/`after` plus a new `diff` field. Field rationale:

| Field | Source | Why present |
|---|---|---|
| `ok` | `buildEditJson` line 520 | Distinguishes success from failure (failure entries use the same outer container; the `fail[]` array separates them) |
| `path` | canonical value line 66 | The file this entry is about |
| `diff` | **new** | Anchor-keyed, mirror of read's `lines`; model can `success[i].diff["+2#BPc"]` to get the new line directly |
| `added`/`removed` | canonical value line 69-70 | Counters; cheaper than diff-text length math |
| `firstChangedLine`/`lastChangedLine` | canonical value line 71-72 | For shift-aware follow-up edits (`newLine=` markers) |
| `hints` | `buildEditJson` line 491 | Per-hunk shift notices, machine-readable |
| `warnings` | canonical value line 74 | Per-file warnings, not aggregated |
| `noop` | canonical value line 76 | `true` if the file was untouched (per-file atomicity can produce noops) |
| `modelText` | canonical value line 77 | Human-readable prose; source-of-truth for the rendered text |

### D2 — `fail[i]` shape (per-file failure)

```jsonc
{
  "path": "b2.txt",
  "error": {
    "code": "[E_BATCH_CONFLICT]",
    "message": "edits[1] line 2 and edits[2] line 2 overlap — every hunk is resolved against the same original snapshot, so row ranges must not overlap in one batch. Split into separate edits or merge the ranges. Nothing was written.",
    "modelText": "Edit for b2.txt failed: [E_BATCH_CONFLICT] \n... (human-readable)",
    "echoRows": [/* 0.4 失败点的 anchor ±N 上下文 */]
  }
}
```

0.4 did not have a per-file failure shape because it failed by throwing. Multi-file requires per-file error reporting, so this is a **new shape**. The `error.code` and `error.message` mirror 0.4's existing `[E_*]` error format; `error.echoRows` is the existing 0.4 `servedRows` semantics; `error.modelText` is the human-readable counterpart.

### D3 — `presentationMeta.diffs: FileDiff[]` (cross-success)

`presentationMeta.diffs` is `FileDiff[]` (one entry per `success[i]`, in input order). Each `FileDiff` is `{path, oldText, newText}` — the same shape the single-file tool already produces via `computeHunkDiffs`. The dsh web UI renders these as the multi-file diff card. Same-file-twice is auto-merged before this computation, so the array length equals the count of *successful files* (not items).

### D4 — Same `absolutePath` twice in one batch

**Auto-merge into that file's sub-batch.** All items with `absolutePath === X` collapse into one X-bounded sub-batch and are processed by the existing 0.4 single-file pipeline (`runFileEdits` per file, `commit()` per file, `saveUndo` per file). Within the sub-batch:

- **Disjoint row ranges**: applied in order; output diff reflects the union.
- **Overlapping row ranges**: 0.4's `[E_BATCH_CONFLICT]` rejects the sub-batch atomically (per-file atomicity from ADR-0003 D2). The `fail` entry is `{path: X, error: {code: "[E_BATCH_CONFLICT]", ...}}`.

This option is selected because (a) it composes cleanly with ADR-0003's per-file atomicity — "X's items become X's transaction"; (b) it preserves 0.4's existing batch-conflict semantics within a file; (c) the model caller doesn't need to learn a new conflict vocabulary — the failure message is the same `[E_BATCH_CONFLICT]` they would have seen for a single-file call.

### D5 — Single-file compat: `edit({path, edits:[…]})` continues to return the 0.4 canonical value verbatim

When the call has a single `absolutePath` target, the tool returns the 0.4 `EditCanonicalValue` shape unchanged (`{path, before, after, added, removed, ..., noop, modelText}`). The `before`/`after` fields stay for **0.4 single-file compatibility** (the dsh-tool-fs contract). Multi-file path is opt-in via ≥ 2 distinct `absolutePath` values across items.

## 0.4 EditCanonicalValue 实际用途（事实记录）

Per #39 ## "0.4 单文件 EditCanonicalValue 实际用途（事实记录）" — recorded for future maintainers' reference:

`EditCanonicalValue` (`src/tool-edit.ts:65-72`) is the **structured return value** of the 0.4 single-file `edit` tool. dsh runtime consumes it in four ways:

1. `output.render` (line 151-153) projects `value.modelText` to `content[].text` — the model actually sees this.
2. `output.presentationMeta` (line 154-159) uses `value.before` + `value.after` to compute `diffs: FileDiff[]` for the dsh web UI diff card.
3. `output.schema` (line 133-180) declares the JSON shape to dsh runtime; `before`/`after` are **required** fields (public contract, not internal).
4. JSON output mode (line 247-253, `isJsonOutput()` true): `modelText` is replaced by `JSON.stringify(buildEditJson(...))`. `buildEditJson` (line 485-527) outputs `{ok, path, diff: {<+>anchor: content}, hints, warnings, errors}` from `before`/`after`.

**Implication for multi-file**: the model in this DSH environment sees only `output.render`'s `content[].text`. `before`/`after` are not consumed by the model — they exist for dsh web UI and JSON-mode downstream. Multi-file `success[i]` therefore **drops** `before`/`after` to avoid dumping N× whole-file content into a single response.

## ASCII schema examples

### A. Happy-path (multi-file success)

Request:
```jsonc
{
  "path": "b1.txt",            // top-level default per ADR-0002
  "edits": [
    { "op": "replace", "anchor_start": "1#...", "anchor_end": "1#...", "lines": ["A1!"] },
    { "op": "replace", "path": "b2.txt", "anchor_start": "2#...", "anchor_end": "2#...", "lines": ["B2!"] }
  ]
}
```

Response:
```jsonc
{
  "success": [
    {
      "ok": true, "path": "b1.txt",
      "diff": {"-1#...": "alpha", "+1#...": "A1!"},
      "added": 1, "removed": 1,
      "firstChangedLine": 1, "lastChangedLine": 1,
      "hints": [], "warnings": [], "noop": false,
      "modelText": "ANCHOR:FILELINE — ...\n-1#...: alpha\n+1#...: A1!\n\nSuccessfully edited in b1.txt. Added 1 line(s), removed 1 line(s)."
    },
    {
      "ok": true, "path": "b2.txt",
      "diff": {"-2#...": "y", "+2#...": "B2!"},
      "added": 1, "removed": 1,
      "firstChangedLine": 2, "lastChangedLine": 2,
      "hints": [], "warnings": [], "noop": false,
      "modelText": "ANCHOR:FILELINE — ...\n 1#...: x\n-2#...: y\n+2#...: B2!\n 3#...: z\n\nSuccessfully edited in b2.txt. Added 1 line(s), removed 1 line(s)."
    }
  ],
  "fail": [],
  "presentationMeta": {
    "diffs": [/* FileDiff[] computed from success[].diff, in input order */]
  }
}
```

### B. Partial failure (b2 sub-batch conflict → b1 succeeds, b2 fails)

Request:
```jsonc
{
  "path": "b1.txt",
  "edits": [
    { "op": "replace", "anchor_start": "1#...", "anchor_end": "1#...", "lines": ["A1!"] },
    { "op": "replace", "path": "b2.txt", "anchor_start": "2#...", "anchor_end": "2#...", "lines": ["X!"] },
    { "op": "replace", "path": "b2.txt", "anchor_start": "2#...", "anchor_end": "2#...", "lines": ["Y!"] }  // same anchor → [E_BATCH_CONFLICT]
  ]
}
```

Response (per-file atomicity applies per ADR-0003 D2):
```jsonc
{
  "success": [
    {
      "ok": true, "path": "b1.txt",
      "diff": {"-1#...": "alpha", "+1#...": "A1!"},
      "added": 1, "removed": 1,
      "firstChangedLine": 1, "lastChangedLine": 1,
      "hints": [], "warnings": [], "noop": false,
      "modelText": "Successfully edited in b1.txt. ..."
    }
  ],
  "fail": [
    {
      "path": "b2.txt",
      "error": {
        "code": "[E_BATCH_CONFLICT]",
        "message": "edits[1] line 2 and edits[2] line 2 overlap — every hunk is resolved against the same original snapshot, so row ranges must not overlap in one batch. Split into separate edits or merge the ranges. Nothing was written.",
        "modelText": "Edit for b2.txt failed: [E_BATCH_CONFLICT] \n...",
        "echoRows": [/* 0.4 失败点 ±3 行 */]
      }
    }
  ],
  "presentationMeta": {
    "diffs": [/* only b1's FileDiff */]
  }
}
```

b1 atomic — committed. b2 atomic — sub-batch conflict, the sub-batch is rejected, the per-file failure goes into `fail[]`. Cross-file is independent (ADR-0003 D2).

## Relationship to other ADRs

- **ADR-0002 (schema contract)**: top-level `path` is the per-call default; per-item `path` overrides per file. `success[i].path` reflects the resolved file for that entry.
- **ADR-0003 (atomicity, concurrency, undo)**: per-file atomicity is the precondition for the `{success, fail}` two-array shape — one file's failure does not affect another's success. ADR-0003 §D5 wording ("`success: Array<{path, before, after, noopEdit?, warnings, driftNotice?}>`") is **amended** by this ADR: `before`/`after` are dropped in multi-file; `diff` is added; `noopEdit?` is renamed to `noop` (consistent with the canonical value's name and is the `edit` tool's existing field name).
- **#35 (parent bug)** and **PR #41 (regression test)**: the strengthened `test/core/presentation.test.ts:173-208` case is the integration test for this ADR's success-path shape. Implementation PR turns it green.

## Carry-forward to ADR-0003 §D5 (amendment)

The current ADR-0003 §D5 wording is:

> The multi-file response is a single tool-call value with **two parallel arrays**:
> - `success: Array<{path, before, after, noopEdit?, warnings, driftNotice?}>` — one entry per file that committed fully.
> - `fail: Array<{path, error: {code, message, echoRows?}}>` — one entry per file that failed its commit.

This wording is **amended** by this ADR. The amended D5 reads:

> The multi-file response is a single tool-call value with **two parallel arrays**:
> - `success[i]` is the per-file structured result: the 0.4 `EditCanonicalValue` **with `before`/`after` removed** and **a new `diff` field added** (anchor-keyed; mirror of read's `lines`). Full field set: `{ok, path, diff, added, removed, firstChangedLine?, lastChangedLine?, hints, warnings, noop, modelText}`.
> - `fail[i]` is the per-file failure shape: `{path, error: {code, message, modelText, echoRows?}}`. New shape (0.4 had no per-file failure because it failed by throwing).

The `before`/`after` removal is **load-bearing**: in a multi-file call with N large files, including `before`/`after` would dump N× whole-file content into the response. The model does not read these fields (per "0.4 EditCanonicalValue 实际用途" above); they were dsh-tool-fs compatibility carry-over that 0.4's edit tool never needed.

## Out of Scope

- **Single-file response shape change**. Single-file `edit` calls continue to return the 0.4 canonical value verbatim, including `before`/`after`. Backwards compat for 0.4 single-file callers.
- **`before`/`after` removal from 0.4 single-file**. That would be a 0.5 contract change; out of scope for the multi-file feature.
- **Cross-mode multi-file (line-anchor + AST simultaneously)**. Per wayfinder map #36's `Out of scope`.
- **`buildEditJson` shape changes**. ADR-0004 multi-file does not change 0.4 single-file JSON output. The multi-file JSON path may produce an analogous `{ok, success, fail, ...}` envelope in a future ADR if needed; not in this one.
- **Performance optimization for very large multi-file batches** (e.g., streaming diffs). N-file-dump is acceptable for N up to ~10; beyond that, an envelope-streaming protocol is a separate decision.

## Further Notes

- **`diff` shape rationale**: anchor-keyed with `+`/`-` prefix mirrors read's `lines` shape (`Record<line#hash, content>`). The prefix in the key is the diff marker; the value is verbatim line content. This format is consistent with what the model reads in `modelText` and what `buildEditJson` produces — no new shape, just lifted to first-class field.
- **No `before`/`after` is a deletion, not a rename**: the field is omitted entirely from multi-file `success[i]`, not aliased. This matches the model's read behavior and avoids bloat.
- **The user's correction during the #39 grill**: the maintainer rejected the "verbatim 0.4 canonical value" framing in the first correction because `before`/`after` are noise. The second correction refined the shape to a trimmed canonical value plus `diff`. The amendment to ADR-0003 §D5 reflects this.
- **Real-machine smoke mandatory**: per CLAUDE.md and sister map #10's lesson — vitest suite passing is necessary but not sufficient. Implementation PR must also pass a smoke-profile or `DSH_HOME=$(mktemp -d)` end-to-end boot. Profile-redline: never install the experimental branch into the `web` profile.
