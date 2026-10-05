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
A per-session agent composition. Since dsh 0.1.7 presets are declared and installed by plugin bundles (the shipped ones — `standard`, `ptc`, `minimal`, `cordis` — ride the harness's own web bundle; the 0.1.6 user-authored `agent.cordis.yml` directory presets are gone). The unit guidance overrides are keyed by; the plugin reads the agent's preset id at `agent/created` (dsh ≥ 0.1.6; the legacy `agent/session-start` is still registered for older harnesses) via `agentPresets.composedPreset`.
_Avoid_: roster (the 0.1.6 `agent.cordis.yml` term)

**Reset**:
Restoring the compiled default guidance and order for an override file. Triggered by emptying an override file without a front-matter fence, deleting it, or deleting its whole `<preset>/` directory: the plugin renders the compiled default at session-start and re-seeds at next boot — shipped presets always re-seed; a deleted custom-preset override stays absent (absence is no override).
_Avoid_: restore, regenerate, "recover the default prompt"

**`op`**:
One of `"ins"` | `"del"` | `"replace"` | `"sed"` — the semantic of one `edits[i]` entry in the `edit` tool payload. `ins` inserts `lines` after `anchor_after` (the anchor line's content is preserved); `del` deletes `anchor_start` (single line) or the `anchor_start..anchor_end` range; `replace` swaps that range (single-line: pass the same anchor twice) for `lines` — required and non-empty (`[""]` clears to the empty line, which is not a delete); `sed` rewrites the `anchor_start..anchor_end` range line by line with `pattern`/`replacement`/`flags` — `lines` is forbidden and the range's line count never changes.

**`anchor_start` / `anchor_end`**:
The line-range anchors of one `edits[i]` entry — variable-length Base62 markers (shortest-first: 2 chars up to 3,844 lines, `2:anchor` accepted as a weak line-number hint) copied from the leftmost column of a read/grep/diff row, never hand-written or line content. `anchor_start` is required; `anchor_end` is optional (single-line when omitted) and REQUIRED for `op: "replace"`. The legacy `line#hash` form (`12#ve7`) is rejected (`E_BAD_REF`).
_Avoid_: `from` / `to` (design-era names), `remove_from` / `remove_to` (0.3-era names), standalone `start` / `end` (reserved for byte offsets elsewhere in the plugin)

**`lines`**:
An array of strings — the new content applied by `op: "replace"` and `op: "ins"`: required and non-empty for both, forbidden for `op: "del"`. **One element is ONE line**; only an element that itself carries a newline becomes several, and no input may change the line count silently. Use `[""]` to clear a single line to empty (the line still exists — distinct from `del`).
_Avoid_: text, content, replacement, `replacement_text` (the pre-0.4 name)

**`edits`**:
An array of `{op, anchor_start, anchor_end?, lines?}` entries — the payload of the single `edit` tool call, applied atomically against one file snapshot (overlapping ranges are rejected, `[E_BATCH_CONFLICT]`). The top-level `path` is the default file; each entry's optional `path` overrides it for that entry only (multi-file dispatch). `path` itself is tool-level, not edit-level, so it is not glossary-defined here.
_Avoid_: patches, modifications, replacements (plural); `batch_edit` (the removed 0.3-era tool)

**declared line (`line`)**:
With `require_line_content` enabled, each anchor in an `edits[i]` entry becomes a `{ anchor, line }` pair — `line` is the caller's declaration of the anchor line's CURRENT full text (single line, verbatim; trailing whitespace and a copied read-row marker prefix are tolerated). Every declaration is verified after the served-staleness check and before anything applies; a mismatch rejects the whole call (`E_CONTENT_MISMATCH`). With the switch off, declared lines do not exist and anchors are plain markers.
_Avoid_: expected content, content echo, `line_content`, confirmation text

**Anchor entry point**:
The designated single path for anchor markers — allocation and release both run through it, and no other code mints anchors. It replaces the four separate retrieval APIs (`anchorsFor` / `allocateForLines` / `updateAnchorsAfterEdit` / `anchorsPure` as separate entry points): allocation now happens in exactly two primitives, `anchorFor` (allocate + record served, one transaction) and `probeLines` (the editability verdict, read-only), both in `domain/session/anchor-entry.ts`. The remap path still mints for a hunk's fresh lines, and it takes the same avoid-set as every other allocation. Allocation happens in exactly three situations: a line's first serve, a line whose content actually changed, or a line whose content changed by an external modification discovered on re-read.
_Avoid_: anchorsFor / allocateForLines / updateAnchorsAfterEdit / anchorsPure as separate entry points

**Served**:
A line of a file that the model has seen in a tool result (read, grep, edit diff, write preview, echo, lsp, ast). Scoped to ONE session — the session's persisted served set holds the anchors it has seen; another session's sightings are invisible. Serving is also what triggers allocation, and only model-visible rows are ever served.
_Avoid_: observed (fs-level event), cached, all sessions' sightings

**Editability**:
An anchor may be written with only when the line's current anchor is in THIS session's served set and that anchor is still live for the current content (a changed line mints a new anchor, so the old one is no longer in the set). A line this session has never seen is rejected however valid its anchor is in another session. The model's declared line number is informational only — a drifted line number never causes a rejection.
_Avoid_: permission, ownership, write access

**Inheritance**:
On a rewrite or external change, prior anchors are diffed line-by-line (contentKey alignment) instead of recomputed — unchanged lines keep their anchors; only genuinely new content allocates; deleted lines release theirs. Supersedes the spec §4.4 recompute-on-mismatch tradeoff.
_Avoid_: re-allocation, full recompute, refresh

**Allocation**:
An anchor identity bound to one line of one file. Scoped to a workspace and a file — NOT to a session: a session that allocates for a line leaves an anchor every later session can reuse without recomputing. A line gets at most one anchor at a time.
The workspace × file scope is the DESIGN target of the map; today the store is per-workspace and the reading session supplies the file's content.
_Avoid_: served (that is what the model has seen), assigned, minted, generated

**Exclusivity**:
One live anchor names at most one line of its file. The binding is one row per line in the persisted anchor row family, and the model holding a stale binding is refused with an echo of the current one, never silently relocated.
_Avoid_: uniqueness (weaker — says nothing about the binding)

**Double-booking**:
The forbidden state where one anchor string is live on multiple lines of the same file — the mechanism behind the silent wrong-line edit incident. Structurally refused (`E_ANCHOR_AMBIGUOUS`) rather than resolved by first occurrence.
_Avoid_: collision (that is the allocator's normal probe path), duplicate hash

**Reject-and-serve**:
A rejected edit echoes the current lines as served rows with fresh, immediately usable anchors — the fix is take-the-marker-and-resubmit, never re-read-from-scratch. The rejection is the recovery path, not a dead end.
_Avoid_: error-only rejection, retry-with-re-read

**Release pool**:
The anchors freed during one `edit` call — by deletion, or by replacement of a line whose content changed. Freed anchors enter an IN-MEMORY, per-file set for the remainder of that call: the allocator may not hand them to any other line, however good the natural slot. The set is discarded when the call ends, so the anchors become allocatable again on the next call. Bounded by one round's releases — never a permanent retired set. ENFORCED by the used-set every allocate-capable path builds: **the file's live `anchor_lines` rows ∪ this call's pool** (`allocationUsedSet`), with no third source — anchors are file-scoped, so another file's anchors are neither an obstacle nor a source. The remap path mints for a hunk's fresh lines too, so it takes the same set; minting without it could re-issue an anchor the same call just released (§9 invariant 5).
_Avoid_: retired set, tombstones, permanent exclusion (the pool is per call and discarded)

**Remap**:
Moving an anchor to a different line number while keeping its identity — what an insertion or deletion does to every anchor below it. Distinct from reallocation (a new identity) and from re-hash (recomputing the identity of unchanged content); a remap never changes which anchor names which content.
_Avoid_: realign (that is the content-pairing step), shift (too narrow — covers the arithmetic only), reallocate

**Echo**:
The rows a rejection returns with their currently valid anchors, so the model can resubmit with fresh markers instead of re-reading the file. An echo allocates for the rows it shows, and it is the only recovery path a rejected edit needs.
_Avoid_: error dump, retry prompt

**Structured error value**:
The success-shaped value a tool's `execute` returns after catching one of its own domain errors — minimal `{ modelText, error }` inside the tool's output schema instead of a throw; the model reads the same `[E_*]` text as before, and the client renders the error card from the persisted `error`.
_Avoid_: error result (`isError: true` is host vocabulary), thrown error, error return value

**`meta.error`**:
The single error object persisted in presentationMeta when a call changed **nothing** — `{ code, message, path?, context?, hint? }`. One failure carries one error. When only some of a multi-file call's files landed, the call is not an error: those files travel in the parallel `failures` list instead. Unrelated to the `errors` array field of edit's JSON success shape (soft per-item notes there, not failures).
_Avoid_: `errors` (plural — that is the JSON success shape's field), ErrorMeta as a model-facing term

**Partial failure**:
A multi-file `edit` in which at least one file landed and at least one was rejected. The card keeps the successful files as diff tabs, adds one red-dotted tab per failed file, and puts a single `role="alert"` banner above the strip ("N of M files failed"); the row itself stays a success, because changes were applied. `meta.error` and `meta.failures` are mutually exclusive and together exhaustive: a call either changed nothing (one `error`) or changed something (a `failures` list, or neither key).
_Avoid_: failure list (that is the model-side `fail[]` array, brackets and all), partial error

**Domain error (域错误)**:
A failure carrying an `[E_*]` code from the tool's own vocabulary (`E_STALE`, `E_BAD_SHAPE`, `E_BATCH_ABORT`, …). The only kind converted into a structured error value; aborts, sandbox denials and unexpected crashes rethrow to the host untouched.
_Avoid_: any failure, host error, framework error

## Segmented responses

**Per-response budget**:
The UTF-16-code-unit ceiling on one tool response's model text (default 48,000, `max_response_chars`). Flow control, never a refusal — oversized results spill instead of being refused.
_Avoid_: read budget, scan budget (the retired refusal-era terms), max tokens

**Segment**:
One response's worth of a larger result — assembled whole-line (a line is never cut), sections/matches kept intact when they fit, continuation pieces repeating their section header.
_Avoid_: chunk, page, slice, batch

**Spill**:
The session-scoped temp file holding the part of an oversized result that was not returned, written incrementally as the scan proceeds; the source a resume serves from.
_Avoid_: overflow dump, cache, temp store

**Resume token**:
The opaque handle a truncated result carries — a random id bound to a sidecar state file (session, consumer tool, spill file, cursor, version stamps). Consumed via a `resume` parameter; read-only tools consume their own, read consumes every mutating tool's report segment.
_Avoid_: continuation id, spill path (never exposed), cursor

**Version stamp**:
The per-file identity recorded when a spill is written and re-checked when a resume is served (snapshot id first, mtime+size fallback); a mismatch raises the modified-file caution.
_Avoid_: mtime check, file hash, staleness token

## Read windows

**Window**:
The line range one `read` actually served — `window: {start, end, totalLines}` in the JSON value and in the card's `presentationMeta`, with `start`/`end` always **file** line numbers (the anchor ledger), never offsets local to the response. Absent when nothing was served (an offset past the end); an empty file's window is `{1, 1, 1}`.
_Avoid_: page, viewport, slice

**Anchor cursor**:
An `offset`/`limit` given as a live anchor instead of a number: it names the window's first / last line (a closed range), so a continuation survives renumbering. Mixable with numbers; an inverted range is `[E_BAD_SHAPE]`, a dead anchor `[E_STALE]`.
_Avoid_: anchor marker (that is the row prefix handed back to `edit`), line hint

