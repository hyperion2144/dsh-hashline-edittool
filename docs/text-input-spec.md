# Spec — text-input DSL（read / write / edit / grep 纯文本参数通道）

> 来源：grilling 会话 #52（四轮裁定）+ 研究 #51（双通道 schema-write 工具）+ 地图 #50。本文是实施票 #53 的唯一规格依据；与 `docs/research/text-input-mechanism.md`（机制研究）、`docs/edit-payload-spec.md`（JSON 通道契约）并列阅读。JSON 通道契约不变；本文只定义并行的纯文本（text）通道。

## Problem Statement

DSH 的所有工具（含 read/write/edit/grep）按协议要求模型产出 `{type:"object"}` 的 JSON 参数：即使工具只有一个字符串，模型也必须包一层 JSON（如 `{"file_path":"src/a.ts"}`）。这让「模型想写一段纯文本」的工具体验变得别扭：对 read 这种整个参数本质就是一个路径的调用，JSON 包装是纯噪音；对 write/edit 这种要携带大段正文或结构化操作的调用，JSON 的引号与转义在模型手写时极易出错。

用户希望：**模型以固定格式的纯文本 DSL 传入整个工具参数**，与现有 JSON 通道并存，由全局配置切换；切换不破坏既有 JSON 契约。

## Solution

`hashline.input_format`（settings.yaml，`hashline` namespace，无 per-call 覆盖）在 **text**（默认）与 **json** 之间切换模型侧呈现的工具参数契约。

> **2026-09-08 决策覆盖（#53 实施期，用户裁定，取代本节原先的「schema 保持 object 根」定案）**：text 模式下工具暴露的 `parameters` **就是 `{"type":"string"}`**——整次调用是一段纯文本，schema 本体即文本契约，不靠 description 引导；`json` 模式保持 object schema 逐字节不变。运行时双通道仍然成立：字符串走文本解析，对象走同一 object schema 校验，两条路最终进入同一个 execute body（payload 等价）。

text 模式的具体形态：`parameters: {type:"string", description:"Plain-text <tool> payload: …"}`；模型产出纯文本 → `parseArguments` 对非 JSON 输入保留字符串 → `execute` 解析为 JSON 等价 args 并校验 → 同一 body 执行。

四个工具 read / write / edit / grep 都有文本形态。DSL 由**共享词法层 + 每工具独立文法**组成，施用于：共享 grammar-core 提供行解析、`key: value` 冒号选项行、heredoc 哨兵、`#` 注释、错误回显；每工具自己的 payload 布局绑定在该 core 上。解析错误整批 abort（与 JSON 批次原子性对齐），错误码新前缀 `E_PARSE_*` / `E_DSL_*`。

write 在 text 及其他模式一律由**插件 shadow 版接管**（消灭 post-execute hook）：模型通道返回 auto-read 文本（写后 `行号:锚点` 的自读视图），web 通道渲染 **write 自己的卡片**（有 diff 能力，覆盖时展示前后 diff）。

## User Stories

1. As a model step running an agent loop, I want to call `read` with a first-line `<file_path>` payload, plus optional `offset:`/`limit:`/`line_numbers:` option lines — so that the most frequent single-path read is free of JSON ceremony.
2. As a model step, I want to call `grep` with a first-line `<pattern>` plus optional `path:`/`include:`/`regex:`/`context:`/`limit:`/`line_numbers:` option lines, so that search parameters are written naturally without quoting.
3. As a model step, I want to write a file with a first-line `<file_path>` followed by `<<<END` + arbitrary multi-line body + `<<<END`, so that file bodies with newlines/quotes never need escaping.
4. As a model step, I want the heredoc terminator `<<<END` to be the single recognized sentinel across all four tools, so I only learn one boundary rule.
5. As a model step, I want to express any JSON scalar option (offset, limit, includes, regex, context, line_numbers, sandbox_permissions, justification) as `key: value` option lines, so text mode loses no capability versus JSON.
6. As a model step, I want to edit with `edit <file>` + an op line (`replace <anchor> [<anchor_end]>` / `del <anchor>` / `ins <anchor>`) plus an optional `<<<END` lines block, so edits read like a script.
7. As a model step, I want to edit several files in one edit call via `@@ <path>` file sections, so multi-file edits that JSON supports remain reachable in text mode (per-file path parity).
8. As a model step, when `require_line_content` is on, I want anchors to carry their line's current text as the read row (`<序号>:<锚点>: <当前全文>`), so that declaration/verification discipline works identically to the JSON `{ anchor, line }` pairs.
9. As a model step, I want comments (`#`) honored on option/header/first lines and ignored, so I can annotate a long edit script without breaking it.
10. As a model step, I want any malformed text (unrecognized op, unterminated heredoc, unknown option) to abort the whole call with `E_PARSE_*` including the offending line number + expectation vs actual + a full example, so I can self-correct without side effects.
11. As a model step, I want the same tool call accepted via JSON when `input_format` is json, via either channel when it is text, so my agent keeps working regardless of how the config changed.
12. As an agent-loop operator, I want text parsing to be strict and atomic (`E_DSL_*` mirrors `E_BATCH_ABORT`), so a half-parsed request never writes to disk.
13. As an operator/user, I want to keep wiring `write` — it always appends a fresh auto-read preview to the model-facing content — whether I call it via text or JSON.
14. As a web UI user, I want write results to render a write-specific card (diff on overwrite, content view on creation) rather than a bare text dump, so I see what changed without reading the model stream.
15. As a developer of this plugin, I want the text parse to land in one shared parser module with per-tool bindings, so tests against the parser cover all four tools without four duplicated matchers.
16. As a maintainer, I want all these text-only behaviors to be switchable off at the config key default (`text`), with the docs showing that the JSON channel remains fully reachable, so no user is forced to adopt the new channel.
17. As an implementation ticket reader, I want the four tool grammars (read/grep/write/edit) spelled out as canonical text forms with examples, so coding #53 has a single source of truth.

## Implementation Decisions

### 1. Text DSL shape — shared lexical core, per-tool grammars

- Introduce a shared **text-input parser core** (`src/text-input/`): line-oriented state machine handling `key: value` option rows, `<<<END` heredoc blocks, `#` comments, and structured error rows. Each tool binds a small per-tool grammar to this core; read/grep/write/edit each provide their own payload field order.
- Entry: each tool's `execute(args, exec)` begins with `typeof args === "string"` — when the string is a valid JSON object the tool ignores it as a string (JSON channel always wins when parseable); otherwise (parseArguments fallback to string) the text branch of the same execute routes to the parser.
  - The remaining channel is passed unchanged to the JSON continue — i.e., JSON channel is the default runtime when the string parses as an object; text is a pure addition.
- Heredoc: a single shared sentinel `<<<END` on its own line opens and closes an arbitrary block; content inside heredoc is parsed as a whole (no options/comments/anchors re-parsed); escape-free: nothing inside the block is special except a line exactly `<<<END`.
- Anchor representation in edit: when `require_line_content` is enabled, anchors in edit ops are written as the full read row `<anchor>:<line>: <current text>` (var-len Base62 + line hint + declaration); decoding keeps the JSON `{ anchor, line }` pair semantics exactly (E_* discrimination for a missing declaration as today).
- Multi-file edit: the first-line `<default_path>` is the single-file form; any `@@ <path>` line switches the current target file for subsequent ops (each section is a list of ops). This is isomorphic to JSON edit's per-item `path` override / top-level `path` default — a `@@ <file>` section corresponds to `{ path }` prefix for the group. The DSL never writes the tool name — the tool name is the call symbol, not a payload prefix.

### 2. Config: `input_format`

- Add `hashline.input_format: "text" | "json"` (default **text**) in the settings schema. No per-call override.
- **It DOES select the wire schema** (superseding note above): `text` → `parameters: {type:"string"}`; `json` → the compiled object schema. The non-selected channel is still accepted at runtime.
- **All settings are hot**: any effective change (`input_format`, `require_line_content`, `output_format`, `separator`, `context_lines`) disposes and re-registers every tool + guidance section on every live agent (the issue #75 mechanism, generalized) — no restart.

### 3. write shadow ownership

- `write` is fully taken over by a shadow tool (in the scope layer, like read/edit/grep/undo registration). The previous `write-hook` post-execute listener is removed.
- The shadow `write` returns the write's `{path, operation, before, after}` and adds the same auto-read preview to the model-facing content (`行号:锚点` self-read) regardless of channel.
- For web: reuse the existing `card:"diff"` convention — `presentationMeta` carries `{ diffs: [...] }` with `computeHunkDiffs` when `before !== null` (overwrite), empty/`newText` view when creating. This matches the native `write` output contract (`create`/`update`, before null on create), so the client-side write card renders a diff for overwrites and content for creates.

### 4. Grammar routes on empty/invalid input

- Any unknown tool construct (unknown option key, malformed heredoc header, option before the primary payload when unsupported) yields `E_PARSE_*` with row context, and the whole call aborts without side effects (mirroring `E_BATCH_ABORT`). JSON channel error set (`E_*`, served-range, sandbox) is unchanged and shared with the JSON side.

### 5. Description/guidance text

- The per-tool `description` (and the guidance sections) are generated from the effective config: in text mode they teach the plain-text payload grammar (first line = primary payload, `key: value` rows, `<<<END` heredocs, `@@` sections); in json mode they describe the JSON keys. The string parameter carries its own payload description. No second tool is registered — one builder (`buildChannelTool`) emits either contract.

## Testing Decisions

- **What is a good test**: only external behavior — text input → parsed payload (equivalence with the JSON payload the same tool would accept), abort semantics, heredoc boundaries, error text with line numbers, `E_PARSE_*` code surface, and edit multi-file grouping into per-file ops. Not internal parser state.
- **Modules under test**:
  - text-input parser core (new, unit): option lines, heredoc open/close, comments, primary-payload ordering, error rows; equivalence tests that a parsed text payload equals a canonical JSON payload.
  - read/grep/write/edit execute channels: same behavior for text and JSON channels (dual-channel parity suite); sandbox and undo keep the existing seams.
  - write shadow: write via text → returns auto-read preview + `before/after`/diff metadata; write via JSON → same channel, and the auto-read preview is present in both contents (assert).
  - settings / channel contract (`test/core/channel-contract.test.ts`): text mode advertises `{type:"string"}` on all four tools (no `properties`/`required` leftovers); json mode keeps the compiled object schema; descriptions switch with the mode; an object payload still executes in text mode and a schema-invalid object still rejects; every effective setting change fires exactly one rebuild and no-change commits fire none; unsubscribing stops rebuilds.
- **Prior art**: `test/core/hashlane.parse.test.ts`, `error-codes.test.ts`, `multi-file-atomicity-contract.test.ts`, `read-and-serve.test.ts`, `write-shadow` (to be added) — these already assert payload/atomic/parse invariants for the JSON side, reused for the text side via the shared core.

## Out of Scope

- AST / block-addressing syntax (Wayfinder #29 owns it; text DSL does not design AST addressing).
- `line#hash` legacy anchor form (rejected by `E_BAD_REF` — unchanged).
- Per-tool `input_format` or per-call override (global config only, explicitly fixed).
- Batching multiple tool calls in one text payload: one tool call = one text payload (this spec does not define a composite call markup; the map notes this is absent).
- Model-side exact text generation formatting beyond the documented grammars; no prompt-engineering beyond the tool description/guidance text points.
- PTC mode (`tools.mode: 'native'` current; PTC out of scope — its own ticket when enabled).
- `output_format` changes; `hash_length`; `separator` — orthogonal, already specified.
- `batch_edit` resurrection or 0.4-contract rewrites.

## Further Notes

- The DSL is not a user-visible shell; it is the model's input contract. It should mirror the JSON options exactly for parity.
- `E_PARSE_*` codes are new; existing `E_*` codes (anchors/served-range/sandbox) are unchanged and shared between the two input channels (a text edit that reaches the engine passes through the same hunk engine — atomicity standard maintained).
- Reading the spec: guideline text flows to the model through the tool schema `description` alongside the guidance sections; the spec text here is the contract, not the copies (avoid drift).
- On completion of #53 implementation, update README/README.zh and possibly a dedicated `docs/text-input-usage.md`; keep the spec as the single source of the grammars.