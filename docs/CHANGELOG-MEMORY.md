# Memory Change Log

Audit log of changes to this repository's **Project Memory layer** (the
agent-facing knowledge system: `AGENTS.md`, `docs/` domains, and the
navigation between them). It is not the product changelog — that is
[`CHANGELOG.md`](../CHANGELOG.md).

Each entry records what changed, why, the confidence in the underlying
evidence, and the evidence paths. Entries are append-only and never rewritten.

---

## 2026-09-26 — Initial Project Memory build

**Type:** initialization + accuracy correction
**Confidence:** High
**Evidence:** `package.json`, `npm test` (113 files / 1,330 tests, exit 0),
`npm run typecheck` (root + client, exit 0), `.github/workflows/ci.yml`,
`scripts/release.mjs`, `git status` (clean), `git log`

### Why

`/project-memory` reported that this workspace already had Project Memory
(`AGENTS.md` present). That was a false positive: the command resolves the
workspace by walking up to six parent directories looking for `AGENTS.md`, and
from the repository root it landed on `/Users/mutou/AGENTS.md` — a
`code-review-graph` MCP instruction file, not Project Memory. The repository
itself had **no** `AGENTS.md`, no `docs/` domain structure, and no memory audit
log, so the correct branch was **initialization**, not audit-and-update.

The audit that followed found the existing knowledge (`README.md`,
`CONTEXT.md`, `docs/adr/`, `docs/agents/`, `CHANGELOG.md`) accurate, well
separated by lifecycle, and richly sourced — but it also found three stale
claims in the two READMEs that current files and a live test run contradict.

### Path / Affected typed relationships

- `AGENTS.md` (created)
- `docs/workflows/release.md` (created)
- `docs/CHANGELOG-MEMORY.md` (created)
- `CLAUDE.md` (reduced to a thin pointer)
- `README.md`, `README.zh.md` (three stale claims corrected)

### Changes

1. **Created `AGENTS.md`** as the single canonical Level-0 entry point, with an
   `l0_domains` map. It carries only identity, critical rules, minimal
   orientation, verification and navigation — no duplicated detail.
2. **Created `docs/workflows/release.md`**, the tag-first release & publish
   procedure, moved out of `CLAUDE.md` so one document owns it.
3. **Reduced `CLAUDE.md` to a thin pointer** at `AGENTS.md` (Option A of the
   dual-entry-point reconciliation). It previously duplicated rules that now
   have one home; two competing primaries silently diverging is the defect
   being fixed.
4. **Corrected `README.md` / `README.zh.md`:**

   | Claim | Was | Now | Contradicted by |
   | --- | --- | --- | --- |
   | Compatibility mechanism | `@deepseek-ai/dsh-settings >=0.1.2-rc.0` peer dep, "enforced by npm" | `@deepseek-ai/schemastery >=3.18.3` peer dep | `package.json` `peerDependencies`; `CHANGELOG.md` 0.9.0 "`@deepseek-ai/dsh-settings` 依赖移除" |
   | Current build/test SDK line | `0.1.6-alpha.1` | `0.1.7-alpha.1`, plugin `0.9.x` | `package.json` devDependencies (all `@deepseek-ai/dsh-*` at `0.1.7-alpha.1`); `CHANGELOG.md` 0.9.0 "仅支持 0.1.7（0.8.x 留给 0.1.6）" |
   | Test count | `1,210` | `1,330` | `npm test` — 113 files / 1,330 tests |

5. **No new Solution/Lesson units.** The engineering learnings present in the
   working tree (#187 echo allocation, #151 `ins` anchor drift, #190 bounded
   Myers, #169 sparse anchors) are already owned by `CHANGELOG.md` and
   ADR-0006 / 0009 / 0010 / 0011. Compounding them again would be semantic
   duplication.

### Not done, deliberately

- **No empty domain scaffolding.** `docs/architecture/`, `docs/solutions/` and
  `docs/lessons/` were **not** created: their content is already owned by
  `README.md`, `CONTEXT.md` and `docs/adr/`, and a domain is created only when
  it has knowledge that benefits from separate retrieval.
- **No edit to the ADR set.** All eleven ADRs are `Accepted` or `Implemented`,
  each with an identifiable issue or spec, and the superseded specs
  (`docs/dynamic-hashline.md`, `docs/line-hashline-spec.md`,
  `docs/edit-payload-spec.md`, `docs/web-ui-structured-views-spec.md`) already
  point at their replacements.

---

## 2026-09-26 — Doc-push convention recorded

**Type:** process-rule correction
**Confidence:** High
**Evidence:** maintainer instruction, 2026-09-26

`AGENTS.md` § Critical rules #2 said "PR first" and left documentation to the
vague `git-std.md` carve-out ("changes too small to justify a PR"). The
maintainer's standing rule is sharper:

- **Code changes** → branch + PR against `main`, `Closes #NN` at the end of the body.
- **Documentation-only changes** (`.md`) → pushed **directly to `main`** — no branch, no PR.
- **Neither may release.** `npm publish` always waits for an explicit instruction.

### Path / Affected typed relationships

- `AGENTS.md` — rule 2 rewritten. No other document's reading changes.

---

## 2026-09-28 — ADR-0012 recorded: `lines` is a line array (#198)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** `npm run typecheck` (root + client, exit 0), `npm test` (114 files /
1,342 tests, exit 0), `npm test -w client` (6 files / 148 tests, exit 0),
`test/core/issue-198-lines-semantics.test.ts` (new, 12 tests), live repro in
`.tmp/triage-198-*` (issue [#198](https://github.com/hyperion2144/dsh-hashline-edittool/issues/198))

### Why

Two defects in one report: (a) `lines` was flattened with `join("\n")` before the
engine saw it, so every all-blank array landed on the wrong side of the string
surface's `""` = delete marker — `[""]` deleted the line instead of clearing it,
`["",""]` lost a line, `ins` + `[""]` was a noop; (b) a diff's removal row took
its anchor from the text diff's head-first alignment, so with identical adjacent
lines it named the SURVIVOR instead of the line the engine spliced out.

The maintainer ruled the contract: in `lines`, one element is ONE line, only an
element's own newline becomes several, and no input may change the line count
silently. That is a durable, non-obvious invariant (the `"\n".repeat(n)` spelling
looks arbitrary without it) with real alternatives (carry the array deeper / change
`parseText`), so it is recorded as ADR-0012 rather than left in code comments.

### Path / Affected typed relationships

- `docs/adr/0012-lines-line-array.md` — new: the decision record.
- `AGENTS.md` — `l0_domains.decisions` now spans ADRs 0001–0012.
- `CONTEXT.md` — the `lines` glossary entry states the line rule (canonical vocabulary).
- `README.md` / `README.zh.md` — the `replace` row states it in both mirrors.
- `docs/edit-payload-spec.md` — the `[""]` bullet and the acceptance-table row.
- `CHANGELOG.md` — new `[Unreleased] → Fixed` section (in Chinese, per rule 4).
