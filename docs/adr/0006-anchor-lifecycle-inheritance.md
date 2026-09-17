# 0006 — Anchor lifecycle: inherit on any content change, allocate only at first serve

The dynamic-hashline spec (§4.4) accepted a tradeoff: on any content-checksum
mismatch (write, external change, cache eviction) the allocator recomputed the
whole file deterministically, relying on served-content verification
(`E_STALE`) as the backstop. The `2t` double-booking incident proved that
tradeoff fatal: deterministic re-allocation reshuffles identical-content runs
(blank lines, closing braces), a freed anchor can be re-emitted for a different
line, and content-equality verification is blind to that swap — the edit
resolved to the wrong line and destroyed lines 55–209.

**Decision**: the allocator (`anchorsFor`) is the single lifecycle gate.
Allocation happens in exactly two situations — a line's first serve, or a line
whose content actually changed. Every other acquisition (rewrite, external
change, LRU miss) inherits by contentKey line-alignment: unchanged lines keep
their anchors. Exclusivity is enforced structurally: the served mirror purges
stale single-owner bindings, and ambiguous resolution is a hard
`[E_ANCHOR_AMBIGUOUS]`, never a silent first-occurrence relocation. The
edit-path incremental updater (`updateAnchorsAfterEdit`) keeps its hunk
precision; `undo` re-seeds `undo.hashes` so served anchors stay real.

**Status**: supersedes the "churn 过的文件按新状态重算（已知权衡，接受）"
clause of `docs/dynamic-hashline-spec.md` §4.4. §4.5's two-moment rule
(allocation on content change, noop does nothing) is unchanged and now holds
for every path, not only tool edits.

**Consequences**: per-line anchor stability is absolute within a session
(verified live: rewrites and external appends keep surviving anchors);
cross-process determinism remains only for never-edited files; the served
mirror's v2 format persists parallel content keys so future drift checking can
activate once key provenance is unified.

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
