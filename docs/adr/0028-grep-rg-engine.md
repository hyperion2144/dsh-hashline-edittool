# ADR-0028 — ripgrep is the grep ENGINE: one `rg --json` search produces the matches

> **Status**: Accepted (2026-10-30; issue [#384](https://github.com/hyperion2144/dsh-hashline-edittool/issues/384) — implemented in the same change).

## Problem Statement

`grep` had two engines, and a trust gap between them.

The search itself was JavaScript's: the tool read every candidate file and ran a
per-line `RegExp` over it. ripgrep was only a PRE-FILTER (`rg --files-with-matches`,
[#183](https://github.com/hyperion2144/dsh-hashline-edittool/issues/183)): it answered
"which files contain a hit", and the tool then re-read those files and decided what
matched. Two consequences followed.

**A mangled pattern became a lie.** The literal mode (`regex: false`) reached
ripgrep as `-F<pattern>` — the `-F` flag glued onto the pattern TEXT — while
ripgrep's argv was `["--no-config", "--files-with-matches", "-e", pattern]`. So
ripgrep searched for the text `-F<pattern>`, matched nothing and exited 1. Exit 1
had been promoted to "nothing matched" (1b16ef8), so the candidate list came back
empty and the answer was "No matches" — for every literal search over a directory,
hit or not ([#384](https://github.com/hyperion2144/dsh-hashline-edittool/issues/384)).
A pattern that reached the wrong engine silently became a false negative, and
nothing in the pipeline could tell.

**The expensive work was done twice.** The pre-filter read the whole tree to
narrow it, then every surviving file was read AGAIN and re-matched line by line in
JavaScript. A large match set cost a second pass over the same bytes.

The original requirement was the other way round: ripgrep produces the matches.

## Decision

ripgrep is the engine. One `rg --json` search returns the matches — file, line
number — as structured records, the way DSH's own search tool does
(`packages/fs/tool-fs-search`: `buildGrepCommand` → `["--json", "--regexp=…"]`,
`parseGrepMatches` → the `match` records). The plugin keeps everything ABOVE the
search: the anchors (ADR-0009), the context rows, the per-response budget and its
spill / resume (#307, ADR-0013), the binary-file fidelity rules (#268/#273) and the
drift cautions.

The argv is the official shape with three deliberate deviations:

- **`--no-config` first.** Without it ripgrep reads the host's
  `RIPGREP_CONFIG_PATH` (or an `rg.conf` beside the binary), and that config may
  set `--pre` — an arbitrary preprocessor run against every file the search
  touches. A search must never execute the host's config.
- **`--text` (`-a`).** ripgrep's default binary handling stops at the first NUL
  byte AND counts it as a line break, so every line number after it drifts and
  the NUL-bearing line's own hit is reported against the wrong line (#268).
  `--text` makes ripgrep search the file as text, so its line numbers agree with
  the plugin's own reader.
- **The file list rides on the command line**, sliced by LENGTH, never by file
  count (#260, ADR-0016).

A literal pattern is `--fixed-strings` — an independent flag, NEVER a `-F` prefix
glued onto the pattern. That concatenation WAS the bug.

The pattern's dialect is ripgrep's. A pattern ripgrep's engine rejects is a
BAD PATTERN: the plugin answers with its own `E_BAD_SHAPE`, the way the
official grep tool answers with `SEARCH_INVALID_PATTERN`. It is not
silently answered by another engine — two engines would mean two answers
for one pattern.

The dialect is not new: the v1 spec already called `pattern` a
"ripgrep-flavour regex" (`docs/line-hashline-spec.md`), and the tool's own
requirement was that ripgrep produce the matches. What had drifted is the
IMPLEMENTATION: the pre-filter answered with a file LIST, and JavaScript
answered with the matches — so the pattern that decided "what matched" was
never the pattern the engine was given.

The plugin's own matcher survives as the DEGRADED path — for the one case
ripgrep could not answer AT ALL: its binary is missing, or the run failed.
"grep never fails because ripgrep did" stays true.

Two things the raw hits do not carry are worked out in the search layer
(`src/tools/grep-search.ts`), between the search and the rows:

- **PLACEMENT.** The read line space folds CRLF and bare CR to LF; ripgrep
  counts LF only. On a file that carries a bare CR the two count the file
  differently, and a pattern could even match ACROSS the CR — so the hit's
  OFFSET inside its line says which line of the read space it is on. The
  hit is still ripgrep's; only its seat is the plugin's.
- **DRIFT.** ripgrep read the file, and the plugin reads it again. The
  search's snapshot of a line and the line as it is now can disagree — and
  a row that claims to be a hit must really be one. A file that changed is
  served as the snapshot it was: its rows unserved (the file no longer
  holds them) and a caution naming the file.

## Consequences

- The trust gap is closed: the engine that decides what matched is the engine the
  pattern was handed to, and the pattern cannot be mangled on the way in —
  `--regexp=<pattern>` is one argv element, and a literal pattern is a flag.
- Only the files that actually matched are read. The second pass over the same
  bytes is gone.
- The plugin's own matcher survives as the DEGRADED path: it answers when
  ripgrep could not run at all (its binary is missing, or the run failed).
  "grep never fails because ripgrep did" stays true — but a pattern
  ripgrep REJECTS is an error, not a second engine's opinion.
- **The line space is the one contract ripgrep cannot reproduce (#147).** The
  read line space folds CRLF and bare CR to LF; ripgrep counts LF only. On a
  file that carries a bare CR the two disagree about which line a hit sits
  on, and a pattern could even match ACROSS the CR — so the hit's OFFSET
  inside its line places it in the read space. The hit stays ripgrep's;
  only its seat is the plugin's, and the dialect stays single.
- **The drift window is closed.** The search's snapshot of a line and the line
  as it is now are compared; a file that changed is served as the snapshot
  it was (unserved rows, a caution naming the file), never as a hit the
  file no longer holds. The degradation is per FILE, the same granularity
  the resume path already uses: a file that changed may have SHIFTED, and
  then its context rows are not the rows around the hit either — so the
  whole file answers as the snapshot the search saw.
- **A file the plugin cannot read at all is still skipped** (ADR-0017: past
  the tolerant read's ceiling the file is skipped, exactly as it was
  skipped before that read existed). The search's snapshot of such a file
  is NOT served: the plugin's contract is to answer with the file it read,
  and it has none. That is the one place the search's line text goes
  unused — and it is the tolerant read (#268/#273) that keeps the case
  rare.
- The candidate list is still the plugin's own (ripgrep's file listing, or the
  plugin's walk), so `grep_respect_gitignore`, the `include` glob and the
  hidden / `node_modules` rules keep their meaning.
- The search card's highlight spans are still computed by the plugin's own
  JavaScript matcher, so a pattern only ripgrep's engine accepts marks no
  highlight (the card degrades to unhighlighted rows, which it already could).
