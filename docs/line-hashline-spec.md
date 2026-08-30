# Spec — Line-anchored hashline (`line#hash`)

> **Superseded by `edit-payload-spec.md`** — This document describes the pre-0.4.0 contract (0.3-era, including `batch_edit`). The 0.4+ contract merged multi-hunk editing into a single `edit({path, edits:[…]})` payload with `op: "ins"|"del"|"replace"` semantics; see [`edit-payload-spec.md`](./edit-payload-spec.md) for the authoritative 0.4 contract. Kept as a historical record of the contract evolution.

> Status: **Draft** — awaiting review before implementation begins.
> Scope: read / edit / batch_edit / grep / undo_last_edit contract changes plus the
> corresponding prompt-section updates. Implementation order and per-file change
> list are at the end.

## 1. Goal

Upgrade the hashline edit anchor from a pure 3-character content hash
(`HASH`) to a paired **(absolute line number, content hash)** anchor
(`line#hash`), so that:

- `edit` returns enough information for the model to **chain a follow-up edit**
  against a downstream line whose absolute line number has shifted, **without
  forcing a re-`read`**.
- `grep` becomes a first-class hashline-aware tool: every match is returned with
  the same `line#hash:content` marker so the model can edit the hit directly
  from the grep output.
- The marker and the file content are visually and structurally separated, so
  the model never confuses one for the other.

The hash itself stays content-derived (3 chars, `[A-Za-z0-9]{3}`); only the
*combined* anchor `line#hash` is position-aware. The same line of content in
the same file still produces the same hash across edits — only its `line`
half moves.

## 2. Background — current behaviour

- `read` renders rows as `HASH:content` (`fmtRegion` in
  `src/hashline/anchor-pipeline.ts`, `HASH_SEP = ":"`).
- `genDiff` (`src/edit-diff.ts`) renders diff rows as
  `[+- ]HASH:content`.
- `edit.remove_from` and `remove_to` are both required; equal hashes means
  one-line edit.
- `[E_STALE_ANCHOR]` (`fmtMismatchWithServes` in
  `src/hashline/anchor-pipeline.ts`) echoes the resolved anchor's context with
  bare `HASH:content` rows plus line numbers — not the read format.
- No `grep` tool is owned by this plugin (verified by `grep -rn "grep" src/`
  returning no registration — only doc-string mentions).

## 3. New design

### 3.1 Anchor format

```
42#ve7:function hello() {
↑  ↑
:  └── 3-char content-derived hash (unchanged behaviour)
└───── absolute 1-indexed line number in the file the tool last wrote/read
```

- Separator between `line` and `hash`: `#` (single ASCII). Distinct from the
  `:` that separates marker from content.
- `parseRef` accepts both `line#hash` and a bare `hash`. Bare-hash form is
  retained as a hash-only fallback (no line check), for compatibility with
  older read output and to let the model skip the bookkeeping when it knows
  the file has not been touched above.
- When both are present, the line and hash must agree in the current file —
  mismatch → `[E_STALE_ANCHOR]`.

### 3.2 Output structure — marker vs content

Every hashline-producing tool response (read, grep, post-edit diff, stale
echo) opens with a single header line:

```
ANCHOR:FILELINE
```

The left column is the marker (`line#hash`); the right column is the
verbatim file line content. The `:` separator is the existing
`HASH_SEP`. No other output in the response carries this exact header
string, so a model can pattern-match on it as the start of a hashline
block.

For multi-file responses (grep across paths, batch_edit across files)
each file gets its own section header:

```
--- src/foo.ts ---
ANCHOR:FILELINE
  ...
```

### 3.3 `read` rendering

```
ANCHOR:FILELINE
 3#ve7:import foo from "./foo.js";
 4#qp1:
 5#8mK:function hello() {
 6#u2x:  return "world";
 7#4nB:}
 ...
[Showing lines 1-7 of 7.]
```

- `file-view.ts::readView` adds the header line directly above the row
  block.
- Truncation footer (`...`) and continuation hint stay unchanged.
- Empty file: header still rendered, body is empty, footer becomes
  `File is empty. Use edit to insert content.`

### 3.4 `edit` — chained, diff-shaped

`remove_to` becomes **optional**. Omitting it is equivalent to passing
`remove_to = remove_from` (single-line edit).

`remove_from` and `remove_to` accept `line#hash` or bare `hash`. Both
forms validate the resolved range against served state (existing
`verifyServedRange`).

The post-edit response has three blocks, in order:

```
ANCHOR:FILELINE
[Diff rows for the edited range — + is new, - is old, space is unchanged context]
+5#hA1:new line a
+6#hA2:new line b
-5#oldH:old single line that was replaced
 4#kp3:unchanged surrounding line
 ...                                  # ellipsis when context was trimmed

[Shift: lines below the last changed row have shifted in their absolute line number]
Shift: lines > 6 shift by +1. To edit what was at line 7 before this edit,
use newLine=8 with the same hash (8#oldHashOf7) — no read required.
If you're unsure, call read() to refresh.

[Warnings / Drift / Snapshot id — unchanged]
```

Block rules:

- **Diff block.** Reuses `genDiff`'s output verbatim, only the left column
  is upgraded to `line#hash`. `+line#hash` = new line in the new file;
  `-line#hash` = old line in the old file; ` line#hash` = unchanged
  context row.
- **Shift block.** Always emitted when the range of changed lines is
  non-empty and at least one line below it exists. `N` is the absolute
  line number in the **new** file of the first unchanged row after the
  edit; `K` = `addedLines - removedLines` for this edit. The example
  phrase in the block is generated from these two numbers so the model
  can copy it verbatim.
- The phrase "use `newLine#oldHash`" requires knowing the hash of the
  row at `N`. For the common single-hunk case the row at `N` is
  included in the diff block as an unchanged context row; the model
  can read its hash off that row. If the diff context omitted it, the
  Shift block re-includes the first row below `N` so the model always
  has a concrete `newLine#hash` to extend the chain.

For `edit` with multiple hunks in the same file (snapshot-concurrency semantics):
every hunk resolves its `<line>#<hash>` anchor against the same original file snapshot,
so all hunks use ORIGINAL anchors — no `newLine#oldHash` chaining. Each hunk emits its
own diff block and its own Shift block; the Shift's `K` is that hunk's own
added-minus-removed (`delta`), displayed as an original-range → final-range mapping
(e.g. `Shift: edits[1] lines 5..6 moved to lines 7..9 (+2)`). Hunks whose row ranges
overlap are rejected up front with `[E_BATCH_CONFLICT]` (§4 error table). Files with
two or more moved hunks end with one final Shift block describing the total
end-of-file shift (`Shift: end of file moved from N lines to M lines (K total)`).

### 3.5 `grep` — new tool

```
defineTool({ name: "grep", ... })
```

Parameters (mirrors dsh's built-in `grep` surface; aligned with the
plugin's read tool for ergonomics):

| Param | Type | Description |
| --- | --- | --- |
| `path` | string | File or directory to search. Directories recurse. |
| `pattern` | string | Substring or regex pattern (see `regex` below). |
| `regex` | boolean? | If true, `pattern` is a ripgrep-flavour regex; default `false` (literal). |
| `-n` / `--line-number` | boolean? | Include the marker for each match (default `true`). |
| `-C` / `--context` | number? | Number of context lines around each match (default `0`). |
| `limit` | number? | Cap on matches per file (default `100`). |
| `glob` | string? | Glob filter for recursive directory search. |

Output:

```
--- src/foo.ts ---
ANCHOR:FILELINE
42#ve7:function hello() {
43#8mK:  console.log("world");
...
--- src/bar.ts ---
ANCHOR:FILELINE
11#qp1:function greet() {
12#u2x:  console.log("hi");
...
```

- Context rows (`-C N > 0`) carry markers too — content unchanged so
  hash unchanged, line number is the absolute line in the file.
- Every file that `grep` reads is passed through `io.emitObserved`,
  matching the read tool's behaviour, so a subsequent `edit` against a
  grep hit does not trigger sandbox escalation.
- Grepped rows are recorded as served (`recordServedTruncated`) so the
  model can edit them directly using the grep output's marker.

### 3.6 `[E_STALE_ANCHOR]` — read-format echo with context

`fmtMismatchWithServes` (not-found branch) is extended:

```
[E_STALE_ANCHOR] Stale anchor "42#ve7" in src/foo.ts. The file content
has changed since that anchor was read, or the line has shifted.

 Echo of the line you tried (read-style, ±3 lines of context):
 ANCHOR:FILELINE
 39#aaa:…
 40#bbb:…
   42#ccc:something different here now ← what line 42 actually is today
   43#ddd:…
   44#eee:…

 If this is the line you meant to edit, reuse the fresh hash 42#ccc
 without calling read.
 If not, call read() to find the correct line.
```

- The line number shown to the model is the **current** absolute line number
  of the row it passed in (or the closest existing line if the row has been
  removed).
- ±3 context lines around it, rendered in read format.
- These rows are pushed into `servedRows` so a retry carrying the fresh
  `42#ccc` passes `verifyServedRange` without re-reading.
- The `[E_AMBIGUOUS_ANCHOR]` branch keeps listing candidates with read-format
  markers.

## 4. API / contract changes

| Surface | Change |
| --- | --- |
| `EditParams.remove_to` | `string` → `string \| undefined`. |
| `removeToSchema` | Description: "Optional. Omit to edit only `remove_from`." |
| `assertEditRequest` | Removes the "must include `remove_to`" branch. |
| `removeFromSchema` / `removeToSchema` | Description updated to accept `line#hash` or 3-char hash. |
| New schema fields for `grep` | see §3.5. |
| `GUIDANCE_SECTIONS` | Adds `tool:grep` with default order `134`. |
| `EDIT_DESCRIPTION` / `EDIT_GUIDANCE` | Updated wording (§5). |
| `READ_DESCRIPTION` / `READ_GUIDANCE` | Updated wording (§5). |
| `BATCH_EDIT_DESCRIPTION` / `BATCH_EDIT_GUIDANCE` | Updated wording (§5). |
| `GREP_DESCRIPTION` / `GREP_GUIDANCE` | New; from `prompts.ts`. |

## 5. Prompt-section wording (compiled defaults)

These are the strings shipped in `src/prompts.ts`. Preset overrides are
unaffected — each preset's `*.md` keeps its own copy.

**`READ_DESCRIPTION`**: "Read a text file; each line is returned as
`line#hash:content` (line = absolute 1-indexed line number, hash =
3-char content-derived). The response opens with a header
`ANCHOR:FILELINE`; everything below the header is the
verbatim file line content. Use `line#hash` as the anchor in `edit`
calls. A bare `hash` is also accepted when you are sure the file has
not been touched above. Binary/directory → rejected; empty → header
only; pageable with `offset`/`limit`; BOM stripped; non-UTF-8 shown
as U+FFFD."

**`READ_GUIDANCE`**: bullets that (1) call it only for content not yet
served, (2) describe the header + marker + content split, (3) note
that the bare-hash form is for untouched-files-only.

**`EDIT_DESCRIPTION`**: "Edit a range of lines in a text file, targeted
by the anchors from read/grep/diff output. Anchors are `line#hash`
(or bare 3-char hash when the file is unchanged above). `remove_from`
is required and anchors the first changed line; `remove_to` is
optional and anchors the last changed line (omit to edit just
`remove_from`). The post-edit response carries a `+line#hash`/`-line#hash`
diff plus a `Shift:` block describing how lines below the edit have
moved in their absolute line number — use that block to chain the next
edit without a fresh `read`. A stale or never-served range is
hard-rejected (`[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]`) with a
read-format echo of the target line (±3 context) that counts as a
serve."

**`EDIT_GUIDANCE`**: bullets that (1) anchor the exact first and last
changed lines, (2) explain `remove_to` optionality, (3) spell out the
diff + Shift response shape, (4) describe how to extend the chain
with `newLine#oldHash` from the Shift block, (5) point at
batch_edit for multi-edit.

**`EDIT_DESCRIPTION`**: extends the current text with "All items resolve
against the same file snapshot (concurrent semantics): pass ORIGINAL
anchors for every hunk; overlapping ranges are rejected with
`[E_BATCH_CONFLICT]`. The diff rows carry final line#hash markers; each
hunk emits a `Shift:` block mapping its original range to its final
position, and multi-hunk batches end with an end-of-file total block."

**`EDIT_GUIDANCE`**: same bullets + (4) pass ORIGINAL anchors for every
hunk; expect `[E_BATCH_CONFLICT]` on overlapping ranges, per-hunk
original-to-final Shift blocks, and an end-of-file total block.

**`GREP_DESCRIPTION`**: "Search for a pattern in one or more files.
Output mirrors `read`: each match is a `line#hash:content` row under
a `ANCHOR:FILELINE` header, one section per file.
Context lines (`-C N`) carry markers too. Grep counts as `read`, so
matches can be edited directly without a separate `read`."

**`GREP_GUIDANCE`**: bullets covering (1) literal vs `regex:true`,
(2) `-C N` for context, (3) `limit`, (4) chainability with `edit`.

## 6. Implementation map (per file)

| File | Change |
| --- | --- |
| `src/hashline/hash-assign.ts` | Add `LINE_HASH_SEP = "#"` and `LINE_HASH_RE = /^(\d+)#([A-Za-z0-9]{3})$/`. Export for `anchor-pipeline`. |
| `src/hashline/anchor-pipeline.ts` | `parseRef` accepts `line#hash` or bare hash. `HL_BARE_PREFIX_RE`, `HL_PREFIX_PLUS_RE`, `HL_PREFIX_MINUS_RE` allow an optional `(line#)` in front of the hash. `resAnchorFromMap` validates line when both are present. `fmtRegion` and `fmtDiffLine` left-column becomes `line#hash`. `fmtMismatchWithServes` not-found branch emits the read-format echo (§3.6) and pushes context rows into `servedRows`. |
| `src/hashline/hash.ts` / `pure.ts` / `served.ts` / `apply.ts` / `resolve.ts` / `index.ts` | No semantic change — pure modules keep producing `string[]` of hashes. Shim re-exports untouched. |
| `src/file-view.ts` | `readView` prepends the header line above the row block. `preview` (pure helper) gets a `header` flag so tests can exercise both with and without. |
| `src/edit-diff.ts` | `fmtDiffLine` left-column changes from `${hash}` to `${line}#${hash}`. `newLineNum` is already tracked per diff row, so the absolute line is naturally available. |
| `src/edit-response.ts` | `buildChanged` emits the three-block response: header + diff + Shift + warnings/drift/snapshot. `buildBatchResult` emits per-hunk diff + per-hunk Shift + end-of-file Shift. `buildNoop` unchanged. |
| `src/edit-engine.ts` / `src/mutation.ts` | Add `effectiveShift = totalAddedLines - totalRemovedLines` and `firstStableLineNew = lastChangedLine + 1` to the pipeline result; consumers (`edit-response.ts`) read these for the Shift block. |
| `src/contract.ts` | `EditParams.remove_to?: string`. `removeToSchema` description updated. `assertEditRequest` drops the `remove_to` presence check. |
| `src/tool-edit.ts` | `remove_to ??= remove_from` in the normalize path. |
| `src/tool-batch-edit.ts` | Pass through the new edit-engine fields; final response assembled by `edit-response.ts`. |
| `src/tool-read.ts` | No schema change; only the rendered text changes (via `file-view.ts`). |
| **`src/tool-grep.ts` (new)** | `defineTool({ name: "grep", ... })` mirroring `tool-read.ts`. `execute` runs a literal-substring or regex match per file, builds `line#hash:content` rows via `file-view.ts::preview` (pure), emits observed via `io.emitObserved`, records served via `recordServedTruncated`. |
| **`src/prompts.ts`** | Add `GREP_DESCRIPTION` and `GREP_GUIDANCE`; update `EDIT_*` / `READ_*` / `BATCH_EDIT_*` strings per §5. |
| **`src/guidance.ts` + `src/guidance/index.ts`** | Register `tool:grep` in `GUIDANCE_SECTIONS` with default order `134`. |
| **`src/guidance/materialize.ts` + `resolve.ts` + `parse.ts`** | Materialize a `grep.md` per shipped preset; resolve it like the existing four sections. |
| **`src/index.ts`** | Call `registerGrepTool` alongside the other tool registrations. |
| `src/write-hook.ts` | No change — write auto-read already uses `file-view.ts`. |
| `test/` | New + adjusted cases (see §7). |

## 7. Test plan

| Test | Asserts |
| --- | --- |
| `read.header.line-hash` | read output starts with `ANCHOR:FILELINE` and rows match `^\s*\d+#\w{3}:` |
| `read.header.empty` | empty file: header only, no rows |
| `read.continuation-paging` | `offset`/`limit` paging still emits the header |
| `edit.single-line.remove_to_omitted` | passing only `remove_from` lands as a 1-line edit |
| `edit.line-hash form` | `5#ve7` resolves correctly; `5#bad` rejects as `[E_BAD_REF]` |
| `edit.bare-hash fallback` | bare `hash` works when file is unchanged above |
| `edit.line-hash mismatch` | `5#ve7` where line 5 has hash `ccc` → `[E_STALE_ANCHOR]` with read-format echo |
| `edit.shift-block single hunk` | 1 → 2 line replacement emits `Shift: lines > N shift by +1` with `N` = first stable line new |
| `edit.shift-block deletes to empty` | replacement `""` of last row → `Shift: lines > N shift by -1` and end-of-file message |
| `edit.no-shift noop` | equal content → no Shift block |
| `batch.two-hunks.shift` | hunk A +1 line, hunk B +2 lines → both use ORIGINAL anchors; A emits `+1`, B emits `+2`, file end emits `+3` total |
| `stale-echo.read-format` | not-found echo is `ANCHOR:FILELINE` ±3 rows in read format |
| `stale-echo.served-rows` | echo rows appear in `servedRows` so a retry with the fresh hash passes |
| `grep.single-file` | literal match produces `line#hash:content` rows under header; file section header present |
| `grep.context` | `-C 2` includes 2 marker rows above/below |
| `grep.regex` | `regex:true` enables `RegExp` matching |
| `grep.emit-observed` | after grep, `edit` against a hit does not trigger sandbox escalation |
| `grep.served-rows` | matches are recorded as served |
| `prompts.tool:grep default` | `GUIDANCE_SECTIONS` includes `tool:grep` with order 134 |
| `prompts.strings updated` | `EDIT_DESCRIPTION` mentions `line#hash` and `Shift:` |
| `noop-loop unaffected` | existing noop-loop guard still fires |

The existing 615 tests (per README) keep passing except where the
shared regex constants changed — those test files are updated as part
of this change.

## 8. Documentation updates

| Doc | Change |
| --- | --- |
| `README.md` | §Quick Start, §Why Hashline, §How It Compares, §Correctness in edge cases, §Benchmark (note), §Tools table (+ grep row), §Error codes, §Project Structure, §Roadmap. See plan-issue earlier in the conversation. |
| `README.zh.md` | Full mirror translation. |
| `CONTEXT.md` | Add `line#hash anchor`, `Shift`, `ANCHOR:FILELINE`, `Reject-and-serve` (refined). Update Prompt section list to include `tool:grep`. |
| `CHANGELOG.md` | `[Unreleased]` block with Added / Changed / Tests. Tests count is filled after `npm test`. |

## 9. Risks and open questions

1. **Anchor stability semantics inverted.** Pre-change, `HASH` was purely
   content-derived and never invalidated by edits above. Post-change, the
   *combined* anchor `line#hash` is invalidated whenever the line moves.
   The hash half alone is still content-stable; the bare-hash form is
   retained as an explicit opt-in for cases where the model is confident
   the file has not shifted. Need to verify this is communicated clearly
   in the prompt sections.
2. **Token cost shift.** Anchors grow from 3 chars to ~`1+1+3=5` chars per
   reference. A two-anchor edit call grows from ~6 chars to ~10 chars.
   `benchmark/run.mjs` should be re-run; the README's "31% saved" claim
   needs a small footnote until the new numbers are in.
3. **Stale-echo ±3 lines.** Constant `STALE_CONTEXT_LINES = 3`. Worth
   re-checking against common edit sizes (one-line edits where context 1–3
   is plenty; multi-line edits where 3 may be tight on either end). Could
   be widened later via the same constant.
4. **Grep regex surface.** v1 ships literal + a single `regex:true` flag
   matching ripgrep's flavour. If users want PCRE / multiline / case
   flags, those can come later as separate schema fields. Default off for
   safety.
5. **Grep binary handling.** Reuse `file-view.ts`'s binary detection so
   grep emits a `[E_NOT_TEXT]` for binary files rather than garbage.
6. **Grep recursion perf.** v1 streams one file at a time via
   `file-view.ts`. No parallelism in v1; matches per file are bounded by
   `limit`.
7. **No-shift Shift block suppression.** When the edit is a no-op or
   affects only the last row, the Shift block may have nothing useful to
   say. Suppress it when `addedLines === removedLines === 0` (noop
   already returns its own message) and when the edit was the last row
   in the file (no "lines below" exist).

## 10. Rollout

1. Land this spec doc as a PR for review.
2. Land implementation as one PR (or one PR per concern: anchor format,
   edit response, grep) depending on review feedback.
3. Re-run `npm run benchmark` and update the Benchmark section in
   README / README.zh.md with the new numbers.
4. Update CHANGELOG `[Unreleased]` once tests are green and the new
   test count is known.
5. Tag a `0.3.0` release (minor bump — anchor format change is
   backwards-compatible at the API level since bare `hash` is still
   accepted, but the output format change is observable by the model).

## 11. Out of scope (this spec)

- Block ops / registers / multi-hunk document format (`PUT N*:` etc.) —
  tracked separately.
- 3-way merge on stale tags — already absent in this plugin.
- Remote / sandbox-specific path coercion for grep — same behaviour as
  `read` inherits from `ctx.fs`.