# ADR-0010 — Bounded anchor storage: budgets, two-layer eviction, and tiered rebuild

> **Status**: Implemented (spec [#184](https://github.com/hyperion2144/dsh-hashline-edittool/issues/184); decisions taken with the maintainer on 2026-09-24 across map [#173](https://github.com/hyperion2144/dsh-hashline-edittool/issues/173); implementation in [#180](https://github.com/hyperion2144/dsh-hashline-edittool/issues/180)).

## Problem Statement

The per-workspace anchor store (`hash-store.sqlite`) grew without bound. Measured
on this repository: **2.17 GB / 10.49 M `anchor_lines` rows / 34,664 paths**, of
which `ios/Pods`, `node_modules` and `target` accounted for roughly 68 % — rows
for files that were only ever scanned and will never be edited.

Three separate failures came out of that measurement, and only the first is about
disk:

1. **Growth**: no eviction policy ran at all. `pruneServedOlderThan` and
   `pruneMissing` existed with zero callers in `src/`, and the two largest
   per-path payloads were unbounded — `undo` stored **two full copies of the file
   body per layer** (10 layers ≈ 20× the file size), and `served` stored a
   growing JSON array that every serve re-read, re-parsed and re-wrote in full.
2. **Cold open**: every open of the store ran `PRAGMA quick_check` — a full
   page-by-page integrity scan — plus two TTL prunes that walked whole tables.
   Measured on a 2 GB / 8.9 M-row store: **1,674 ms, of which 1,345 ms was the
   check** (small store: 8 ms). That cost landed on the first tool call that
   touched the store (`read`, `grep` — not `bash`), which is exactly the "tools
   hang once the store grows" report. Deleting the directory made it vanish,
   which is why the symptom looked like a size problem rather than an open-path
   one.
3. **Per-operation memory on large files** (out of scope here, tracked
   separately): reading a 50-line window of an 800 k-line file costs ~317 MB of
   heap and a one-line edit ~547 MB — nothing to do with the store.

## Decision

The store becomes **budgeted, self-evicting and self-healing**, and the open path
stops scaling with the store's contents.

1. **Three budgets, any one of which triggers eviction**: 5,000 paths /
   300,000 `anchor_lines` rows / 64 MiB of main-store bytes. Bytes are measured
   as `(page_count − freelist_count) × page_size` — NOT `page_count × page_size`,
   because `DELETE` only moves pages to the freelist, so a physical page count
   could never be brought back under budget and the sweep would delete the same
   paths forever. Eviction is therefore a *logical* release; `VACUUM` only
   returns disk to the OS.
2. **Two eviction layers, both always applied** (not a phasing): per-path
   slimming first (`undo` capped at 2 MiB per path with ≥ 1 layer kept), then
   whole-path LRU ordered by `MAX(updated_at)` across the five per-path tables,
   over-deleting by 10 % so the next sweep has headroom. Pure LRU, no protection
   allow-list: recency is the protection.
3. **TTL 7 days** on "not served since". Dropping an anchor is not data loss:
   file contents never change, the model re-reads.
4. **Tiered handling of oversize stores**: > 4× budget → evict; > 16× budget →
   **rebuild** by reusing the corrupt-store quarantine rename (`.sqlite`/`-wal`/
   `-shm` renamed aside, fresh store), with a 24 h throttle so a workspace that
   legitimately needs more does not rebuild on every launch.
5. **The open path no longer scales with rows.** `quick_check` runs only when the
   previous shutdown was NOT clean — `meta.clean_shutdown` is written at close
   and consumed at open, so a crash leaves it absent and the next open verifies.
   The maintenance indexes (`updated_at` on four tables) are created **after** the
   budget gate, once per store, because building them over 3 M rows measured ~5 s
   — all of it wasted when the gate then tears the store down. The open records
   its decision in `meta.last_open_integrity_check` (`skipped` / `ran`), which is
   what the cold-open tests assert instead of timing.
   - The promise, stated accurately: **a store inside the budgets opens within
     50 ms**; an over-budget store spends time healing at open and the *next*
     open is back inside the budget.
6. **Reclamation at close**: `VACUUM` + `wal_checkpoint(TRUNCATE)` on the
   shutdown path, with `pending_vacuum` repairing a hard kill on the next open —
   which checkpoints before measuring, so a sticky WAL is never counted as
   current size. No worker thread: contending with the main thread for the same
   SQLite file is not worth the complexity.
7. **`served` is not capped — it is re-represented.** It is the anti-fabrication
   proof that a line's content was shown to this session (`served.has(anchor)`),
   so dropping entries silently revokes edit rights on unchanged lines. It is now
   stored as sorted anchors, delta-encoded as varints, base64'd, behind a `~`
   marker no JSON payload can start with: a realistic 2,000-anchor window packs
   to less than half the JSON bytes, and decoding is one linear pass. Every legacy
   shape still decodes and any write replaces the row, so migration is lazy. (The
   decision said "bit-packed"; the varint bytes already carry the deltas, so a
   separate bit-stream would save a fraction of a byte per anchor and cost a lot
   of clarity.)
8. **`undo` keeps a checksum, not a second body**: `result_checksum` is added in
   place, new rows leave `result_content` empty, and the stale check prefers the
   checksum while legacy rows keep verifying by text.
9. **Degradation is explicit**: when the *current* batch alone exceeds the
   remaining budget, rows are served but not persisted, and the tool result says
   so. A rebuild is announced to the model (every anchor it holds just died);
   ordinary eviction stays silent except one log line per sweep.

## Consequences

- The store has a hard ceiling (≈ 64 MiB per workspace) and returns disk after
  eviction; a pathological workspace self-heals without user action.
- Anchors can be invalidated by governance (eviction, rebuild, or the
  serve-without-persist degradation). The failure mode is always "re-read the
  file", and it is stated in the tool result instead of surfacing as an
  unexplained never-served rejection.
- `undo` keeps its most recent layer for every path; large files keep only 1–2
  layers — a deliberate trade that preserves "undo what I just did".
- The first open after this upgrade pays a one-time index build proportional to
  the store's rows (measured ~130 ms at 240 k rows, ~5 s at 3 M). It is bounded
  by the budget afterwards, and an over-budget store rebuilds instead.
- The three budgets are settings (`store.max_bytes_mb`, `store.max_paths`,
  `store.max_lines`), validated at the schema *and* re-checked by `applyEffective`
  with a warning that names the field, the value, the range and the fallback. A
  change lands on the store's next sweep, never synchronously.

## Alternatives Considered

- **Per-path cap on `served`** — rejected by the maintainer as the wrong frame:
  it revokes edit rights for content the model has already been shown, and any
  fixed number is smaller than what a legitimate multi-window read or a
  directory-wide grep produces.
- **Served as a per-line bitmap** (≈ 56× smaller) — rejected: it loses the content
  dimension, so a multi-line claim's middle lines would be accepted on "this line
  was served once" alone, weakening the drift guarantee the anchor-as-content-
  identity design exists to provide.
- **Served as a row table** — exact and O(delta) per serve, but 30–40 B per anchor
  (more disk than the JSON it replaces) and it would need its own budget story.
- **Physical `page_count` accounting** — makes "delete until under budget"
  unsatisfiable, as above.
- **`VACUUM` inside the sweep** — a 2 GB `VACUUM` costs ~8–10 s and needs roughly
  the store's size in free space; it would block a tool call and can fail on a
  full disk.
- **`worker_threads` for the `VACUUM`** — two writers on one SQLite file need
  explicit `busy_timeout` coordination for no user-visible gain over doing it at
  close.
- **Path heuristics** (skip `node_modules`, `dist`, build output) — rejected:
  editing into those trees is a real workflow (the session that produced this ADR
  edited built client bundles), so budget and LRU carry the load instead.
- **Running `quick_check` on every open** — the original behaviour, and the
  measured cause of the hang.

## References

- Spec: [#184](https://github.com/hyperion2144/dsh-hashline-edittool/issues/184)
- Decisions: [#175](https://github.com/hyperion2144/dsh-hashline-edittool/issues/175) (budgets), [#176](https://github.com/hyperion2144/dsh-hashline-edittool/issues/176) (eviction + representations), [#177](https://github.com/hyperion2144/dsh-hashline-edittool/issues/177) (migration + reclamation), [#179](https://github.com/hyperion2144/dsh-hashline-edittool/issues/179) (settings)
- Evidence: [#174](https://github.com/hyperion2144/dsh-hashline-edittool/issues/174) (growth profile), [#178](https://github.com/hyperion2144/dsh-hashline-edittool/issues/178) (load baseline and the cold-open root cause), [#181](https://github.com/hyperion2144/dsh-hashline-edittool/issues/181) (the independent crash path)
- Bug: [#172](https://github.com/hyperion2144/dsh-hashline-edittool/issues/172)
- Related: [ADR-0009](0009-sparse-lazy-anchors.md) (the allocation half of the same cost story), [ADR-0011](0011-bounded-alignment.md) (the alignment half)
