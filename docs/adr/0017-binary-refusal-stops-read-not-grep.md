# ADR-0017 — A backend's binary refusal stops `read`, not `grep`

> **Status**: Accepted (2026-10-10; issue [#268](https://github.com/hyperion2144/dsh-hashline-edittool/issues/268) — implemented in the same change).

## Problem Statement

`grep` read every candidate through `FileIO.readText`, and the dsh backend refuses
a file it judges binary (`fs.readText` → `FS_NOT_TEXT` → `[E_NOT_TEXT]`). The read
loop caught that refusal and `continue`d — "unreadable file, never a refusal" — so
a log carrying one `\0` answered **No matches**, indistinguishable from "this text
does not occur", while `rg -a` finds it.

The refusal is right for READING: `read` serves anchors over lines a model will
reproduce and `edit` rewrites them, and handing either one a blob breaks that
contract. The failure was letting the READ contract decide a SEARCH.

## Decision

The refusal belongs to `readText`, not to searching. `FileIO` gains
`readTextTolerant(absolutePath, signal?): Promise<TolerantRead>`:

- `readText` first — every text file takes the path it always took, with the same
  call sequence;
- only a `FS_NOT_TEXT` refusal falls back to the backend's raw-bytes seam
  (`fs.readBytes`, which neither decodes nor rejects), decoded as UTF-8 with every
  undecodable byte replaced by `U+FFFD` — the reading `rg -a` gives the same file;
- every other failure keeps its mapping: a missing file stays `[E_NOT_FOUND]`, a
  directory stays not-a-text-file, an abort stays an abort;
- the fallback is bounded by `TOLERANT_READ_MAX_BYTES = MAX_BYTES`, the read
  layer's own ceiling. Past it the read fails as too large and the file is skipped
  exactly as it was skipped before this read existed.

It answers `{ text, binary }` rather than a bare string, because the caller must
know WHICH read it got. A file the backend refused as text is not editable either
(`edit` reads through `readText`), so `grep` leaves its rows UNSERVED —
`[line N] content`, the shape every anchor-less row already takes. Serving an
anchor there would promise an edit that can only be refused, which is worse than
the bug: the output would look like a handle.

The fallback reads through `ctx.fs`, never `node:fs`: on a remote or sandboxed
deployment the bytes are not on this machine, and the bridge exists so tools
cannot route around the deployed backend.

## Consequences

- A NUL-bearing file is matched, and its hits are visible — but they are not
  handles. The row shape says "found, not editable" up front instead of letting a
  rejection say it afterwards.
- On a LOCAL backend nothing is refused (`readFile` decodes and never rejects), so
  `binary` stays false and a NUL-bearing file keeps its ordinary served rows —
  that deployment can edit such a file. The boundary is a property of the deployed
  backend, reported by the seam that knows it, not guessed by the tool.
- A UTF-16 file (also NUL-bearing) is searched as the bytes it is: a search for
  ASCII text inside it still misses, exactly as `rg -a` misses. No encoding is
  guessed — a wrong guess would silently re-interpret a deployment's files.
- The ripgrep pre-filter needs no `-a`, but only because it names its files: with
  its candidates passed as explicit paths, `rg --files-with-matches` reports a
  binary file whose match sits AFTER a NUL (measured with the NUL at byte 0 and
  the match ~10 MB in, and with a match BEFORE the NUL too). Searching the same
  tree as a DIRECTORY reports none of them. The pre-filter must therefore keep
  naming its candidates, which the directory-search test pins end to end.
- Only `grep` uses the tolerant read. A future tool that must search binary
  content reuses it rather than importing `node:fs`.
