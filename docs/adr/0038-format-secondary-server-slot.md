# ADR-0038 — The formatting secondary slot: one language, two servers (decision C of #290)

> **Status**: Accepted (2026-11-11; direction decided on [#290](https://github.com/hyperion2144/dsh-hashline-edittool/issues/290) — C preferred, A the recorded fallback). Amends [ADR-0019](0019-format-tool-contract.md), whose format layer this decision routes, and revisits the one-slot-per-language model the LSP manager has kept since its introduction.
> Implementation: [#424](https://github.com/hyperion2144/dsh-hashline-edittool/issues/424) (role-keyed slots + settings + routing) · [#425](https://github.com/hyperion2144/dsh-hashline-edittool/issues/425) (formatter-only catalog entries + docs) · [#426](https://github.com/hyperion2144/dsh-hashline-edittool/issues/426) (real-server smoke).

## Problem Statement

R1 ([#276](https://github.com/hyperion2144/dsh-hashline-edittool/issues/276)) and the real-server smoke behind [#288](https://github.com/hyperion2144/dsh-hashline-edittool/pull/288) confirmed a domain fact: in LSP, type/diagnostic service and formatting are two independent capabilities. pyright advertises no `documentFormattingProvider` at all, rust-analyzer advertises `false` and answers `-32600`, and bash-language-server and csharp-ls carry no formatter either — while the manager is strictly ONE slot per language: `#slots` is a plain `Map<languageId, Slot>`, and `readySessionFor(languageId)` / `waitForSession(languageId, …)` hand that single session to every caller, formatting included. A python user running pyright therefore gets silence from `format.auto` (G3: a capability boundary, never a failure) and `[E_FORMAT_UNSUPPORTED]` from the manual tool — and the only escape today is re-pointing `lsp.servers.python` at a server that has a formatter, which REPLACES the type server and forfeits diagnostics. `-32601` is the field's normal signal that a server has no formatter (R1), not a bug to route around.

## Decision

**Decision C — a per-language formatting slot, opt-in through settings; the primary slot never moves.**

1. **New setting `format.servers.<languageId>`**, mirroring `lsp.servers.<id>` in shape and discipline: a NAMED server is not a running one, an entry may name a command that does not exist, the value is read once into the effective settings snapshot, and a garbage value falls back to absence. (The ticket's `format.server` shorthand resolves to this plural form so the two override namespaces read as siblings.)
2. **Slots become role-keyed.** The slot key gains a role axis defaulting to `primary`; every existing caller — diagnostics, completion, hover, navigation, document sync, the status card, `decide` — is untouched and never sees the format role. A format slot exists only when the setting names a secondary; no setting, no second process.
3. **Only formatting resolves it.** The two format surfaces — the manual `format` tool (`waitForSession`, cold start allowed) and the automatic pass (`readySessionFor`, ready-only; G3's never-warm rule intact) — look up the format role when present and otherwise follow today's path byte-for-byte. Capability semantics are unchanged: a named secondary that itself lacks a formatter still answers `[E_FORMAT_UNSUPPORTED]`, with the error text now suggesting `format.servers.<id>` as the fix.
4. **Shared lifecycle.** Both surfaces resolve the slot through the same role-aware manager lookup, so they cannot drift. The format slot joins idle reaping and the failed-slot retry backoff ([ADR-0021](0021-lsp-failed-slot-retry.md)); it publishes no diagnostics, so [ADR-0030](0030-diagnostic-freshness.md) has nothing to say about it.
5. **The LSP server catalog may carry formatter-only entries** (`KNOWN_SERVERS`, e.g. `ruff-lsp` for python) so the card can offer installing a secondary the way it offers primaries.

**Fallback: decision A (full multi-slot capability routing).** If one formatter-only secondary proves insufficient — a language needing more than two concurrent servers, or formatter-only primaries — this ADR is revisited toward routing every request by advertised capability. **Rejected: decision B** — its escape hatch (point the primary at a formatter-bearing server) is exactly the capability loss C exists to remove.

## Consequences

- Python-with-pyright stops being a dead end: `format.auto` formats through the secondary while diagnostics keep coming from pyright.
- The unconfigured path is invariant: every existing test, error text and card view keeps its meaning; the settings surface gains one map.
- Two processes per language is a real resource cost — accepted because the format slot exists only when explicitly named, and the idle reaper bounds both.
- `[E_FORMAT_UNSUPPORTED]` guidance changes once (#424); `README.md` / `README.zh.md` gain the `format.servers` group (#425).
