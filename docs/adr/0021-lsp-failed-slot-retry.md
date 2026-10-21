# ADR-0021 — LSP failed-slot retry: bounded backoff, `status`/`warm`, stderr tails

> **Status**: Accepted (issue #318; 2026-10-21). Governs `src/lsp/manager.ts` and the `lsp` tool's operation set.

## Problem Statement

A language server that failed to start left its slot in the `failed` state
forever. Three mechanisms had to conspire for that:

- `warm()` early-returned on **any** existing slot — including `failed` — so the
  periodic `decide()` retry path that every other cold start goes through never
  fired again (dead code since 5db349d).
- The only code that deleted a failed slot, `rescan()`, ran solely from the
  settings card's install route — an agent with no settings UI open had no way
  to trigger it.
- `waitForSession()`'s poll gave up on `failed` immediately, so every tool call
  against that language refused with `The language server exited (code 1).` —
  a message whose only remedy it named was "Install one", even when the server
  was installed and had merely crashed (its stderr tail was captured by the
  transport but consumed by no one).

A user could recover only by opening the settings card and pressing install;
the model had no recovery path at all. There was also no way to ASK what state
the servers were in: `manager.status()` reached only the HTTP status route.

## Decision

1. **Failed slots retry with bounded exponential backoff.** A failed start
   records `attemptedAt` and a per-language attempt counter.
   `warm()` restarts a failed slot when
   `min(base · 2^(attempts−1), 60_000) ≤ now − attemptedAt`
   (`retryBaseDelayMs`, default 5_000, capped at 60_000). Success clears the
   counter; `rescan()` and `dispose()` reset it. `waitForSession()` is
   unchanged: before the backoff elapses the warm is a no-op and the poll still
   returns promptly on `failed`, so callers are never held for the full start
   timeout against a server that just died.
2. **`forceWarm()` bypasses the backoff explicitly.** It deletes the failed
   slot and starts anew — the escape hatch for a caller who fixed the
   underlying cause (installed the server, edited the config) and wants the
   outcome now, not at the next backoff boundary.
3. **`snapshot()` is read-only.** It reports every slot's state — including
   `failed` slots' reason, message and attempt count — and never starts
   anything: a status question with side effects stops being one.
4. **The `lsp` tool gains `status` and `warm` operations.** `status` lists
   every language that has a server slot (or one language's state) from `snapshot()`, and a slot-less language is reported as not started;
   `warm` calls `forceWarm` and reports the outcome, surfacing the manager's
   `unavailability()` reason on failure. Both are language-level: they branch
   before `path` resolution, and `path` stays required for the four file
    operations. Their card is the language status list, not a file view:
    `presentationMeta` projects `card: "lsp-status"` + `slots` (the client
    draws a dedicated status block from it; #320). The projection returns an
    OBJECT, never `undefined` — the host serializes meta as JSON, where
    `undefined` is not lossless and its rejection kills the whole call.
5. **Failure messages carry the server's stderr tail.** The `#start` catch
   (and the server-missing path) appends up to ~1,200 characters of the
   captured stderr under a `--- server stderr (tail) ---` separator, turning
   "exited (code 1)" into the actual compile error or missing-binary message.

6. **An unexpected failure is wrapped into the vocabulary, not re-thrown.** A
   non-`[E_*]` throw (a spawn crash, an internal error) used to escape as a
   rejection; the host persists that as an `isError` result whose `Error`
   object cannot survive lossless JSON, and EVERY `lsp` call then dies with
   `value is not lossless JSON` (#320). The wrapper converts it to
   `[E_LSP_UNEXPECTED]` — the refusal rides the error card like every other
   one. Aborts keep their host semantics untouched (ADR-0007).
    The witness fill (#317) that makes the converted refusal carry every
    REQUIRED field must not literal-write `path: undefined`: `path` is
    optional since this ADR's tool face, `status`/`warm` pass none, and
    lossless JSON rejects the attribute outright — the host refused every
    path-less refusal before it ever reached the card. Omitted, not
    undefined.
## Alternatives considered

- **Retry immediately on every `decide()`** — rejected: a crashing server
  would be respawned in a tight loop, burning CPU and log lines; a server that
  just failed is likely still broken seconds later.
- **Retry inside the tool layer only** — rejected: the auto-diagnostics path
  and every other `warm()` caller would stay dead; the fix belongs where the
  slot state lives.
- **A dedicated `lsp_status` tool** — rejected: `status`/`warm` are
  language-server concerns of the existing tool's operation set; a second tool
  splits one domain across two entry points (Q2 in #318).

## Consequences

- A crash-looping server is retried on the next use at 5 s, 10 s, 20 s … capped at 60 s — bounded,
  observable through `status`, and reset by success.
- The model can now ask (`status`) and act (`warm`) without the settings card;
  the card's install route keeps working unchanged.
- Backoff state is in-memory like the slots themselves; a manager restart
  resets it, matching the existing restart semantics.
