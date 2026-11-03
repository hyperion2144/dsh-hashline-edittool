# `apply_patch` — implementation spec

Status: **draft, not accepted** — prototype artifact for the ticket
[原型：锚点优先的 patch 文本长什么样（三份候选文法 + 真实样例）](https://github.com/hyperion2144/dsh-hashline-edittool/issues/409),
under map [#401](https://github.com/hyperion2144/dsh-hashline-edittool/issues/401).
This file holds **three candidate grammars**; the grammar chapter becomes normative only
after the maintainer picks one and the pick is recorded on #409.

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

## Candidate A — Codex shell, `@@` carries the anchor

```
*** Begin Patch
*** Add File: <path>
+<content line>
…

*** Update File: <path>
@@ replace <anchor>
-<old content, optional>
+<new content>
…
@@ replace <start>..<end>
+<new content>
…
@@ insert <anchor>
+<new content>
…
@@ delete <anchor>
@@ delete <start>..<end>

*** Update File: <path>
*** Move to: <new path>
@@ … (optional hunks: move plus edit)

*** Delete File: <path>
*** End Patch
```

Rules:

- `+` lines are content, at least one for `replace`/`insert`; a bare `+` is an empty line.
- `-` lines are an **optional** declaration of the anchor line's current text (the same check
  `require_line_content` performs; a mismatch is a preflight refusal). They never locate
  anything — the anchor does.
- `@@ replace` replaces the anchor line, or the `start..end` range.
- `@@ insert` puts the following `+` lines after the anchor line; `-` lines are refused.
- `@@ delete` takes no content lines after it.
- `*** Move to:` must follow `*** Update File:` before the first `@@`.
- Hunks apply against the file's **pre-patch snapshot** (same rule as one `edit` batch), so an
  anchor never shifts under another hunk; overlapping ranges are a preflight refusal.
- Paths keep their spelling and resolve against the session's live cwd.
- Diagnostics point at the **input line number** of the offending hunk.

### A — worked example

Read gave these rows (abridged):

```text
Ab:12:  return `hello ${name}`
Cd:13:}
Ef:20:  if (!name) {
Gh:21:    return "hi"
```

The patch that edits `src/greet.ts`, adds a file, moves one and deletes one:

```text
*** Begin Patch
*** Add File: src/hello.ts
+export function hello(name: string) {
+  return `hi ${name}`
+}

*** Update File: src/greet.ts
@@ replace Ab
-  return `hello ${name}`
+  return `hi ${name}`
@@ replace Ef..Gh
+  if (!name) return "hi"
@@ insert Cd
+
+// trailing note

*** Update File: src/old.ts
*** Move to: src/new.ts

*** Delete File: src/dead.ts
*** End Patch
```

**Pros** — the envelope is the one models trained on Codex have seen; the `+` prefix keeps
arbitrary content (including lines that start with `***`, `@@` or `-`) unambiguous; input-line
diagnostics fall out naturally; the shape is close enough to the official tool that prompt and
Review familiarity carry over.

**Cons** — two prefix systems (`@@` header + `+`/`-` body lines) in one construct; three
keywords to learn; an optional `-` line means the same operation has two legal spellings
(D1 must decide whether to require, allow or forbid it).

## Candidate B — no new text grammar: extend `edit`'s JSON

```json
{
  "patch": [
    { "op": "add",    "path": "src/hello.ts",  "lines": ["export function hello(name: string) {", "  return `hi ${name}`", "}"] },
    { "op": "replace","path": "src/greet.ts",  "anchor_start": "Ab", "lines": ["  return `hi ${name}`"] },
    { "op": "replace","path": "src/greet.ts",  "anchor_start": "Ef", "anchor_end": "Gh", "lines": ["  if (!name) return \"hi\""] },
    { "op": "ins",    "path": "src/greet.ts",  "anchor_after": "Cd", "lines": ["", "// trailing note"] },
    { "op": "del",    "path": "src/dead.ts" },
    { "op": "move",   "path": "src/old.ts",    "to": "src/new.ts" }
  ]
}
```

**Pros** — zero new grammar; `edit`'s field names, `op` semantics and `lines` rule are reused
verbatim; structural mistakes die in schema validation; the model has already learned these
fields from `edit`.

**Cons** — no compact "one blob" form; a large change set is verbose and token-expensive; the
only difference from `edit` is add/delete/move, which raises the real question D1 must answer
— why is this a second tool instead of three more `op` values on `edit`? It is also the
farthest from the "aligned with the official `apply_patch`" story.

## Candidate C — hashline line DSL

```
*** Patch
add src/hello.ts
| export function hello(name: string) {
|   return `hi ${name}`
| }
update src/greet.ts
Ab replace
|   return `hi ${name}`
Ef..Gh replace
|   if (!name) return "hi"
Cd insert
|
| // trailing note
Ij delete
move src/old.ts -> src/new.ts
remove src/dead.ts
*** End Patch
```

**Pros** — one operation per line, the most compact of the three; the anchor sits at the start
of its operation, which scans well; the `|` content prefix keeps content unambiguous.

**Cons** — an entirely new lexicon (two keyword families, `->`, `|`), with no model prior; the
boundary between a block's content and the next operation header is "a line that does not
start with `|`", which is more fragile than A's explicit headers; diagnostics need a hand-built
line map; the compactness is eaten by `|` on every content line.

## Recommendation

**A.** Three reasons: the `+` content prefix is the only one of the three that stays safe for
arbitrary content without a second rule; the envelope is the same shape as the official tool,
so prompt wording and reviewer expectations transfer; and `@@ replace|insert|delete` reads
unambiguously, whereas sigil-per-line grammars (C) are learned only by trial.

Candidate B's real value is a **question for D1**, not a syntax: should `edit` itself grow
`add` / `delete` / `move` ops so the patch never needs a second tool? If D1 answers yes, this
ticket's pick becomes "no separate tool" and the map needs re-scoping.

## Open questions this ticket does not settle (D1 / D2)

- `-` declaration lines: forbid / optional / required (and how they interact with
  `require_line_content`).
- An empty patch: success with no operations, or a refusal?
- Case and indentation tolerance for `@@` keywords.
- Ordering and overlap rules when one file carries several hunks; whether a later operation may
  consume lines produced by an earlier one (recommend: no — anchors must already be served).
- Parameter name: `input` (official) or `patch`; and whether the value is one string or a
  `{patch: […]}` object.
- Whether `sed`-style regex operations belong to a patch at all.
- How the whole patch is rejected: one aggregated refusal listing every refusal (official
  style), or first-refusal-wins.
