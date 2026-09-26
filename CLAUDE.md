# dsh-hashline-edittool — notes for Claude Code

A DeepSeek Harness (`dsh`) plugin: hashline-anchored `read`/`edit`/`write`/`grep`/`undo_last_edit` tools, `ast_grep`/`ast_edit`/`lsp`, and per-preset guidance overrides. TypeScript, vitest.

## This file is a thin pointer

The canonical agent entry point is [`AGENTS.md`](AGENTS.md): project identity,
critical rules, verification requirements, and the knowledge map. Read it first —
this file exists only for Claude-specific tooling notes and must not grow a
second copy of those rules.

- **Checks:** `npm run typecheck`, `npm test`, `npm run build`
- **Release & publish:** [`docs/workflows/release.md`](docs/workflows/release.md)
- **Git flow** (branch → PR, `Closes #NN`): [`.agents/skills/git-std.md`](.agents/skills/git-std.md)
- **GitHub issues** via `gh`: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- **Knowledge changes** are logged in [`docs/CHANGELOG-MEMORY.md`](docs/CHANGELOG-MEMORY.md)
