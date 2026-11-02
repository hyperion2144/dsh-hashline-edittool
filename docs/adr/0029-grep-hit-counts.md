# ADR-0029 — grep 的命中数与截断口径：真总数、统计行、卡片标题

> **Status**: Accepted (2026-10-30; issue [#386](https://github.com/hyperion2144/dsh-hashline-edittool/issues/386)).
> Extends ADR-0013 (the per-response budget) and ADR-0028 (ripgrep is the engine).

## Problem Statement

The search stops at the per-file cap: ripgrep runs with `--max-count=limit`, so the
number of hits the plugin collected is **the cap** whenever the cap bit, and never the
file's real hit count. Everything downstream inherited that number and said nothing
about it:

- **the model text was silent.** A limit-truncated search produced exactly the same
  text as a complete one — no "there are more", no count. The parameter description
  (`"Cap on matches per file (default 100)."`) is not a response: the model reads
  the response, and "the first 100 hits" read as "all the hits".
- **the canonical `total` was the collected count.** The card's footer said
  "showing 100 of 100 matches" for a file with 300 matching lines — a number that
  reads as a whole.
- **the folded row carried no count at all.** The card body had a footer, but the
  row the reader sees first (the collapsed title) said only "Grep".

The data was half there: `totalMatches` and the truncated flag were accumulated per
file and written into the canonical value — and no channel carried them. The other
half was wrong: the count itself.

## Decision

**1. The count is a SECOND pass, and it is uncapped.** A file that did NOT reach the
cap needs no second pass: the engine read the whole file, so its count IS the
count. A file that DID reach the cap is counted again by `rg --count` — a pass of
its own, with **no `--max-count`**, because a capped count is the cap. The common
case therefore costs nothing, and the capped case costs one extra process over the
files that need it. The pattern rides as one argv element (`--regexp=<pattern>`) and
a literal pattern as the `--fixed-strings` flag — never a `-F` prefix glued onto
the pattern text (the #384 lesson).

**2. The count is per matching LINE, not per occurrence.** The plugin's unit is a
row, and the number has to be comparable with what was served: `rg --count`, not
`rg --count-matches`. A line that carries the pattern three times is one hit here,
and the served count would not add up otherwise.

**3. The canonical value carries the truth and the reason.**

- `total` — the **true** hit count across the files.
- `totalExact` — whether `total` IS that count. It is false whenever a file
  reached the cap and its true count could not be settled: the degraded path
  (ripgrep could not run at all), or the counting pass itself failing. There
  the count is a LOWER BOUND, and the model text says `≥N`.
- `truncatedBy` — which cut happened: `limit` (the per-file cap), `budget` (the
  response budget), or `limit+budget`.

**4. The model text says it, per file.** Every file section ends with its own count
line — `[Matches: 300 total, 100 served. Truncated by the per-file limit (100).]` —
so the count travels WITH the file it belongs to. A continuation does the same:
the per-file counts ride in the spill's sidecar, so every section a continuation
serves ends with the SAME count line the first segment gave — the continuation is
part of the same search, not a new one. The budget's continuation notice carries
the search's total (`… ; 300 matches in total.`).

The JSON path is the exception, and it is the one the ticket names: its `total`
is the search's true count and it carries `truncatedBy`, but it has no per-file
counts — its `files` are `{path, matches}` projections of the rows, and a count
line is a MODEL-TEXT thing. The model text and the JSON path are two channels
with two shapes; the ticket asks each of them for the counts it can carry.

**5. The card says it too.** The folded row's trailing suffix carries the counts —
the same slot the read row's window fills (#374) — and the wire carries FACTS, never
prose (ADR-0026): a stable key that names the wording (`row.title.grep.stats*`) plus
the numbers that fill it (`hits`, `served`). The cut is its OWN key, because a
template cannot say "and it was cut" without a conditional.

ONE qualifier is composed by the host: a lower bound rides as `≥N` rather than as
a bare number. It is a mathematical SYMBOL, not a word — the wording around it
stays in the client's vocabulary — and it is the only honest way to say "at least
N" without minting a second wording for every cut (eight keys for a case that only
arises when ripgrep is missing AND a file reaches the cap). The host's own
`totalExact` carries the same fact for the callers that want it as a boolean.

## Consequences

- A capped search no longer reads like a complete one. The model sees the real size
  of the match set, the card's footer says "showing 100 of 300 matches", and the row
  the reader sees first carries the counts.
- The card's own footer needed no change: it already read `total`; `total` is now
  the number it claims to be.
- `total` changed meaning. It was the collected count; it is now the true count.
  A session that stored the old value keeps the old meaning — the value is a
  number, and nothing re-reads it.
- `truncated` changed meaning with it: it used to say "the cap was REACHED"
  (which a file with exactly `limit` hits also did, though nothing was cut); it
  now says "a cut happened", and agrees with `truncatedBy`.
- The search costs one extra ripgrep process when — and only when — a file reaches
  the per-file cap. A search that fits under the cap is untouched.
- The degraded path (ripgrep missing) cannot count: its count is a lower bound, and
  the model text says `≥N`. The plugin's own matcher counts exactly when the file
  is under the cap, because then it read the whole file anyway.

## Alternatives Considered

- **`rg --count-matches` (occurrences, not lines)**: rejected — the number would
  not add up with the served rows, and the card's "showing X of Y matches" would
  read wrong.
- **One count pass over every file**: rejected — the search already read the files
  that did not hit the cap, so their counts are free; a second pass over them would
  be pure overhead.
- **Report the cap as the total and say so**: rejected — it is the bug. The point of
  the count is the number the search did NOT show.
- **A global stats line instead of per-file ones**: rejected — the count belongs to
  the file it describes; a single global line leaves the model guessing which file
  held how many.

## References

- Issue: [#386](https://github.com/hyperion2144/dsh-hashline-edittool/issues/386)
- ADR-0013 (the per-response budget, the spill and the resume token),
  ADR-0028 (ripgrep is the engine), ADR-0026 (the host-text key contract),
  ADR-0027 (the read window's truncated flag)
- Code: `src/domain/grep/stats.ts` (the vocabulary: the hits, the truncations,
  the count line), `src/tools/grep-rg.ts` (the counting pass),
  `src/tools/grep-search.ts` (what the search knows about a file's hits),
  `src/tools/tool-grep.ts` (the canonical value, the card's title),
  `src/render/wire-text.ts` (the grep row's title), `client/src/client/locale.ts`
  (the wording)
