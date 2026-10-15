# ADR-0018 — A refusal is not one thing: fidelity classification for NUL-tolerant text

> **Status**: Accepted (2026-10-14; issue [#273](https://github.com/hyperion2144/dsh-hashline-edittool/issues/273) — implemented in the same change). Extends [ADR-0017](0017-binary-refusal-stops-read-not-grep.md).

## Problem Statement

ADR-0017 taught `grep` to search through a backend's binary refusal and left every
refused file's rows unserved — correct at the time, because every refused file was
also uneditable: `edit` read through the strict `readText`, so an anchor would have
promised an edit that could only fail.

#273 made the boundary itself the bug: `read` and `edit` refuse a file that carries
one NUL byte **even when the file is perfectly valid UTF-8**, while the local
backend — which never refuses — happily serves and edits the same bytes. The
maintainer's ruling: the judgment is too crude ("含 null 也可能是文本文件"), and the
policy is "能读就能写" — what can be read can be written.

But the OTHER refused files — bytes that are not valid UTF-8 at all — carry a real
constraint: the plugin's write seam is string-only, so no edit can preserve such a
file's bytes. One boolean (`binary`) cannot say these two classes apart. The
refusal's REASON is the contract.

## Decision

`TolerantRead` becomes `{ text, fidelity: "native" | "lossless" | "lossy" }`:

- `native` — the ordinary `readText` succeeded; the text IS the file.
- `lossless` — the backend refused the file, but its bytes are valid UTF-8 (a NUL
  is enough to trip the refusal): the fallback decode is byte-exact, proven by
  round-trip equality (`Buffer.from(text, "utf-8")` equals the raw bytes), never
  assumed from the refusal. The text is the file.
  The decode keeps a UTF-8 BOM (`ignoreBOM`): the default would strip it and a
  byte-perfect BOM file would fail the round-trip — `edit` re-attaches the BOM
  it strips, so the write-back stays byte-exact.
- `lossy` — undecodable bytes were replaced by `U+FFFD`; the text is an
  interpretation, not the file.

Per surface:

- `read` — `native`/`lossless` serve anchors exactly as before. A `lossy` file
  still reads: rows render `[line N] content`, unserved, with a note that the view
  is not editable. Serving anchors over text the model cannot write back would
  promise an edit that must be refused. An unserved page still FORMS A WINDOW:
  the one-sentence tail — and the resume token it carries — applies to a lossy
  read exactly as to a served one, and the sentence's cursor is the numeric
  offset (no anchor exists on an unserved row).
  In JSON mode the payload carries the unserved rows (`unservedRows`) and the
  note (`warnings`) — it must never present a lossy file as an empty `lines`
  object.
- `edit` — reads through the tolerant seam. `lossy` is refused with the new
  `[E_LOSSY_BYTES]`, the file untouched; `lossless` edits through, and the
  write-back is byte-exact (the decode was byte-exact; the write encodes the same
  string). "能读就能写" holds exactly where the bytes allow it.
- `grep` — a `lossless` refusal upgrades to served rows: ADR-0017's "found, not
  editable" caveat dissolves where it was over-broad. A `lossy` file keeps unserved
  `[line N]` rows, unchanged from ADR-0017.
- `undo_last_edit` and `write`'s read-before-write preview go through the tolerant
  seam too: a NUL file is undoable and overwritable like any other.
  A lossy OLD side renders no per-line diff — the `-` rows would show bytes the
  disk never had — and the write's preview says so instead.
- Showing a file's content IS observing it, served or not: a `lossy` read or grep
  still emits `fs/observed`, so `write` may follow either one. The observation was
  originally gated on served rows, which made a lossy file readable but NOT
  writable — the host refused the write with `[E_NOT_OBSERVED]` and a remedy
  ("call `read()` first") that no lossy read can satisfy. `edit` is untouched:
  `[E_LOSSY_BYTES]` is decided before any anchor is resolved.
- `write`'s lossy flag is declared in its output schema (`beforeLossy`): the host
  validates the returned value against that declaration and rejects an undeclared
  field, so an `execute`-level test cannot pin it.
- `lsp`, `ast_grep`, `ast_edit` keep the strict `readText` — out of scope for this
  decision.

The classification is a property of the BYTES, not of the backend: the same file
reads `lossless` on a strict backend and `native` on a local one, and `read`/`edit`
answer identically for both.

## Consequences

- A NUL-bearing, valid-UTF-8 file is first-class on every backend: served by
  `read` and `grep`, editable, undoable, overwritable. The local deployment and the
  strict deployment no longer disagree about such a file.
- A non-UTF-8 file (UTF-16, Latin-1, a truncated fragment) stays readable and
  searchable but never editable — and the refusal now has a name,
  `[E_LOSSY_BYTES]`, documented in the README error table, instead of hiding
  inside "not a text file".
- Undo keeps byte-exact fidelity through its persistence layer: an undo body is
  stored as BLOB bytes in the hash store, because node:sqlite on Node 22 loses a
  TEXT value's bytes past the first NUL and SQLite's `LENGTH()` stops at that NUL
  for TEXT (which also skewed the per-path byte budgets); BLOBs are exact for both.
- Preserving non-UTF-8 bytes through an edit would need a bytes-mode write seam;
  that is a backend contract change and is explicitly out of scope here.
- Past `TOLERANT_READ_MAX_BYTES` the fallback fails as too large and maps to
  `[E_TOO_LARGE]` (ADR of #271) — an oversize file is skipped, not misclassified.
- `[E_NOT_TEXT]` remains for what still refuses: directories, and the strict
  `readText` paths (`lsp`/`ast_*`) that must not guess.
