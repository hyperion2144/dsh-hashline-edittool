# ADR-0007 — Domain-error whitelist conversion boundary (structured error values)

> **Status**: Accepted (issue #138 grilling under wayfinder map #137, 2026-09-19; user-confirmed「按推荐」).

## Problem Statement

Map #137 flips all 8 tools from throwing errors at dsh to catching their own failures and returning **structured error values** — success-shaped `{ modelText, error }` values that persist `meta.error` and render as a client error card. But the catch sits at each tool's `execute` boundary, where it sees *every* failure the pipeline can raise, and the host keys real semantics to `isError: true`:

- interruption recording (`block.error.code === "interrupted"`);
- sandbox policy denials and their escalation offers;
- failure accounting and retry policy in the agent loop;
- host-side argument validation before `execute` even runs.

Converting everything into "successful" error values would silently opt all of these flows out.

## Decision

A **whitelist keyed on the tool's own `[E_*]` error-code vocabulary** (`E_STALE`, `E_BAD_SHAPE`, `E_BATCH_ABORT`, … — the word list `extractFailure` already parses, including `E_BATCH_ABORT` unwrapping). Only domain errors carrying a recognized `[E_*]` code are converted into structured error values. Aborts, sandbox denials, and unexpected crashes **rethrow untouched** — they keep the host failure path and every semantic keyed to it.

Shape: one thin wrapper per tool `execute` (catch → recognize → `buildErrorResult` → return), so the ~28 throw sites are rewritten at zero sites; their byte-identical message contract (see `edit-engine`) is preserved by construction, and the converter is the single place that grows.

## Considered Options

- **Catch-all conversion** — rejected: aborts and sandbox denials would return as success values, silently breaking interrupted-recording, escalation offers, and failure accounting.
- **Per-throw-site rewriting** (return instead of throw at each of the ~28 sites) — rejected: easy to miss one site, and the byte-identical message contract would be at risk at every one of them.
- **Host-side conversion via `finalizeContent`** — rejected: it can replace `content` but cannot set `meta`, so `meta.error` (the single error signal per map Q2a) could not be persisted on the failure path.

## Consequences

- New failure modes must carry a `[E_CODE]` prefix to become structured error values. An unrecognized throw degrades to the legacy raw-IO error display (the client synthesizes a card from `block.content` per map Q5a) — visible, never silent.
- `isError: true` on a block from these tools now means *host-level failure only* (abort / sandbox denial / crash / pre-execute validation), which sharpens its meaning for the client instead of blurring it.
- The recognizer vocabulary is prior-art-backed (`extractFailure`); both it and the wrapper's catch must stay in sync with any new `E_` code introduced in the edit/grep/read contracts.
