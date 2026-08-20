# Spec — Structured web-UI views for `dsh-hashline-edittool` tools

> Status: **Draft** — awaiting review before implementation begins.
> Scope: emit `ToolResultView` / `ToolCallView` shapes from each tool so
> dsh-web can render them as line-numbered code views, diff cards, and
> grouped search cards instead of plain text. **No behavioural change**
> to the model-facing text contract — this is purely a presentation
> upgrade the web picks up automatically.

## 1. Goal

Today every tool's `output.render` returns
`{ type: "text", text: value }`. dsh-web renders that as plain text
inside the tool-call card. The model gets the right contract (`HASH
IDENTIFIER │ FILE LINES` header + `<line>#hash│content` rows + `Shift:`
blocks), but the human looking at the chat sees an undifferentiated text
blob.

`dsh-tools` ships a typed `ToolResultView` vocabulary — `card: 'read'`,
`card: 'diff'`, `card: 'search' shape: 'matches'`, etc. — that a "capable
UI" (dsh-web today; dsh-cli tomorrow) can switch on to render the
appropriate component family. Tools opt in by:

1. emitting structured metadata via `output.presentationMeta(args, value)`
   — this gets persisted with the session log so **replays** can also
   render the rich view;
2. returning a typed `ToolResultView` from `presentResult(args, result)`.

Pending state (the card shown while the call is running) optionally
adds `presentCall(args)` returning a `ToolCallView`.

The web does not need a slot/registry API — it already has renderers
matching each card type. **Our job is to emit the right shape** so the
web picks the right renderer automatically.

## 2. Background — what is and isn't available

From `@deepseek-ai/dsh-tools` `presentation.d.ts` and the runtime
contract in `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.js` +
`index.js`:

| Card type | When to use | Key fields |
| --- | --- | --- |
| `card: 'generic'` | Default; plain-text content | `title?`, `content?` |
| `card: 'terminal'` | Shell / long-running process | `title?`, `output?`, `exitCode?`, `signal?` |
| `card: 'diff'` | File mutation (call-time OR result-time) | `title?`, `diffs: FileDiff[]` |
| `card: 'search' shape: 'matches'` | `grep`-style content search | `title?`, `files: { path, matches: { lineNumber, line }[] }[]`, `truncated`, `total` |
| `card: 'search' shape: 'paths'` | `glob`-style path search | `title?`, `paths: string[]`, `truncated`, `total` |
| `card: 'read'` | File read | `title?`, `path`, `offset`, `lines: { number, text }[]`, `totalLines`, `lang?`, `content?` |
| `card: 'web'` | Web retrieval (`web_search` / `web_fetch`) | `kind: 'search'\|'fetch'`, … |

Pending-state call views (`ToolCallView`):

| Card type | Use case | Key fields |
| --- | --- | --- |
| `card: 'generic'` | Default | `title`, `kind?: ToolCallKind`, `rawInput?`, `content?`, `locations?: FileLocation[]` |
| `card: 'terminal'` | Shell | `title`, `description?`, `cwd?` |
| `card: 'diff'` | File mutation at call-time | `title`, `diffs: FileDiff[]`, `locations?` |

### 2.1 Contract properties from the runtime

Verbatim from `@deepseek-ai/dsh-tools` `README.md` (English) and the
runtime validation in `node_modules/@deepseek-ai/dsh-tools/lib/types/index.js` + `schema.js`:

- `presentCall` / `presentResult` **depend only on their arguments** —
  UIs call them during live streaming AND session-log replay. They must
  be pure and never throw. The runtime soft-validates args and falls
  back to `undefined` (generic UI presentation) on any mismatch.
- `output.presentationMeta(args, value)` derives JSON metadata for
  **direct top-level calls only** (nested Code dispatches don't compute
  metadata). The result is persisted with `tool/result` and returns to
  `presentResult`. The canonical `value` itself is execution-local and is
  never replayed.
- `output.schema` is the JSON schema enforced against every successful
  body or policy-replaced value. It is **declared**, not checked
  automatically — `render` reads whatever the body returned. (`defineTool`
  asserts the schema is well-formed; runtime does not validate values
  against it.)
- `output.render(args, value)` is the only path the model sees. It
  converts the canonical value to one or more `ContentBlock`s (typically
  one `{ type: 'text', text }`).

### 2.2 Reference implementation: `@deepseek-ai/dsh-tool-fs`

The official fs package is the canonical pattern this spec is for.
`/Users/mutou/Applications/.backup/DeepSeek-Harness.app.original.bak/Contents/Resources/host/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js`
shows the full `read` / `write` / `edit` shape:

- **`read`** canonical value: `{ path, offset, lines: [{ number, text }],
  totalLines }`. `presentationMeta` adds `lang` from the file
  extension. `presentCall` is generic (`kind: 'read'`) with the
  `locations` hint. `presentResult` validates `result.meta` strictly
  (`readMetaFromMeta`), regex-parses the envelope
  `/^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u`
  to extract the body for `content`, and returns `{ card: 'read', …,
  content }`.
- **`write` / `edit`** canonical value: `{ path, operation?, before,
  after }`. `presentationMeta` calls `computeHunkDiffs(path, before,
  after)` (a `diff` package `structuredPatch` with `context: 3`) and
  returns `{ diffs: [{ path, oldText, newText }, …] }`. For a new-file
  create, `before` is `null` and the diffs array is empty (a UI renders
  a "create" card with `oldText: null` per the spec note).
  `presentCall` uses `args.old_string || null` for `oldText` (call-time
  presenter has no access to the file's prior content per spec note).
  `presentResult` validates via `diffsFromMeta`.

This is the pattern we replicate for the hashline contract.

## 3. What is NOT available — clarifying misconceptions

- **There is no slot mechanism for tool-result cards.** `@deepseek-ai/dsh-client-ui-slots`
  (`register`, `inject`, the `'conversation.input.left'` /
  `'conversation.input.dock'` / `'shell.overlay'` slot names) is for
  **ambient web UI** — toggle buttons, panels, settings sections
  embedded in a fixed page slot. Verified against two production
  plugins that use exactly this pattern:
    - `@dsh-external/dsh-ui-progress` registers a `SessionProgressBar`
      into `conversation.input.dock`.
    - `@dsh-external/dsh-ui-whale` registers a `WhalePet` into
      `conversation.session.header.actions`.
  Neither plugin implements tool-result rendering. Tool-result
  rendering is the **`presentResult` / `presentationMeta` mechanism**
  that `dsh-tool-fs` demonstrates and that dsh-web consumes via the
  pre-existing `resultView: ToolResultView | null` field on
  conversation events.
- **Plugin code does not write web-side rendering.** The web has the
  renderers for each card type. Plugins only emit typed views.
- **`run_code` is reserved** for the Code Mode transport and cannot
  be registered or shadowed — irrelevant here but flagged so future
  variants that try to add a tool with that name fail fast.

## 4. New design — per tool

The model-facing text format is **byte-identical to today**. The
canonical value behind it grows structured fields; `render` projects
the model text from those fields. `presentationMeta` and
`presentResult` are added.

### 4.1 `read` → `card: 'read'`

Canonical `value` (returned by `execute`):

```ts
{
  path: string,           // model-facing path (relativized by the bridge)
  offset: number,         // 1-based first line of the returned window
  totalLines: number,     // exact total line count in the file
  lines: { number: number, text: string }[],  // window content, with hash-free text
  hashlines: { number: number, hash: string, text: string }[],  // same lines WITH hash anchor
  truncatedByBytes?: boolean,
}
```

`output.schema` matches that shape (the hashlines field is part of the
canonical contract — the model text uses it, and the card uses
`hashlines` for the anchor column).

`output.render(args, value)` projects the model-facing text:

```
HASH IDENTIFIER │ FILE LINES
 3#ve7│function hello() {
 4#szJ│  console.log("world");
 ...

```

The first line of the rendered body is the `HASH IDENTIFIER │ FILE
LINES` header (fixed). Each subsequent line is
`<number>#<hash>│<content>` from `value.hashlines[i]`. The trailing
pagination footer matches today's behaviour
(`(Showing lines 3-4 of 12. Use offset=5 to continue.)`).

A thin regex `^HASH IDENTIFIER │ FILE LINES\n([\s\S]*)$` extracts
`body` for the `content` field of the `ReadResultView` (the
envelope-stripped fallback).

`presentationMeta(args, value)` returns `{ path, offset, lines,
totalLines, lang?, hashlines }`. `lang` derived from the file
extension via `langFromPath` (mirroring `dsh-tool-fs`'s helper — see
implementation seam below).

`presentCall(args)` returns the generic call view
(`{ card: 'generic', title: 'Read <path> (<range>)', kind: 'read',
locations: [{ path, line: offset ?? 1 }] }`) — pure, no IO. The call
has no content yet.

`presentResult(_args, result)`:
1. `result.isError === true` → return `undefined` (generic error card).
2. `result.meta === undefined` → return `undefined` (replay of an
   older logged call without meta → generic card).
3. Soft-validate `result.meta` (path: string, offset: integer ≥ 1,
   totalLines: integer ≥ 0, lines: array of `{ number, text }`,
   hashlines: array of `{ number, hash, text }`, lang?: string,
   truncatedByBytes?: boolean). Reject to `undefined` on any
   violation. Line numbers must strictly increase from `offset`,
   not exceed `totalLines`. (Mirrors `dsh-tool-fs`'s `isFileTextLine` +
   loop.)
4. Parse `result.content[0].text` (must be exactly one text block) with
   `^HASH IDENTIFIER │ FILE LINES\n([\s\S]*)$` to extract the body
   for the fallback `content` field.
5. Return `{ card: 'read', title: 'Read <path>', path, offset,
   lines, totalLines, lang?, hashlines, content: [{ type: 'text',
   text: body }] }`.

`hashlines` is **added** to the standard `ReadResultView` shape as a
plugin-specific field. UIs that don't know about it ignore the extra
key and use `lines` (hashline-agnostic rendering). UIs that do know
about it use `hashlines[i]` for the anchor column.

### 4.2 `edit` → `card: 'diff'`

Canonical `value`:

```ts
{
  path: string,         // model-facing path
  before: string,       // original (pre-edit) full file content, LF-normalized
  after: string,        // post-edit full file content, LF-normalized
  hunkShifts: {         // per-hunk shift info (the model-facing Shift: blocks)
    index: number,
    delta: number,
    firstStableLineNew: number,
    lastChangedLine: number,
  }[],
}
```

`output.render(args, value)` projects:
- `HASH IDENTIFIER │ FILE LINES` header
- The post-edit diff rows (`+line#hash│content`, `-line#hash│content`,
  ` line#hash│content`) from `computeHunkDiffs(value.before,
  value.after)` (mirroring `dsh-tool-fs`'s implementation)
- One `Shift: lines > N shift by +K …` block per hunk
- The success summary line
- The warnings / drift blocks (already text — projected from
  `value.warnings`, `value.driftNotice`)

The canonical value carries `before` / `after` because computing diffs
needs both. `presentationMeta` derives diffs once and caches them in
the session log.

`presentationMeta(args, value)` returns `{ diffs: FileDiff[] }`
where each `FileDiff` is computed via `computeHunkDiffs(value.before,
value.after)` with `context: 3`. `oldText` is the before-context +
removed-line lines + the same trailing context (the standard hunk
format). `newText` is the after-context + added-line lines + the
same trailing context. Empty diffs means noop; we still return
`{ diffs: [] }` and `presentResult` falls back to `undefined`
(no card to render).

`presentCall(args)` — note: hashline-anchored edits need a special
case. The user-facing anchors are `<line>#<hash>`, but the diff card
needs `oldText` / `newText` plain text. For pending state we emit a
generic card with `kind: 'edit'` and `locations: [{ path, line:
parseLineFromHash(args.remove_from) }]`. **We do not emit a
`card: 'diff'` pending view** because:

- The call-time presenter is pure and cannot read the file (per spec).
- Emitting `oldText: null` plus `newText` from the replacement text
  is honest but loses the user's anchor information — the pending
  card would show "diffs: [{oldText: null, newText: '...replacement...'}]"
  with no anchor. Better to show the generic card until the real
  diff lands.

`presentResult(_args, result)`:
1. `result.isError === true` → `undefined`.
2. `result.meta === undefined` → `undefined`.
3. `diffsFromMeta(result.meta)` validates `diffs` (non-empty array of
   `{ path: string, oldText: string | null, newText: string }`). On
   failure → `undefined`.
4. Return `{ card: 'diff', title: 'Edit <path>', diffs }`.

### 4.3 `batch_edit` → `card: 'diff'`

Canonical `value` is one of:

```ts
// all-or-nothing batch with hunks in multiple files
{
  results: { path: string, before: string, after: string }[]
}
```

(or `{}` when every item was a noop.)

`output.render(args, value)` produces the existing model-facing text:
one `--- path ---` per file, each with the header + diff rows + Shift
blocks. The diffs for the per-file rendering come from
`computeHunkDiffs(before, after)` per file.

`presentationMeta(args, value)` returns `{ diffs: FileDiff[] }` —
flattened across files in file order.

`presentResult(_args, result)` returns
`{ card: 'diff', title: 'batch_edit (<N> files)', diffs }` or
`undefined` when empty (all noop).

### 4.4 `grep` → `card: 'search' shape: 'matches'`

Canonical `value`:

```ts
{
  files: { path: string, matches: { lineNumber: number, line: string }[] }[],
  truncated: boolean,
  total: number,           // pre-cap total
}
```

`output.render(args, value)` projects the current model-facing text:

```
--- src/foo.ts ---
HASH IDENTIFIER │ FILE LINES
42#ve7│function hello() {
43#8mK│  console.log("world");
...
```

(`matches[i].line` is `line#hash│content` already-formatted, so
`render` joins them directly.)

`presentationMeta(args, value)` returns `{ files, truncated, total }`.

`presentResult(_args, result)`:
1. `result.isError` → `undefined`.
2. Soft-validate: `files` is an array, each entry has `{ path: string,
   matches: array of `{ lineNumber: number, line: string } }`,
   `truncated: boolean`, `total: number`. On failure → `undefined`.
3. Return `{ card: 'search', shape: 'matches', files, truncated,
   total }`.

**Note**: grep has no `presentCall` — per the dsh-tools spec, "a
search has no `card: 'search'` call-time analogue" because the
pending state has no matches to show. The pending state stays the
generic call view (`kind: 'search'`).

### 4.5 `undo_last_edit` → `card: 'diff'`

Canonical `value`: `{ path, before, after }` (where `before` is the
post-edit content and `after` is the pre-edit content — the undo
flips them).

`presentationMeta(args, value)` returns `{ diffs: FileDiff[] }`
computed the same way as `edit`.

`presentResult(_args, result)` returns `{ card: 'diff', title:
'Undo <path>', diffs }`.

## 5. Cross-cutting concerns

### 5.1 `output.schema` change

Today every tool's `output.schema` is `{ type: 'string' }`. We
change each to a structured object matching the canonical value shape.
`render` projects `value.<textField>` to the model-facing content
blocks.

### 5.2 Markdown table side-effect

The `HASH IDENTIFIER │ FILE LINES` header + `<line>#hash│content` rows
can accidentally trigger markdown table parsing when a row has `│`
as the separator and surrounding rows line up.

**Decision: emit `type: 'code'` content blocks.** A fenced code block
skips markdown table parsing entirely. The chat loses inline
formatting on warnings / drift notices — those are structured
metadata anyway, not flowing prose. This is the safe, honest choice;
we trade a small UX loss for predictable rendering.

### 5.3 Persistence + replay

`output.presentationMeta` is computed once at execute time and
persisted with the session log. `presentResult` reads `result.meta`
to build the view on both live and replay paths. A session log
captured before this spec lands → no `meta` → generic card fallback
(graceful degradation, no migration).

### 5.4 Sandboxed / remote filesystems

`path` in views is always the **model-facing** path, never the
resolved absolute path — so a sandboxed or remote FS doesn't leak
the host layout. The bridge relativizes for display.

### 5.5 `presentCall` purity

`presentCall` must not read the filesystem. Even though `execute`
reads the file for `edit` / `write`, the call-time presenter cannot
do that — per spec. We always emit a generic call view (`kind:
'edit'`, with `locations: [{ path, line }]` parsed from
`remove_from`).

### 5.6 Reusable helpers

Extract three pure helpers into `src/presentation-helpers.ts`:

- `buildReadPresentation(content, hashes, offset, limit, path, lang?)`
  → `{ path, offset, totalLines, lines, hashlines, truncatedByBytes,
  modelText }`.
- `buildDiffPresentation(path, before, after)` → `{ diffs:
  FileDiff[], modelText }`. Reused by `edit`, `batch_edit`,
  `undo_last_edit`.
- `buildSearchPresentation(files, truncated, total)` → `{ files,
  truncated, total, modelText }`.

`computeHunkDiffs(path, before, after)` — a thin wrapper over
`structuredPatch('', '', before, after, undefined, undefined, {
context: 3 }).hunks`. Mirrors `dsh-tool-fs` 1:1.

`langFromPath(path)` — extract `.ext`, lowercase, look up in
a small map (mirror of `dsh-tool-fs`'s helper; we extend with
`tsx`/`jsx`/`json`/`yaml`/`md` for the hashline corpus).

## 6. API / contract changes

| Surface | Change |
| --- | --- |
| `output.schema` (all 5 tools) | `{ type: 'string' }` → structured object matching the canonical value. |
| `output.render` (all 5 tools) | Returns `[{ type: 'code', text: <modelText> }]` (see §5.2). |
| `output.presentationMeta` (all 5 tools) | **New.** Returns the structured card projection. |
| `presentCall` (`edit`, `batch_edit`, `undo_last_edit`, `read`) | **New.** Returns a generic call view with `kind` + `locations` hint. `grep` has no `presentCall` (per spec). |
| `presentResult` (all 5 tools) | **New.** Returns the typed `ToolResultView`. |
| Model-facing text format | **Unchanged.** `HASH IDENTIFIER │ FILE LINES`, `<line>#hash│content`, `Shift:` blocks, `[E_*]` codes — byte-identical. |

No prompt-section or contract change for the model. A human reading
the chat sees the same text as today, plus the structured card from
the web.

## 7. Implementation map (per file)

| File | Change |
| --- | --- |
| `src/presentation-helpers.ts` (new) | `buildReadPresentation`, `buildDiffPresentation`, `buildSearchPresentation`, `computeHunkDiffs`, `langFromPath`. Pure functions, no IO, no cordis. |
| `src/tool-read.ts` | `output.schema` → structured. `execute` returns the structured value. `render` → `type: 'code'`. `presentationMeta` + `presentCall` (generic with `kind: 'read'`) + `presentResult` (`card: 'read'`). |
| `src/tool-edit.ts` | Same shape. `execute` returns `{ path, before, after, hunkShifts }`. `presentationMeta` returns `{ diffs }`. `presentCall` generic with `kind: 'edit'` + `locations`. `presentResult` `card: 'diff'`. |
| `src/tool-batch-edit.ts` | Same shape with `results: [{ path, before, after }]`. |
| `src/tool-grep.ts` | Same shape with `{ files, truncated, total }`. **No `presentCall`.** |
| `src/tool-undo.ts` | Same shape as `edit`. |
| `src/edit-response.ts` | Extract `buildDiffPresentation` call. The model-text formatting and the per-hunk Shift block rendering stay in this module; the structured diffs live in the helpers. |

## 8. Test plan

| Test | Asserts |
| --- | --- |
| `tool-read.presentResult` returns `ReadResultView` with `path`, `offset`, `lines: [{number, text}]`, `totalLines`, `lang?`, `hashlines`. |
| `tool-read.presentResult.content` strips the `HASH IDENTIFIER │ FILE LINES` envelope. |
| `tool-read.presentResult` keeps `offset` even when `lines` is empty (oversize first-line cap). |
| `tool-read.presentResult` returns `undefined` when `result.isError` is true. |
| `tool-read.presentResult` returns `undefined` when `result.meta` is missing or fails soft-validation. |
| `tool-read.output.render` returns a single `code` content block; the model text matches the pre-this-spec format byte-for-byte. |
| `tool-read.presentCall` returns generic with `kind: 'read'`, `locations: [{path, line}]`. |
| `tool-edit.presentCall` returns generic with `kind: 'edit'`, `locations` parsed from `remove_from`. |
| `tool-edit.presentResult` returns `DiffResultView` with one entry per hunk; `oldText` and `newText` are the standard `structuredPatch` shape (3 lines of context on each side). |
| `tool-edit.presentResult` returns `undefined` when `result.meta.diffs` is empty. |
| `tool-edit.output.render` returns the same diff text + Shift block as before. |
| `tool-batch-edit.presentResult` aggregates `diffs` across files in a single batch. |
| `tool-batch-edit.presentResult` returns `undefined` when all items were noop. |
| `tool-grep.presentResult` returns `SearchMatchesResultView` with `shape: 'matches'`; `files[]` is in first-seen order; context rows are included in the `matches` arrays. |
| `tool-grep.presentResult.truncated` is `true` when `limit` capped the per-file matches. |
| `tool-grep.presentResult.total` equals the pre-cap count of matched lines across all files. |
| `tool-grep` has **no** `presentCall`. |
| `tool-undo.presentResult` returns `DiffResultView` with `oldText` = post-edit content, `newText` = pre-edit content. |
| `computeHunkDiffs` produces 3-context-line diffs identical to `dsh-tool-fs`'s implementation. |
| Schema validation — passing a non-matching value to a tool fails `defineTool`'s schema-shape check (via `assertSupportedJsonSchema`). |

## 9. Risks and open questions

1. **`output.schema` is currently `{ type: 'string' }` and is read by
   other parts of dsh (logging, replay, `--dump-config` diagnostic).**
   Changing it to an object is observable to those consumers.
   Mitigation: `output.render` is responsible for the model-facing
   `content` block, not the consumer. Consumers that read
   `tool/result.content` already get text blocks, not the raw value.
   Verify with `npm run typecheck` and the integration suite.

2. **Markdown `│` table parsing.** Mitigated by `type: 'code'` content
   blocks (see §5.2). The chat loses inline formatting on warnings /
   drift notices — acceptable since those notices are structured
   metadata.

3. **`grep` "truncated" semantics.** `limit` is per-file. The spec
   uses a global `truncated` + `total`. We treat any per-file
   truncation as a global `truncated: true` (the model text and the
   card agree). `total` is the sum across all files pre-cap.

4. **Sandbox / remote path leakage.** `path` in the view is always
   the model-facing path. No additional sanitization needed; the FS
   bridge already enforces this.

5. **`presentResult` for a failed call.** `result.isError` is true;
   the view should fall back to the generic card. Implementation:
   return `undefined` from `presentResult` when `result.isError`, so
   the web uses the default error rendering.

6. **Replay of pre-this-spec sessions.** `presentationMeta` is
   optional; missing meta → generic card fallback. No migration
   needed.

## 10. Rollout

1. Land this spec for review (this PR).
2. Land the implementation as one PR per concern if it gets large:
   - PR 1: shared `presentation-helpers.ts` (foundational).
   - PR 2: `read` → `ReadResultView`.
   - PR 3: `edit` + `batch_edit` + `undo_last_edit` → `DiffResultView`.
   - PR 4: `grep` → `SearchMatchesResultView`.
3. Run the integration suite + new presentation tests.
4. Verify against dsh-web (manual boot — see the dsh-plugin-guidelines
   "Local install & verification" section for the pack→add→boot
   pattern; bump the version each round to defeat pnpm content-store
   dedup on same-version tarballs).
5. Update `README.md` "Tools" table with the "web UI" column
   pointing at the rendering.
6. `CHANGELOG.md [Unreleased]`: Added — Structured web-UI views via
   `output.presentationMeta` + `presentResult` + `presentCall`.
7. Tag `0.3.0` (minor bump — schema change is observable).

## 11. Out of scope

- New card types beyond the existing 6 (`card: 'generic'`, `'terminal'`,
  `'diff'`, `'search'`, `'read'`, `'web'`) — would require a
  `dsh-web` change, not a plugin change.
- Slot registrations (`@deepseek-ai/dsh-client-ui-slots`) for ambient
  web UI (toggle / panel / settings) — orthogonal; not used here.
- A `web` card for our tools (none hit the web).
- A `terminal` card for our tools (none run a shell).
- Replay-time reflow of `presentationMeta` for sessions logged before
  this spec landed — they degrade to the generic card automatically;
  no backfill.

## 12. References

- **Authoritative reference**: `@deepseek-ai/dsh-tool-fs/lib/index.js`
  — the official built-in fs tools. `read` (line 320), `write` (line
  580), `edit` (line 760). `computeHunkDiffs` (line 486),
  `diffsFromMeta` (line 522), `readMetaFromMeta` (line 202),
  `langFromPath` (line 130+).
- Slot mechanism for ambient UI (NOT used here):
  - `@dsh-external/dsh-ui-progress/src/client/index.ts` —
    `conversation.input.dock` registration.
  - `@dsh-external/dsh-ui-whale/src/client/index.ts` —
    `conversation.session.header.actions` registration.
- dsh-tools contract: `@deepseek-ai/dsh-tools/lib/types/presentation.d.ts`
  + `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.js`
  (`defineTool` wrapper) + `index.js` (`register` validation).
- Plugin-authoring rules: `.agents/skills/dsh-plugin-guidelines/SKILL.md`
  (host-plane vs agent-plane, scope layering, the two planes).