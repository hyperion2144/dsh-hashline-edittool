---
title: "ADR-0042: The prompt surface layers into description, schema fields, and guidance sections"
type: decision
status: Accepted
date: 2026-11-20
issue: 447
supersedes: ""
---

# ADR-0042: The prompt surface layers into description, schema fields, and guidance sections

## Context

The #447 report: with the plugin installed, models still inspected files
through `bash` grep/cat and then edited with invented anchors, and submitted
multi-line ranges whose middle lines they had never read. Two causes, both
prompt-side:

1. **The text taught the wrong thing first.** Tool-schema descriptions led
   with mechanics — row formats, batch semantics, error-code enumerations —
   and never said what a tool is for. The anchor discipline lived as one
   bullet buried mid-list in `tool:edit`, with no statement that anchors
   exist only in tool returns, that shell output has no anchors and is not
   observed, or that a multi-line range must be fully served before an edit.
   Five tools (`write`, `ast_grep`, `ast_edit`, `lsp`, `format`) had no
   injected section at all.
2. **Most sections never reached the model.** The agent-install loop that
   shadows the preset's built-in `tool:*` sections lost its default branch
   in #413 (map #401): only `tool:edit` — and `tool:apply_patch` behind its
   own switch — were registered. `tool:read`, `tool:grep`,
   `tool:undo_last_edit`, `tool:delete` and `tool:rename` resolved,
   seeded override files, and were then dropped on the floor, so the model
   kept reading dsh's built-in guidance for those tools. Nothing asserted
   the registration, so the regression survived three releases.

## Decision

The prompt surface is a three-way layering; each layer answers exactly one
question, and a semantic is stated in one layer only:

1. **Tool-schema `description`** — what is this tool for. First sentence
   purpose, at most one following contract sentence. No code blocks, bullet
   lists, all-caps emphasis, `[E_*]` enumerations, or row-format legends.
2. **Per-field schema `description`s** — the mechanical reference: op
   shapes, range rules, defaults, constraints, one sentence per field,
   every field covered (the traversal test enforces coverage; array
   `items` nodes count as fields, `oneOf` alternatives are covered by the
   enclosing field).
3. **Injected guidance sections** — the behavioral discipline. One section
   per tool plus a cross-tool `anchors` section that is the single home of
   the anchor rules: anchors only from tool returns (never derived from
   line numbers, content, or memory), shell output is not observed, the
   grep → read → edit workflow with echo-retry, and multi-line ranges read
   through before submitting. Each section renders as an intro plus at
   most five bullets, with no error-code tables.

Supporting decisions:

- The default registration branch is restored: every resolved section is
  registered on the agent layer (edit and apply_patch keep their
  rebuild/switch paths), and `agent-tool-registration.test.ts` pins the
  full section list so the #413 regression cannot return silently.
- `ToolGuidance` moved to the contract layer so any domain can type its
  section text; per-domain guidance modules (`write`, `format`, `ast`,
  `lsp`) and the cross-tool `guidance/anchors.ts` own their texts.
- End-to-end "does the model now behave" checks are manual/real-session
  verification (2026-11-20 decision); CI asserts the static contract in
  `prompt-contract.test.ts`.
- **The guidance document layer was removed** (PR #448 review): the plugin
  no longer materializes per-preset `<section>.md` files, no longer reads
  them back as override sources, and no longer parses front-matter. The
  sections come only from the compiled defaults (`GUIDANCE_SECTIONS` +
  `renderDefault()`); `compiledDefaultSections()` is the single injection
  source. The seed-fingerprint refresh built on top of that layer was
  abandoned with it — the layer itself was the problem, not its refresh
  policy. Old files are left on disk (they may hold user edits) and are
  ignored; boot logs one line telling the user they can remove the
  directory. A future customization surface would be an explicit config
  option, not a document the plugin creates and reads back.

## Consequences

- Models see a purpose-first catalog and exactly one anchor-discipline
  passage instead of scattered bullets; the descriptions shrink while the
  schema fields absorb the mechanics they were duplicating.
- **Override-file compatibility:** the per-preset `<section>.md` files from
  older versions are no longer read. They are not deleted (they may hold
  user edits); boot logs one line naming the directory to remove for a
  clean tree. The injected text is always the compiled default, so a
  plugin upgrade's new wording reaches every session immediately.
- `ast-settings` wording assertions follow the layering: the read
  description still names the structure replacement, lowercase ("reads
  lines and nothing else") because all-caps emphasis is banned in
  descriptions.
