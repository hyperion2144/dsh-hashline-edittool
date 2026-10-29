# `write` preview modes — implementation spec

Status: accepted (map [#354](https://github.com/hyperion2144/dsh-hashline-edittool/issues/354); decisions [#355](https://github.com/hyperion2144/dsh-hashline-edittool/issues/355), [#356](https://github.com/hyperion2144/dsh-hashline-edittool/issues/356), [#357](https://github.com/hyperion2144/dsh-hashline-edittool/issues/357); spec [#359](https://github.com/hyperion2144/dsh-hashline-edittool/issues/359)).
Owners: `src/tools/tool-write-shadow.ts`, `src/domain/write/model-text.ts`, `src/domain/format/write-section.ts`, `src/config.ts`, `src/infra/settings.ts`, `client/src/client/settings-card.tsx`.

## Purpose

Give `write` the same quiet form `edit` got (ADR-0020). The post-write echo is an OUTPUT
behaviour, so it is the user's setting — never a tool parameter the model picks for itself.

Three modes, one key: `write.preview` = `full` | `diff` | `confirmation` (default `diff`).

## Contract

```yaml
write:
  preview: diff   # full | diff | confirmation
```

- `full`: re-read the file (`readAndServe`), serve every written row, emit the read window
  sentence and — when the preview is truncated — a resume token (consumer `read`).
- `diff`: an UPDATE comes back as the unified diff every edit tool renders — legend,
  `--- path` / `+++ path`, `@@ -old,count +new,count @@ scope`, `context_lines` of context,
  `+`/`-` rows with anchors (`-` rows carry the pre-write anchor marked `~`). A CREATE, and an
  UPDATE whose pre-write bytes are lossy (#273), stay on the `full` path.
- `confirmation`: model text is the one line `Wrote <path> (create|update).`; no re-read, no
  window, no token, and no anchors minted or served.

The canonical value is unchanged in every mode: `{path, operation, before, after, modelText}` plus
the optional `diffRows` / `diagnostics` / `formats`. The tool's name, description, parameters and
output schema are constant — a mode switch hot-reloads without re-registering the tool.

## Behavior

1. Write through the fs bridge exactly as before; auto-format, diagnostics baseline and the
   pre-call served set are unchanged.
2. Read the mode at CALL time (`writePreviewMode()`), then:
   - `confirmation`: skip the preview entirely; the model base is the confirmation line (JSON:
     `{path, operation}`); the format section, when one ran, is row-less (header + counters);
     card rows are the diff shape with blank hashes.
   - `diff` + update + decodable pre-write: no re-read; `genDiff` over the sparse view, then mint
     the rendered rows (`allocateForRenderedRows` — the card's own allocation, #188); the model
     text is `renderUnifiedDiff`, spilled through `spillModelTextOverflow` (producer `write`,
     consumer `read`, kind `report-segment`); JSON output is
     `{path, operation, diff: diffDictFrom(...)}`; the card rows are `diffRowsFromBlocks` of the
     same blocks.
   - everything else: the `full` path.
3. The model text is assembled in ONE place (`buildWriteModelText`): base (prose or JSON payload),
   then diagnostics, then the lossy-before note, then the format section — a JSON envelope stays
   parseable (sections ride as fields, never appended prose).
4. Read guidance gains one bullet, rendered only while the mode is `confirmation`: a write serves
   nothing in that mode, so read before editing what it produced.

## Errors

No new codes. `confirmation` does not change what a later `edit` answers with: an anchor minted
before the write is refused by the stale family (`E_RANGE_UNVERIFIED`, wrapped in
`E_BATCH_ABORT` for the call) and the refusal echo carries a fresh marker, so the recovery may not
need a re-read.

## Store

`full` and `diff` serve the rows they show (the read preview, or the rendered diff rows);
`confirmation` serves nothing and allocates nothing — its card rows are built from the sparse view
with blank hashes, so "no anchors" is true in the store as well as in the text. The write itself
still records `fs/observed`, so the write-before-read policy is satisfied.

## Card / settings

- `full`/`diff`: the `行号:锚点` gutter, unchanged.
- `confirmation`: the same diff with blank hashes — the client's `gutterLabel` already degrades a
  blank hash to a bare line number (`+21` / `-21` / `20`).
- Settings card: 行为 → 输出, a segmented row (全文 / diff / 仅确认) writing the whole `write`
  subtree; the snapshot default is `diff`, and an unrecognized value falls back to it.

## Tests

- `test/core/write-preview-confirmation.test.ts` — the mode's text, JSON, no window/token, no
  served rows, blank-hash card rows, row-less format section, the stale refusal then read-then-edit,
  and hot reload (one session, two modes).
- `test/core/write-preview-diff.test.ts` — diff shape, writable `+` anchors, create stays
  read-style, JSON diff dictionary, oversized diff spills through the segment channel, lossy
  fallback.
- `test/core/write-preview-settings.test.ts` — default, legal values, fallback, hot apply.
- `client/test/diff-rows.test.ts` — a blank hash renders as a bare line number.
- `test/guidance.test.ts` — the confirmation bullet appears only while that mode is on.

Prior art: `write-shadow.test.ts`, `write-diff-bounded.test.ts`, `format-auto-integration.test.ts`.
Verification gates: root `npm run typecheck` + `npm test`; client `npm run typecheck` + `npm test`;
`npm run build`.

## Docs

README/README.zh (tool row, `Write preview` paragraph, config sample, settings-card list);
CHANGELOG `[Unreleased]`; CONTEXT term; ADR-0025; `docs/CHANGELOG-MEMORY.md`.
