# ADR-0013 — Streaming segmented responses: refusing by size becomes flow control

> **Status**: Accepted (2026-10-03; decisions #204/#205, specs #209/#210, map #201; implementation tracked as #207)

## Problem Statement

The #167 read budget charged every candidate file's GROSS byte size against a
64 MiB per-call ceiling and ended the scan the moment one file did not fit.
ADR-0009's lazy anchors later shrank the real retained cost to the served
rows, but the billing basis never followed: a 68 MB file with one matching
line was reported as "No matches", folder scans truncated mid-way at an
order-dependent point, and files past the cut were not even listed in the
notice (#200, both shapes reproduced). The refusal also quietly retracted
ADR-0009's "large files are searchable" promise. And even with the plugin out
of the way, the host clips any single result over ~49,984 characters
(dsh-spill-policy, `maxInlineTokens: 12500`) — unbounded responses were never
actually deliverable.

## Decision

Refusing by size is retired. Every tool scans and reads in full. A result
larger than the **per-response budget** (48,000 UTF-16 code units — the
default of the `max_response_chars` setting, clamped to [8,000, 49,984]) is
**streamed in segments**: the first segment is returned with a resume token,
the rest is written incrementally to a session spill file, and the model walks
the result to the end via `resume` parameters. Read-only tools (read, grep,
ast_grep, lsp) consume their own tokens; mutating tools (write, edit,
ast_edit, undo_last_edit) never take a `resume` parameter — their oversized
reports are consumed by **read**, the only continuation exit (writing stays
writing; a token must never replay a mutation). Segments are assembled
whole-line — a line is never cut, sections/matches stay intact when they fit.
Resumed rows allocate or reuse anchors at serve time exactly per ADR-0009, so
every continued line is editable; when a file changed since its excerpt was
captured, the response carries a caution. The budget is pure flow control:
bounded memory comes from incremental spilling (resident = current file buffer
+ returned segment), not from refusal — which is how #167's original motive
(the heap death) stays covered without refusing anything.

## Consequences

- `GREP_MAX_TOTAL_BYTES`, the 1 MiB model-text cap and the 100 MiB read gate
  retire, along with the admit/release refusal arithmetic (the running counter
  moves into the segment assembler). The full constant inventory — including
  the dormant `AUTO_READ_MAX` / `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` — is
  owned by #205/#210.
- `persisted == served == visible` must hold on every channel, including
  read's second render path (#203's seam) — this decision closes it; a model
  may never see a row that was not served.
- Guidance, the README contract and the settings surface gain `resume`,
  `max_response_chars` and the `E_RESUME_GONE` / `E_RESUME_BAD` /
  `E_RESUME_TOOL` codes; the `[grep budget]` notice and the `truncated`
  semantics retire.
- Host pressure-period pruning (results over 8,192 code units get
  middle-pruned once the session crosses ~80% of the context window) is out of
  plugin control; it is documented, with a lower setting as the user-side
  mitigation.
- Spill files are plugin-owned session temp state with exit cleanup and a lazy
  TTL — aligned with the host's spill *vocabulary* (locator footers, "use read
  to continue") but not its store: the tool context has no spillStore.

## Alternatives Considered

- **Fix the meter, keep the refusals** (bill served rows instead of gross
  size): rejected by the maintainer — once streaming landed, refusals had no
  reason to exist and the billing fix became throwaway work (the trade-off
  record lives in #200's comments).
- **Raise the caps, keep refusing**: leaves order-dependent truncation and the
  host gate untouched; the refusal was the defect, not the number.
- **Ride the host spill-policy** (deliberately overflow into the host's own
  spill and parse its locator): segmentation becomes uncontrolled and coupled
  to host internals the SDK does not expose.
- **`resume` on mutating tools**: "call again with a token" would replay the
  write/edit — rejected for safety; report segments flow through read instead.
