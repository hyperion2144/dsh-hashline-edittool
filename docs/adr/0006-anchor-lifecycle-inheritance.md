# 0006 — Anchor lifecycle: allocate at serve, on content change, or on external change

The dynamic-hashline spec (§4.4) accepted a tradeoff: on any content-checksum
mismatch (write, external change, cache eviction) the allocator recomputed the
whole file deterministically, relying on served-content verification
(`E_STALE`) as the backstop. The `2t` double-booking incident proved that
tradeoff fatal: deterministic re-allocation reshuffles identical-content runs
(blank lines, closing braces), a freed anchor can be re-emitted for a different
line, and content-equality verification is blind to that swap — the edit
resolved to the wrong line and destroyed lines 55–209.

**Decision**: allocation happens in exactly three situations — a line's
first SERVE (returned to the model in a tool result), a line whose content
actually changed (per-line `contentKey` comparison), or a line whose content
changed by an EXTERNAL modification, discovered on re-read. Every other
acquisition (rewrite, LRU miss) inherits by `contentKey` line-alignment:
unchanged lines keep their anchors at their new positions. Inheritance is a
REMAP — the anchor keeps its identity and only its line number moves; it is
never a re-allocation and never a re-hash. Exclusivity rests on the
allocation-set invariant: the persisted anchor rows carry one anchor per live
binding, so a duplicate cannot arise from the row family, and an ambiguous
resolution is a hard `[E_ANCHOR_AMBIGUOUS]` rather than a silent
first-occurrence relocation. Editability is a separate question with a
separate scope — the per-session persisted served set; the two are read from
the same store in the same transaction. `undo` re-seeds the snapshot so
served anchors stay real.

**Status**: Amended (2026-10-04, #215) — the rule's principle is unchanged;
the enumeration of allocation moments widened from two to THREE (first
serve / content change / external change discovered on re-read). The
enforcement carrier moved from the served mirror to the persisted per-session
served set plus the persisted anchor row family, and the stability boundary
widened from one session to every session sharing a workspace. The #136
amendment below stands; its `verifyServedRange` sentence now refers to the
persisted served set.

This ADR supersedes the "churn 过的文件按新状态重算（已知权衡，接受）"
clause of `docs/dynamic-hashline-spec.md` §4.4. §4.5's two-moment rule
(allocation on content change, noop does nothing) is unchanged and now holds
for every path, not only tool edits.

**Consequences**: per-line anchor identity is stable across SESSIONS that
share a workspace — not merely within one session. It ends when the line's
content changes, the line is deleted, the row's TTL expires, or the store
budget evicts it. Cross-process determinism remains only for never-edited
files. Editability is per session by construction: a session may write only
rows it has itself seen, so another session's anchors are usable for
reference but not for writing until this session reads the file. The
persisted row family carries each line's content key, so external drift is
detectable without storing line text.

**Amendment (2026-09-17, issue #136)**: the served-mirror purge clause above
("the served mirror purges stale single-owner bindings") is superseded — a
duplicate anchor in the served mirror is now KEPT and reported loudly
(`[E_SERVED_DUP]`). The purge was itself a silent record destroyer: it
masked upstream allocator bugs and manufactured "never served" rows.
`verifyServedRange`'s strict positional check remains the arbiter of what
may be written. Anchor state is additionally PERSISTED per cwd + path in
the sqlite hash-store (`anchor_state` row family): a cache miss recovers
from the store instead of re-allocating, external changes diff-inherit
against the persisted record, and no recompute path remains anywhere for a
path that already carries anchors. `updateAnchorsAfterEdit` now persists
the new content's per-line contentKeys (it previously keyed the ANCHOR
strings, so the first external change after a tool edit could not align
and reshuffled every line).

## Amendments

**2026-10-04, #215** — two refinements to the Consequences above.

The failure list is not exhaustive: a store **rebuild** invalidates every anchor
a session holds (announced to the model, ADR-0010), and a serve that could not
be persisted leaves editability that does not survive a restart. Both are
governance invalidations on top of content change, deletion, TTL and eviction.

**Two TTLs, two scopes** — `SERVED_TTL_MS` (7 days) governs the served set, so
it bounds WRITE permission; `ANCHOR_STATE_TTL_MS` (30 days) governs anchor
identity. Where ADR-0010 names "TTL 7 days" it means the served set only.

## References

- Amended: [#215](https://github.com/hyperion2144/dsh-hashline-edittool/issues/215) (three moments of allocation, persisted served set, cross-session stability boundary)
- Earlier amendment: [#136](https://github.com/hyperion2144/dsh-hashline-edittool/issues/136)
- Related: [ADR-0009](0009-sparse-lazy-anchors.md) (allocation timing), [ADR-0010](0010-bounded-anchor-storage.md) (the store the served set lives in), [ADR-0011](0011-bounded-alignment.md) (the alignment both inheritance and the release path use)
