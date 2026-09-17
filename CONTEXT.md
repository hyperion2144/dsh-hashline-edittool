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
A per-session agent composition from the dsh roster (`agent.cordis.yml` plus metadata, system- or user-authored). The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/created` (dsh ≥ 0.1.6; the legacy `agent/session-start` is still registered for older harnesses) via `agentPresets.composedPreset`.

**Reset**:
Restoring the compiled default guidance and order for an override file. Triggered by emptying an override file without a front-matter fence, deleting it, or deleting its whole `<preset>/` directory: the plugin renders the compiled default at session-start and re-seeds at next boot — shipped presets always re-seed; a deleted custom-preset override stays absent (absence is no override).
_Avoid_: restore, regenerate, "recover the default prompt"

**`op`**:
One of `"ins"` | `"del"` | `"replace"` | `"sed"` — the semantic of one `edits[i]` entry in the `edit` tool payload. `ins` inserts `lines` after `anchor_after` (the anchor line's content is preserved); `del` deletes `anchor_start` (single line) or the `anchor_start..anchor_end` range; `replace` swaps that range (single-line: pass the same anchor twice) for `lines` — required and non-empty (`[""]` clears to the empty line, which is not a delete); `sed` rewrites the `anchor_start..anchor_end` range line by line with `pattern`/`replacement`/`flags` — `lines` is forbidden and the range's line count never changes.

**`anchor_start` / `anchor_end`**:
The line-range anchors of one `edits[i]` entry — variable-length Base62 markers (shortest-first: 2 chars up to 3,844 lines, `2:anchor` accepted as a weak line-number hint) copied from the leftmost column of a read/grep/diff row, never hand-written or line content. `anchor_start` is required; `anchor_end` is optional (single-line when omitted) and REQUIRED for `op: "replace"`. The legacy `line#hash` form (`12#ve7`) is rejected (`E_BAD_REF`).
_Avoid_: `from` / `to` (design-era names), `remove_from` / `remove_to` (0.3-era names), standalone `start` / `end` (reserved for byte offsets elsewhere in the plugin)

**`lines`**:
An array of strings — the new content applied by `op: "replace"` and `op: "ins"`: required and non-empty for both, forbidden for `op: "del"`. Use `[""]` to clear a single line to empty (the line still exists — distinct from `del`).
_Avoid_: text, content, replacement, `replacement_text` (the pre-0.4 name)

**`edits`**:
An array of `{op, anchor_start, anchor_end?, lines?}` entries — the payload of the single `edit` tool call, applied atomically against one file snapshot (overlapping ranges are rejected, `[E_BATCH_CONFLICT]`). The top-level `path` is the default file; each entry's optional `path` overrides it for that entry only (multi-file dispatch). `path` itself is tool-level, not edit-level, so it is not glossary-defined here.
_Avoid_: patches, modifications, replacements (plural); `batch_edit` (the removed 0.3-era tool)

**declared line (`line`)**:
With `require_line_content` enabled, each anchor in an `edits[i]` entry becomes a `{ anchor, line }` pair — `line` is the caller's declaration of the anchor line's CURRENT full text (single line, verbatim; trailing whitespace and a copied read-row marker prefix are tolerated). Every declaration is verified after the served-staleness check and before anything applies; a mismatch rejects the whole call (`E_CONTENT_MISMATCH`). With the switch off, declared lines do not exist and anchors are plain markers.
_Avoid_: expected content, content echo, `line_content`, confirmation text

**Lifecycle gate (`anchorsFor`)**:
The single path through which anchors are allocated or released — every tool's marker column comes from it, and no other code mints anchors. Allocation happens in exactly two situations: a line's first serve, or a line whose content actually changed.
_Avoid_: lineHashes as a second source, per-tool anchor computation, `anchorsPure` in production paths

**Served**:
A row the model has SEEN in a tool result (read, grep, edit diff, write preview, lsp, ast). Served rows are recorded in the session's served mirror and only served rows are editable; serving is also what triggers first-serve allocation.
_Avoid_: observed (that is the fs-level event name), cached, known

**Inheritance**:
On a rewrite or external change, prior anchors are diffed line-by-line (contentKey alignment) instead of recomputed — unchanged lines keep their anchors; only genuinely new content allocates; deleted lines release theirs. Supersedes the spec §4.4 recompute-on-mismatch tradeoff.
_Avoid_: re-allocation, full recompute, refresh

**Exclusivity**:
One live anchor names at most one line of its file. Enforced by the allocator's occupied set and the served mirror's single-ownership purge; the model holding a stale binding is refused, never silently relocated.
_Avoid_: uniqueness (weaker — says nothing about the mirror)

**Double-booking**:
The forbidden state where one anchor string is live on multiple lines of the same file — the mechanism behind the silent wrong-line edit incident. Structurally refused (`E_ANCHOR_AMBIGUOUS`) rather than resolved by first occurrence.
_Avoid_: collision (that is the allocator's normal probe path), duplicate hash

**Reject-and-serve**:
A rejected edit echoes the current lines as served rows with fresh, immediately usable anchors — the fix is take-the-marker-and-resubmit, never re-read-from-scratch. The rejection is the recovery path, not a dead end.
_Avoid_: error-only rejection, retry-with-re-read
