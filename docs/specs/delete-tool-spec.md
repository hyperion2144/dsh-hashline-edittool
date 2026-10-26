# `delete` tool — implementation spec

Status: accepted (map [#322](https://github.com/hyperion2144/dsh-hashline-edittool/issues/322); decisions [#323](https://github.com/hyperion2144/dsh-hashline-edittool/issues/323), [#324](https://github.com/hyperion2144/dsh-hashline-edittool/issues/324), [#325](https://github.com/hyperion2144/dsh-hashline-edittool/issues/325)).
Owners: `src/tools/tool-delete.ts`, `src/infra/fs-bridge.ts`, `src/domain/session/hash-store.ts`.

## Purpose

Remove regular files and reclaim the hashline state a path leaves behind. `bash`
already removes bytes; it leaves `anchor_meta`, `anchor_lines`, `served` (every
session), and `undo` (every depth) for the deleted path in the store, so the
workspace budget slowly fills with dead paths. `delete` is the one call that
makes the file and its state disappear together.

Not a directory/recursive/glob tool. Not a restore/undelete tool.

## Contract

```json
{ "paths": ["src/a.ts", "tmp/b.log"], "sandbox_permissions": "workspace-write", "justification": "remove generated files" }
```

- `paths`: 1–32 non-empty strings; exact duplicates collapse in first-seen order;
  relative entries resolve against the session cwd.
- `sandbox_permissions` / `justification` are advertised only when the mounted
  backend confines (`sandbox.escalationModes.length > 0`), same pairing rules as
  `write`/`edit`; the approval applies to the whole call.
- The canonical value: `{ results, failures, totals, reclaimed, vacuum, warnings,
  modelText, error? }` where each result is
  `{ path, canonicalPath, status: "deleted" | "already-absent", reclaimed?,
  warning? }` and each failure is the shared `FileFailureMeta`.
- `presentationMeta`: `{ delete: { results, failures, totals, reclaimed, vacuum,
  warnings } }`. The client card is `HashlineDeleteRow` (`client/src/client/delete-card.tsx`);
  a call without the projection falls back to the platform row.

## Behavior

1. Validate the request shape (`E_BAD_SHAPE` for empty/too many/non-string entries).
2. **Preflight every path** with `io.probeFile` before approval: the final
   component's type is `file` / `symlink` / `directory` / `other` / `absent`.
   Symlink → `E_SYMLINK`; directory/other → `E_NOT_FILE`; those paths become
   per-path failures and never prompt for a wider mode.
3. Resolve the sandbox policy once (`resolvePolicy("delete", args, exec)`).
   `read-only` is denied by the fence; `workspace-write` allows only
   `writableRoots(policy)` (workspace + `/tmp` + the platform temp dir, canonical);
   `danger-full-access` is unfenced. Any root resolve/contains failure denies
   (fail closed). See ADR-0023.
4. Per path, in request order:
   - `deleteFile` re-probes, compares the expected kind/version, checks the
     local-only probe (`processPathFromHostPath(processPath) === processPath`),
     applies the fence, re-probes, then `unlink(processPath)`.
   - A file that vanished is `already-absent`; a type/version change is
     `E_DELETE_STALE` or the matching type code. A missing path is success and
     still reclaims residue.
   - On success/absent: record only `fs/observed` with `{kind:"absent"}` (never a
     write intent), clear any pending alignment notice, and `didClose` a running
     LSP document (never warm one).
   - Purge the path's four row families in one transaction (`purgePath`), and
     report the counts/bytes. A purge failure is a **warning** on that result,
     not a delete failure; the sweep/TTL retries the residue.
5. Partial failure never stops the other paths. All-failed calls carry the first
   failure as `error` for the error card; partial failures carry `failures` only.

## Errors

New: `E_DELETE_UNSUPPORTED`, `E_SYMLINK`, `E_NOT_FILE`, `E_DELETE_STALE`.
Reused: `E_ACCESS` (EACCES/EPERM/EBUSY/EROFS; Windows read-only or open handle —
no automatic chmod or retry), `E_BAD_SHAPE`, `E_DELETE_FAILED` (only as the
whole-call fallback code when no per-path code exists). A sandbox denial keeps
the shared `[sandbox: …]` marker + escalation hint, not an `[E_*]` code.

## Store

`HashStore.purgePath(path): PurgeReport` is the single cascade:

- delete `undo` rows for **that path, all depths** (never the whole table;
  other paths' undo is untouched);
- delete that path's `served` rows across **every session**;
- delete its `anchor_meta` and `anchor_lines` rows;
- return `{ anchorLines, undoLayers, servedRows, anchorMeta, bytesFreed }`;
- when logical bytes actually drop, write `pending_vacuum=1` (idempotent).

The sweep and `pruneMissing` share the row cascade. Shutdown runs a synchronous
`VACUUM` when the marker is present, clears the marker only on success, and
keeps it for the next shutdown on failure. The marker is the one physical
reclamation signal; deletes never VACUUM inline.

## Sandbox/transport

`FileIO.deleteFile(requestedPath, cwd, expected, signal?, policy?)` is the seam.
`ctx.fs` has no delete API in dsh 0.2.x (research note
`docs/research/dsh-removal-seam.md`); the bridge uses `node:fs.unlink` only for
paths proven local. Non-local/undeterminable targets fail with
`E_DELETE_UNSUPPORTED` and a bash hint. Symlinks are refused before resolve
(the link and its target stay). Windows read-only/occupied files fail `E_ACCESS`;
the tool does not change attributes or retry. See ADR-0023 for the accepted
residual TOCTOU window.

## Tests

- `test/core/delete-tool.test.ts` — four-family reclaim, other paths untouched,
  absent + residue, symlink/directory, multi-file partial failure, output schema.
- `test/core/hash-store-purge-path.test.ts` — cascade counts/idempotence,
  `pending_vacuum`, and the shutdown VACUUM shrinking the file.
- `test/core/fs-bridge.delete.test.ts` — workspace-write/read-only/danger fences,
  local-only probe, symlink refusal, version recheck.
- Client `client/test/delete-card.test.ts`; guidance section updates in
  `test/guidance.test.ts`.

## Docs

README/README.zh tool table + error codes + store paragraph; CHANGELOG
`[Unreleased]`; CONTEXT terms; ADR-0023; ADR-0010 amendment.
