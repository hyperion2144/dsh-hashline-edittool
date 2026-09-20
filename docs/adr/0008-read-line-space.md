# ADR-0008 — One line space: every line-number producer splits toLF text

> **Status**: Accepted (issue #147, maintainer spec in the re-triage comment, 2026-09-20).

## Problem Statement

The plugin had TWO line spaces. `read` (and the anchor allocator behind every tool) normalizes file text through `toLF` — CRLF, bare CR and LF each fold to one line break — but `grep`, `lsp`, `ast_grep` and `ast_edit` split the raw `io.readText` text on `\n` only. On any file carrying bare CRs (progress-bar / ANSI overwrite logs are the natural habitat), the read-side tools drifted from read's space by the cumulative number of CRs above each line: the field report's 1.14 MB log counted 3774 grep lines against 4064 read lines, with match offsets 173→198→229 growing with depth. Worse than the numbers, the anchor PAIRING broke: grep indexed a toLF-based `hashes` array with LF-only positions, serving rows whose anchor belonged to a different line — on bare-CR-heavy files `ast_edit` could rewrite a line the pattern never matched.

## Decision

**The read line space is the contract**: every tool that produces line numbers folds its text with `toLF` at the `io.readText` boundary — before the matcher, before the AST client, before the language-server sync, before the row splitter — and uses that one text for everything downstream. `anchorsFor` already normalized internally (it cannot import `render/`, so it hand-copies stripBOM+toLF); the four read-side tools now meet it in the same space instead of straddling two.

Concretely: `grepFileContent(file, text, …)` after `const text = toLF(raw)`; `lsp` syncs the toLF text to the server AND splits rows from it; `ast_grep` / `ast_edit` hand the toLF text to tree-sitter (whose rows count `\n` only). `splitLines` / `visLines` document the precondition; the LF-only `linesOf` duplicate in tool-grep is deleted.

## Considered Options

- **Change `splitLines` itself to split on `/\r\n|\r|\n/`** — rejected: the majority of its callers operate on already-normalized text and the line-index math above (anchors, diffs, `buildIdx`) already assumes folded text; changing the bottom primitive to compensate for four callers inverts the layering and widens the blast radius for no gain.
- **Normalize inside each consumer (matcher only, splitter only, …)** — rejected: the bug WAS scattered normalization; adding a fourth local copy of the rule would let the next tool re-introduce the dual-space drift.
- **Leave it and document "grep numbers are LF-only"** — rejected by the maintainer: a match row must be the read row at the same number, because both are editable anchors.

## Consequences

- **Declared behavior change**: a regex that matched ACROSS a bare-CR boundary (`alpha.r` inside the old single line `alpha\rbeta`) no longer matches — the CR is a line boundary now, exactly as pwsh counts it. Within-line patterns are unaffected; CRLF files keep one line per CRLF and lose the invisible trailing CR their rows used to show.
- A bare-CR file edited by `ast_edit` keeps its CR ending style (`detectEnding` reports `"\r"`, `restoreEndings` writes CRs back) — the round trip changes content, not the file's ending convention.
- The auto-diag write path needed no change: post-write text has uniform endings by construction (the plugin writes normalized + restored text), so its line numbers were already in one space.
- New line-number producers inherit the rule by following the one comment that names it ("READ LINE SPACE", issue #147) at each existing read boundary; `test/core/issue-147-line-space.test.ts` pins the contract for all four tools.
