# ADR-0030 — a late LSP diagnostic speaks about the file's NEWEST write, or about nothing

> **Status**: Accepted (2026-10-31; issue [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388) — implemented in the same change; amended 2026-11-02 with the C′+D labelling after the maintainer's field report of the enqueue→delivery window).

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
6. **A report that is ALREADY enqueued cannot be withdrawn — so it says which
   write it describes.** `agent.inject` queues without waking the driver: a
   report enqueued for write #1 can be delivered AFTER write #2's report, and
   the plugin has no handle on the platform's queue to check or retract it at
   that point. The enqueued report therefore carries a **generation stamp**
   and a one-line precedence rule: *"This report describes write #1 of a.ts.
   If a newer write has landed since, its diagnostics take precedence over this
   one."*
7. **The newer report says so too.** The ledger remembers that an async
   injection happened for the document; the next inline report appends one
   line — *"An earlier write's delayed diagnostics may still arrive; if they
   do, this report takes precedence."* — and clears the flag. The two lines
   together bound the confusion in BOTH orders: the model reads the fresh
8. **The probe's waits only accept pushes that arrived AFTER the probe.**
   The session counts pushes, so a push that was already sitting there
   cannot answer the probe — the second wait's criterion ("a push that no
   longer mentions the nonce") is satisfied by any later push, including
   one that belongs to a different analysis.
9. **A caller that brought its OWN snapshot syncs the CURRENT content.**
   The manual `lsp diagnostics` path reads the file itself; a write that
   lands while its probe is in flight must win, or the probe's revert would
   roll the server's view back to the old content. `currentContentFor` is
   that rule: a write the ledger knows and that landed after the call
   started wins; otherwise the caller's own snapshot stands.
   report first and is warned, then reads the old report and is told which
   one wins.
   The background wait checks the generation before it probes and again before
   it injects.

## Alternatives rejected

- **Withdraw the enqueued report.** The plugin cannot: `agent.inject` is a
  queue-without-waking primitive and the platform owns the queue. The best
  the plugin can do is label both sides of the confusion.
- **Deliver the stale report twice — once labelled, once plain.** No: the
  model would read two reports for one write. One report, labelled, is
  the whole point.

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
- **The promise is bounded by the platform's queue.** A report that was
- **The probe's own guarantee rests on the server pushing its analyses in
  order for a document.** A server that pushes an analysis of ANOTHER
  content after the probe's push could still be accepted by the second
  wait — the plugin cannot tell which content a push was computed from
  (the version field tsserver does not send would have told it). The wait
  now rejects pushes that predate the probe; the out-of-order case stays
  a documented residual, not a fixed one.
  ALREADY enqueued when a newer write landed cannot be withdrawn: it will
  still be delivered, carrying old content and dead anchors. What the
  plugin guarantees is that the model can always tell WHICH report is
  newer — the generation stamp on the old one, the precedence line on the
  new one — not that the old report never arrives.
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
