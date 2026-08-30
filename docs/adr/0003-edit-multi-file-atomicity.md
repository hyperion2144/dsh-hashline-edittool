# ADR-0003 — Multi-file `edit` concurrency, atomicity, undo (per-file atomic)

> **Status**: Accepted (issue #38 spec locked 2026-08-30, see also wayfinder map issue #36 and parent bug issue #35). Implementation PR lands after issue #39 (response shape + same-file conflict) closes; ADR-0002 (schema contract) must already be merged.

## Problem Statement

From the user's perspective, the `edit` tool is single-file today: `edit({path, edits:[…]})` operates on one file, with all-or-none semantics **within** that file. To honor the multi-file semantics locked at ADR-0002, the engine must decide how multiple files cooperate — at minimum:

- Can files run truly concurrently, or does the engine serialize them?
- If a write fails mid-batch, do other files' writes survive or get rolled back?
- After a multi-file call, how does `undo_last_edit` recover state?
- What's the response shape when some files succeed and some fail?

The current engine has no answer to any of these — `runFileEdits` (`src/edit-engine.ts`) is single-file batch, `commit()` (`src/tool-edit.ts`) writes one file, and there is no concept of cross-file dispatch.

## Solution

**Per-file atomicity.** An `edit({path, edits:[…]})` invocation whose items target multiple `absolutePath` values is first grouped by file. Each file's sub-batch is processed through the existing single-file flow (read → normalize → apply → persist-undo → write) with all-or-none semantics **within** that file — the existing `commit()` per-file transaction is the primitive. Files are independent: one file's write failing does not affect other files' writes. Partial success is reported.

This is the maintainer's atomicity narrative from #38, verbatim, and load-bearing for this ADR:

> 对于一次 edit 工具调用，不管怎么传——多文件也好、单文件多条子修改也好——**一个文件的所有修改必须 atomic**。但如果一次 edit 修改多个文件，可以先按文件将修改分组，然后按单文件的 edit 处理来处理这些文件的修改。某个文件失败，那么这个文件的修改全部不应用，保证这个文件的修改原子性即可。
>
> 最终返回时若存在部分文件失败：成功的文件按正常的 edit 返回信息；失败的文件在最后写明哪些失败，按正常 edit 失败的信息写。文本用 `— success —` / `— fail —` 段分隔；JSON 用 `success / fail` 两个字段组织。

## User Stories

1. As a **model** invoking `edit`, I want a multi-file call to fully commit on every file when all writes succeed, so that I get a single transaction outcome for the whole batch.
2. As a **model**, I want partial success to be reported explicitly — successful files' results and failed files' errors in the same response — so that I can decide what to retry without re-running the whole batch.
3. As a **model**, I want `undo_last_edit` after a multi-file call to undo each file's edits one at a time, so that my "undo once" mental model is preserved.
4. As a **model**, I want each file's commit to be fast (concurrent reads + concurrent writes, not serial), so that the latency for a 2-3 file batch is bounded by the slowest file, not the sum.
5. As a **script caller**, I want the response shape to be distinguishable between all-success, partial-success, and all-failure paths, so that my automation can branch without parsing error text.
6. As the **maintainer**, I want the new behavior implemented as a thin extension of the existing single-file engine — `commit()` per file, `saveUndo()` per file, etc. — rather than a parallel pipeline, so that the test surface and code surface stay close.
7. As the **edit-engine implementer**, I want the per-file atomicity primitive spelled out at the seam of `runFileEdits` and `commit()`, so that I can land the implementation in a single PR.
8. As a **human reviewer of CI**, I want the failing regression test (PR #41, `test/core/presentation.test.ts:173-208`) to turn green once the implementation lands, so that "is multi-file `edit` working?" is answerable from CI alone.

## Implementation Decisions

The following is the **target contract state** — what holds after the implementation PR lands. The implementation PR is out of scope for this ADR (it lands after wayfinder ticket #39 closes).

### D1 — Concurrency model

**Full parallel reads + writes** (option (a) in issue #38). For each file in the batch, run `normFromText → applyOne → persistUndo → writeFile` independently, using `Promise.all` over the file list.

**Caveat**: if the dsh-fs sandbox (`src/sandbox.ts`) does not support concurrent writes for the current policy, downgrade to read-parallel + write-serial (option (c)). The downgrade is detected at the sandbox layer, not at the contract layer — this ADR still specifies (a) as the target.

**Zero overhead for one-file calls**: a single-file invocation continues to use the existing single-file path (`runFileEdits` with one `absolutePath`); no group-by-file overhead. Only multi-file calls take the new path.

### D2 — Atomicity scope

**Per-file atomic** (option (b) in issue #38). Each file's commit is an all-or-nothing transaction within itself. Cross-file is progressive: failed files are reported but successful files keep their committed state.

**Implementation hint**: the existing `commit()` (`src/tool-edit.ts:282-304`) is already per-file atomic — it accepts one file and one undo slot. The multi-file dispatch loops over files, calling `commit()` once per file with that file's `saveUndo` slot. **No new transaction primitive is needed.**

### D3 — Undo semantics

**N independent undo slots** (option (a) in issue #38). One multi-file call occupies N slots, one per file. `undo_last_edit` recovers one file at a time, in reverse batch order.

**Failure interaction with undo**: if file A's write succeeded but file B's write failed in a multi-file call, A's undo slot is **not** consumed by the failed call. The `commit()` `restoreUnwrittenUndos: true` flag already implements this: only the files whose `writeText` actually ran keep their undo slots; files that failed before write left their persisted undo intact for the caller's "transaction rolled back" semantics. The result: `undo_last_edit` after a partial-success multi-file call undoes the most recent successful file's change, not the whole batch — consistent with "per-file atomicity, files are independent".

### D4 — Failure mid-flight

**Keep A + report B's error** (option (b) in issue #38). Per D2, A's commit was atomic and B's failure cannot retroactively uncommit A. The response carries both: A in `success: [...]`, B in `fail: [...]`.

**No cross-file revert mechanism** is introduced. D2's per-file atomicity makes a cross-file revert unnecessary — there is no cross-file commit to roll back. The `commit()` per-file flow's existing `persistUndoAndWrite` already handles within-file failure gracefully.

### D5 — Response shape (carry-forward to issue #39)

The multi-file response is a single tool-call value with **two parallel arrays**:

- `success: Array<{path, before, after, noopEdit?, warnings, driftNotice?}>` — one entry per file that committed fully.
- `fail: Array<{path, error: {code, message, echoRows?}}>` — one entry per file that failed its commit.

A fully-successful batch has empty `fail`; a fully-failed batch has empty `success`; partial success has both populated.

**Implementation location**: issue #39 (`wayfinder:grilling`) carries the implementation. This ADR carries the **shape contract** (the two-field structure); #39 carries the schema DSL detail, the `presentationMeta.diffs` array shape, and the text format (`— success —` / `— fail —` section markers per the maintainer's wording).

### D6 — Relationship to ADR-0002

ADR-0002 locks the schema contract: top-level `path` optional iff every items has its own `path`; per-item `path` is each item's file; auto-fold normalizer when `item.path === topLevelPath`; `additionalProperties: false` on the three schemas.

ADR-0003 assumes that contract is in force at runtime:

- Items are dispatched to their stated files per the per-item `path`.
- The auto-fold normalizer has already reduced same-value items.
- `assertEditRequest` has accepted the request (top-level absent → all items have `path`; otherwise per-item paths orthogonal to top-level).

If ADR-0002's schema contract is not in force when this ADR's implementation runs, ADR-0003's behavior is undefined: per-item `path` may be silently dropped (the #35 bug), undo semantics may collide with the silent-override, and `success`/`fail` partitioning may be mis-attributed.

### D7 — Out-of-scope decisions deferred to other ADRs

- **Response shape details** (`output` schema DSL, `modelText` text format, `presentationMeta.diffs` array shape, `Successfully edited in <path>` text template's multi-file adaptation) → ADR-0004 (forthcoming, locked at issue #39).
- **Same-file-twice-in-one-batch semantics** (whether two items referencing the same `absolutePath` get rejected with `E_BATCH_CONFLICT`, auto-merged into a sub-batch, or queued) → ADR-0004 (issue #39).

ADR-0003 + ADR-0004 together complete the multi-file `edit` design packet.

## Testing Decisions

### TD1 — What makes a good test

External behavior, asserted on **file content** and **response value** after the call returns:

- File-level assertion: `await readFile(path)` matches the expected post-edit content. Per-file atomicity is the property under test; mid-flight failure should leave successful files alone and unsuccessful files unchanged.
- Response-level assertion: the response value's `success: [...]` and `fail: [...]` arrays correctly partition the file list (every input file is in exactly one of the two arrays).

Tests must NOT assert on internal lock-step sequencing, specific `Promise.all` shapes, or transient state during the call. What matters: given a request shape and a file-system state, the final file-system state and the response value are correct.

### TD2 — Test surfaces

- **Primary (extension)**: extend the strengthened regression test in `test/core/presentation.test.ts:173-208` (PR #41 OPEN). Currently it asserts "two-file call → both files updated" — case 2 below. Extend with cases 3–8.
- **Primary (new file)**: `test/core/multi-file-atomicity-contract.test.ts` — small `it()` blocks per case, real temp files via `withTempFile`, post-call `readFile` assertions, response-shape assertions.
- **Secondary**: `test/core/edit-engine.e2e.test.ts` already covers single-file batch scenarios; that file is unchanged.

### TD3 — Cases

Each case asserts the documented behavior in isolation:

1. **Happy-path (one file, many items)**: top-level `path` = X, all items reference X → file X updated; `success: [X]`, `fail: []`.
2. **Happy-path (multi-file, all succeed)**: items reference X and Y → both files updated; `success: [X, Y]`, `fail: []`.
3. **Per-file atomic (single file failure)**: items reference X and Y, where Y's edit has a stale anchor → X's content updated, Y's content unchanged; `success: [X]`, `fail: [{path: Y, error: {code: '[E_STALE_ANCHOR]', message: '...', echoRows: [...]}}]`.
4. **All-files-failure**: items reference X and Y, both with stale anchors → both files unchanged; `success: []`, `fail: [{path: X, ...}, {path: Y, ...}]`.
5. **Concurrency (multi-file with N=5)**: items reference 5 different files → all 5 updated; verify served mirror and hashes are coherent post-write (no partial state visible to a subsequent read).
6. **Undo after partial success**: multi-file call (X ok, Y fail) → run `undo_last_edit` → X reverts (X's commit was atomic, X's undo slot is intact), Y's content unchanged.
7. **Auto-fold normalizer (from ADR-0002)**: multi-file call where one item's `path` matches top-level `path` → that item's `path` is folded, file edits correctly.
8. **Schema rejection (from ADR-0002)**: top-level absent + some item missing `path` → `[E_BAD_SHAPE]` thrown before any file is touched (this is ADR-0002's validation; ADR-0003's implementation must not bypass it).

### TD4 — Prior art

Test patterns similar to ADR-0003 already live in `test/core/edit-engine.e2e.test.ts` (single-file batch scenarios, real temp files, post-call `readFile` assertions) and the strengthened `test/core/presentation.test.ts:173-208` (PR #41, two-file case 2). The new test file follows the same shape: small `it()` blocks per case, real temp files via `withTempFile`, post-call `readFile` for content assertion, response-value assertions for `success / fail` shape.

## Out of Scope

- **Implementation PR for this ADR's changes**. Lands after #39 closes; ADR-0002 must already be merged.
- **Response shape details** (`output` schema DSL, `modelText` text format, `presentationMeta.diffs` array shape). Lives behind #39 / ADR-0004. ADR-0003 only fixes the **shape** (`{success, fail}` two-field structure), not the wire format.
- **Same-file-twice-in-one-batch semantics**. Lives behind #39.
- **Schema validation changes**. Lives behind ADR-0002.
- **Any change to single-file behavior**. Single-file calls continue to use the existing path with zero overhead (D1's last bullet).
- **Cross-mode multi-file (line-anchor + AST simultaneously)**. Out of scope per wayfinder map #36's `Out of scope`.

## Further Notes

- **Q2 framing reversal mid-grilling**: during the issue #38 grilling, the original Q2 was (a) all-or-nothing. After one round, the maintainer reframed atomicity to per-file — "edit失败要一起失败" was re-read as "the file whose edit fails has all its edits not applied", not "all files in the call are rolled back". This became Q2=(b) and the basis of this ADR's atomicity narrative.
- **Q4 revert sub-decision collapse**: per-file atomicity makes a cross-file revert unnecessary — there is no cross-file commit to roll back. This ADR does not introduce any revert primitive.
- **D1 caveat on full parallel writes**: the (a) choice depends on the dsh-fs sandbox accepting concurrent writes. If the sandbox rejects (some prior policy configurations may), the implementation PR must detect this at the sandbox layer and downgrade to (c). This is runtime detection, not a contract change — the ADR-0003 contract stays the same.
- **Relationship to #35 (parent bug)**: the strengthened regression test (PR #41) stays red until this ADR's implementation lands; the test's assertion is exactly case 2 above. Once this ADR implements, the test turns green.
- **Atomicity narrative is load-bearing**: the maintainer's words in this ADR's preamble are not paraphrased — they are the literal definition. Future readers should treat them as load-bearing: any drift from "per-file atomic, files independent" would invalidate this ADR.
- **Real-machine smoke mandatory**: per CLAUDE.md and sister map #10's lesson — vitest suite passing is necessary but not sufficient. Implementation PR must also pass a smoke-profile or `DSH_HOME=$(mktemp -d)` end-to-end boot. Profile-redline: never install the experimental branch into the `web` profile.