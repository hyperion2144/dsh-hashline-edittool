# dsh-hashline-edittool

Hash-anchored read/edit/grep/undo_last_edit tools for DeepSeek Harness (dsh). This context covers the plugin's model-facing vocabulary: what its tools are and how the text the model reads is configured.

## Language

**Prompt section**:
A named unit in dsh's `systemPrompt` registry — one of `tool:read`, `tool:edit`, `tool:grep`, `tool:undo_last_edit` — carrying a name, an `order`, and rendered text. Registered per agent on the agent's own scope layer, so it shadows the preset's built-in section of the same name.
_Avoid_: prompt, prompt entry

**Guidance**:
The editable prose of a prompt section — the usage instructions the model reads. Overridable per preset; the compiled defaults live in `src/prompts.ts`.
_Avoid_: prompt, instructions ("instructions" is `dsh-agent-instructions`' term for AGENTS.md content), guidelines (the legacy `*_GUIDELINES` constant names in `src/prompts.ts` — unify on "guidance")

**Override file**:
A `<preset>/<section>.md` plain-markdown file in the plugin's shared home that overrides one prompt section's guidance and (optionally) its `order` via front-matter. The unit users edit and reset — distinct from the preset, which is a roster composition.
_Avoid_: preset ("the preset file" is the composition row, not this override file), custom prompt

**Order**:
The numeric ordering of a prompt section within the assembled system prompt. Overridable alongside guidance.

**Preset**:
A per-session agent composition from the dsh roster (`agent.cordis.yml` plus metadata, system- or user-authored). The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/session-start` via `agentPresets.composedPreset`.

**Reset**:
Restoring the compiled default guidance and order for an override file. Triggered by emptying an override file without a front-matter fence, deleting it, or deleting its whole `<preset>/` directory: the plugin renders the compiled default at session-start and re-seeds at next boot — shipped presets always re-seed; a deleted custom-preset override stays absent (absence is no override).
_Avoid_: restore, regenerate, "recover the default prompt"

**`op`**:
One of `"ins"` | `"del"` | `"replace"` — the semantic of one `edits[i]` entry in the `edit` tool payload. `ins` inserts `lines` after `anchor_start` (the anchor line's content is preserved); `del` deletes `anchor_start` (single line) or the `anchor_start..anchor_end` range; `replace` swaps that range (single-line: pass the same anchor twice) for `lines` — required and non-empty (`[""]` clears to the empty line, which is not a delete).
_Avoid_: edit type, edit kind, action, edit mode

**`anchor_start` / `anchor_end`**:
The line-range anchors of one `edits[i]` entry — `line#hash` markers (`<line>#<hash>` like `12#ve7`) copied from the leftmost column of a read/grep/diff row, never hand-written or bare hashes. `anchor_start` is required; `anchor_end` is optional (single-line when omitted) and REQUIRED for `op: "replace"`.
_Avoid_: `from` / `to` (design-era names), `remove_from` / `remove_to` (0.3-era names), standalone `start` / `end` (reserved for byte offsets elsewhere in the plugin)

**`lines`**:
An array of strings — the new content applied by `op: "replace"` and `op: "ins"`: required and non-empty for both, forbidden for `op: "del"`. Use `[""]` to clear a single line to empty (the line still exists — distinct from `del`).
_Avoid_: text, content, replacement, `replacement_text` (the pre-0.4 name)

**`edits`**:
An array of `{op, anchor_start, anchor_end?, lines?}` entries — the payload of the single `edit` tool call, applied atomically against one file snapshot (overlapping ranges are rejected, `[E_BATCH_CONFLICT]`). The top-level `path` is the default file; each entry's optional `path` overrides it for that entry only (multi-file dispatch). `path` itself is tool-level, not edit-level, so it is not glossary-defined here.
_Avoid_: patches, modifications, replacements (plural); `batch_edit` (the removed 0.3-era tool)
