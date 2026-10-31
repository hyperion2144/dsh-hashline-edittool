# ADR-0029 — a late LSP diagnostic speaks about the file's NEWEST write, or about nothing

> **Status**: Accepted (2026-10-31; issue [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388) — implemented in the same change).

## Problem Statement

The automatic diagnostics delivery had exactly ONE notion of freshness, and it
was the wrong one.

`verifiedReport` could prove: "this report was computed against the text I
just wrote". It could not prove: "that write is still the current one". The
delivery kept no record of the file's write history at all, so when a
background wait for write #1 finished AFTER write #2 had landed, it delivered
a report rendered from write #1's snapshot:

- the source rows showed the OLD file's lines, and the anchors minted for them
  no longer existed in the file — the model was handed markers for lines that
  were not there any more;
- worse, the freshness PROBE PUSHES TEXT INTO THE SERVER. Its revert
  (`didChange` back to the wait's snapshot) rolled the server's document view
  back to the version the model had left behind, so every answer the server
  gave for that file afterwards was computed from the old content.

The delivered message carried no version, no fingerprint and no timestamp, so
the model could not tell a stale report from a fresh one. The session's own
bookkeeping (`diagnosticsVersion(uri)` vs `documentVersion(uri)`) could have
answered that — and still cannot, because typescript-language-server sends no
`version` on its pushes: the comparison is unavailable for the most common
server, and the session's comment asking consumers to make it has had no
consumer for the whole life of the feature.

## Decision

**A diagnostic speaks about the file's NEWEST write, or about nothing.**

1. **The write path records the write.** `notifyDocumentWritten` — the single
   funnel every write tool goes through — records the new content per document
   in `src/lsp/write-tracker.ts`, together with a generation number that never
   repeats. The ledger is bounded in documents AND in bytes (it holds whole
   files) and holds only what a freshness check needs.

2. **A delivery owns exactly one write.** It captures that write's generation
   when it starts. A later write bumps the generation, and the delivery's
   report is DROPPED — the newer write has its own delivery, so the model
   receives exactly one report per write, and it is about the newest one.

3. **The probe syncs the server with the CURRENT content, never with a
   snapshot.** `verifiedReport` takes a RESOLVER for the text and re-reads it
   before every step; the probe's revert therefore pushes the file's current
   content even when a newer write landed while the probe was in flight. The
   server is never rolled back to a version the model has left behind.

4. **The report is rendered from the text that was verified.** The rows, the
   anchors and the served set all describe ONE version of the file — the one
   the server answered for.

5. **A wait that no longer owns the file stops before it touches the server.**
   The background wait checks the generation before it probes and again before
   it injects.

## Alternatives rejected

- **Compare the push's version with the document version.** The bookkeeping
  exists (`diagnosticsVersion` / `documentVersion`) but
  typescript-language-server sends no version on its pushes, so the comparison
  cannot decide freshness where it matters. It stays a note in the session, not
  the mechanism.
- **Serialize the waits per document.** The race survives: the first wait's
  probe still pushes its old text after the second write.
- **Re-target the stale wait to the newest text and deliver it.** The newer
  write's own delivery reports the same content, so the model would get the
  same report twice and could not tell which write it belonged to. Dropping
  keeps "one write, one report".
- **Fix the rendering only** (show the current file's lines). The rows would
  look right while the diagnostics still belonged to the old content — a
  report that is right about the wrong version.

## Consequences

- A late report for a superseded write is dropped. The model still gets the
  newest write's diagnostics — exactly one report, about the file as it is.
- The plugin never pushes an older text into a server that already knows a
  newer one, so the server's answers stay about the file on disk.
- The ledger is process-wide and bounded; a delivery whose document fell out
  of the ledger drops its report (the safe side) instead of guessing.
- The freshness contract is now "the newest write", not "the write I am
  serving" — a delivery that cannot prove the former says nothing.

## Evidence

- Field report: [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388)
  (two edits on one file; the first edit's delayed diagnostics arrived after
  the second, carrying the old content).
- Take-a-before: `docs/research/lsp-auto-diagnostics-staleness.md` — the
  code-path取证 that found the missing "newest write" bookkeeping.
- Regression: `test/core/issue-388-stale-diagnostics.test.ts` — a fake-timer
  loop that goes red on the old behaviour (the injected rows carried the old
  file's lines) and green on this one (exactly one injection, about the
  current file).
