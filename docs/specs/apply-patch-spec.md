# `apply_patch` — implementation spec

Status: **draft v2 (A′)** — prototype artifact for the ticket
[原型：锚点优先的 patch 文本长什么样（三份候选文法 + 真实样例）](https://github.com/hyperion2144/dsh-hashline-edittool/issues/409),
under map [#401](https://github.com/hyperion2144/dsh-hashline-edittool/issues/401).
v1 shipped three Codex-shaped candidates and was rejected: the patch must not carry file
content at all, and the Codex envelope is not ours. v2 keeps candidate A's skeleton (file
sections + hunk blocks + `+` content lines) and drops the envelope, the `***`/`@@`
vocabulary and the old-content lines.

Owners (once accepted): `src/domain/patch/` (parse + preflight + commit),
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

Open for D1: whether this capability should instead be three more `op` values on `edit`
(candidate B's real question).

## Open questions this ticket does not settle (D1 / D2)

- Old-content declaration: A′ never writes it. When `require_line_content` is on, does the
  patch offer an optional declaration (a hunk-header tail note), or ignore the setting?
- An empty patch: success with no operations, or a refusal?
- Case and indentation tolerance for the section and hunk keywords.
- Ordering and overlap rules when one file carries several hunks; whether a later operation may
  consume lines produced by an earlier one (recommend: no — anchors must already be served).
- Parameter name: `input` (official) or `patch`; and whether the value is one string or a
  `{patch: […]}` object.
- Whether `sed`-style regex operations belong to a patch at all.
- How the whole patch is rejected: one aggregated refusal listing every refusal (official
  style), or first-refusal-wins.
