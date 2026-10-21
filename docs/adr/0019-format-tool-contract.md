# ADR-0019 — The format tool contract: LSP formatting as an observed, anchor-aware write

> **Status**: Proposed (2026-10-18; decided on [map #275](https://github.com/hyperion2144/dsh-hashline-edittool/issues/275) — G1 [#277](https://github.com/hyperion2144/dsh-hashline-edittool/issues/277), G2 [#279](https://github.com/hyperion2144/dsh-hashline-edittool/issues/279), G3 [#280](https://github.com/hyperion2144/dsh-hashline-edittool/issues/280)). Extends [ADR-0004](0004-edit-multi-file-response.md) / [ADR-0006](0006-anchor-lifecycle-inheritance.md) / [ADR-0009](0009-sparse-lazy-anchors.md) / [ADR-0014](0014-read-window-cursor-and-summary.md).
>
> **Amendment** (2026-10-20, #312): the section no longer repeats a formatter-changed row the main diff renders — the `alsoInMainDiff` row flag is retired, `inMainDiffRows` counts the withheld rows, and the header reads `… · n lines changed · k in main diff · u unserved` (see "Output shares one shape with the automatic path" below).
>
> **Amendment** (2026-10-21, #315): `format.auto` becomes a tri-state mode — `off` (default) | `full` | `range` (legacy booleans migrate `true`→`full`, `false`→`off`) — and a new `format.fallback_full_file` switch (default **off**) replaces the silent whole-file fallback. In `range` mode a server without range formatting skips the automatic pass silently, and the `format` tool with an explicit range **refuses with `E_FORMAT_UNSUPPORTED`** instead of silently reformatting the whole file — superseding the G3 ruling (#280) that a range request may fall back silently. A `write` with no hunks is treated as a whole-file call in `range` mode.
>
> **Amendment** (2026-10-21, #315 PR review — section body): a formatter-changed line whose final text equals its pre-edit text is **located, not quoted** — each contiguous run becomes a `@@ ~start,count @@ scope` locator plus a one-line restored summary (`restoredRows` + `clusters`); only rows whose same-text occurrence position shifted past the pre-edit count (anchor genuinely changed) stay content rows. The header reads `… · k in main diff · r restored · u unserved`; the invariant becomes `changedLines = inMainDiffRows + unservedRows + restoredRows + rows.length`. Manual `format` output is unchanged (no pre-edit lines to compare).

## Problem Statement

The plugin has no formatter. Models reformat by hand-editing whole files through `edit`,
which spends the diff budget on whitespace and invites noop-loop guardrails. A language
server already knows how to format — but bolting `textDocument/formatting` onto a
hash-anchored toolchain raises four contract questions at once:

1. **Observation** — `format` is a write; must the file be observed first?
2. **Anchors** — a formatter rewrites lines the model never touched; which of the
   resulting lines may mint new anchors, and which must stay unserved?
3. **Errors** — servers disagree wildly: some advertise no formatter, some advertise one
   and answer `-32601`, some support range formatting and some do not, and clangd's range
   replies expand past the requested lines.
4. **Options** — where do `tabSize` / `insertSpaces` come from, and who decides?

R1 (#276) measured the field: range formatting is ~70× cheaper than full-file on large
documents.
Range formatting is offered by only some servers: the spec field
`documentRangeFormattingProvider` (a real TLS 6.0 handshake, the smoke test,
corrected an earlier draft that read a `textDocumentFormattingProvider` name no
server sends), clangd adding the non-standard extra `rangesSupport`;
rust-analyzer advertises `false` and answers `-32600`;
gopls and pyright have neither field nor method — and returned `TextEdit`s silently
swallow characters when applied without clamping.
P1 (#278) fixed the output shape (option B:
main diff pre→final, formatter extras in a separate format section). G1/G2/G3 fixed the
remaining contracts.

## Decision

**`format` is a write tool** (single file), bound by the same observation gate as
`write`: full-file and range formatting both require the file to be observed
(`fs/write-intent`; `[E_NOT_OBSERVED]`). The tool itself only `io.readText`s — it never
`emitObserved`s and never `readAndServe`s.

**Range addressing uses served anchors.** `range: {start, end}` — both bounds must be
anchors served in this session (verified like `edit`'s, `[E_STALE]` / 
`[E_RANGE_UNVERIFIED]` with echo); interior rows may be unserved. Closed line interval;
`start ≤ end`, same line allowed. No `range` means the whole file.

**FormattingOptions come from the file, not the caller.** Default: infer from the
document's existing indentation (tabs dominate → `insertSpaces: false`; spaces dominate →
`insertSpaces: true` with the dominant width of 2/4/8; unrecognizable → `{4, true}`). The
user-level setting `format.editorconfig` (default false) reads `.editorconfig` upward from
the file to the workspace root for `indent_style`/`indent_size`, falling back to the
inference. No tool parameter exposes these; the server's own `.clang-format` etc. still
win inside the server.

**Output shares one shape with the automatic path** (G2): a `FormatSection` per file —
`status / server / mode ("range" | "full-file") / requested / applied / changedLines /
inMainDiffRows / unservedRows / rows / reason` — with `rows: FormatRow[]`, `FormatRow =
EditDiffRow`. Amended 2026-10-20 by [#312](https://github.com/hyperion2144/dsh-hashline-edittool/issues/312),
superseding G2's original display ruling (#279 Q4-A): under ADR-0020's unified main
diff a formatter-changed line the diff already shows carries its anchor and content on
the diff row, so the section no longer repeats it — it is not a `FormatRow` at all (the
former `alsoInMainDiff` flag is retired) and `inMainDiffRows` counts it; the header
reads `… · n lines changed · k in main diff · u unserved`, and a pass whose rows are
all withheld renders the bare header. Rendered means the diff's own row set — the per-change ±context union `genDiff` draws (`diffRenderedLines`), not the wider served window; on `write` updates the preview must provably show the row (the model rewrote the pre-disk line it came from) — uncertain visibility stays a row, never a silent drop. The manual `format` call has no separate main
diff, so nothing is withheld for it — its section still lists every changed row. Text
renders it as a separate segment after the main diff (`[format: <server> · …]` header,
four-space placeholder for anchor-less rows); JSON via `details.formats`; the card
channel via `presentationMeta.formats`. `noop` (already formatted) is a real status:
`rows: []`, no disk write, no undo entry, no anchor changes.

**Anchor eligibility is provenance-based, never positional.** A formatter-touched final
line may mint an anchor only when its pre-format source line was served before the call
(`loadServed` snapshot taken at call start). Model-edited lines keep the existing `edit`
eligibility. Splits inherit to every child row, merges inherit the union, deletions leave
no final row, formatter-inserted lines with no source are ineligible, and unclear
provenance defaults to ineligible (never mint on a guess). `buildServedRowsFromDiff`
gains an optional `eligible(position)` gate so the default (everything eligible) is
unchanged when formatting is off.

**Errors are one table.** No language/server → `[E_LSP_NO_SERVER]`; boot timeout →
`[E_LSP_TIMEOUT]`; transport failure → `[E_LSP_UNAVAILABLE]`; a ready server without a
formatter → new **`[E_FORMAT_UNSUPPORTED]`**; a capability field that lies (call answers
`-32601`) counts as absent. Amended 2026-10-21 by [#315](https://github.com/hyperion2144/dsh-hashline-edittool/issues/315), superseding the G3 silent-fallback ruling: an explicit range request now refuses with `[E_FORMAT_UNSUPPORTED]` unless `format.fallback_full_file` is on — the whole-file fallback must be an explicit setting, never a guess. The manual path may cold-start (`waitForSession` 15 s, request 10 s);
the automatic path may not.

**Automatic formatting (`format.auto`, a three-way mode — `off` (default) | `full` | `range` per the 2026-10-21 [#315](https://github.com/hyperion2144/dsh-hashline-edittool/issues/315) amendment — is best-effort and silent by
design.** After a real change via `write` / `edit` / `ast_edit` (and with
`appliedCount > 0`), the auto path touches only READY servers — never `warm`, never
`waitForSession` — with a 2000 ms per-file budget. No server / no formatter → silently
skipped (no section, no warning — a capability boundary, not a failure). An attempted
request that fails → `FormatSection.status = "skipped"` + `reason` + a warning
(`metrics.warnings` for `edit`/`ast_edit`; the section itself is the write's warning).
Formatting happens in memory before undo/persist (one disk write for `edit`), and before
notify/diagnostics/preview for `write`; undo rolls back the whole call, with
`resultContent` = the formatted content. Formatting is non-blocking: the original
operation succeeds regardless.

## Consequences

- `format.auto` off (the default) changes nothing: no `formats` section, unchanged
  diff/served/undo behavior (`eligible` defaults to always-true).
- Anchor-less rows stay uneditable until a fresh `read` serves them; the main diff's
  `+`/context anchors always describe the final content.
- `README.md` / `README.zh.md` gain the `format` tool, the `format` settings group, and
  the new error code; `test/core/error-codes.test.ts` pins it.
- No new dependencies (the `.editorconfig` reader is hand-rolled, two keys only); no new
  tool parameters; `presentationMeta.formats` must be declared in every affected tool's
  output schema (`additionalProperties: false` validates at mount, not in unit tests).
