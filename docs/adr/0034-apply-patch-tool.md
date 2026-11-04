# ADR-0034 — the `apply_patch` tool: one change set per call, a whole-patch preflight, and a commit that stops instead of rolling back

Status: Accepted (2026-11-03)
Map: [#401](https://github.com/hyperion2144/dsh-hashline-edittool/issues/401)
Prototype: [#409](https://github.com/hyperion2144/dsh-hashline-edittool/issues/409)
Spec: [`docs/specs/apply-patch-spec.md`](../specs/apply-patch-spec.md)

## Context

`edit` already takes several files (each entry carries its own `path`), but it
cannot **add**, **delete** or **move** a file: those are three more tools and
three more confirmations. And `edit`'s atomicity is **per file** — a change set
that spans files has no single gate today, so file A can land while file B is
rejected. On top of that, the model pays a planning cost per tool call: one
"here is the whole change" call is cheaper than a sequence that must be
ordered correctly.

The tempting move is to extend `edit` (the spec's shape B: give `edit` an
`add` / `move` / file-level `del` entry). It was rejected, because the two
tools want incompatible failure models:

- `edit`'s contract is **per-file atomicity with partial success across
  files**: one file's batch is all-or-nothing, while the other files in the
  same call may land or fail independently (ADR-0003).
- A change set wants **whole-patch refusal** before anything is written, and
  then a commit that runs in order, stops at the first failure, and rolls
  nothing back.

One tool cannot honestly promise both: the same call shape would have to mean
"nothing at all happened" in one phase and "half of it happened" in the other.
So `apply_patch` stays a **separate tool**, and `edit` keeps its per-file
batch. Single-file anchored surgery stays `edit`; `delete` / `rename` stay for
exactly their one job; `write` stays for a whole file.

## Decision

1. **A separate tool with one parameter.** `apply_patch` takes `patch: string`
   and nothing else. It is not a replacement for `edit`, not a directory/glob
   operation, not a binary-file operation, and not a rollback engine.

2. **Grammar A′ — file sections + anchor hunks.** A patch is a sequence of
   **file sections**: `file <path>` (update), `new <path>` (create),
   `move <from> -> <to>`, `remove <path>` (delete). Inside a section sit
   **anchor hunks**: `replace <anchor>` / `replace <start>..<end>`,
   `insert <anchor>`, `delete <anchor>` / `delete <start>..<end>`. Every
   content line is `+`-prefixed, so a section header is the only thing that can
   appear un-prefixed and the content/next-header boundary is unambiguous — a
   content line may contain the words `file`, `replace` or `---` because it is
   always behind the `+`.

3. **The patch never copies old content.** A hunk addresses a line by an
   anchor the session already holds (from its read/grep/diff rows); there is
   no old-content line to restate. The served set stays the source of truth,
   so a stale or unserved anchor is refused at preflight instead of being
   silently re-based on a copy of the text. The price is that the model must
   have read the file; the gain is that it never echoes the code it is
   replacing, and that a hunk can only touch a line it has actually seen.

4. **Two phases: a whole-patch preflight, then a commit that stops.** The
   preflight runs **every** check (syntax, shape, paths, anchors, sandbox) and
   collects **every** failure — no short-circuit — into one refusal value
   (each problem names its operation, kind, path and patch line; the list is
   truncated after ten entries). A refused patch writes nothing. The commit
   then runs the operations **in patch order** and **stops at the first
   failure**; the stopped commit is a *success-shaped* value that reports the
   completed, failed and skipped operations truthfully, and **nothing is rolled
   back**. A rollback engine is explicitly out of scope.

5. **Default on, and the same name shadows the official implementation.**
   `apply_patch.enabled` defaults to **true** — an explicit `false` removes
   the tool *and* its guidance section. The official `@deepseek-ai/dsh-tool-fs`
   may ship a same-named `apply_patch`; exactly one wins. The plugin probes
   the registry once per plugin context (the `lsp` pattern, ADR-0032): a
   **foreign** same-name tool registered farther out means we register on the
   **agent layer**, which is nearer and therefore shadows it; with no foreign
   same-name tool (or an unanswerable registry) we register **once on the
   plugin layer**, so every agent has the tool from its first turn. Our own
   definition is remembered, so a later probe never mistakes ours for a
   built-in.

6. **One guidance section.** The section is named `tool:apply_patch`, its
   override file is `apply_patch.md`, and its default order is **136** (right
   after `rename` 135). The compiled default text — the grammar in one line
   plus the five rules the model cannot guess — lives in
   `src/domain/edit/prompts.ts` as `APPLY_PATCH_GUIDANCE` and is overridable
   per preset like every other section.

## Alternatives considered

- **Extend `edit`'s JSON with `add` / `move` / file-level `del`** — rejected:
  the failure models conflict (see the Context). Making `edit`'s partial
  success whole-call would rewrite a published contract for every existing
  caller, and making the patch per-file would give away the single gate the
  change set needs.
- **Copy the Codex envelope** (`*** Begin Patch` / `*** Update File:` /
  `-` old-content lines) — rejected: the envelope is a second grammar layered
  on ours (one tool, one shape), and old-content lines are pure cost — the
  anchor already addresses the line. This was prototype v1 (`05b7cda`),
  rejected on 2026-11-03; A′ is the accepted grammar.
- **A hashline line DSL** (`Ab replace` + `|` content) or a sigil instruction
  table (`= Ab …` / `+ Gh …`) — rejected: both make the content/next-header
  boundary "a line that does not start with the sigil", the very fragility
  the `+` prefix removes; invented sigils also mean nothing to a reader of
  `edit`.
- **Register on the plugin layer unconditionally and let the official tool
  win the name** — rejected: the anchors, the served set and the store are this
  plugin's contract, and the guidance section describes exactly that contract;
  a foreign implementation would own the name the guidance talks about.
- **Default the tool off (opt-in)** — rejected: the tool is purely additive,
  and leaving it off taxes every multi-file change with extra planning; an
  explicit `false` is a complete opt-out.

## Consequences

- A multi-file change is one call, one gate and one answer: the model either
  gets the whole change set applied, or a single refusal that lists every
  problem at once.
- The failure semantics are now two different shapes in one tool — a refusal
  (an error) and a stopped commit (a success-shaped value) — so the model
  must read the outcome, not just the exit status. The output contract makes
  that explicit (`error` exists only for a refusal).
- A stopped commit leaves the workspace partially changed on purpose. The
  model's recovery is to re-read the affected files and re-issue the remainder;
  there is no undo for the patch as a whole (each completed file operation
  still pushes its own undo layer, exactly like `edit`).
- `apply_patch` is offered by default, so the tool surface grew for every
  user; `apply_patch.enabled: false` is the switch that removes it, together
  with its guidance section.
- The name collides on purpose with the official `apply_patch`: ours wins, and
  the layer that carries it depends on whether a foreign same-name tool is
  present (ADR-0032) — a moving target we answer at install time rather than
  at build time.
- `require_line_content` and `write.preview` are **ignored** by the patch: A′
  has no declaration slot, and the patch's own diff is its preview.

## References

- Spec: [`docs/specs/apply-patch-spec.md`](../specs/apply-patch-spec.md)
  (grammar A′, execution contract, store contract, registration and guidance)
- ADR-0003 (`edit`'s multi-file atomicity — the model this tool does NOT copy)
- ADR-0006 (anchor lifecycle: unchanged lines keep their anchors, changed ones
  mint new ones)
- ADR-0024 (the `rename` tool — the path-migration machinery a `move` section
  reuses)
- ADR-0032 (tool registration layers — agent layer to shadow, plugin layer
  otherwise)
- ADR-0022 (the toolview takeover priority the diff card reuses)
