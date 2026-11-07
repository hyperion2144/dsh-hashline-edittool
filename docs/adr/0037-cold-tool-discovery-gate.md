# ADR-0037 — cold tools register once and are gated by a persisted discovery flag

> **Status**: Accepted (2026-11-06; issue [#421](https://github.com/hyperion2144/dsh-hashline-edittool/issues/421)).
> Amends [ADR-0032](0032-tool-registration-layers.md) (as corrected by #418) and
> revisits one consequence of the #398 contract.

## Problem Statement

The default surface carries every tool's schema on EVERY model request —
measured at **5,138 tokens** for the twelve tools
(`benchmark/schema-tokens.mjs`), of which the four cold tools
(`ast_grep`, `ast_edit`, `format`, `lsp`) hold **1,847 (36%)**. A session that
never touches AST/format/LSP work pays that 36% on every turn. The reference
plugin [dsh-ops](https://github.com/T-Auto/dsh-ops) demonstrates the schema-side
saving (its resident surface: 241 tokens, gated at ≤400 by CI — BM-03), but its
mechanism does not transfer verbatim: its discovered-set is a per-agent in-memory
`Set` (lost on restart, every cold tool goes cold again), it has no residency
assertion, and a model calling a not-yet-admitted tool gets a bare `UNKNOWN_TOOL`
with no guidance. Meanwhile #418's lesson stands: a probe that decides tool
placement mis-decided the resume path and left tools out of a resumed session's
first turn.

## Decision

**Register once, gate admission with a persisted flag, fail open.**

1. **Register once per agent, on the agent layer** — the same layer every
   shadowing tool already lives on. The four cold tools move OFF the plugin
   layer (`installPluginTools`) INTO the agent install, which completes
   synchronously before the host releases a resumed session's queued input
   (#398 contract). A resumed session that had unlocked the tools sees them
   from its first turn.
2. **The gate is dispose-after-registration, not register-on-discovery.**
   Registration always happens; the persisted discovery state then decides
   whether the definitions stay. Failure direction is chosen deliberately:
   an unreadable/corrupt state keeps the tools registered (fail open) —
   the gate saves tokens, and its failure mode must never be a missing tool
   (#418 restated).
3. **The unlock persists in `configDir()/discovered-tools.json`**, NOT in the
   hash store: the gate is read at `agent/created` time outside any workspace
   scope, while an unlock write happens inside a tool call inside one. The
   hash store resolves per workspace and the two writes would land in
   different databases. The discovery state is a per-user model preference,
   not file data — it sits beside the settings, global by design.
4. **A resident discovery entry, `hashline_tools`, is the only door.** It is
   itself never gated (a cold discovery tool leaves nothing to discover
   through). Calling it persists the unlock and re-registers the four tools;
   the host re-assembles the wire surface every step, so they appear at the
   model's next step without a restart — the same behavior the
   `require_line_content` flip has ridden since #75.
5. **The entry's description is the guidance.** There is no runtime fallback
   for a model that calls a still-cold tool by name: the host answers
   `UNKNOWN_TOOL` and the plugin cannot rewrite that message. The entry's
   description says so in-schema ("if you call one of them before unlocking,
   the call fails with UNKNOWN_TOOL — call this tool first").

## Consequences

- A fresh session's surface drops by 1,847 tokens (36% of the measured
  surface); `benchmark/schema-tokens.mjs` counts the RESIDENT surface and
  gates it in CI, so the number is now pinned.
- The unlock is one tool call, then permanent for the session key (it
  survives restarts; it does not survive the user deleting the state file,
  which is the documented reset path).
- The cold tools are no longer visible before unlocking, including to models
  that know their names from training. The entry description is the mitigation
  (§ Decision 5); if that proves insufficient in practice, the fallback is a
  settings switch to force the cold tools resident, not a probe.
- Per-agent gating means the cold tools are re-registered per agent — the
  plugin-layer "register once" saving for these four is traded away on
  purpose: residency is per session by definition.
