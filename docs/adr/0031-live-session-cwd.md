# ADR-0031 — a tool call resolves against the session's LIVE working directory

> **Status**: Accepted (2026-11-02; issue [#394](https://github.com/hyperion2144/dsh-hashline-edittool/issues/394) — implemented in the same change).

## Problem Statement

A session has TWO directories, and they are not the same thing.

The session HEADER carries a `cwd`: the directory the session was created
in. The host freezes it for the session's whole life, on purpose — a resumed
session must be able to find its project again even if the model has moved
on.

A session's WORKING DIRECTORY is different: it MOVES. DSH's
`create_worktree` and `working_directory` tools commit a
`working-directory/change` event, and the live directory follows it. The
host's own fs tools ask the host's `workingDirectory` service for that live
directory on every call (`packages/fs/tool-fs/src/session-cwd.ts`:
`await ctx.workingDirectory.ensure(exec.agent, exec.signal)`).

This plugin resolved every relative path against the HEADER. So after the
model entered a worktree:

- a relative `read` returned the ORIGINAL checkout's file — the worktree's
  copy of the same path was never looked at;
- a relative `write`/`edit` landed in the ORIGINAL checkout, so the change
  the model believed it made was applied to a different tree (and the
  worktree stayed untouched);
- the served rows and the undo history were filed under the ORIGINAL
  checkout's workspace store, so the anchors the model held did not describe
  the tree it was editing.

The model was told the working directory had changed, and the plugin's tools
did not follow.

## Decision

**Every tool call resolves its paths against the session's LIVE working
directory, asked of the HOST — never inferred from the disk.**

1. **The plugin asks the host, once per call.** `src/domain/session/live-cwd.ts`
   owns the only answer the plugin has to "where is this session working?" —
   `liveCwd(exec)`. It reads the host's `workingDirectory` service through
   `ctx.get("workingDirectory")` — the same optional-service read the sandbox
   policy uses — and asks it for the directory the session is in NOW:
   `ensure(agent, signal)`, the very call the host's own fs tools make.

2. **The host's answer is authoritative — including its failure.** `ensure`
   validates the directory (and restores the session's original project when it
   vanished). If it throws, the error PROPAGATES: the built-in fs tools treat
   it the same way, and resolving against a stale header is the very bug this
   decision removes. The seam never substitutes a directory the host did not
   name — so a cancelled call cannot slip through against a fallback either.

3. **The session header is the fallback for a host WITHOUT the service** (an
   older harness) — and such a host cannot move a session's directory either,
   so it has nothing to follow. That is the old behaviour, and it is a safe
   degradation.

4. **The plugin never probes the disk for worktrees.** Several checkouts can
   exist at once (`.agents/worktrees/`, sibling clones, a nested worktree),
   and only the host knows which one THIS session is in. A directory that
   merely exists is not evidence of anything.

5. **ONE resolution per call.** `withLiveWorkspace(exec, fn)` resolves the live
   directory and enters the workspace scope in ONE step, and hands the body
   the same value the scope carries: the ambient workspace, the store it
   opens, the path the body resolves and the diagnostics it writes all read
   that one value, so they cannot disagree about where the session is working.

## Alternatives rejected

- **Probe the disk for worktree directories** (e.g. "is there a
  `.agents/worktrees/` entry matching this branch?"). Rejected: several
  checkouts can exist at once, a worktree can be created outside the
  repository, and the branch is not the directory. This is the guessing the
  issue explicitly rules out.
- **Read the session's event log** and replay `working-directory/change`
  events to find the latest one. Rejected: the host already folds that log
  into a projection; replaying it in the plugin would duplicate the host's
  state machine and drift from it.
- **Keep the header and make the MODEL pass absolute paths.** Rejected: the
  host's own fs tools do not require that, and the model cannot be asked to
  know the host's directory layout.
- **Stamp the sandbox's workspace root with the live directory too.** The fence
  is the HOST's: `dsh-sandbox-policy` roots the workspace at
  `session.header.cwd` (`resolveWorkspaceRoot(session?.header.cwd ?? …)`), and
  the host's own fs tools stamp exactly the same policy — so the plugin's
  exposure is identical to theirs. DSH's default worktree lives INSIDE the
  repository (`.agents/worktrees/<name>`), where the header's root already
  contains the live directory, so the fence does not block it. A working
  directory OUTSIDE the header's root leaves the resolved paths outside the
  fence — the host's own fs tools have exactly the same exposure there.
  Overriding the host's fence from the plugin would make the plugin MORE
  permissive than the built-in tools, which is not a thing a plugin should
  decide on its own.
- **Fall back to the committed-but-unvalidated directory when `ensure` fails.**
  Rejected: the host's `get()` answers with the committed directory even when
  it has VANISHED, so the "fallback" is a directory the host could not
  confirm. The host's failure is the answer's failure.

## Consequences

- A relative path in a moved session resolves in the session's live
  directory, exactly as the host's own `read`/`write`/`edit` do.
- The workspace store is keyed by the live directory, so served rows, anchors
  and undo history belong to the tree the model is actually editing. Moving
  the session starts a SEPARATE store — the anchors of the previous tree are
  not visible in the new one, which is the same rule that already separates
  two checkouts.
- The plugin's tools and the host's built-in tools now agree about the
  working directory. Before, they disagreed after every move.
- The seam is ASYNC: it asks the host, which may touch the filesystem. Every
  tool that resolves a path awaits one resolution at the start of its body.
- A host whose `workingDirectory` service fails makes the tool call fail,
  exactly as the host's own fs tools do. That is deliberate: the plugin never
  resolves against a directory the host did not name.
- A host without the `workingDirectory` service keeps the header behaviour —
  the plugin loads and works on such a host, it just does not follow a
  directory change (a host that cannot move a session's directory has nothing
  to follow).

## Evidence

- Field report: [#394](https://github.com/hyperion2144/dsh-hashline-edittool/issues/394)
  — the reporter's session created a worktree, and every relative
  read/edit/write landed in the original checkout while the worktree stayed
  untouched. Stable, not intermittent.
- Host semantics: `@deepseek-ai/dsh-working-directory` — "the immutable
  Session header retains the original project"; the live directory is a
  session projection folded from `working-directory/change` events, and
  `ensure()` restores the original project when the live directory
  vanished. The built-in fs tools read it per call.
- Regression: `test/core/issue-394-worktree-cwd.test.ts` — six cases over the
  real tool builders: a relative read follows the live directory, the served
  rows land in the live workspace's store, a relative edit lands in the live
  directory, a relative write lands in the live directory, a host without the
  service keeps the header's cwd, and a host that fails makes the call fail.
