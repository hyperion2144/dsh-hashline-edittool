# ADR-0035 — The line space is ripgrep's `\n` model

> **Status**: Accepted (2026-11-04; issue [#414](https://github.com/hyperion2144/dsh-hashline-edittool/issues/414)).
> Supersedes [ADR-0008](0008-read-line-space.md).

## Problem Statement

ADR-0008 fixed a real bug — two line spaces — by choosing the READ space as the
contract: `toLF` folded CRLF **and bare CR** to LF, and every line-number
producer met it there. The cost was a permanent translation layer: ripgrep
counts `\n` only, so on any file carrying a bare CR the engine's line numbers
and the plugin's disagreed, and `grep` had to place every hit by hand
(`indexLineSpaces` / `readSpacePosition`, reading the whole file to do it).

#414 removed that layer's reason to exist. The engine now walks the path
itself, and the plugin's own tools can share its model instead of translating
into a second one.

## Decision

**One line space, and it is ripgrep's.** `toLF` and `normalizeContent` fold
`\r\n` to `\n` and nothing else; a bare CR is a CHARACTER inside its line.
`detectEnding` never reports `"\r"`. The placement subsystem is deleted:
`hasBareCr`, `indexLineSpaces`, `readSpacePosition`, `rawRgLine` and the
cross-space DRIFT comparison are gone, and a hit's line number is used as-is.

The checksum's normalization follows the same rule, so `read`, `edit` and
`grep` derive one identity for one file.

## Consequences

- **Declared behavior change**: a bare-CR file (an ANSI progress log, an
  old-Mac text file) is ONE line in every tool. `read` shows it as one row, and
  the 2000-byte preview cap applies to it. This is the trade the maintainer
  accepted in #414: one model everywhere beats per-file readability.
- CRLF files are unaffected: `\r\n` still folds, line numbers are unchanged,
  and the served row carries no trailing CR.
- `grep` no longer needs the file's text to place a hit, which is what lets it
  serve rows from ripgrep records alone (ADR-0036).
- The #147 contract test is replaced by `issue-414-line-space.test.ts`; the
  old expectations (bare CR = a line break) are now wrong by design.
