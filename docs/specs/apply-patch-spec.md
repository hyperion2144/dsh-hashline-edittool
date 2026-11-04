# `apply_patch` — implementation spec

Status: **accepted** — the grammar chapter for the ticket
[原型：锚点优先的 patch 文本长什么样（三份候选文法 + 真实样例）](https://github.com/hyperion2144/dsh-hashline-edittool/issues/409),
under map [#401](https://github.com/hyperion2144/dsh-hashline-edittool/issues/401).
Accepted 2026-11-03. Prototype v2 (A′) lived at `2adad8e`; the accepted text is the commit
that carries this line. Supersedes prototype v1 (`05b7cda`), whose three Codex-shaped
candidates were rejected: a patch never copies file content, and the Codex envelope is not
ours. Everything under “Grammar A′” is normative for implementation tickets.

Owners: `src/domain/patch/` (parse + preflight + commit),
`src/tools/tool-apply-patch.ts`, `src/render/` + `client/` (diff card), `src/guidance/`.

## Purpose

A tool that applies **one change set** in one call: add, update, delete and move across
several files, with a preflight that must pass as a whole before a single byte is written,
and a commit that runs in order, stops at the first failure, and never rolls back.

Why it exists at all — first principles:

- `edit` already takes several files (per-item `path`), but it cannot **add**, **delete** or
  **move** a file; those are three more tools and three more confirmations.
- `edit`'s atomicity is **per file**. A change set that spans files has no single gate today:
  file A can land while file B is rejected.
- The model pays a planning cost per tool call. One "here is the whole change" call is cheaper
  than a sequence that must be ordered correctly.

What it is not: a replacement for `edit` (single-file anchored surgery stays `edit`), a
directory/glob operation, a binary-file operation, or a rollback engine.

## Cases the grammar must express

1. add a file (including an empty one)
2. replace one line
3. replace a multi-line range
4. insert new lines after a line
5. delete one line / a range
6. delete a file
7. move a file, with and without a content change
8. several files in one patch (A + M + D together)
9. failures: anchor not served, anchor stale, malformed anchor, missing file, destination
   exists, empty patch

Anchors follow the existing contract (`CONTEXT.md`): variable-length Base62, copied from the
leftmost column of a read/grep/diff row, editable only when that anchor is in **this session's**
served set and still live. `line:anchor` is accepted as a weak line hint.

## Grammar A′ — file sections + anchor hunks (this draft's proposal)

A patch is a sequence of **file sections**. Every content line is prefixed with `+`, so a
section header is the only thing that can appear un-prefixed. There is no outer envelope and no
old-content line: the anchor addresses the line, the `+` lines are what goes there.

Section headers:

```text
file <path>              open an update section for <path>
new <path>               create <path>; the following `+` lines are its whole content
move <from> -> <to>      move <from> to <to>; optional hunks follow (move plus edit)
remove <path>            delete <path>
```

Hunk headers inside a `file` or `move` section:

```text
replace <anchor>             replace that line with the following `+` lines
replace <start>..<end>       replace the range
insert <anchor>              put the following `+` lines after that line
delete <anchor>              delete that line (no content lines follow)
delete <start>..<end>        delete the range
```

Rules:

- A hunk's content ends at the next hunk header, the next section header, or the end of the
  input; a blank line between blocks is cosmetic and ignored.
- `+` is the only content prefix; a bare `+` is an empty line. Content may contain `file`,
  `replace`, `---` or any other word — it is always behind `+`.
- Anchors are the contract's markers; `line:anchor` is accepted as a weak hint. The old text
  is **never** copied into the patch: the served set is the source of truth.
- Hunks inside one section apply against the file's pre-patch snapshot (the `edit` batch
  rule); overlapping ranges are a preflight refusal.
- Paths keep their spelling and resolve against the session's live cwd.
- Diagnostics point at the input line number of the offending header.

### A′ — worked example

Read gave these rows (abridged):

```text
Ab:12:  return `hello ${name}`
Cd:13:}
Ef:20:  if (!name) {
Gh:21:    return "hi"
Ij:24:
```

```text
file src/greet.ts
replace Ab
+  return `hi ${name}`
replace Ef..Gh
+  if (!name) return "hi"
insert Cd
+
+// trailing note
delete Ij

new src/hello.ts
+export function hello(name: string) {
+  return `hi ${name}`
+}

move src/old.ts -> src/new.ts

remove src/dead.ts
```

### What A′ drops from the Codex shape

| Codex / candidate A | A′ | Why |
|---|---|---|
| `*** Begin Patch` / `*** End Patch` | no envelope | one tool has one shape; the envelope adds a failure mode, not meaning |
| `*** Update File:` / `*** Add File:` / `*** Delete File:` | `file` / `new` / `remove` | same information, no asterisks |
| `@@ replace` | `replace` | the header is already line-initial; `@@` was Codex's marker for a context anchor |
| `-` old-content lines | none | the anchor addresses the line; copying old text is pure cost |
| `*** Move to:` | `move <from> -> <to>` | a move is a section, not a hint line |

## Rejected shapes (kept for the record)

- **A — Codex shell as-is**: rejected 2026-11-03 — the envelope and the old-content lines are
  Codex's vocabulary, and a patch never needs to copy file content.
- **B — extend `edit`'s JSON**: not rejected on merit; it is the answer to a D1 question
  (should `edit` grow `add` / `move` / file-level `del` instead of a second tool?).
- **C — hashline line DSL** (`Ab replace` + `|` content, `move` / `remove` lines): rejected —
  the content/next-header boundary is "a line not starting with `|`", exactly the fragility
  the `+` prefix fixes.
- **D — sigil instruction table** (`= Ab …` / `+ Gh …` / `- Ij`): rejected — invented sigils
  that mean nothing to a reader of `edit`; keywords say it better.

## Recommendation

Adopt **A′**. It keeps the one structural idea that survived review: a change set is a list of
file sections, each a list of anchor hunks, every content line `+`-prefixed. It drops
everything Codex-shaped and never asks the patch to restate file content.

D1 settled the tool-existence question: `apply_patch` stays a **separate tool**; `edit` keeps
its per-file atomic batch, and the patch owns the whole-patch preflight plus the
stop-at-first-failure commit. The contract below is normative.

## Execution contract

### Phase 1 — preflight (refuses the whole patch, writes nothing)

Every check runs and every failure is collected — no short-circuit:

1. **Syntax** — section and hunk headers, `+` content lines, range spelling, each header
   anchored to an input line. A syntax failure is a whole-call refusal on its own.
2. **Shape** — at least one section; each path appears once across the whole patch (a second
   section for the same path is refused, not merged); `replace` carries at least one content
   line (clearing a line is `replace` with `+` + an empty line; removing it is `delete`).
3. **Paths** — resolved against the session's live cwd. `new`: path must not exist and its
   parent directory must exist. `file` / `remove` / `move` source: must exist, be a regular
   file, and not a symlink, directory or binary. `move` destination: must not exist. `remove`
   on a missing path is refused (the patch is a change set, not an idempotent delete).
4. **Anchors** — every hunk anchor parses, belongs to the target file, is in THIS session's
   served set, and is still live; a stale anchor is refused with the fresh echo rows. Hunks in
   one section resolve against the file's pre-patch snapshot; ranges must not overlap and
   `start` must not follow `end`.
5. **Sandbox** — the call-level policy, one escalation for the whole patch.

Refusals are aggregated into **one** error value, one entry per problem, in **patch order**
(preflight discovers them in two passes, so the list is sorted before it is rendered —
the model reads it against the text it just sent). Each entry is
`operation N (kind path, patch line L): [CODE] message`, truncated after 10 entries with
`and N more`.

- `CODE` is the most **specific** code the engine reported: a container's `E_BATCH_ABORT`
  is peeled off, because "the batch failed" is not something the caller can act on.
- A rejection echo (a stale anchor's fresh rows) rides as indented continuation lines
  under its entry, capped at 10 lines; it is load-bearing for reject-and-serve, and the
  cap keeps ten problems from burying the list that names them.
- A path written twice is refused **symmetric to the spelling**: whether a move's
  destination is claimed by an earlier section or by a later one, exactly one section is
  refused — the answer never depends on which section the model wrote first.

### Phase 2 — commit (sequential, stops at the first failure, never rolls back)

- Operations run in patch order and settle as `completed`, `failed`, `unknown` or `skipped`.
- `skipped`: every operation after the stopping one; also everything left when cancelled.
- `failed`: the provider refused the write before any effect, or reported a settled failure.
- `unknown`: only when the mutation had started and the outcome cannot be settled (aborted
  request, or an I/O error whose before/after `stat` changed); its message ends with
  `re-read the affected files before retrying`.
- `cancelled`: the call aborted between operations.
- A stopped commit is a **success-shaped value**, not an error: completed work is reported
  truthfully and nothing is rolled back.

## Output contract

### Canonical value

```json
{
  "modelText": "…",
  "stopped": true,
  "cancelled": false,
  "operations": [
    { "index": 0, "kind": "add", "path": "src/hello.ts", "line": 2, "status": "completed",
      "changes": [{ "path": "/abs/src/hello.ts", "before": null, "after": "…" }] },
    { "index": 1, "kind": "move", "path": "src/old.ts", "destination": "src/new.ts", "line": 9,
      "status": "completed", "changes": [ … ] },
    { "index": 2, "kind": "delete", "path": "src/dead.ts", "line": 18, "status": "failed",
      "code": "E_NOT_FOUND", "message": "File not found." },
    { "index": 3, "kind": "update", "path": "src/x.ts", "line": 24, "status": "skipped" }
  ],
  "affectedPaths": ["/abs/src/hello.ts", "/abs/src/new.ts"],
  "error": { "code": "E_PATCH_REFUSED", "message": "…", "context": "…" }
}
```

- `kind` names the **effect** (`add` / `update` / `delete` / `move`), never the section keyword.
- `line` is the input line of the section header; a refused hunk adds `hunkLine`.
- `changes` carries the provider's before/after text for the card and never reaches the
  model text.
- `error` exists **only** for a syntax or preflight refusal. A stopped commit carries none.
- Every field is declared in the tool's `output.schema` (`additionalProperties: false`).

### Model-visible text

Success:

```text
Success. Updated the following files:
A src/hello.ts
M src/greet.ts
D src/dead.ts
M src/old.ts -> src/new.ts
```

Stopped commit (completed / failed / skipped, in that order):

```text
Patch stopped after 2 of 4 operations.
Completed:
A src/hello.ts
M src/old.ts -> src/new.ts
Failed:
- operation 3 (delete src/dead.ts, patch line 18): [E_NOT_FOUND] File not found.
Not executed:
- operation 4 (update src/x.ts)
```

Whole-patch refusal:

```text
[E_PATCH_REFUSED] Patch rejected before any change (2 problems):
- operation 1 (update src/greet.ts, patch line 3): [E_STALE] …
- operation 4 (update src/x.ts, patch line 24): [E_RANGE_UNSERVED] …
```

An empty patch succeeds with `Success. No operations in patch.`

### Anchor return

- Unchanged lines keep their anchors (inheritance), and a pure move keeps them too — they
  migrate to the destination path. The result therefore has to return only the anchors of
  **changed and inserted lines**.
- Those ride in per-file diff blocks appended to the model text, rendered by the same diff
  renderer `edit` uses: `+` rows carry the new anchor, `-` rows the old anchor marked stale.
- A `new` section returns the new file's own anchors: the create path mints and serves
  them, so a follow-up edit can address the file without a re-read (#416).
- Budget: the whole response honours `max_response_chars`; when it overflows, files are served
  in order until the budget runs out and the rest degrade to
  `(truncated; re-read <path> for anchors)`.

### Settings and interactions

- `require_line_content` — **ignored by the patch**: A′ has no declaration slot, and anchors
  plus the served set already gate the write. Adding an optional hunk-header tail note later
  stays backward compatible.
- `write.preview` — **ignored**: the patch's own diff is the preview.
- `sed` — not part of the patch grammar; it stays an `edit`-only operation.
- Sandbox escalation — call level (`sandbox_permissions` + `justification`): one approval covers
  the whole patch when the backend confines.

## Store contract (D2)

### Re-serve after a successful operation

- A completed `file` (and a `move` that carries hunks) re-serves through
  `buildServedRowsFromDiff` — the SAME window `edit` and `format` serve: first→last differing
  line ± `max(2, context_lines)`, minted and recorded in one transaction by
  `anchorForInWorkspace`. Serving narrower than the rendered diff would leave context rows
  visible but uneditable, breaking the served ⊇ rendered invariant.
- `new` mints and serves the new file's rows through the write path's own method
  (`allocateForRenderedRows`): the model sees the file's lines, so it gets their anchors
  (ADR-0009). `remove` serves nothing (the path is gone).
- A pure `move` (no hunks) serves nothing: `renamePath` migrates the served rows, so anchors
  the model already holds stay valid at the destination.
- Only the calling session's served set is written.

### Revoking old anchors

- The ordinary remap does it: unchanged lines keep their anchors (contentKey inheritance),
  changed lines mint new ones, deleted lines release theirs. No grace period — a stale anchor
  was already refused at preflight, and a later refusal echoes fresh rows (reject-and-serve).

### `remove`

- `remove` uses `HashStore.purgePath`: `anchor_meta`, `anchor_lines`, `served` (every session)
  and `undo` (every depth) — the same knife as the `delete` tool.

### `move`

- A move RENAMES FIRST, then writes its hunks at the **destination**. The order is not a
  preference: the provider's rename fence compares the probe taken at preflight against the
  file's fingerprint at rename time, and writing a hunk changes that fingerprint — so
  "write then rename" reports `[E_RENAME_STALE]` for the patch's own write and leaves the
  source edited with the move undone. Renaming first keeps the fence answering "did somebody
  ELSE touch this file", and the hunks then land where the operation says they belong.
- The anchors belong to the source file's snapshot; `renamePath(from, to)` migrates all four
  row families to the destination (purging the destination's residue) and the served window
  is recorded there. A pure move is the migration alone — no rows are written.

### `new`

- `new` goes through the write path's OWN create method (`createFile`): the model's content
  lands, the automatic format pass may rewrite it, the language server is told what the
  file holds — then any rows left at that path by a previous incarnation are purged (the
  path was absent at preflight, but a deleted file's rows can linger until the sweep), and
  the new file's rows are minted AND served through `allocateForRenderedRows` — the same
  method the write path's diff uses (#416).

### Partial results

- Only `completed` operations touch the store. `failed`, `skipped` and `unknown` leave it
  untouched; an `unknown` mutation is settled by the next `read` (drift check).

### `undo_last_edit`

- Each `completed` `file` (and `move` with hunks) pushes **one undo layer for its file**,
  exactly as a single `edit` would: `undo_last_edit <path>` reverts that file by one layer.
- `new` and `remove` are not undoable: a removal purges its own history, and "return to
  not-existing" has no undo slot.
- A commit that stops midway leaves layers only for the operations that completed —
  consistent with reporting completed work truthfully.

## Registration and guidance (D3)

### Registration

- The tool is ALWAYS offered while `apply_patch.enabled` is true (the default). The official
  `@deepseek-ai/dsh-tool-fs` tool may exist beside it (its `applyPatch` composition flag); the
  name is the same, so exactly one wins:
  - Probe the registry once per plugin context (the `lsp` pattern, `builtInToolPresent`): a
    FOREIGN `apply_patch` already registered farther out → register on the **agent layer**,
    which is nearer and therefore shadows it; remember the definition in `ownToolDefinitions`
    so a later probe never mistakes ours for a built-in.
  - No foreign same-name tool, or the registry cannot answer → register ONCE on the **plugin
    layer**, so every agent has it from its first turn (ADR 0032).
- Registration follows the flag: disabled disposes the tool and the guidance section together;
  the settings `document-updated` event re-installs (hot), the seam the edit surface already
  uses.

### Setting

```yaml
apply_patch:
  enabled: true   # default when absent; explicit false removes tool + section
```

- Schema: `apply_patch: z.object({ enabled: z.boolean() }).volatile()` — volatile on the
  outermost node only, like `write` / `format`.
- `resolveSettings` reads `settings?.apply_patch?.enabled ?? defaults.applyPatchEnabled`, with
  the default `true` in `infra/settings.ts`.

### Guidance section

- Name `tool:apply_patch`, override file `apply_patch.md`, order **136** (after `rename` 135).
- Compiled default text: intro `apply_patch applies one change set across files: file sections
  (file / new / move / remove) with anchor hunks (replace / insert / delete)`, then bullets:
  - Reach for it when a change spans several files or creates, removes or moves a file; a
    single-file anchored surgery stays `edit`.
  - Every hunk is addressed by an anchor from this session's read/grep/diff rows — the patch
    never repeats file content.
  - The whole patch is checked before anything is written (syntax, shape, paths, anchors); a
    rejected patch lists every problem at once and changes nothing.
  - Once applying starts, operations run in order, stop at the first failure and are not rolled
    back — re-read the affected files before retrying.
  - A completed add/update/move returns fresh anchors for the changed lines; a created file
    returns anchors for its own rows too, so it can be edited right away.
- Boundary, same section and README: `edit` = one file of anchored surgery; `write` = whole
  file; `delete` / `rename` stay for exactly their one job; `apply_patch` = the multi-file
  change set.

### Client and docs

- The settings card gains one toggle beside `write.preview`, writing `apply_patch: { enabled }`
  (label + hint in both locales).
- README (both languages): the tool table gains its row, plus a short section with the A′
  example and the default-on note.
- `CONTEXT.md`: `apply_patch`, `patch section`, `preflight refusal`.

## Presentation contract (D4)

### The card

- **One section, one single-function tool's card** (the rule the review settled on): `new`
  draws a write's `+` rows, `file` an edit's anchored hunks, `move` a rename's sentence plus
  its hunks, and `remove` a tab that says the file is deleted. Register a `tool.call.toolview`
  entry keyed `apply_patch` at the plugin's takeover priority; the payload is `{ card: 'diff',
  title, diffs, diffRowGroups?, failures? }` from `presentationMeta`.
- Title: `Apply patch (N files)`; `Apply patch (stopped)` for a stopped commit;
  `Apply patch (no operations)` for an empty patch. Titles ride the existing
  `rowTitle(key + params)` wire contract, THREE keys (`row.title.apply_patch.files` /
  `.stopped` / `.empty`), each present in the wire-key whitelist and in both locales — a
  key the whitelist does not carry is dropped and the row falls back to its variant's label
  (which is how the card once announced itself as a read).
- `diffRowGroups` is ALWAYS present, one group per **completed operation** — a row-less
  group is still a file. Each group carries the section's `kind` (`added` / `modified` /
  `renamed` / `deleted`) and, for a rename, its `from` source path; the group KIND is the
  card's one typed fact about a section, and the shared card keys the tab's tone, its
  sentence and the strip's strikethrough off it. A group without `kind` is a plain content
  change (every other writer of this shape).
- Tab body: a rename shows `renamed {from} to {to}` (localised) above its hunks; a removal
  shows `file deleted` and no rows at all. **No tab body is ever empty** — an empty panel
  is how a moved file used to read as "nothing happened", and how a removed file read as
  "this file is not in the patch".
- Tab strip: a `deleted` tab label is red AND struck through (the error tone plus the
  deletion mark, no dot — a dot means the file FAILED, a different fact).
- Order: files appear in **operation order** (the order they occur in the patch), named by
  the caller's display spelling. A/M/D is model-text vocabulary and is never a card grouping.
- The folded row's path list marks every section's OUTCOME: `+ path` created, `~ path`
  edited, `- path` removed, `from -> to` renamed. A list of bare paths cannot say which file
  was new and which was deleted, which is the whole point of a change set; `+` / `~` / `-`
  are the diff stat's own words at zero locale cost. A move keeps its two ends together —
  the arrow is the rename tool's spelling, and a comma between them reads as "two files
  changed".
### Diffs

- Fed only from each operation's `changes` (`before` / `after`):
  - add → `{ path, oldText: null, newText }` — the whole-file create form the card renders today.
  - update → the hunk diff between `before` and `after`.
  - move with hunks → the diff at the **destination** path.
  - delete → **no diff at all**, in either channel: the tab's `deleted` kind names the path
    and the card renders its sentence. A `-` row is the edit card's vocabulary, not the
    delete card's.
  - pure move → no line diff; the tab carries the rename sentence, and `operations` carries
    the ledger.
### Call-time preview

- `presentCall` returns a generic card with one line per operation (`A path` / `M path` /
  `D path` / `M from -> to`) and **no** line diff: at call time the patch carries no old
  content, so a diff would read as if everything were an addition.

### Stopped and refused

- A stopped commit reuses the card's `failures` list (the same `FileFailureMeta` the
  multi-file `edit` uses) plus the `(stopped)` title suffix.
- A whole-patch refusal is the existing error card: `presentationMeta` returns
  `{ error: ErrorMeta }`. No new component, no new field.

### Review

- Untouched. The Review panel reads the fs intent slots and turn snapshots, not this card;
  because apply_patch commits through `ctx.fs.*`, its changes appear there for free.

### Client

- One new `tool.call.toolview` key (`apply_patch`) pointing at the SHARED edit row: the
  `meta.diffs` / `meta.diffRowGroups` payload is exactly what `edit` sends, and the section
  outcome + tab note (#401) are drawn by that same card. `DiffRowGroup` grew two optional
  fields (`kind`, `from`) and the tab strip one optional prop (`deletedIndexes`); no new
  component, no wire-contract change.
