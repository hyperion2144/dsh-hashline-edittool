<h1 align="center">dsh-hashline-edittool</h1>

<p align="center">
  <img src="docs/images/cards.png" alt="hashline cards: read / edit / grep / LSP / settings" width="760">
</p>

<p align="center">
  <strong>Line-anchored editing for DeepSeek Harness<br>
  Every line gets a variable-length content anchor — no line numbers, no echoing old code, fewer tokens, more context for real work.</strong>
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#the-anchor-contract">The Anchor Contract</a> •
  <a href="#tools">Tools</a> •
  <a href="#settings">Settings</a> •
  <a href="#error-codes">Error Codes</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#acknowledgments">Acknowledgments</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/DeepSeek_Harness-Plugin-blueviolet.svg" alt="DeepSeek Harness Plugin">
  <img src="https://img.shields.io/npm/v/dsh-hashline-edittool" alt="npm version">
  <img src="https://img.shields.io/github/stars/hyperion2144/dsh-hashline-edittool?style=social" alt="GitHub Stars">
</p>

---

## What it is

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that replaces the built-in
`read` / `edit` / `grep` tools with **hash-anchored** versions and adds `undo_last_edit`,
`ast_grep`, `ast_edit`, and an `lsp` tool on top:

- **Every line carries a content anchor** — a variable-length Base62 marker (2 characters
  covers the first 3,844 lines; the encoding grows only as the file demands). The model
  edits by marker, so it never echoes the code it is replacing.
- **Edits are verified against what the model actually saw.** Each resolved range is checked
  against the *served* mirror (anchor + content). A line that changed under the agent is
  rejected with `[E_STALE]` — and the rejection echoes the current lines **with fresh,
  immediately usable anchors** (reject-and-serve).
- **One call = one atomic batch.** All anchors in one `edit` resolve against the original
  snapshot; any failure rejects the whole call and writes nothing. Multi-file batches are
  grouped per file, each file all-or-nothing, partial success reported.
- **Everything is a card.** The bundled client plugin renders read / diff / grep / undo /
  write / structural / LSP cards in the dsh web UI from structured `presentationMeta` —
  the model text and the UI never have to agree by string parsing.

Ships as one npm package (`dsh-hashline-edittool`): host plugin + web card plugin + prompt
sections, mounted by a single bundle patch.

## Highlights

**Self-rendering cards.** The bundled client plugin ships its own React components —
`HashlineReadRow`, `HashlineEditRow`, `HashlineGrepRow` (file tabs + match highlighting),
`HashlineUndoRow`, `HashlineWriteRow`, `HashlineAstGrepRow`, `HashlineAstEditRow`,
`HashlineLspRow` — registered straight into the dsh web UI's slots. Every card renders
from the tool's structured `presentationMeta`, with anchor gutters, diff rows, and
highlight spans drawn natively. No generic tool-output cards, no string parsing, no
upstream web changes.

**Dynamic-length anchors.** Anchors are not fixed-width hashes. Allocation is
shortest-first: 2 characters cover the first 3,844 lines, and a new layer grows only when
the file demands it (up to 62⁸ lines — practically unbounded). All-digit encodings are
skipped so a marker can never be confused with a line number, collisions are probed and
resolved at allocation time, and surviving lines keep their anchors across edits within
the session.

**AST + LSP, two semantic backends.** `ast_grep` / `ast_edit` answer "where does the
syntax match" through a sandboxed tree-sitter worker, with a curated grammar catalog
(SHA-256-pinned downloads, install/uninstall routes) and folded editable outlines for
long files. The `lsp` tool answers "what does this symbol mean" through a real language
server per language — started on demand, shared with dsh's own `lsp` service — and falls
back to a heuristic backend when none can be had. Both serve their rows, so structural and
semantic results are directly editable.

**Diagnostics on write.** After an edit/write lands, the plugin baselines the language server with the pre-write text, pulls diagnostics, and delivers them per written file — an inline, severity-tinted capsule under the card within a short window, with bounded async delivery at the model's next natural step, riding both the JSON envelope and the text channel. One switch (`lsp.auto_diagnostics`) turns it off.

**A settings panel rendered by the plugin itself.** The bundled `HashlineSettingsCard` is
a full settings UI in the web: separator, output format, context lines,
require_line_content, the AST master switch plus per-language toggles, named LSP servers,
auto-diagnostics. Edit, commit, done — no YAML editing required.

**Hot switching, everywhere.** A committed settings change takes effect on the **next
tool call** — output format, separator, context lines, AST/LSP toggles (verified live:
flipping `output_format` mid-session immediately changes what the model receives). And the
switch with the biggest blast radius is handled too: flipping `require_line_content`
disposes and re-registers the `edit` tool's schema, so the model's very next step sees the
new `{ anchor, line }` parameter set — no restart anywhere.

## Quick Start

```sh
npx @deepseek-ai/dsh plugin --profile web add github:hyperion2144/dsh-hashline-edittool   # from github
npx @deepseek-ai/dsh plugin --profile web add dsh-hashline-edittool                       # from npm
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-hashline-edittool              # local checkout
```

The profile's next session runs with the hashline tools installed. Verify the layer is active:

```sh
dsh --profile <name> --dump-config   # shows a "# == dsh-hashline-edittool" layer
```

| Requirement | |
| --- | --- |
| Node | `^22.19.0 \|\| >=24.0.0` (dsh's requirement; the store uses `node:sqlite`) |
| Profile | a dsh profile (`dsh plugin` initializes one on first use) |
| Backends | sandboxed / remote filesystems supported (writes go through `ctx.fs`) |

## The Anchor Contract

### Markers

- An anchor is a variable-length Base62 marker, **unique per line** (identical content
  lines get *distinct* anchors — the anchor is a row identity, not a content hash you can
  guess). Digits-only encodings are skipped, so a marker is never all digits.
- A marker is written `<anchor>` or `<anchor>:<line>`; `line` is a **positional hint only**
  — the anchor is authoritative, and a disagreeing hint is a warning
  (`[E_LINE_HINT]`), not an error. The legacy `<line>:<anchor>` order is still accepted.
- `read` output opens with an `ANCHOR:FILELINE` header separating the marker column from
  verbatim content, using the configured separator (`|` in the examples below):

```text
ANCHOR:FILELINE
G8:1|// UI demo file
ur:2|export const APP = "hashline";
D0:4|export function greet(name: string): string {
```

### Served-state verification (reject-and-serve)

A row becomes **served** when a tool result shows it to the model (`read`, `grep`, edit
diffs, structural results, LSP rows). `edit` verifies each resolved range against that
mirror before writing:

- anchor unknown or row never served → `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]`;
- served content differs from disk → `[E_STALE]` / `[E_RANGE_STALE]`;
- every rejection **echoes the current lines as served rows with fresh anchors**, so the
  fix is: take the marker from the echo and resubmit. Served rows are also emitted as
  `fs/observed`, so they can be written with immediately.

There is no `Shift:` block — after an edit, take anchors from the diff rows the response
just gave you, or re-read.

### Batch semantics

- `edits[]` apply **in order against one snapshot**; overlapping ranges are
  `[E_BATCH_CONFLICT]`; any failure is `[E_BATCH_ABORT]` — nothing is written.
- With per-item `path` (or every item carrying `path`), items are grouped per file and each
  file is **all-or-nothing independently**; results aggregate as `success[]` / `fail[]`
  (multi-file form). `item.path === topLevelPath` is auto-folded to absent.
- Up to 32 edits per call.

### `op` semantics

| op | anchor field | behavior |
| --- | --- | --- |
| `replace` | `anchor_start` (+ optional `anchor_end`) | swap the range for `lines` (non-empty; `[""]` clears a line to empty, distinct from `del`). `anchor_end` omitted = single-line replace; **required when `lines` spans multiple lines**. |
| `ins` | `anchor_after` | insert `lines` **below** that line — the anchor line is kept, `lines` holds only what is new. `anchor_start`/`anchor_end` are refused. May anchor on another hunk's range **end** line, never its start/interior. |
| `del` | `anchor_start` (+ optional `anchor_end`) | delete the range (or the single `anchor_start` line); `lines` is ignored. |
| `sed` | `anchor_start` (+ optional `anchor_end`) | rewrite the range **line by line** with `pattern` + `replacement` + optional `flags` (`gims`), no `lines`, no newline in `replacement`; sed's `\1`/`&` and JS's `$1`/`$&` both accepted. |

Mixing anchor fields with the wrong op is `[E_BAD_SHAPE]`.

### `require_line_content` (optional hardening)

When `hashline.require_line_content` is on, every anchor becomes a
`{ anchor, line }` pair — `line` is your declaration of that row's **current full text**.
Declarations are verified after the stale-anchor check; a mismatch rejects the call with
`[E_CONTENT_MISMATCH]` and echoes where your declared content actually lives.

## Tools

| Tool | What it does |
| --- | --- |
| `read` | File as served rows: `ANCHOR:FILELINE` header + `<anchor>:<line>` markers (set `line_numbers: false` for bare anchors). `offset` (1-based) / `limit` paging; oversize lines (>200 KB) become a marker + `sed` hint — anchors need full lines. |
| `edit` | One or more range edits via `{ path?, edits: [{ op, … }, …] }` — the full contract is [above](#the-anchor-contract). Replaces the legacy `batch_edit`. |
| `write` | Fully shadowed: creates/overwrites a file and returns the write **plus an auto-read preview** with fresh anchors, so the next edit never needs a separate read. |
| `grep` | JavaScript-flavre regex search (or `regex: false` for literal) across a path tree, one section per file under the same header, full lines only. `-C N` echoes context rows; hits are served → directly editable. |
| `undo_last_edit` | `{ path }` reverts the file's last hashline edit — only while the file still matches the stored post-edit content; survives restarts. |
| `ast_grep` | Structural search by syntax shape (`pat` with `$NAME` / `$$$ARGS` / `$_` metavariables). Refuses instead of guessing when a pattern does not parse as one node. Long files come back as a folded, editable outline. |
| `ast_edit` | Structural rewrite: finds places by shape and hands the change to the **same engine** `edit` uses — served-state check, undo entry, diff and syntax gate all apply. |
| `lsp` | Symbol-aware work through a real language server when one can be had (started per language, shared with dsh's `lsp` service); falls back to a heuristic backend otherwise. Serves its rows, so LSP output is directly editable. |

### Output modes

`hashline.output_format` switches the model-facing text between:

- **`text`** (default) — the `ANCHOR:FILELINE` row format shown above;
- **`json`** — pure JSON envelopes (e.g. edit returns `{ ok, path, diff, hints, warnings }`
  where `diff` is a `{"<anchor>:<line>": content}` dict). Structured, for models that
  prefer parsing over row formats.

The web cards are unaffected — they render from `presentationMeta`, which is always
structured.

## Settings

All keys live under the `hashline` namespace in dsh settings (`~/.dsh/settings.yaml`), are
optional, and **hot-reload**: a committed change takes effect on the next tool call, no
restart.

```yaml
hashline:
  separator: "|"           # marker/content column separator (default ":")
  output_format: text      # "text" | "json"
  context_lines: 3         # context rows around stale echoes / diffs (0..20)
  require_line_content: false
  ast:
    enabled: true
    languages: {}          # per-language { <id>: { enabled: false } } narrowing
  lsp:
    servers: {}            # named servers: { <languageId>: <command> }
    auto_diagnostics: true # deliver server diagnostics inline after writes
```

Every one of these keys is editable in the web through the plugin's own **settings card**
(`HashlineSettingsCard`) — change, commit, done; see [Highlights](#highlights).

### Per-preset guidance

The `tool:read` / `tool:edit` / `tool:grep` / `tool:undo_last_edit` guidance sections are
plain-markdown override files in the plugin's shared home, keyed by preset id — see
[`docs/adr/0001`](docs/adr/0001-guidance-override-files.md). Emptying a file resets to the
compiled default; a broken front-matter fence is fast-failed with a warning.

## Error Codes

| Code | Meaning |
| --- | --- |
| `[E_ACCESS]` | File exists but is not readable/writable. |
| `[E_ANCHOR_AMBIGUOUS]` | The anchor is live on multiple lines (a freed anchor was re-allocated while the model still held the old binding) — refused; re-read. Nothing was written. |
| `[E_ANCHOR_STATE_DUP]` | The file's anchor state has duplicate anchors (corruption). The state is rebuilt; the edit is refused — re-read to get fresh anchors. Nothing was written. |
| `[E_AST_DISABLED]` / `[E_AST_PATTERN]` / `[E_AST_TOO_LARGE]` | AST capability off for the language / pattern did not parse as one node / file exceeds the AST size cap. |
| `[E_AST_WORKER_ABORTED]` / `[E_AST_WORKER_FAILED]` | The tree-sitter worker was aborted / failed. |
| `[E_BAD_OP]` | Range end precedes range start (autocorrected when reversed). |
| `[E_BAD_REF]` | Anchor field is not a marker copied from a row's leftmost column. |
| `[E_BAD_SHAPE]` | Request/field shape wrong (unknown fields, wrong anchor field for the op, …). |
| `[E_BATCH_ABORT]` | A batch item failed; nothing was written. |
| `[E_BATCH_CONFLICT]` | Two items' ranges overlap on the same snapshot. |
| `[E_BARE_HASH_PREFIX]` | An anchor-prefixed row was pasted into `lines`; stripped with a warning. |
| `[E_CONTENT_MISMATCH]` | A declared `line` (require_line_content) does not match. |
| `[E_ELISION_IN_PAYLOAD]` | Payload carries the outline marker `…`; warning, edit proceeds. |
| `[E_GRAMMAR_BUILTIN]` / `[E_GRAMMAR_NO_DESCRIPTOR]` / `[E_GRAMMAR_UNKNOWN]` | Grammar catalog: built-in name collision / no descriptor for the language / unknown language. |
| `[E_GRAMMAR_FETCH_FAILED]` / `[E_GRAMMAR_HASH_MISMATCH]` / `[E_GRAMMAR_NOT_IN_TARBALL]` | Grammar download failed / SHA-256 mismatch / entry missing from the tarball. |
| `[E_HASH_SPACE]` | Anchor space exhausted (> 62⁸ lines). |
| `[E_INS_ANCHOR_DUP]` | `ins` `lines[0]` duplicates the anchor line; warning, proceeds. |
| `[E_INVALID_PATCH]` | Diff-preview markers pasted into `lines`; stripped with a warning. |
| `[E_LINE_HINT]` | A `<line>:<anchor>` hint disagreed with the anchor; anchor wins. |
| `[E_LINE_REF]` | A bare number was passed as an anchor; resolved via served state when safe. |
| `[E_LSP_NO_SERVER]` / `[E_LSP_BAD_OPERATION]` / `[E_LSP_UNAVAILABLE]` | LSP: no server for the language / unknown operation / server unusable. |
| `[E_LSP_ABORTED]` / `[E_LSP_CLOSED]` / `[E_LSP_NOT_READY]` / `[E_LSP_TIMEOUT]` | LSP request aborted / channel closed / server still starting / timed out. |
| `[E_NOOP_LOOP]` | The same edit keeps producing no change; resubmission rejected. |
| `[E_NOT_FOUND]` / `[E_NOT_TEXT]` | Missing file / directory-binary-non-UTF-8. |
| `[E_NOT_OBSERVED]` | File never observed this session (read-before-write policy). |
| `[E_OP_INS]` | Informational: `ins` placed lines after the anchor. |
| `[E_PASTE_DUP]` | Replacement line matches an adjacent file line; kept verbatim. |
| `[E_SERVED_RECORD]` | Diagnostics: served state could not be persisted (storage failure); the response carries a re-read notice instead of silently losing the rows. |
| `[E_RANGE_STALE]` / `[E_RANGE_UNSERVED]` / `[E_RANGE_UNVERIFIED]` | Served-state verification failed; the range is echoed fresh. |
| `[E_STALE]` | Anchor no longer matches served content; re-read. |
| `[E_SYNTAX_AFTER_EDIT]` | `ast_edit`'s replacement would leave the file unparsable; not written. |
| `[E_UNDO_STALE]` / `[E_UNDO_UNAVAILABLE]` | File changed after the edit / undo history could not persist. |
| `[E_WOULD_EMPTY]` | Edit would empty a non-empty file; use `write`. |
| `[E_WIN_REPLACE]` | Windows atomic replace held open by another process. |
| `[E_PARSE_FAILED]` | AST worker could not parse the document. |

## Store

Anchor identity, served rows, and undo history live in one SQLite store **keyed by the
workspace** being edited:

```
$DSH_HOME/plugins/dsh-hashline-edittool/<projectKey>/hash-store.sqlite
```

`<projectKey>` is a human-navigable encoding of the session cwd, so parallel workspaces
never share anchors or undo history. Callers outside a workspace fall back to the
shared-home store. A 7-day TTL prunes served rows; corrupt stores are quarantined and
rebuilt automatically.

## Architecture

One plugin, three planes:

```text
src/
├── index.ts              # entry: mounts tools, settings, LSP, grammar routes
├── config.ts             # settings schema + wiring (hot-reload)
├── tools/                # the 8 tool entry points — thin, no IO of their own
├── domain/
│   ├── edit/             # edit engine, mutation transaction, contract, prompts
│   └── session/          # served state, hash store, file views
├── render/               # per-card projections: read / edit / grep cards, diff renderer
├── contract/             # request shapes + validation (schema is the single authority)
├── hashline/             # the anchor core: allocation, resolve/apply engine
├── infra/                # fs bridge, sandbox, paths, settings snapshot, workspace scope
├── lsp/                  # language-server sessions, auto-diagnostics
├── ast/                  # tree-sitter worker, grammar registry
└── guidance/             # per-preset override resolution + materialization
client/                   # the web card plugin (same package)
test/                     # 1,210 tests
```

Dependencies point one way: `tools → domain → render/contract → hashline/infra`. Cards
render from structured `presentationMeta`; the model text and the UI never parse each
other. See [`CONTEXT.md`](CONTEXT.md) for the domain glossary and [`docs/adr/`](docs/adr/)
for the decisions behind the contract.

## DSH Version Support

Compatibility is declared through a settings-service peer dependency
(`@deepseek-ai/dsh-settings >=0.1.2-rc.0`, enforced by npm) and verified
against the harness this repository is actually run on:

| dsh version | plugin versions | notes |
| --- | --- | --- |
| **0.1.6-alpha.1** (current env) | **0.7.1+** | dual event registration (`agent/created` + legacy `agent/session-start`); `systemPrompt` resolved as a scoped service |
| 0.1.5-rc.2 (prior env, live-verified) | 0.7.0 | unified anchor lifecycle, AST/LSP split, settings card, card gallery |
| ≥ 0.1.2-rc.0 | 0.6.x – 0.7.1 | self-rendered cards, per-workspace store, settings panel |
| 0.1.2 | 0.4.x – 0.5.x | v2 dynamic anchors; dsh 0.1.2 web-card adaptation completed (#69) |
| 0.1.2 (early) | 0.1.x – 0.3.x | legacy `line#hash` anchors, batch_edit |

- Build/test SDK line: `0.1.6-alpha.1` (#134); the 0.7.0 line was verified on dsh `0.1.5-rc.2`.
- Newer dsh 0.1.x/rc lines are expected to work; report regressions as issues.

## Development

```sh
npm run typecheck   # tsc --noEmit (src + test projects)
npm test            # vitest
npm run build       # clean lib/ + tsc + client workspace
```

Releases are **tag-first**: `npm run release -- X.Y.Z` bumps the version, moves the
changelog, tags `vX.Y.Z`, and pushes — the tag triggers the GitHub Actions release
workflow. `npm publish` is blocked until the tag exists. PRs first; `Closes #NN` in the
body. See [`.agents/skills/git-std.md`](.agents/skills/git-std.md).

## License

[MIT](LICENSE)

## Acknowledgments

This project is a **fork of
[**Rianico/dsh-better-edit**](https://github.com/Rianico/dsh-better-edit)**, now maintained
independently — thank you, [@Rianico](https://github.com/Rianico), for the foundation and
for putting hash-anchored editing in front of DeepSeek Harness users.

That fork itself stands on the hashline lineage, and this project is grateful to:

- [**pi-hashline-edit**](https://github.com/RimuruW/pi-hashline-edit) by RimuruW — the
  original pi-coding-agent extension that introduced content hashes and collision
  resolution;
- [**pi-hashline-edit-pro**](https://github.com/YuGiMob/pi-hashline-edit-pro) by YuGiMob —
  the hardened fork the hashline core here is ported from;
- Can Bölük's [*The Harness Problem*](https://stencil.so/blog/the-harness-problem) — the
  post that showed the harness, not the model, is the bottleneck.

Related reading: [Hash anchors + Myers diff + single-token anchors
(dirac.run)](https://dirac.run/posts/hash-anchors-myers-diff-single-token) and an
independent [hashline-vs-replace
benchmark](https://nwyin.com/blogs/hashline-vs-replace-edit-bench.html).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=hyperion2144/dsh-hashline-edittool&type=Date)](https://star-history.com/#hyperion2144/dsh-hashline-edittool&Date)

---

<p align="center">
  <strong>⭐ If hashline editing made your agent edit better, give it a star!</strong>
</p>
