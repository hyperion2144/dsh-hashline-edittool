# ADR-0036 — `grep`'s pipeline is bounded, and the anchor store is addressed by file identity

> **Status**: Accepted (2026-11-04; issue [#414](https://github.com/hyperion2144/dsh-hashline-edittool/issues/414)).
> Amends [ADR-0013](0013-streaming-segmented-responses.md),
> [ADR-0028](0028-grep-rg-engine.md) and [ADR-0029](0029-grep-hit-counts.md).

## Problem Statement

ADR-0028 aligned the SEARCH (engine, dialect, exit codes, record parsing) but
left the pipeline around it unbounded: a pre-listed candidate set that ignored
ancestor `.gitignore` rules, a file list sliced onto ~125 command lines, a
64 MB / 15 s cap per invocation with no total, `--text` turning 31 GB of build
artifacts into text, a silent fallback that read the whole tree in JavaScript
when any invocation failed, and a full re-read of every hit file to mint
anchors. On a 31 GB `target/` tree the host ran out of memory.

## Decision

**The pipeline is bounded, and the bounds live in the engine seam.**

1. **One invocation.** `rg --json --regexp=… [--glob=…] [--context=n] -- <path>`
   walks the path itself with ripgrep's own ignore rules. No file list, no
   chunking, no `--text`.
2. **A whole-search raw-output ceiling** of 20 MB. Crossing it is a loud
   `[E_SEARCH_OVERFLOW]` ("narrow pattern, path, or include and retry"), never
   a partial parse.
3. **A per-row preview cap** of 2000 bytes (UTF-8 boundary safe, marked
   `(line truncated)`). A cut row is NOT anchorable — its text is no longer the
   line's text.
4. **A serve-time hit cap** of 250 inline (`GREP_MAX_MATCHES`); the rest spills
   with a resume token. The per-file `limit` is a serve-time cut too, so a hit
   past it is shown as context.
5. **Failure is failure.** `[E_SEARCH_FAILED]` / `[E_SEARCH_UNAVAILABLE]`; the
   JavaScript matcher and the whole-tree fallback are deleted. A named path
   under an ignored ancestor gets ONE wide retry (`--no-ignore-parent
   --no-require-git`) when the first search found nothing.
6. **The anchor store is addressed by file identity.** `anchorFor` takes
   `rows: [{line, text}]` plus `identity: {checksum, lineCount}` instead of a
   whole `content` string; the content-based callers keep an adapter. The
   checksum is a `node:crypto` streaming sha256 over the normalized text
   (`infra/file-identity`), so `grep` derives the same value `read`/`edit` do
   without holding the file. `HASH_STORE_VERSION` 7 → 8 wipes rows written
   under the old 53-bit spelling.
7. **Realignment still needs the text.** A caller without it gets
   `[E_ANCHOR_REALIGN]`; `grep` reads the file and retries through the content
   adapter (the rare path).

## Consequences

- ADR-0028's "grep never fails because ripgrep did" and its PLACEMENT/DRIFT
  sections retire; ADR-0029's second uncapped `rg --count` pass retires (the
  engine no longer caps per file, so the parsed count IS the count).
- ADR-0013 gains a second category: the 48k response budget stays pure flow
  control, and the work-layer caps above bound what is collected at all.
- `grep` no longer reads a hit file to serve it; the only per-file read is the
  streaming identity (O(1) memory).
- The `grep_respect_gitignore: false` setting maps onto `--no-ignore`.
