# ADR-0024 — the `rename` tool: host rename with a two-sided fence, two observations, and a path migration that never rewrites anchors

Status: Accepted (2026-10-26)
Map: [#337](https://github.com/hyperion2144/dsh-hashline-edittool/issues/337)
Decisions: [#339](https://github.com/hyperion2144/dsh-hashline-edittool/issues/339), [#348](https://github.com/hyperion2144/dsh-hashline-edittool/issues/348), [#342](https://github.com/hyperion2144/dsh-hashline-edittool/issues/342)
Research: [`docs/research/dsh-rename-seam.md`](../research/dsh-rename-seam.md)
Spec: [`docs/specs/rename-tool-spec.md`](../specs/rename-tool-spec.md)

## Context

Hashline state is keyed by the canonical process path: `anchor_meta(path PK)`,
`anchor_lines(path, line)`, `served(session_id, path)`, `undo(path, depth)`.
Anchor values themselves are content-derived (`lineHashesPure`), so a path is
nothing but a key — but it is the key every read, edit and undo lookup uses.

`bash mv` (and every shell-style move) changes the path without touching the
store. The old path keeps four families of rows until TTL/LRU, and the first
read of the new path mints a second batch: one file, two anchor sets, and stale
anchors that can never verify.

dsh 0.2.x has no rename seam: `ctx.fs` is 15 methods + 1 getter with no
rename/move, the only `fs/*` events are write-intent / edit-intent / observed,
`FsErrorCode` has no rename code, and the fs-sandbox fences only
`writeText`/`editText`. The capability exists — `fs-local`'s atomic write
already ends in `node:fs.rename` — but it is not exposed and not fenced.

## Decision

1. **Transport**: a tool, not a shell wrapper. The bridge performs a guarded
   `node:fs.rename` after rebuilding the fence from the same policy vocabulary
   dsh uses (`writableRoots(policy)` + `fs.resolve` + `fs.contains`), checking
   **both** the source and the destination — one-sided checks would let a file
   leave a protected root or be written into it. Non-local/undeterminable
   targets fail closed with `E_RENAME_UNSUPPORTED`; `EXDEV` is
   `E_CROSS_DEVICE` with no copy+unlink fallback (non-atomic and it bypasses the
   fence).
2. **Observation**: two events — old path `absent`, new path `present` with a
   version stat'ed **after** the rename. `versionOf` includes `ctime`, which
   rename changes, so carrying the old version forward would fail the next
   `edit` with `FS_STALE_VERSION`; skipping the new `present` would fail it with
   `FS_NOT_OBSERVED`. No `fs/write-intent` is emitted: nothing derives a write
   guard from a rename, and `workspace-changes` therefore does not capture it.
   This is deliberately the same call `delete` made, for the same reason.
3. **State migration**: `HashStore.renamePath(from, to)` in one transaction per
   pair. The target path's residue is purged first (the destination file did not
   exist, so those rows are dead cache; merging them would mix two incompatible
   anchor sets). Then each family is copied with `INSERT … SELECT` and the
   source rows are deleted — **never `UPDATE … SET path`**, because the
   maintained path/row counts are `AFTER INSERT` / `AFTER DELETE` triggers.
   `updated_at` keeps its value: a rename is not a serve, so the TTL definition does not
   change. A store failure is a warning, not a failed rename: the file move is
   the primary effect and the residual rows are reclaimed by sweep/TTL.
4. **LSP**: `didClose` the old URI only. dsh has no LSP package and no
   `workspace/didRenameFiles`; the plugin's document table is keyed by URI per
   session, so the new URI is opened lazily by the next semantic call, never
   pre-warmed.
5. **Contract**: `renames: [{from, to}]`, 1–32 pairs, executed in request order,
   each pair judged against the disk state at its turn (chains `a→b`, `b→c`
   work; swaps fail naturally). Duplicate `from`/`to` are rejected in preflight;
   exact duplicate pairs collapse. An existing destination is `E_EXISTS` unless
   it is the same `dev`+`ino` with a different spelling (case-only rename on
   case-insensitive volumes). The destination parent must already exist.
6. **Failure model**: per pair, not per call. A failed pair does not stop the
   rest; an all-failed call carries the first failure as `error`.

## Consequences

- A moved file keeps the anchors it had: the next `edit` finds the same served
  rows at the new path, with no second batch and no re-read.
- The old path is left with zero rows, so `pruneMissing`/TTL cannot resurrect a
  stale alias later.
- Per-pair transactions accept a crash window between the rename and the store
  migration; the file wins, the store is repaired by the sweep, and the result
  reports a warning rather than lying about success.
- Two-sided fence checks are a policy replication, not a kernel boundary:
  `processPathFromHostPath` is lexical, so a future partial-sharing remote
  backend could pass it. `fs.contains` is lexical containment, not an inode
  check; Windows 8.3 / case aliases may be denied (the safe direction).
- The `lstat`→`rename` window remains, and Windows open-handle / read-only
  failures surface as `E_ACCESS` without chmod or retry.
- No directory moves, no overwrite, no cross-device copy, no undo of the rename
  itself. Directories and symlinks stay on the bash path.

## References

- Research: [`docs/research/dsh-rename-seam.md`](../research/dsh-rename-seam.md)
- ADR-0006 (anchor lifecycle — path is a key, content is the anchor)
- ADR-0010 (bounded storage — TTL/LRU over the four families)
- ADR-0023 (delete — the same host-seam + fence + observation discipline)
- `src/tools/tool-rename.ts`, `src/infra/fs-bridge.ts`,
  `src/domain/session/hash-store.ts`
