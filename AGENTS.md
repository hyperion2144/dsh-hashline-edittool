---
# AGENTS.md — dsh-hashline-edittool
# Level 0 progressive-loading entry point. Keep this file short: project
# identity, critical rules, minimal orientation, verification, navigation.
# Detailed knowledge lives in docs/ and is reached through the map below.
#
# l0_domains lets an agent decide which domain is relevant WITHOUT opening it.
# One line per domain. Domains without durable knowledge are omitted.
l0_domains:
  decisions: "ADRs 0001–0011: anchor lifecycle, error conversion, sparse + bounded anchors, alignment"
  workflows: "Release & publish procedure — tag-first, npm publish gated on the tag"
  agents: "Issue tracker, triage labels, and domain-doc conventions for the engineering skills"
  reference: "The anchor contract, tool surface, settings, error codes, DSH support (README)"
  history: "Superseded specs and research records, kept because they explain the current shape"
---

# dsh-hashline-edittool

A [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`) plugin that replaces
the built-in `read` / `edit` / `write` / `grep` tools with **hash-anchored**
versions and adds `undo_last_edit`, `ast_grep`, `ast_edit` and `lsp` on top. It
ships as one npm package: host plugin + web card plugin + prompt sections,
mounted by a single bundle patch.

## Critical rules

1. **Verify before you commit.** `npm run typecheck` and `npm test` must pass at
   the repo root, and `npm run typecheck -w client` + `npm test -w client` for
   the companion client package. CI runs the same set on Ubuntu (Node 22 + 24),
   Windows (Node 22), and the client workspace — a POSIX-only run cannot see the
   Windows path/home assumptions.
2. **PR first.** Work on a branch, open a PR against `main`, put `Closes #NN`
   (or `Part of #NN`) at the **end** of the body. A direct `main` push is for
   changes too small to justify a PR. See [`.agents/skills/git-std.md`](.agents/skills/git-std.md).
3. **Releasing is tag-first and tag-gated** — never `npm publish` before the tag
   exists, and never publish without an explicit instruction to release. Full
   procedure: [`docs/workflows/release.md`](docs/workflows/release.md).
4. **Keep the two READMEs in sync.** [`README.md`](README.md) and
   [`README.zh.md`](README.zh.md) are mirrors; a user-visible change lands in
   both. `CHANGELOG.md` entries are written in Chinese under `[Unreleased]`.
5. **Host SDK packages stay out of `dependencies`.** `@deepseek-ai/*` belongs in
   `devDependencies` (types/test) or `peerDependencies` — currently only
   `@deepseek-ai/schemastery`.
6. **Never delete a superseded document.** Mark it in place
   (`> Status: Superseded by <path>`) and leave it as the historical record;
   never leave it reading as current.

## Orientation

```text
src/        host plugin: tools/ → domain/ → render/ + contract/ → hashline/ + infra/,
            plus lsp/, ast/, guidance/          (dependencies point one way)
client/     web card plugin (npm workspace): renders every card from
            presentationMeta — the model text and the UI never parse each other
test/       vitest suite (test/core)
scripts/    release, changelog, build, diagnostics, schema verification
docs/       adr/ · workflows/ · agents/ · research/ · specs
```

The anchor contract, tool table, settings, error codes and DSH version support
are owned by [`README.md`](README.md); the domain vocabulary is owned by
[`CONTEXT.md`](CONTEXT.md). Do not restate them here.

## Memory navigation

```text
AGENTS.md (you are here, L0)
    ↓
docs/adr/                          ← decisions: why the contract is shaped this way
docs/workflows/release.md          ← the release & publish procedure
docs/agents/                       ← issue tracker · triage labels · domain-doc conventions
docs/research/                     ← measurements and investigations behind the decisions
README.md                          ← the authoritative reference for the current contract
CONTEXT.md                         ← glossary: anchor, served, inheritance, exclusivity, …
CHANGELOG.md                       ← what shipped, version by version
```

Read an ADR before changing the area it governs; if your change contradicts one,
surface it rather than silently overriding it. Knowledge changes to this memory
layer are logged in [`docs/CHANGELOG-MEMORY.md`](docs/CHANGELOG-MEMORY.md).

## Agent & skill conventions

- **Issues and specs** live as GitHub Issues on `hyperion2144/dsh-hashline-edittool`
  and are read/written with the `gh` CLI — [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- **Triage labels** keep the five canonical names — [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- **Domain docs** are single-context: one root `CONTEXT.md` plus `docs/adr/` —
  [`docs/agents/domain.md`](docs/agents/domain.md).
