# ADR-0023 — the `delete` tool: host unlink with a rebuilt fence, four-family reclaim, and a real close-time VACUUM

Status: Accepted (2026-10-26)
Map: [#322](https://github.com/hyperion2144/dsh-hashline-edittool/issues/322)
Decisions: [#323](https://github.com/hyperion2144/dsh-hashline-edittool/issues/323), [#324](https://github.com/hyperion2144/dsh-hashline-edittool/issues/324), [#325](https://github.com/hyperion2144/dsh-hashline-edittool/issues/325)
Spec: [`docs/specs/delete-tool-spec.md`](../specs/delete-tool-spec.md)

## Context

The plugin replaces `read`/`edit`/`write`/`grep` with anchored versions. A file
deleted with `bash` leaves its `anchor_meta`, `anchor_lines`, `served` (per
session), and `undo` rows in the workspace SQLite store until TTL/LRU; the model
also keeps a stale `fs/observed` entry. There was no tool that removed the file
and the state together.

dsh 0.2.x's `ctx.fs` has **no delete seam** (type surface, events, and error
codes — research [`docs/research/dsh-removal-seam.md`](../research/dsh-removal-seam.md)).
`fs-sandbox` fences only `writeText`/`editText`; a host `node:fs.unlink` bypasses
it entirely. The transport therefore has to rebuild the fence from the same
policy vocabulary dsh itself uses.

## Decision

1. **Transport**: `delete` is a tool, not a shell wrapper. A new
   `FileIO.deleteFile` seam probes the final component with `lstat` (no-follow),
   resolves the target, proves it is local with
   `processPathFromHostPath(processPath) === processPath` (Windows case-folded),
   rebuilds the fence from `writableRoots(policy)` + `fs.contains`, re-probes the
   expected kind/version, then calls `node:fs.unlink(processPath)`.
   Non-local/undeterminable targets fail closed with `E_DELETE_UNSUPPORTED`.
2. **Policy**: `read-only` denies; `workspace-write` allows only the canonical
   writable roots (workspace + `/tmp` + the platform temp dir); `danger-full-access`
   is unfenced. Escalation is the existing `sandbox_permissions` +
   `justification` + `approveEscalation` choreography, advertised only when the
   backend confines. Ordinary calls do not ask again.
3. **File type**: regular files only. Symlinks are refused before resolution
   (`E_SYMLINK`; the link and its target stay), directories/special files are
   `E_NOT_FILE`. No directory, recursive, or glob form.
4. **TOCTOU**: the tool probes before approval, `deleteFile` re-probes after
   approval, and it re-probes once more immediately before `unlink`; a version
   change is `E_DELETE_STALE`, a vanished file is `already-absent`. The second
   `lstat`→`unlink` window remains (accepted below).
5. **Reclaim**: one public `HashStore.purgePath(path)` deletes the path's
   `undo` (all depths, never the whole table), `served` (every session),
   `anchor_meta`, and `anchor_lines` rows in one transaction; it returns counts
   and the logical byte delta. Delete, sweep, and `pruneMissing` share it. A
   purge failure is a warning, not a delete failure.
6. **Physical release**: a purge that lowers logical bytes writes
   `pending_vacuum=1`. Shutdown runs a **synchronous** `VACUUM` when the marker is
   present, clears it only on success, and leaves it for the next shutdown on
   failure. Deletes never VACUUM inline. This repairs ADR-0010's reclamation
   path: the marker previously had no producer, and the previous worker call was
   asynchronous, so shutdown cleared the marker before the VACUUM was confirmed.
7. **Observation/LSP**: after a successful or already-absent result, record only
   `fs/observed` with `{kind:"absent"}` (never `fs/write-intent`), clear a
   pending alignment notice, and `didClose` a running LSP document — never warm
   one for a delete. Other sessions' old anchors are dead; their next edit
   re-reads.

## Consequences

- The model gets one explicit, non-shell way to delete regular files and see
  what was reclaimed (rows + logical bytes).
- The physical shrink happens at store shutdown, not in the tool call: a delete
  stays fast and does not contend with the main connection.
- The fence is a policy replication, not a kernel boundary. `processPathFromHostPath`
  is a lexical mapping, not an identity proof; a future partial-sharing remote
  backend that implements it could pass. Revisit if such a backend ships.
- `fs.contains` is the backend's lexical containment, not `fs-sandbox`'s
  `isPathUnder` inode fallback; Windows 8.3/case aliases may be denied (safe
  direction), pinned by tests where possible.
- The second `lstat`→`unlink` window and the Windows errno/occupancy matrix are
  accepted residual risks, covered by the acceptance ticket rather than pretended
  atomic.
- No restore exists: `undo` rows are part of the purge. `bash` remains the path
  for directories and symlinks.

## References

- Research: [`docs/research/dsh-removal-seam.md`](../research/dsh-removal-seam.md)
- ADR-0010 (bounded storage; amended for the producer + synchronous close VACUUM)
- ADR-0006 (anchor lifecycle — deletion invalidates anchors)
- `src/tools/tool-delete.ts`, `src/infra/fs-bridge.ts`, `src/domain/session/hash-store.ts`
