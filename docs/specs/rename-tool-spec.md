# `rename` tool — implementation spec

Status: accepted (map [#337](https://github.com/hyperion2144/dsh-hashline-edittool/issues/337); decisions [#339](https://github.com/hyperion2144/dsh-hashline-edittool/issues/339), [#348](https://github.com/hyperion2144/dsh-hashline-edittool/issues/348), [#342](https://github.com/hyperion2144/dsh-hashline-edittool/issues/342); research [`docs/research/dsh-rename-seam.md`](../research/dsh-rename-seam.md)).
Owners: `src/tools/tool-rename.ts`, `src/infra/fs-bridge.ts`, `src/domain/session/hash-store.ts`, `client/src/client/rename-card.tsx`.

## Purpose

Move or rename regular files while migrating the path-keyed hashline state, so
anchors already allocated and already served stay valid at the new path and the
old path leaves no rows behind. `bash mv` moves the bytes and leaves
`anchor_meta` / `anchor_lines` / `served` / `undo` under the old path forever —
a moved file then grows a second anchor batch on its next read. `rename` is the
one call that moves the file and its state together.

Not a directory/recursive/glob tool. Not an overwrite tool (an existing
destination is `[E_EXISTS]`). Not a cross-device copy. Not an undelete.

## Contract

```json
{ "renames": [ { "from": "src/a.ts", "to": "src/b.ts" } ], "sandbox_permissions": "workspace-write", "justification": "move generated file" }
```

- `renames`: 1–32 pairs; each pair has two non-empty strings; relative paths
  resolve against the session cwd. Exact duplicate pairs collapse in first-seen
  order. Empty / more than 32 / non-string entries / a repeated `from` after
  collapsing / a repeated `to` after collapsing → `[E_BAD_SHAPE]`.
- `sandbox_permissions` / `justification` are advertised only when the mounted
  backend confines (`sandbox.escalationModes.length > 0`), same pairing rules as
  `write` / `edit` / `delete`; the approval applies to the whole call.
- The canonical value: `{ results, failures, totals, migrated, warnings,
  modelText, error? }`.
  - Each result: `{ from: { path, canonicalPath }, to: { path, canonicalPath,
    version }, status: "renamed", migrated?: MigrateReport, purged?: PurgeReport,
    warning? }`. `version` is the **post-rename** snapshot version (see
    Observation).
  - Each failure: the shared `FileFailureMeta`; `path` carries the requested
    `from`.
  - `totals`: `{ renamed, failed }`.
  - `migrated`: summed per-pair family counts (`anchorMeta`, `anchorLines`,
    `servedRows`, `undoLayers`) plus purged target residue and logical bytes.
- `presentationMeta`: `{ rename: { results, failures, totals, migrated, purged,
  warnings } }`. The client card is `HashlineRenameRow`
  (`client/src/client/rename-card.tsx`); a call without the projection falls
  back to the platform row.

## Behavior

1. Validate the request shape (`E_BAD_SHAPE`).
2. **Preflight every pair** before approval:
   - Source `lstat` (no follow): symlink → `[E_SYMLINK]`; directory / special →
     `[E_NOT_FILE]`; absent → `[E_NOT_FOUND]`. Capture the source
     `stat` version.
   - Destination `lstat`: absent → proceed. Present → `stat(bigint)` both sides
     and compare `dev` + `ino`: the same file with a different requested
     spelling (case-only rename on a case-insensitive volume) is allowed;
     anything else is `[E_EXISTS]`. A destination symlink is `[E_EXISTS]`
     (symlinks are not followed and not overwritten).
   - Destination parent: must exist and be a directory, else `[E_NOT_FOUND]`.
     Never create directories implicitly.
   - Per-pair failures never prompt for a wider sandbox mode.
3. Resolve the sandbox policy once (`sandbox.resolvePolicy("rename", args,
   exec)`). `read-only` denies; `workspace-write` requires **both** canonical
   paths inside `writableRoots(policy)` (resolve each root, `fs.contains` each
   side, fail closed on any error); `danger-full-access` is unfenced. Escalation
   keeps the existing `sandbox_permissions` + `justification` +
   `approveEscalation` choreography; ordinary calls do not ask again.
4. Per pair, in request order:
   - Re-probe the source (kind + version) and the destination (absent, or the
     same inode). A changed source version is `[E_RENAME_STALE]`; a source that
     vanished is `[E_NOT_FOUND]`; a destination that appeared is `[E_EXISTS]`.
   - Re-probe once more immediately before the syscall (the same accepted TOCTOU
     window `delete` has).
   - `node:fs.rename(sourceProcess, destProcess)`.
   - **Old path**: `emitAbsent`, `clearAlignmentNotice`, `notifyDocumentClosed`.
   - **New path**: `emitObserved` (a fresh `stat` after the rename — `versionOf`
     includes `ctime`, which rename changes). Never emit `fs/write-intent`.
   - `store.renamePath(sourceProcess, destProcess)`: one transaction for the
     pair (target residue purge + four-family move, see Store). A store failure
     is a **warning** on that result, never a failed rename.
5. Partial failure never stops the other pairs. An all-failed call carries the
   first failure as `error` for the error card; partial failures carry
   `failures` only.

## Errors

New: `[E_RENAME_UNSUPPORTED]`, `[E_RENAME_STALE]`, `[E_CROSS_DEVICE]`,
`[E_EXISTS]`, `[E_NOT_FOUND]`.
Reused: `[E_SYMLINK]`, `[E_NOT_FILE]`, `[E_ACCESS]`, `[E_BAD_SHAPE]`;
`[E_RENAME_FAILED]` only as the whole-call fallback code when no per-pair code
exists. A sandbox denial keeps the shared `[sandbox: …]` marker + escalation
hint, not an `[E_*]` code.

- `EACCES` / `EPERM` / `EBUSY` / `EROFS` → `[E_ACCESS]`. On Windows a permission
  denial arrives as `EPERM`, not `EACCES`; the tool does not chmod and does not
  retry.
- `EXDEV` → `[E_CROSS_DEVICE]`; there is no copy+unlink fallback (non-atomic and
  it bypasses the fence).
- `ENOENT` (source or destination parent) → `[E_NOT_FOUND]`; `EISDIR` /
  `ENOTEMPTY` → `[E_NOT_FILE]`; `EEXIST` → `[E_EXISTS]`.

## Store

`HashStore.renamePath(from, to): MigrateReport` is the single primitive, one
transaction per pair:

1. Purge the **target path's** residue in all four families (the destination
   file did not exist on disk, so those rows are dead cache), reporting the
   reclaimed counts.
2. For each family, `INSERT … SELECT` the source rows under `to`, then `DELETE`
   the source rows. The `AFTER INSERT` / `AFTER DELETE` count triggers move the
   maintained path / row counts; a bare `UPDATE … SET path` would drift them.
3. Carry `served.reported`, `undo.content`, `undo.hashes` and
   `undo.result_checksum` verbatim; `updated_at` keeps its original value
   (a rename is not a serve, so the TTL definition does not change).
4. Return per-family counts, the purged counts, and the logical byte delta. No
   `pending_vacuum` producer is added (only row deletions from the target purge
   can free pages; the sweep/TTL path already marks it).

The four-family key story: `anchor_meta(path PK)`, `anchor_lines(path, line)`,
`served(session_id, path)`, `undo(path, depth)`. A source path absent from the
store is a no-op success.

## Sandbox / transport

`FileIO.renameFile(requestedFrom, requestedTo, cwd, expectedFrom, expectedTo,
signal, policy)` is the seam (`ctxFsIO` and the test `localIO` both implement
it). It owns: two-sided probe, local-only proof
(`processPathFromHostPath(processPath) === processPath`, Windows case-folded),
fence checks on both canonical paths, the pre-syscall re-probe, the
`node:fs.rename`, and the errno mapping above. A target that cannot be proven
local fails `[E_RENAME_UNSUPPORTED]` with a bash hint, fail-closed.

## Observation / LSP

- Two events, in this order: old path absent, then new path present with a fresh
  version. No `fs/write-intent` (nothing derives a write guard; the
  workspace-changes capture hangs off the write intents and does not see a
  rename).
- LSP: `didClose` the old URI (ready servers only, never warm, never throw); the
  new URI is opened lazily by the next semantic call. There is no
  `workspace/didRenameFiles` in dsh or in this plugin.

## Tests

- `test/core/hash-store-repath.test.ts` — four-family move, cross-session
  `served`, multi-depth `undo`, target-residue purge, maintained counts,
  `updated_at` preserved, source-absent no-op.
- `test/core/rename-tool.test.ts` — batch order/chaining, duplicate preflight,
  case-only rename, destination exists, symlink/directory, missing parent,
  partial failure, store-failure warning, presentation schema.
- `test/core/fs-bridge.rename.test.ts` — three fence modes, local-only proof,
  same-inode acceptance, errno mapping, TOCTOU version check.
- Client `client/test/rename-card.test.ts`; guidance section updates in
  `test/guidance.test.ts`; output-schema pinning via `test/support/schema-check.ts`.

## Docs

README / README.zh tool table + error codes + store paragraph; CHANGELOG
`[Unreleased]` (one Chinese line + issue ref); CONTEXT terms (`rename`, `path
repath`, `anchor preservation across path`); ADR-0024; guidance
`tool:rename` section + `rename.md` override file + materialize list;
`docs/CHANGELOG-MEMORY.md`.
