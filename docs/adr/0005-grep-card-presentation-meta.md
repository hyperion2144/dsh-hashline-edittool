# ADR-0005 — `grep` card presentation meta (structured rows + highlight spans)

> **Status**: Accepted (issue #92 implementation of wayfinder map #88; contract locked by tickets #89 (data) and #90 (card visuals), 2026-09-10). Supersedes the `grep` half of `docs/web-ui-structured-views-spec.md`.

## Problem Statement

The `grep` tool has shipped a structured `presentationMeta` projection since 0.3, but no UI could use it. Two independent defects:

1. **The shipped web card never renders.** dsh-web's `searchCardModel` requires `meta.shape === "matches"`; the tool persists `{files, truncated, total}` with no `shape`, so the built-in search renderer declines and the call falls back to the generic input/output card.
2. **The persisted rows were the wrong data.** `meta.files[].matches[].line` held the **whole rendered section text** for every row of a file — the same multi-line string repeated once per row — rather than that row's line. It could not feed a per-row gutter, could not distinguish a match from an echoed context row, and carried no anchor structure.

The requirement (map #88) is a grep card that matches the read card's shape — a `行号:锚点` gutter on the left, content on the right — with a file tab bar across the top (one tab even when only one file matched) and **the matched text highlighted inside the line**.

## Solution

Persist a row-level projection from the `grep` tool and render it in the bundled client plugin.

### Meta shape (canonical)

```jsonc
{
  "files": [
    {
      "path": "src/a.ts",
      "rows": [
        { "number": 12, "hash": "a3f", "text": "const alpha = 1;", "match": true, "spans": [[6, 11]] },
        { "number": 13, "hash": "b7c", "text": "const beta = 2;" }
      ]
    }
  ],
  "truncated": false,
  "total": 3
}
```

- **Row fields align with the `read` card's `hashlines`** (`number` / `hash` / `text`) — grep is a file-window tool, not a diff, so no `kind`. `rows` holds every line the card shows (matches **and** echoed context rows), in file order.
- **`match: true`** appears only on rows the capped match list contains. It is the *only* way to tell a result from a context row: a zero-width pattern (`^`, `b*`) matches a line yet produces no spans, so `spans.length > 0` is not a substitute.
- **`spans`** is `[[start, end), …]` in UTF-16 code units, relative to that row's `text`, ascending and non-overlapping. Absent means "nothing to mark on this line".
- **The old `files[].matches[]` is removed.** Nothing else consumed it; pre-0.4.4 session logs keep their old payloads untouched and degrade to the generic card (below).

### Span semantics (host-computed)

`matchSpans(text, pattern, regex)` mirrors the tool's own matching contract exactly: every occurrence on the line, literal scans and regex scans alike; regex mode marks the **whole match**, never a capture group; zero-width matches are **skipped** (nothing to mark, and stepping past them is what keeps the scan finite); case sensitivity follows the matcher. Context rows are scanned too — a context line that contains the pattern is highlighted like any other.

The client **never re-runs matching** and never parses the model-facing text: the card is a pure projection of the persisted meta. That is what keeps card and model text from drifting.

### Byte budget

The projection is capped at **64 KiB** of serialized JSON (mirroring `@deepseek-ai/dsh-tool-fs-search`'s `SEARCH_META_MAX_BYTES`). Over budget, **trailing file groups are dropped**, at least one group survives, `total` keeps counting what the search found, and `truncated` reports the loss. A single group that alone exceeds the budget is kept rather than emptied — the invariant is a bounded payload, never a card that hides a real result. `truncated` therefore carries two meanings (the per-file match cap and the card-side group drop); the card's footer wording covers both.

### No `shape: "matches"`, no `lang`

- The meta deliberately does **not** satisfy the built-in search card: its `matches[]` contract wants one plain-text line per match, which would store every line twice and re-introduce the drift this ADR removes. With the client half missing or disabled, a grep call renders the generic input/output card — exactly what read/edit/write already do, since their metas are not built-in-shaped either (the shipped `readCardModel` additionally requires a result envelope that direction B removed in #71).
- `lang` is not persisted. The card draws no syntax colouring (see below), so the field would serve only a banner label the client can derive from `path` itself.

### `presentResult` stays, fed correctly

`presentResult` still returns a built-in-compatible `{card:"search", shape:"matches", …}` view, now built from the persisted meta with **only `match: true` rows** as entries and their plain text as `line`. It has no consumer in the current dsh runtime (cards travel through raw events + `presentationMeta`), but keeping it aligned with the built-in fs tools costs little and avoids a second, wrong answer if a consumer returns.

### Card rendering (client plugin)

- The card is **self-drawn** (banner row → tab bar → gutter/content rows → footer), not the primitives' `ReadBlock`/`SearchBlock`: `ReadBlockLine.text` is a plain string whose colouring comes from an internal, unexported tokenizer, and neither primitive exposes an inline-span hook. Vendoring the layout is the same call the edit card made for its gutter in #71.
- **Syntax colouring is deliberately dropped** — the price of per-row highlight spans. The edit and write cards have no colouring either, so the hashline card family stays coherent.
- **Highlight** is a semantic `<mark>` painted with the familiar highlighter yellow `#ffe066` and **forced-dark text** (`#1f1f1f`): dark-on-yellow is readable under both themes, whereas inheriting the line colour would not be (the UA's own `mark` pairing — light background plus black text — was also rejected for exactly that reason). The yellow is a literal value because the theme ships **no yellow token at all**: its only warm family is amber, whose lightest tier (`--dsw-alias-state-warn-tertiary`) reads as cream rather than yellow.
- **Tab bar**: one tab per file, **including the single-file case**; labels are the meta paths (unique within a result set), ellipsised with the full path as `title`; the first file is active; switching resets the fold and the copy flash. Full `tablist`/`tab`/`tabpanel` semantics with `ArrowLeft`/`ArrowRight` switching.
- **Overflow folds, it does not scroll** (revised after the first review of the running card; the earlier sideways-scroll rule is superseded): `foldTabs()` divides the files between the bar and an overflow trigger by measured width, recomputed on container resize. The trigger opens a **portal** `Menu` of the folded files (portal so the card's own clipping cannot crop it) and its accessible name is the existing `common.more` key. **The tab being read is never folded** — it takes the last visible slot and the tab it displaces moves into the menu, so the reader always sees which file is on screen. A single tab is never folded even when the strip is narrower than it.
- **The tab strip is SHARED, not owned by this card** (issue #96): `client/src/client/tab-strip.tsx` owns the whole head row — measuring, `foldTabs`, the overflow trigger and its portal menu, keyboard switching and the aria wiring — and the diff cards (edit / write) mount the **same** component. It is *controlled*: the owning card holds the active index and the rows, the strip holds everything about the strip. Sharing is deliberate — the two families had already drifted once (grep folded, diff wrapped), so a second implementation would drift again. Two seams stay per-card, because they are genuinely different: the body rows (grep rows carry `spans`, diff rows carry a `+`/`-` marker and colour) and the footer wording.
- **Gutter** is `行号:锚点` (bare number when the anchor is unknown), one width for all rows.
- **Copy** takes the rows' own text — no gutter, no mark artifacts.
- **Footer** reuses the shipped locale keys (`search.matches` / `search.matches.truncated`) with `shown` counted from `match` rows across the whole result.
- **Zero matches** renders the card's empty state (`search.noResults`) with no tab bar; errors and running calls keep the shipped presentation.

### Degradation tiers

| Tier | Condition | Render |
| --- | --- | --- |
| 1 | No `rows` (pre-0.4.4 log, missing or malformed meta) | shipped generic body |
| 2 | `rows` present, no `spans` | card, unhighlighted |
| 3 | `spans` present | card with highlights |

Both soft validators (host `grepPresentationFromMeta`, client `grepPresentationMeta`) return "absent" for any deviation, which is what separates tier 1 from tiers 2/3. The client additionally clamps span offsets and merges abutting slices, so a hand-edited payload can neither lose nor duplicate text.

## Implementation Decisions

- Pure logic lives in `src/presentation-helpers.ts` (`matchSpans`, `capGrepMeta`, `grepPresentationFromMeta`) and `client/src/client/models.ts` (`grepCardModel`, `highlightSegments`, `grepGutterLabel`, `grepResultCounts`) so both are unit-testable without a harness or a DOM.
- `grepFileContent` builds **one** row list carrying `isMatch` and `spans`; the model text and the card rows both derive from it, so identity, match flag and spans cannot drift apart.
- The tool's declared `output.schema` mirrors the new shape.
- The client test environment renders no React (no jsdom), so everything text-deciding is asserted on the pure functions; keyboard/focus behaviour is a real-machine smoke item.
- The client plugin registers the takeover as keyed `tool.call.toolview` × `key: "grep"` at `priority: -1`, alongside read/edit/write; `client/scripts/verify-bundle.mjs` asserts the four registrations in the built artifact.

## Testing Decisions

- `test/core/grep-card-meta.test.ts` (host): span scanning (literal all-occurrences, regex whole-match, zero-width, non-overlap, UTF-16, invalid regex), the byte budget (drop-from-tail, keep-one, `total` preserved, input not mutated), the three degradation tiers and the malformed-payload matrix, plus end-to-end rows (context rows flagged/highlighted correctly, capped matches), the zero-match empty card, `presentResult`, and that the model text is unchanged while the card gains spans.
- `client/test/grep-card.test.ts`: card derivation and tiers, highlight segmentation (including the "segments always reproduce the input exactly" sweep), gutter text, footer counts, and the grep row chrome (variant, `tool.title.grep`, pattern summary, no file link).
- `npm run build` re-runs `client/scripts/verify-bundle.mjs`, which now expects four toolviews.
- `client/test/grep-card.test.ts` also covers `foldTabs`: fitting strips keep every tab, overflowing strips fold from the tail while reserving the trigger, the active tab is pinned (including the wider-than-displaced case and the nothing-fits case), a lone tab is never folded, and degenerate inputs (empty strip, zero-width container, out-of-range active index) stay sane.

## Out of Scope

- Editing the built-in `glob` card (this plugin does not shadow `glob`).
- Any change to the model-facing `grep` text, arguments or error codes.
- Syntax colouring on the grep card (would require shipping a tokenizer into the client bundle).
- Retrofitting the single-tab rule onto the edit/write cards — tracked separately as wayfinder ticket #91.
- A built-in-search-card fallback for deployments without the client half.

## Further Notes

- `docs/web-ui-structured-views-spec.md` is a draft written when the assumption was "emit a typed view and dsh-web renders it". Web rendering now goes through the bundled client plugin, so that document is superseded by this ADR plus the `#71`/`#82` implementation records.
- The `truncated` field's dual meaning and the 64 KiB budget both trace to `@deepseek-ai/dsh-tool-fs-search`, which the card intentionally mirrors rather than inventing a second convention.
