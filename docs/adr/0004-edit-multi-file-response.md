# ADR-0004 — Multi-file `edit` aggregated tool call result

> **Status**: Accepted (supersedes the previous ADR-0004 merged in `831801a`; this rewrite is a correction based on the #39 grill session on 2026-08-30 where the LLM-visible result was re-grounded against the dsh runtime). See wayfinder map #36 + tickets #37 / #38 / #39. Implementation PR lands after this ADR merges; #39 closes upon merge.

## Problem Statement

From the model's perspective, the `edit` tool today is single-file. The model receives, on every call, **one** tool call result with `content[].text`:
- text mode: prose (ANCHOR:FILELINE block + summary line)
- json mode: stringified JSON envelope from `buildEditJson` (e.g. `{"ok":true,"path":"...","diff":{...},"hints":[...],...}`)

When multi-file dispatch lands (per ADR-0003), two questions become unavoidable:
- What does the model see when one `edit({path, edits:[…]})` call touches N files with mixed success/failure?
- When two items in one batch target the same `absolutePath`, is that a conflict or a sub-batch?

The model's view of the response is the **only** contract that matters for callers. Whatever the dsh tool runtime stores internally for dsh web UI rendering or JSON-envelope construction is out of scope of this ADR.

## Solution

Multi-file is **N independent single-file edit calls' results, aggregated by file**. The aggregated `content[].text` is structured as a `{success: […], fail: […]}` container in both text and json modes:

- **`content[].text` in text mode** is the aggregated prose: each successful file appears as its own `Successfully edited in <path>.` block (with the ANCHOR:FILELINE diff), separated by `--- <path> ---` lines; each failed file appears as its own `Error: [E_*] <message>` block. A top summary line `Successfully edited N file(s) — M of K edit(s) applied (X noop).` is included when the batch is all-noop. Failed-file blocks are appended after the success blocks.

- **`content[].text` in json mode** is the stringified JSON envelope `{"ok":<bool>, "success":[…per-file envelopes], "fail":[…error entries]}`. Each `success[i]` is the verbatim `buildEditJson` output (i.e. 0.4 single-file edit's JSON envelope). Each `fail[i]` is `{path, code, message}` — the structured capture of 0.4's `Error` throw.

Same-`absolutePath` items in one batch are **auto-merged into that file's sub-batch** and processed by the existing 0.4 single-file path. Within the sub-batch, 0.4's existing `[E_BATCH_CONFLICT]` behavior (overlapping anchors → sub-batch rejected) is preserved; the file then goes into `fail[]`.

Single-file `edit({path, edits:[…]})` calls keep the 0.4 `content[].text` shape unchanged. Multi-file path is opt-in via ≥ 2 distinct `absolutePath` values across items.

## User Stories

1. As a **model**, when I call `edit` with items targeting two different files and both succeed, I want `content[].text` to give me the diff of each file in one read — I do not want to make two `edit` calls.
2. As a **model**, when one file succeeds and one fails, I want `content[].text` to tell me both outcomes in one read — I do not want to figure out which file failed by retrying.
3. As a **model**, I want the failed file's `content[].text` segment to be just the error message (e.g. `Error: [E_STALE_ANCHOR] …`) — not the file's original content. If I need the file content, I call `read`.
4. As a **model**, when I set `jsonOutput: true`, I want `content[].text` to be a stringified JSON envelope I can parse into `{ok, success:[…], fail:[…]}`. Each `success[i]` should be the same shape 0.4 single-file edit returns (`{ok, path, diff, hints, warnings, errors}`), so my existing single-file scripts work unchanged.
5. As a **script caller**, when I parse the json envelope of a multi-file call, I want the top-level `success` and `fail` arrays to be plain arrays — I want a single `for` loop, not a tree walk.

## Implementation Decisions

The following is the **target contract state** — what holds after the implementation PR lands.

### D1 — `content[].text` in text mode (default)

For a multi-file call with mixed results, `content[].text` is the prose string:

```
Successfully edited <N> file(s) — <M> of <K> edit(s) applied (<X> noop).

--- <path1> ---
ANCHOR:FILELINE — each row is `<line>#<hash>:<content>`; edit uses the LEFT "line#hash" marker as its anchor; everything after ":" is the verbatim file content; to modify the file, pass the content after ":" — never the anchor part.
 <+-><line#hash>: <content>
 ...

Successfully edited in <path1>. Added <a> line(s), removed <b> line(s).

--- <path2> ---
ANCHOR:FILELINE — ...
 ...

Successfully edited in <path2>. Added <a> line(s), removed <b> line(s).

Edit for <path3> failed: [E_*] <message>

  Echo of the line you tried (read-style, ±3 context):
ANCHOR:FILELINE — ...
 ...

  If this is the line you meant to edit, reuse a fresh marker from: ...
  If not, call read() to find the correct line.
```

Format rules:
- **Per-file success**: the same prose that 0.4 single-file edit returns for that file. The aggregation just concatenates these blocks with `--- <path> ---` separators (same as `buildBatchResult`'s multi-file sectioning).
- **Per-file fail**: `Edit for <path> failed: [E_*] <message>` followed by the REST of the single-file error text verbatim — including the ±3 echo block and the fresh-marker hint, exactly as 0.4's throw path renders them. The multi-file container only changes the organization; the per-file content is the single-file error unchanged. The batch-abort tail (`The whole batch was rejected …`) is stripped: it is single-file batch wording and would misstate the multi-file outcome (other files DID commit).
- **Order**: success blocks first, then fail blocks.
- **Summary line**: `Successfully edited <N> file(s) — <M> of <K> edit(s) applied (<X> noop).` (or the equivalent when all are noop). The `Successfully edited in <path>.` per-file line remains inside each block.
- **No file content** beyond what 0.4 already exposes (per-file success block, or the echo lines in a fail block — ±3 rows, same as single-file).

### D2 — `content[].text` in json mode (`jsonOutput: true`)

For a multi-file call with mixed results, `content[].text` is the stringified JSON envelope:

```json
{
  "ok": true,
  "success": [
    {
      "ok": true,
      "path": "<path1>",
      "diff": {"<+|-><line#hash>": "<content>", ...},
      "hints": [],
      "warnings": [],
      "errors": []
    },
    ...
  ],
  "fail": [
    {"path": "<path3>", "code": "[E_*]", "message": "<message>"},
    ...
  ]
}
```

Format rules:
- **Top-level**: `ok`, `success`, `fail`. `ok` is `true` iff at least one file succeeded (i.e. `fail.length === 0`); partial success has `ok: true` and a non-empty `fail`.
- **`success[i]` is the verbatim `buildEditJson` output** for that file (i.e. 0.4 single-file edit's JSON envelope verbatim). The `diff` field uses the same anchor-keyed map shape with `+`/`-` prefix as 0.4 single-file.
- **`fail[i]` is `{path, code, message}`** — structured capture of 0.4's `Error` throw. `code` is the `[E_*]` prefix token. `message` is the rest of the error text. No `before`/`after`, no `echoRows`, no `diff`, no `modelText` — the model can `read` the file if it needs content.
- **Order**: success array in input order; fail array in input order.

### D3 — Same `absolutePath` twice in one batch

**Auto-merge into that file's sub-batch.** All items with `absolutePath === X` collapse into one X-bounded sub-batch and are processed by the existing 0.4 single-file pipeline. Within the sub-batch:

- **Disjoint row ranges**: applied in order; output `diff`/`modelText` reflects the union.
- **Overlapping row ranges**: 0.4's `[E_BATCH_CONFLICT]` rejects the sub-batch atomically (per-file atomicity from ADR-0003 D2). The file goes into `fail[]` with `code: "[E_BATCH_CONFLICT]"`.

This option composes cleanly with ADR-0003's per-file atomicity — "X's items become X's transaction". It preserves 0.4's existing batch-conflict semantics within a file, so the model's mental model "the same anchor twice in one batch is a `[E_BATCH_CONFLICT]`" continues to hold.

### D4 — Single-file compat: `edit({path, edits:[…]})` returns the 0.4 `content[].text` verbatim

When the call has a single `absolutePath` target, the tool returns the 0.4 `content[].text` shape unchanged:
- text mode: 0.4 prose (`ANCHOR:FILELINE — …\n\nSuccessfully edited in <path>. Added N line(s), removed M line(s).` for success, or `Error: [E_*] <message>` for fail)
- json mode: 0.4 stringified `buildEditJson` envelope (e.g. `{"ok":true,"path":"...","diff":{...},...}`)

Multi-file path is opt-in via ≥ 2 distinct `absolutePath` values across items. Existing 0.4 single-file callers (and their scripts) see no change.

## ASCII examples

The four examples below show **what the model reads** — i.e. the `content[0].text` field of the tool-result message the dsh runtime delivers. The dsh tool runtime's internal `value` field (with `before`/`after`) and its `presentationMeta` (for dsh web UI) are not part of the model's view and are out of scope of this ADR.

### Setup

- `b1.txt` = `"alpha\nbeta\ngamma\n"` (3 lines)
- `b2.txt` = `"x\ny\nz\n"` (3 lines)
- `b1.txt` line 1 anchor = `1#…`; `b2.txt` line 2 anchor = `2#…`

### A. Success, text mode (default)

Request:
```jsonc
{
  path: "b1.txt",
  edits: [
    { op: "replace", path: "b1.txt", anchor_start: "1#...", anchor_end: "1#...", lines: ["A1!"] },
    { op: "replace", path: "b2.txt", anchor_start: "2#...", anchor_end: "2#...", lines: ["B2!"] }
  ]
}
```

`content[0].text` (the model's read):
```text
Successfully edited 2 file(s) — 2 of 2 edit(s) applied.

--- b1.txt ---
ANCHOR:FILELINE — each row is `<line>#<hash>:<content>`; edit uses the LEFT "line#hash" marker as its anchor; everything after ":" is the verbatim file content; to modify the file, pass the content after ":" — never the anchor part.
 1#...: A1!
 2#...: beta
 3#...: gamma

Successfully edited in b1.txt. Added 1 line(s), removed 1 line(s).

--- b2.txt ---
ANCHOR:FILELINE — each row is `<line>#<hash>:<content>`; ...
 1#...: x
-2#...: y
+2#...: B2!
 3#...: z

Successfully edited in b2.txt. Added 1 line(s), removed 1 line(s).
```

The per-file success block reuses the single-file ANCHOR:FILELINE header, which is rendered with the CONFIGURED `hashlineHeader()` (`sep`/`hash_length` aware) — same as `read` — not a hard-coded shape.
### B. Success, json mode

Same request as A; `jsonOutput: true` is set.

`content[0].text` (the model's read, single string):
```text
{"ok":true,"success":[{"ok":true,"path":"b1.txt","diff":{"-1#...":"alpha","+1#...":"A1!"},"hints":[],"warnings":[],"errors":[]},{"ok":true,"path":"b2.txt","diff":{"-2#...":"y","+2#...":"B2!"},"hints":[],"warnings":[],"errors":[]}],"fail":[]}
```

The model parses this as:
```jsonc
{
  ok: true,
  success: [
    { ok: true, path: "b1.txt", diff: {"-1#...": "alpha", "+1#...": "A1!"}, hints: [], warnings: [], errors: [] },
    { ok: true, path: "b2.txt", diff: {"-2#...": "y", "+2#...": "B2!"}, hints: [], warnings: [], errors: [] }
  ],
  fail: []
}
```

Each `success[i]` is the verbatim `buildEditJson` output for that file — same shape 0.4 single-file edit returns. The `diff` map may include unchanged context rows (bare `line#hash` keys without `+`/`-` prefix), exactly as 0.4's single-file json envelope does; this example elides them for brevity.

### C. Partial-fail, text mode (b1 succeeds / b2 anchor stale)

Request:
```jsonc
{
  path: "b1.txt",
  edits: [
    { op: "replace", path: "b1.txt", anchor_start: "1#...", anchor_end: "1#...", lines: ["A1!"] },
    { op: "replace", path: "b2.txt", anchor_start: "2#As2", anchor_end: "2#As2", lines: ["B2!"] }  // stale anchor
  ]
}
```

`content[0].text` (the model's read):
```text
Successfully edited 1 file(s) — 1 of 2 edit(s) applied.

--- b1.txt ---
ANCHOR:FILELINE — each row is `<line>#<hash>:<content>`; ...
 1#...: A1!
 2#...: beta
 3#...: gamma

Successfully edited in b1.txt. Added 1 line(s), removed 1 line(s).

Edit for b2.txt failed: [E_STALE_ANCHOR] 2 stale anchors in b2.txt: "As2", "As2". Re-read for fresh anchors.

  Echo of the line you tried (read-style, ±3 context):
ANCHOR:FILELINE — each row is `<line>#<hash>:<content>`; ...
  1#...: x
  2#...: y
  3#...: z

  If this is the line you meant to edit, reuse a fresh marker from: 2#..., 2#... without calling read.
  If not, call read() to find the correct line.
```

Per-file fail blocks carry the single-file error verbatim (echo + fresh-marker hint), so the model can retry without an extra `read` — same contract as single-file.

### D. Partial-fail, json mode

Same request as C; `jsonOutput: true` is set.

`content[0].text` (the model's read, single string):
```text
{"ok":true,"success":[{"ok":true,"path":"b1.txt","diff":{"-1#...":"alpha","+1#...":"A1!"},"hints":[],"warnings":[],"errors":[]}],"fail":[{"path":"b2.txt","code":"[E_STALE_ANCHOR]","message":"2 stale anchors in b2.txt: \"As2\", \"As2\". Re-read for fresh anchors.\n\n  Echo of the line you tried (read-style, ±3 context):\nANCHOR:FILELINE — ...\n  1#...: x\n  2#...: y\n  3#...: z\n\n  If this is the line you meant to edit, reuse a fresh marker from: 2#..., 2#... without calling read.\n  If not, call read() to find the correct line."}]}
```

The model parses this as:
```jsonc
{
  ok: true,                       // at least one file succeeded
  success: [
    { ok: true, path: "b1.txt", diff: {"-1#...": "alpha", "+1#...": "A1!"}, hints: [], warnings: [], errors: [] }
  ],
  fail: [
    { path: "b2.txt", code: "[E_STALE_ANCHOR]", message: "2 stale anchors in b2.txt: \"As2\", \"As2\". Re-read for fresh anchors.\n\n  Echo of the line you tried (read-style, ±3 context):\nANCHOR:FILELINE — ...\n  1#...: x\n  2#...: y\n  3#...: z\n\n  If this is the line you meant to edit, reuse a fresh marker from: 2#..., 2#... without calling read.\n  If not, call read() to find the correct line." }
  ]
}
```

Note: the failed file's `fail[]` entry keeps the `{path, code, message}` structure; the `message` carries the single-file error text VERBATIM, including the echo block and fresh-marker hint (each `\n` inside `message` is a real newline in the JSON string). No whole-file content (`before`/`after`) — only the single-file error's own ±3 echo. The model can retry directly with the fresh marker.

## Relationship to other ADRs

- **ADR-0002 (schema contract)**: top-level `path` is the per-call default; per-item `path` overrides per file. The aggregation in this ADR picks up items by resolved file path.
- **ADR-0003 (atomicity, concurrency, undo)**: per-file atomicity is the precondition for the `{success, fail}` two-array shape — one file's failure does not affect another's success. ADR-0003 D2 wording (`success: Array<{path, before, after, noopEdit?, warnings, driftNotice?}>`) is **replaced** by this ADR: the per-file entry in `success[]` does **not** carry `before`/`after`; the model never sees those fields (they are dsh tool runtime internals, used for dsh web UI rendering and JSON-envelope construction in `buildEditJson`).
- **#35 (parent bug) + PR #41 (regression test)**: the strengthened `test/core/presentation.test.ts:173-208` case is the integration test for the success-path examples in §A / §B above. Implementation PR turns it green.
- **#39 (this ADR's source ticket)**: the `## Answer` section after the 2026-08-30 grill session mirrors this ADR's implementation decisions and ASCII examples.

## Out of Scope

- **What the dsh tool runtime stores internally**: the `value` field with `before`/`after`, the `presentationMeta.diffs` for dsh web UI, the `servedRows` for served-mirror — these are dsh tool runtime internals, not the model's view. Out of scope for this ADR.
- **0.4 single-file `content[].text` shape change**: 0.4 single-file callers (and their scripts) see no change. The per-file prose in text mode and the per-file envelope in json mode are the existing 0.4 shapes, verbatim.
- **Cross-mode multi-file (line-anchor + AST simultaneously)**: per wayfinder map #36's `Out of scope`.
- **Streaming-diffs protocol for very large N**: not in scope; a future ADR if needed.

## Further Notes

- **The "4 examples" are the canonical reference**: any future change to multi-file `content[].text` shape must be diffed against §A / §B / §C / §D above.
- **No file content in `fail[]`**: deliberately. The model can `read` the file if it needs the original content for retry. Putting file content in `fail[]` would dump N× whole-file content into a single response — both model-irrelevant (model doesn't read the file content field, per the empirical observation that the LLM only sees `content[].text`) and bloat-prone.
- **Why `fail[i]` is `{path, code, message}` and not the full `Error` shape**: 0.4 throws `Error("[E_*] <message>")`; `code` extracts the `[E_*]` prefix; `message` is the rest. This is the minimal structured capture that lets the model decide what to do next.
- **Top-level `ok` in json mode**: `true` iff at least one file succeeded. Partial success has `ok: true` and a non-empty `fail[]`. All-fail has `ok: false`. The `ok` field matches `buildEditJson`'s per-file `ok` semantics.
- **Single-file compat in §D5 (ADR-0003)**: §D5 of ADR-0003 says "Multi-file path is opt-in via ≥ 2 distinct `absolutePath` values across items". This is the gate that protects 0.4 single-file compat — when there's only one `absolutePath` target, the tool returns the 0.4 `content[].text` shape unchanged.
- **Real-machine smoke mandatory**: per CLAUDE.md and sister map #10's lesson — vitest suite passing is necessary but not sufficient. Implementation PR must also pass a smoke-profile or `DSH_HOME=$(mktemp -d)` end-to-end boot. Profile-redline: never install the experimental branch into the `web` profile.