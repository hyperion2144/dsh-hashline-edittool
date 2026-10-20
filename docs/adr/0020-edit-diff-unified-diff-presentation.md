# ADR-0020 — `edit` diff rendered as a unified diff (file header, hunk header, interleaved rows)

> **Status**: Accepted (wayfinder map #293; spec #296, prototype #299, scope detection #294, model-side rendering #297, card side #295, acceptance experiment #298; 2026-10-19). Supersedes the model-facing diff format described in `README.md` before 0.10.4. The row shape `<+|-><anchor>:<content>` is **not** superseded.

## Problem Statement

The model-facing diff used to be a bare list of rows with ` ... ` elision lines and
no file or position information. The rows were correct and the anchors were
usable — but the *frame* around them was missing, and the model read the result
as a pile of fragments.

Measured, not assumed (`docs/research/diff-presentation-experiment/RESULTS.md`):
across 8 fixtures × 4 questions, the model could name the function that was
changed in only **3 of 8** cases — and only when the change happened to fall
within three lines of the declaration line, so the declaration happened to be
inside the context window. Otherwise the function name was simply **not present
in the diff** and the model answered "I can't tell from the diff". In the
multi-site fixture the ` ... ` elision swallowed the middle function outright:
the answer was "a function whose name is hidden by an ellipsis".

That is the mechanism behind the reported complaint — sometimes the diff is
readable, sometimes it is not, and the model cannot tell why.

Two constraints ruled out the obvious fixes:

- **Line numbers cannot carry it.** The repo's own anchor scheme already
  replaces line numbers, and the external per-line-anchor tools all agree that
  line numbers are unreliable to write (Aider, Cursor, OpenAI) while useful to
  read. Per-row line-number prefixes also break the row-shape contract and
  every consumer of the leftmost column.
- **Aider's own measurement is against the "whole function" shape**: an
  unprompted new-vs-old full-function diff raised apply errors by 30–50%
  (`aider.chat/docs/unified-diffs.html`). Copying the whole function is not a
  safe remedy.

The card and the model text are two separate surfaces (`presentationMeta` vs
the tool's text) and must agree in form without either one parsing the other.

## Solution

The diff becomes a **git-style unified diff**, and the frame is carried by two
kinds of non-row lines:

```text
Diff rows: <+|-><anchor>:<content> — a unified diff: `@@ -old,count +new,count @@ scope()` gives the line range and the enclosing function(s); `-` rows are the pre-edit lines (their `~` anchors are stale), `+` rows and unchanged rows are the post-edit code.
--- src/render/line-diff.ts
+++ src/render/line-diff.ts
@@ -194,7 +194,7 @@ myersRange()
  B1:		trace.push(v.slice());
  Yc:		for (let k = -d; k <= d; k += 2) {
  jt:			let x: number;
-~Tl:			if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;
+ bj:			if (k === -d || (k !== d && v[mid + k - 1]! <= v[mid + k + 1]!)) x = v[mid + k + 1]!;
  5X:			else x = v[mid + k - 1]! + 1;
  Tg:			let y = x - k;
  nm:			while (x < n && y < m && a[aLo + x] === b[aLo + y]) {
```

### Frame

- **File header** — `--- path` / `+++ path`, one group per file.
- **Hunk header** — `@@ -oldStart,oldCount +newStart,newCount @@ scope()`. The
  counts are git convention: context rows are counted, so the range describes
  the visible segment of the file, not just the changed lines. The scope name
  is the enclosing function, method, class or type of every scope the
  segment's changes fall into.
- **Body** — git's interleaving: unchanged rows (` `), added rows (`+`),
  deleted rows (`-`).

### Rows

The row shape is unchanged: `<+|-><anchor>:<content>`. The marker column is
two cells wide and right-aligned, and a **deleted row's stale anchor carries a
`~`**:

```text
-~Tl:…      (pre-edit line, anchor already stale)
+ bj:…      (post-edit line, fresh anchor)
```

The `~` makes the deleted row's marker cell as wide as the others (so the
anchor column stays aligned) and makes a stale anchor unmistakable. A model
that copies a `~` anchor gets a clean `[E_BAD_REF]` instead of a
rescued-then-stale anchor.

### Segment boundaries

Segments split by the **git compact rule**: an unchanged run longer than
`2 × context_lines` between two changes starts a new segment. Segment size
therefore follows the existing `hashline.context_lines` setting (default 3) —
raising it shows more of the function around the change, lowering it splits a
distant change into several segments. **No new setting is introduced.**

### Scope name

The name comes from purely syntactic detection over the **post-edit** text
(`src/render/scope/`): only functions, methods, classes and types get a
name; control flow stays anonymous, and an undetectable scope simply has no
name. The detector never guesses. Because it reads the post-edit text, a
function that was deleted entirely cannot be named — the deleted rows still
show its body.

**The language is chosen by file name, the way git chooses its pattern
table.** The path selects a *language descriptor*; the descriptor selects a
**block family** (how a block's extent is found) and a **declaration pattern
group** (how a declaration line is recognised). The table is the extension
point: a new language is one row plus an existing pattern group.

- **brace family** — the extent is a pair of braces. TypeScript,
  JavaScript, Vue, Svelte, Rust, Zig, Go, C, C++, Objective-C, Java, Kotlin,
  Scala, C#, Swift, Dart, Groovy, Solidity, D, PHP, Perl, Shell, PowerShell.
  The brace scanner is language-agnostic — it masks braces inside strings,
  templates, regular expressions and comments — so only the *declaration
  recognition* is per language.
- **indent family** — the extent is the indentation. Python, Vyper, Ruby (plus
  `Rakefile` / `Gemfile`, matched by file name). A `def`/`class` runs from its
  line to the next non-blank line indented no further than it.
- **keyword-end family** — the extent is counted `end`s. Lua, Elixir, Julia.

Erlang, OCaml, Haskell, Clojure, Lisp, Fortran, Ada, Pascal, Cobol, SQL, R,
Makefile and Dockerfile are **not covered**: such a file gets no scope name.
The detector does not guess.
A caller **without a path** falls back to the **TypeScript reading** — the `js`
declaration group inside the brace family — which keeps the earlier
TypeScript/JavaScript behaviour unchanged. It is deliberately *not* the union
of every brace group: a file that never said it was Go is not read as Go.

Reading a file is a pure function of (text, language), so the detector scans each text **once** and answers every line of it from that scan. A diff labels every changed line of one file, and re-reading the file per line made that quadratic — a `write` of a file the size of the response budget timed the test suite out. The scan cache is keyed by the path too, because the path decides the language.
One segment may span several functions. The header names **every** scope the
segment's changes fall into, in the order the changes appear, joined by ` / ` —
a change in `first()` and a change in `second()` give
`@@ -1,7 +1,7 @@ first() / second()`. A change's scope is looked up at the
change's own line, not at the segment's first line, so a context row that pulled in a
neighbouring function does not lend its name. Segment splitting stays git's:
purely by line distance (`hashline.context_lines`), never by function boundary —
splitting on boundaries would change the hunk semantics already settled on.

### Card

`presentationMeta.diffRows` gains `kind: "hunk"`. The client draws the hunk
header as a group title, folds by **code rows only** (headers and `⋯` markers
do not consume the fold budget), lets a header follow its own segment, and
excludes headers from copy — `@@` is structure, not code.

The legend and the model prompt (`src/domain/edit/prompts.ts`) tell the model
that the file and hunk headers are structure and must not be pasted into an
edit, that `~` anchors are stale, and that `+` and unchanged rows carry fresh
anchors.

## Implementation Decisions

- `genDiff` returns `blocks: DiffBlock[]` alongside the old row list;
  `DiffBlock = { header, oldStart, oldCount, newStart, newCount, scope?, rows }`.
  Ranges are computed from the diff's own line counters, never by parsing
  rendered text back.
- Hunk headers carry **no anchor** and are **not served** — ADR-0009's lazy
  allocation is untouched, and the served set does not grow. A `@@` header is
  not valid Base62, so pasting it yields a clean `[E_BAD_REF]`.
- `src/render/scope-registry.ts` is the seam between detection and rendering
  (`ScopeLabelAt`, `setScopeLabelAt` / `currentScopeLabelAt`), so the detector
  can be swapped without touching the renderer.
- The path reaches the detector through `genDiff`'s options: its trailing
  positional parameters (`partsFor` / `changedRanges` / `scopeLabelAt`) became
  one `GenDiffOptions` object, because nine call sites would otherwise have to
  be padded with `undefined` to reach the one parameter they wanted — the
  reason the path could not be added at all.
- `write` keeps its **auto-read preview** as the model-facing text (it must
  read the new content back); the shared rendering applies to the **card rows**.
- `edit`, `write`, `undo_last_edit` and `ast_edit` share one rendering path.

## Testing Decisions

- `test/core/diff-blocks.test.ts` — range arithmetic, segment splitting
  (three segments vs one merged segment), the `~` prefix, hunk card rows, and
  the four tools' shapes.
- `test/core/render-scope.test.ts` — the syntactic detector, including
  multi-line signatures, braces inside strings and comments, and anonymous
  scopes.
- `client/test/diff-rows.test.ts` — the pure projection layer: header
  placement, fold counting, copy exclusion.
- `docs/research/diff-presentation-experiment/` — the two-arm acceptance
  experiment (8 fixtures, 4 questions, 16 answers, 8 independent scorings),
  with its method, per-question scores, conclusions and limits in
  `RESULTS.md`.

## Out of Scope

Forms the user rejected, each with a reason:

- **Whole function carried out** — the accepted evidence (Aider) is about
  unprompted new-vs-old full-function diffs, but the cost is real: every
  context row would be anchored and served (ADR-0010 budgets the store).
- **Clean body with deleted lines listed separately** — the deletion loses
  its position; the user rejected the variant outright.
- **Deleted block moved to the end of the segment** — same reason.
- **New-vs-old full-function pair** — Aider measured a 30–50% apply-error
  increase.
- **A line-number prefix on every row** — breaks the row-shape contract;
  line numbers are unreliable to write.
- **Full-file rewrite** (Cursor's shape) — out of budget and out of scope.
- **Function-level semantic summary** — no precedent in any surveyed tool
  (the summaries that exist stop at counts), and it would need a second
  summariser beside the diff.
- **Diff only on the failure path** (Zed's shape) — changes the success-path
  contract of every tool.

## Further Notes

- Research behind the decision: `docs/research/diff-presentation-mainstream.md`
  (14 surveyed tools and agents), `docs/research/diff-presentation-hashline-and-literature.md`
  (the external "hashline" family and the literature), and
  `docs/research/diff-presentation-repo-facts.md` (this repository's own
  capabilities and budgets).
- The specification this ADR implements is `docs/diff-presentation-spec.md`.
- The acceptance result: old 27/32, new 32/32, with all five points of the
  difference in "which function was changed". The semantic / condition /
  impact questions were unchanged between the arms — the two arms share the
  same body rows, so the frame is what the experiment actually measured.
  Limits (single model, one run per cell, no significance test) are recorded
  in `RESULTS.md`; the "which closure pairs with which" complaint was not
  scored directly.
