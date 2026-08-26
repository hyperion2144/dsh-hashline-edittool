# Changelog

All notable changes to the `dsh-hashline-edittool` plugin will be documented in this file.

## [Unreleased]

### Fixed

- `edit` anchors (`remove_from` / `remove_to`) now accept a full read/grep/diff output row pasted verbatim — e.g. `12#aB3:const x = 1;` (optionally with `+`/`-` diff markers or surrounding whitespace) — and automatically extract the `line#hash` anchor while dropping the trailing `:content` noise. A row without a line number (bare `aB3:content`) is still rejected with a clear message, since the line number is what disambiguates identical content.
- `[E_BAD_REF]` messages no longer echo the whole pasted line/block: inputs are clipped (`clipLine`, 60 chars) in `diagRef` and the `resEdit` stripping warnings, and the bare-anchor rejection shows only a clipped hint. Multi-line blocks pasted into an anchor now warn that only the first row's anchor is used and the rest is ignored.
- Anchor contract sync: prompts, schema descriptions, and README error tables no longer advertise a "bare 3-char hash" as accepted — `line#hash` copied from the leftmost column is stated as the only valid anchor form (the code already rejected bare hashes).
- Fixed empty-file read rendering: the marker row was emitted as `1:<hash>:` (missing the `#` separator) instead of `1#<hash>:`; the byte-size computation in `fmtReadPreview` used the same wrong separator.

### Changed

- **Batch edits use snapshot-concurrency semantics.** Every hunk in one `edit` call resolves its `<line>#<hash>` anchor against the same original file snapshot, so all hunks may use ORIGINAL anchors — no more manual `newLine#oldHash` chaining. Hunks with overlapping row ranges are rejected up front with the new `[E_BATCH_CONFLICT]` code (replace/del × replace/del overlap; two `ins` at the same anchor line; `ins` whose anchor line lies inside a replace/del range). Non-overlapping hunks apply atomically, in one pass from the back, and remain all-or-nothing. New pure module `src/range-conflicts.ts` owns the conflict rules.
- Post-edit `Shift:` blocks now map each hunk's original range to its final position (e.g. `Shift: edits[1] lines 5..6 moved to lines 7..9 (+2)`), and the diff rows carry final line numbers + hashes throughout. The old `newLine#oldHash` chaining guidance is gone from prompts.
- `[E_BATCH_ABORT]` no longer duplicates the file echo: the failing hunk's anchored error (stale / unverified) is the single ±3 echo, recorded as served for direct fresh-marker reuse. The old appended "on-disk range" block (which rendered a virtual in-batch state, mislabeled as on-disk, with mismatched hashes vs content) was removed.
- **Deterministic content hashing.** The 3-char hash is now a pure content signature (cyrb53, dependency-free, synchronous) instead of a snapshot-unique allocation: identical lines share one hash and collisions are accepted by design — the line locates, the hash only verifies content (anchors stay strictly `line#hash`, no lenient auto-correction). This removes the `62^3` line ceiling (`MAX_HASH_LINES` / `E_FILE_TOO_LARGE` are gone; arbitrarily large files work), deletes the `mapStableHashes` stable-mapping pass (hashes after an edit are a plain O(n) recomputation), and drops the xxhash-wasm dependency. `CANON_VERSION` bumped to 3; hash-store snapshots recompute on the new checksum. Stale-anchor echoes now merge overlapping ±3 windows into one block.'


## [0.4.0] - 2026-08-21

### Added

- `line#hash` anchor (issue: line-anchored hashline upgrade). Every read / grep / edit row now carries the absolute 1-indexed line number alongside the 3-char content hash, e.g. `12#ve7:function hello() {`. The model passes the full `line#hash` (or a bare 3-char hash when it knows the file has not shifted above) as `remove_from` / `remove_to`.
- `ANCHOR:FILELINE` header line at the top of every hashline response, visually separating the marker column from the verbatim file content.
- Post-edit response carries a `Shift:` block describing how absolute line numbers below the edited range have moved: `Shift: lines > N shift by +K (original line X now at line Y, …). Use newLine=<N>#<oldHash> to edit the row immediately below without re-reading — copy the hash from the next "unchanged" diff row if one was rendered.` The model chains edits by reading the Shift block instead of re-reading.
- `[E_STALE_ANCHOR]` rejection echoes the target line in read format (`ANCHOR:FILELINE` + ±3 context rows). The echo rows are recorded as served, so a retry carrying the fresh `line#hash` marker passes served-state verification without a re-`read`.
- New `grep` tool. Hashline-aware substring (default) or regex (`regex: true`) search. Output mirrors `read`: each match is a `<line>#<hash>:content` row under a `ANCHOR:FILELINE` header, one section per file. Context rows (`-C N`) carry markers too. Every file read by grep is emitted as `fs/observed` and recorded as served, so a grep hit can be edited directly without a separate `read`.
- New `tool:grep` prompt section (default order `134`), overridable per agent preset via `<preset>/grep.md`.
- **Structured web-UI views.** Each tool now emits the typed `presentationMeta` + `presentResult` / `presentCall` projections from the `@deepseek-ai/dsh-tools` contract, so dsh-web (and any future UI that consumes the same contract) renders the read as a line-numbered code view (`card: 'read'`), each edit / batch_edit / undo as an inline diff card (`card: 'diff'`), and grep as a grouped-by-file search card (`card: 'search' shape: 'matches'`). The model-facing text contract is byte-identical to the pre-change version — the structured metadata rides alongside the existing `modelText`. The pattern is mirrored from `@deepseek-ai/dsh-tool-fs` (the official built-in fs tools, the authoritative reference for the contract). Pure helpers live in `src/presentation-helpers.ts` (`buildReadPresentation`, `buildDiffPresentation`, `buildSearchPresentation`, `computeHunkDiffs`, `langFromPath`, soft-validators). See `docs/web-ui-structured-views-spec.md` for the full design.
- **Cherry-picks (non-breaking).** Three non-breaking ticket-bundles cherry-picked from the upstream
  at `0.3.0`:
  - **T1 (ADR-0005) — whitespace-insensitive canon.** `canon()` now strips every run of `[ \t\r\n]+` instead of just `\r` and `trimEnd()`. A line that differs only by whitespace keeps its hash, so a reformat cannot rotate anchors. `CANON_VERSION = 2` is exported; the hash-store cache invalidates on version change. `getCanon(cache, line)` memoizes per call (input set bounded by file line count).
  - **T2 (ADR-0008) — orphaned serve healing.** `_mergeServedRows` builds an internal `Map<hash, position>` as it scans the existing array; when the same hash appears at a second position, the older position is nulled. This prevents a partial re-serve from leaving a stale duplicate behind. Both `recordServed` / `recordServedTruncated` short-circuit on no-op writes. `verifyServedRange` now uses **candidate-span enumeration** when `startPositions.length` or `endPositions.length` is not exactly 1: for each `s ∈ startPositions × e ∈ endPositions`, it checks `served[s..e] === fileHashes[startLine-1..endLine-1]`. If exactly one candidate matches, it's accepted. If multiple match, the closest to `startLine-1` wins. The new `[E_RANGE_UNVERIFIED]` message says "A full read will re-sync the served mirror" instead of the old "is never guessed at" boilerplate.
  - **T5 — terse notices + lean prompts.** All `[E_NOOP_LOOP]` / `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` / `[E_BAD_REF]` / `[E_BAD_OP]` / `[E_INVALID_PATCH]` / `[E_BARE_HASH_PREFIX]` messages shortened; the "Autocorrected: " prefix dropped from autocorrection notices. Model-facing output is shorter per rejection so the next edit prompt has more room for actual code context. Schema description one-liners land here too.

### Changed

- **Yet-evolving edit contract → `op` semantics.** Following the `absorb/t3-payload` merge (which
  bundled `batch_edit` into `edit({path, edits})`), this release goes further and adds an explicit
  `op` field to each `edits[i]`:
  - `remove_from` → `from`; `remove_to` → `to` (optional, single-line when omitted); `replacement_text` → `lines` (string array).
  - `op: "ins"` — insert `lines` AFTER the `from` line (the anchor line's content is preserved). `to` is forbidden.
  - `op: "del"` — delete the `from` line, or the `from..to` range. `lines` is forbidden.
  - `op: "replace"` — replace the `from` line, or the `from..to` range, with `lines` (required and non-empty). Use `lines: [""]` to clear a line to empty (not `del`).
  - `batch_edit` is **removed** — one `edit` with `edits:[]` handles single and multi-edit calls; the per-item optional `path` preserves multi-file edits in one call.
  - Errors: `edits[i].op` must be `ins`/`del`/`replace`; `ins` rejects `to`; `del` rejects `lines`; `replace`/`ins` require non-empty `lines`. An `[E_OP_INS]` notice records the moved anchor line for an `ins` (the "insert after line N" expands to a single-line replace that preserves N).
- Anchor parsing accepts both `line#hash` and a bare 3-char hash. Bare-hash form is the pre-existing hash-only fallback for cases where the model is confident the file has not shifted above.
- Post-edit response reorganised into a three-block layout: `ANCHOR:FILELINE` header, the `+- line#hash : content` diff rows, the `Shift:` block, and the unchanged trailing warnings / drift notice. Each hunk in the `edits` array emits its own `Shift:` block; the cumulative Shift (added − removed through each hunk) lets the model compose `newLine#oldHash` markers between hunks without a re-read.
- Output column position is no longer fixed across line-number widths (the column moves with the line-number digit count). The marker structure (`<prefix><line>#<hash>:<content>`) is invariant and is what the model parses.
- All five tools' `output.schema` upgraded from `{ type: 'string' }` to structured objects (`read` → `{ path, offset, totalLines, lines, hashlines, truncatedByBytes }`; `edit` → `{ path, before, after, modelText, … }`; `grep` → `{ files, truncated, total, modelText }`; `undo_last_edit` → `{ path, before, after, modelText }`). The model still gets a `text` content block (the same string as before) — the schema change is observable only to consumers that read `tool/result.value` (none in the model path).

### Tests

- 11 new tests in `test/core/line-hashline.test.ts` covering: `parseRef` accepting `line#hash`, the read header line, single-line edit (`op:"replace"` with only `from`), single-hunk `Shift:` block, cumulative per-hunk `Shift:` blocks in a merged `edits` array, stale-anchor echo in read format with ±3 context, grep output format, grep context rows, and `grepFileContent` no-match path.
- 10 new tests in `test/core/presentation.test.ts` covering: `read` returns a structured value with `lines` + `hashlines`; model text starts with header + ends with pagination footer; `grep` returns `files` + `truncated` + `total`; `grep` sets `truncated` when the per-file cap is hit; `edit` returns `{ path, before, after, modelText }`; multi-edit aggregation; `computeHunkDiffs` produces a 3-line-context hunk (mirroring `dsh-tool-fs`); `computeHunkDiffs` returns `oldText: null` for noop/create; `langFromPath` derives syntax-highlighting language from file extension.
- New `op`-semantics tests: `ins` inserts after `from` and rejects `to`; `del` deletes and rejects `lines`; `replace` requires non-empty `lines` and rejects empty; `replace` with `lines: [""]` clears a line (still exists).
- Existing test suite adjusted to the new `line#hash` / `op` contract: read-preview, read-and-serve, edit-diff-preview, edit-diff-utils, edit-engine-e2e, hashline-stable-duplicate, hashline-hash, hashline-recovery, hashline-strict-input, hashline-parse, guidance (tool:batch_edit section removed), presentation, line-hashline. The pre-existing hash-store / served-store / served-state / snapshot-store / reject-and-serve-seam failures are sqlite-environment issues unrelated to this change (verified on `main`).
- Test count: 664 passing (32 pre-existing sqlite-env failures excluded; was 615 pre-change).

## [0.2.2] - 2026-08-19

### Added

- Guidance reset & restore defaults (issue #17): emptying or deleting an override file — or deleting its whole `<preset>/` directory — restores that section's compiled default guidance and order: the default renders at session-start and the file re-seeds at next boot (shipped presets; a deleted custom-preset override stays absent). A whitespace-only file with no front-matter fence means "I want the default"; any well-formed fence (even keyless, even an empty body) is a deliberate-intent signal and is never reset. Malformed fences now fast-fail instead of degrading to prose: a missing closing `---`, a non-integer `order`, or an unknown key rejects the file — the compiled default renders, a warning names the file and the reason, and the file is left untouched on disk for repair.

## [0.2.1] - 2026-08-18

### Added

- Configurable per-preset tool guidance (issues #7, #8; tickets #9–#13): the four `tool:*` prompt sections resolve from plain-markdown override files keyed by agent preset — `$DSH_HOME/plugins/dsh-hashline-edittool/<preset>/<section>.md` — with an optional `order` front-matter. On first boot the plugin seeds each shipped preset (`standard`, `code`, `minimal`, `cordis`) with its guidance as editable files plus a root README documenting the scheme. Per section the chain is `<preset>/<section>.md` → compiled default; files are read once per agent at session-start, so edits apply to new sessions. Deployments without the `agentPresets` service keep the compiled defaults untouched.
Default orders sit at 130–133, above the built-in tool-guidance band (100–116 in the shipped
dsh), so a same-order section merge with unrelated tool guidance cannot occur out of the box; the
seeded preset files expose that `order` as editable front-matter.
- Default guidance text simplified per the writing-for-agents principles; the `*_GUIDELINES` constants unified on `*_GUIDANCE`.
- Thanks to [@R-LEI2536](https://github.com/R-LEI2536) for requesting configurable per-preset prompts and for the design input that shaped this release (issue [#7](https://github.com/hyperion2144/dsh-hashline-edittool/issues/7)).

### Changed

- Benchmark extended to a third arm, `@oh-my-pi/hashline`: same corpus, same 12 replacements, two modes (per-edit `seq` with renumbered lines + one-document `batch` fixed to original line numbers). Payloads are built from the package's published grammar and validated before counting (the package is Bun-only, so it cannot run under the Node benchmark). Honest result, reported as such: hashline saves 31% vs `str_replace` on the session (43% on multi-line ranges) and remains the plugin's claim; the compact patch language saves 42% per edit / 53% batched — and this README says so. `npm run benchmark` stays byte-deterministic (verified over repeated runs).
- READMEs (English and 中文) refined along ponytail-style lines: "How It Compares" gains an `@oh-my-pi/hashline` column plus a same-lineage/different-jobs comparison; the Benchmark section documents all three arms, adds an honest "regenerate, don't trust" reproducibility note, and widens the scope-and-honesty block with what the payload numbers do *not* capture (renumber/tag-chase cost, block ops, Bun-vs-Node, tool-pair vs patcher library).
- `package.json` keywords now include `oh-my-pi` alongside `hashline`.
- Roadmap gains a first-class decision item: close or justify the gap vs `@oh-my-pi/hashline` (payload-lighter by 42%/53% vs 31%, with block ops / registers / `REM`/`MV` / multi-hunk documents / pluggable fs we do not support — against correctness costs: unverified line numbers, renumber-per-edit, best-effort merge on stale tags, model skill floor). A reference record lives at `../oh-my-pi.md` (workspace-level, outside this repo): the token comparison, the correctness asymmetry, the ability-by-ability status, and the decision rationale.

## [0.2.0] - 2026-08-16

### Changed

- Architecture deepening across six refactors (GitHub issues #1–#6), with the model-facing contract unchanged — every `[E_…]` code and message byte-identical, full suite green (615 → 626 tests):
  - Served state (what the model has been shown) now lives in one async module: the doubled sync/async store interface (whose sync half had zero production callers) is gone, and the served-row merge invariant — stale tail / duplicate anchors — is one shared helper with a regression test.
  - `edit` and `batch_edit` run on one edit-sequence engine — apply-one, the multi-edit sequencer, the noop-loop guard, and the persist-undo → write → restore transaction — replacing `batch_edit`'s duplicated 685-line pipeline with a thin orchestrator. Batch apply, atomic batch rejection, and undo revert are now covered by end-to-end tests.
  - The hashline anchor math is a pure module (no store imports); persistence is a thin wrapper over it. The public hashline interface shrank to the consumer call surface.
  - The `read` tool and the write auto-read share one read-and-serve operation; canonical path resolution moved out of the write module into the path helpers.
  - All four tools validate requests through one contract module — field sets and the `[E_BAD_SHAPE]` vocabulary declared once.
  - The hash store exposes domain APIs (snapshots / undo / served) instead of raw prepared statements; corruption handling and cross-table cleanup are owned by the store, and the import graph is acyclic.

## [0.1.9] - 2026-08-15

### Changed

- READMEs (English and 中文): added a concise "Why you need this" opening section — the transcription cost and 46–51% patch-failure rate of `str_replace`, the 31%/43% edit-token savings, verified landing, and the leaner-context benefit (the model's attention stays on the code, not on re-transcribing it) — placed before Quick Start so the demo stays immediately visible. Fixed the stale static version badge.

## [0.1.8] - 2026-08-15

### Added

- This CHANGELOG (Keep-a-Changelog style, following the pi-interactive-shell layout), shipped in the npm tarball.
- Git tag / GitHub release automation: a `postpublish` hook (`scripts/tag-current.mjs`) reads the version from `package.json`, creates an annotated `vX.Y.Z` tag at HEAD and pushes it, so every successful `npm publish` stays in sync with git; a GitHub Actions workflow (`.github/workflows/release.yml`) turns any `v*` tag push into a release with auto-generated notes.
- Backfilled `v0.1.0`–`v0.1.7` git tags and GitHub releases at their version-bump commits.

## [0.1.7] - 2026-08-15

### Added

- `assets/logo.svg` and `assets/banner.svg` (file.ts → read → hashed lines → edit by hash → diff), shipped in the npm tarball.
- READMEs (English and 中文) restyled in a centered, image-led layout: badge row, harness-problem pull-quote, example-driven Quick Start, a hashline-vs-`str_replace`-vs-line-number comparison table, project-structure tree, roadmap, acknowledgments, and a star-history chart.

### Changed

- The published tarball now includes `assets/` alongside `README.md` and `README.zh.md`.

## [0.1.6] - 2026-08-15

### Added

- Chinese README (`README.zh.md`) — a full translation mirroring the English one (pillars, diagrams, benchmark, tools, error codes, lineage).
- Reciprocal language links at the top of both READMEs; `README.zh.md` shipped in the npm tarball.

## [0.1.5] - 2026-08-15

### Added

- Reproducible token-cost benchmark (`benchmark/run.mjs` + frozen 103-line corpus + methodology): hashline vs `str_replace` on the same file with the same 12 replacements — 31% fewer output tokens over the session (43% on multi-line ranges), ~1.4× cheaper on effective cost at the 5× output-token rate. Deterministic: content-addressed self-checking edit script, pinned `js-tiktoken` `cl100k_base` devDependency. Run with `npm run benchmark`.
- README rewritten around the three pillars — token-saving, correctness, and the modern content-addressed edit pattern — with Mermaid diagrams, a `str_replace` comparison table, and an inspiration/lineage section (The Harness Problem, pi-hashline-edit, pi-hashline-edit-pro).

## [0.1.4] - 2026-08-15

### Fixed

- `E_RANGE_UNVERIFIED` ("served at N positions") on edits after a shrinking write: the served-state array was upserted by position but never truncated to the file's current line count, so a stale tail kept a surviving line's hash at its OLD position while the current serve held it at its new one. `recordServed`/`recordServes` now take the current line count and truncate before upserting, threaded from every whole-file serve — read, write auto-read, drift rows, and all rejection-echo sites. Regression test covers the 8-line→2-line write case (issue #27).

## [0.1.3] - 2026-08-15

### Fixed

- Sandboxed sessions rejected in-workspace edits while the built-in `write` succeeded: the shadowed mutating tools called `fs.writeText` without the per-call sandbox policy, so a confined backend fell back to the deployment root. Tools now mirror `@deepseek-ai/dsh-tool-fs`'s `FsSandboxController` — resolve the policy with the session cwd as the workspace root, advertise `sandbox_permissions`/`justification`, pass the policy to `fs.writeText`, and map `FS_SANDBOX_DENIED` to the shared `[sandbox: …]` marker.

## [0.1.2] - 2026-08-15

### Changed

- The hash store moved from `$DSH_HOME/plugins/dsh-hashline-edittool` to a per-workspace location: `<workspace>/.dsh_hashline_edittool/hash-store.sqlite`, carried per tool call via an AsyncLocalStorage workspace context (`src/workspace.ts`). Parallel sessions in different workspaces no longer share anchors or undo history. The shared home path remains the fallback for tests/previews.
- Undo history from before 0.1.2 is not migrated to the new layout.

## [0.1.1] - 2026-08-15

### Fixed

- Shadowed tools silently never registering, leaving sessions on the built-ins: per-agent installation failed with `cannot get property "fs" without inject` at `session-start`. The plugin now declares `inject = ['tools', 'systemPrompt', 'fs']` and resolves the host `fs` service from the plugin's own `rootCtx` (the agent fiber chain does not carry the plugin's inject list).

## [0.1.0] - 2026-08-14

### Added

- Initial dsh port of the hashline editor: hash-anchored `read` / `edit` / `batch_edit` / `undo_last_edit` tools for DeepSeek Harness. Every line gets a unique 3-character content hash; edits target `remove_from`/`remove_to` hashes. The hashline core is ported byte-for-byte; the tool layer is rewritten on dsh's plugin API (batch_edit spec #19).
- Built-in replacement via scope-layered registry shadowing: on `agent/session-start` the tools and the `tool:read`/`tool:edit` prompt sections are registered on the agent's own layer (own-layer-wins), unwinding automatically on disposal; a `tools/post-execute` listener appends the auto-read to built-in `write` results.
- Served-state range verification with reject-and-serve: every line of the resolved range is checked against what the model was shown; stale/never-served/unverified ranges are hard-rejected with the current `HASH:content` rows echoed back (retry needs no `read`). Drift notices report served territory changed outside the edit range (reject-and-serve spec #13).
- Chained edits without re-reading: post-edit diff rows and rejection echoes count as serves, so follow-up edits verify cleanly.
- Error-code contract (`[E_*]` codes, README-documented and test-enforced) including the noop-loop guard (issue #18); `undo_last_edit` surviving restarts; and safe writes preserving permissions, line endings, BOMs, symlinks, and hard links via `ctx.fs`.
- Test suite ported from the original project (614 tests at release), driving the dsh tool builders directly over a local filesystem bridge.
