# Changelog

All notable changes to the `dsh-hashline-edittool` plugin will be documented in this file.

## [Unreleased]

### Changed — edit/write 卡统一为 grep 卡的 tab 形态（wayfinder #91/#96）

- **已发布卡片的行为变更**：#82 定下的「仅多文件画 tab、多文件时换行」被推翻 —— edit / write 卡现在**单文件也画一个 tab**（`≥1`），溢出改为**按宽度折叠 + portal `Menu`**（不再换行、也不滚动），与 grep 卡同构。`DiffRowsBlock` 的 `groups.length > 1` 门槛与体内那行路径（`kind: "path"`）已移除 —— tab 已承载文件身份，体内重复画路径没有意义。
- **tab 条抽为公共组件** `client/src/client/tab-strip.tsx`（issue #96）：测量、`foldTabs`、溢出触发器与菜单、键盘切换、aria 接线全在组件内，grep 卡与 diff 卡共用同一份实现；组件为**受控**（active 索引与行数据仍由各自卡片持有）。
- **单文件 group 由 client 合成**（`models.ts` 的 `diffCardGroups`）：host 与 `presentationMeta` **零改动**；无 `diffRowGroups` 的单文件 meta（含**所有** 0.5.x 以前的历史会话）与新多文件 meta 走同一条路，各自都有且只有一个 tab。
- 无新增 locale 键：溢出菜单的可访问名仍复用 `common.more`；tab list 的名字用卡片自己的标题。
- read 卡不受影响（它没有 tab 栏）。

### Added — grep 卡片 web 渲染接管（wayfinder #88/#89/#90/#92）

- **`grep` 的 web 卡片由本插件 client 半区接管**（keyed `tool.call.toolview` × `key: "grep"`，`priority: -1`，与 read/edit/write 同机制）：卡顶**文件 tab 栏**（只有一个文件匹配时也保留一个 tab）、左 `行号:锚点` gutter / 右内容，**每行命中文本高亮**（含上下文行、一行多出现全高亮、正则整段匹配、零宽跳过）。
- **tab 栏按宽度折叠而非横向滚动**（真机效果评审后修订，取代最初的单行横滚规则）：`foldTabs()` 按实测宽度把文件分到可见区与溢出菜单，容器尺寸变化时用 `ResizeObserver` 重算；溢出按钮（`IconEllipsisOutline16`）开一个 **portal `Menu`** 列出被折叠的文件（portal 模式避开卡体自身裁剪），可访问名复用既有的 `common.more`；**正在阅读的 tab 永不被折叠**（它占最后一个可见位，被挤掉的那个进菜单）；仅一个文件时即使容器更窄也不折叠。
- **命中高亮改为常用高亮黄** `#ffe066` + 强制深色文字 `#1f1f1f`（两套主题下均可读）。主题**没有任何黄色 token**（暖色只有 amber 族，最浅档读起来是奶油色），所以颜色写死在插件自带样式表里。
- **host `presentationMeta` 结构化行契约**（ADR-0005）：`files[].rows[] = {number, hash, text, match?, spans?}` —— 行字段对齐 read 的 `hashlines`；`match: true` 只标真命中行（零宽模式下 `spans` 非空 ≢ 命中）；`spans = [[start,end),…]` 为 UTF-16 索引、由 host 计算，client 绝不重跑匹配、绝不解析 modelText。
- **meta 体积上限 64 KiB**（对齐内置 `SEARCH_META_MAX_BYTES`）：超出则从尾部丢弃整个文件组（至少留 1），`total` 保留、`truncated` 置真。
- **降级三档**：无 `rows`（旧会话/畸形 meta）→ 通用 I/O 卡；有 `rows` 无 `spans` → 新卡不高亮；有 `spans` → 高亮。
- 卡体自绘（fork `ReadBlock` 布局），**不含语法着色** —— 版本要求：`ReadBlock`/`CodeBlock` 的行内容只能是 `string`、着色 tokenizer 未导出、无行内 span 注入口，而高亮是本卡的核心；edit / write 卡本来也无着色。
- 移除旧字段：`files[].matches[]`（实测为「整段 section 文本」重复，非该行文本）与 `lang`；`presentResult` 保留但改为只喂真命中行（纯文本）。

### Added — grep 卡片测试与文档

- `test/core/grep-card-meta.test.ts`（22 项）：span 扫描边界、64 KiB 上限与丢组顺序、三档降级与畸形矩阵、上下文行标记/高亮、0 命中空卡、`presentResult`、模型文本不变。
- `client/test/grep-card.test.ts`（27 项）：卡模型与降级、切段（含「切段拼接恒等于原文」扫描）、gutter、footer 计数、grep 行 chrome（variant / `tool.title.grep` / pattern 摘要 / 无文件链接），以及 `foldTabs` 的 9 项边界（放得下不折叠、溢出从尾部折、active 钉住含「被顶替的 tab 更宽」与「一个都放不下」、单 tab 永不折叠、空/零宽/越界输入）。
- `client/scripts/verify-bundle.mjs` 断言新增的第 4 个 toolview 注册（`grep:-1:conversation`）。
- 新增 `docs/adr/0005-grep-card-presentation-meta.md`；`docs/web-ui-structured-views-spec.md` 标注为已被取代。

## [0.5.1] - 2026-09-10

### Fixed — 发布产物携带陈旧构建文件（0.5.0 打包缺陷）

- **根因**：`build` 只做增量 `tsc`、从不清理输出目录，且 `prepublishOnly` 只重建 client 半（`build --prefix client`）未重建主包——`src/` 中已删除的文件（本轮移除的 text 输入实现 `lib/text-input/*`、`lib/write-hook.js`、`lib/surface-rebuild.js` 及其 `.d.ts`，共 12 个）残留在 `lib/` 内并被 `files: ["lib", …]` 打进 0.5.0 的 npm 包。运行时无影响（`lib/index.js` 不引用它们），但属打包污染且会随每次发布复现。
- **修复**：新增 `npm run clean`（`scripts/clean.mjs`，清除 `lib/` 与 `client/lib/`）；`build` 前置 clean；`prepublishOnly` 改为完整 `npm run build`（typecheck + 全量测试 + 干净重建 + tag 门禁）。已验证 `npm pack --dry-run` 不再含任何陈旧文件。

## [0.5.0] - 2026-09-10

### Added — write 工具 shadow：模型侧 auto-read 内联 + web 卡片 `行号:锚点`（#53，PR #87）

- **`write` 由插件影子接管**（`src/tool-write-shadow.ts`，agent scope 层 `defineTool` 注册）：参数词汇 `{file_path, content, sandbox_permissions?, justification?}` 与返回值 `{path, operation, before, after}` 与内置工具完全一致，JSON 契约不变；`diffRows` / `modelText` 为增量字段。
- **模型通道内联 auto-read**：execute 内直接 `readAndServe`，写后立即返回 `行号:锚点` 预览，模型无需追加 read 即可继续编辑；原 post-execute `write-hook` 监听器删除（不再依赖 hook 管线）。
- **web 卡片左栏 `行号:锚点`**：`presentationMeta.diffRows` 携带结构化行（`kind` / `lineNumber` / `anchor` / `text`，由 `genDiff` + 会话锚点分配器计算）；client 新增 `HashlineWriteRow`，以 `priority: -1` 接管 `write` toolview，复用 edit 卡同一 `DiffRowsBlock` gutter——create 渲染全 `+` 行（每行带锚点），overwrite 渲染 `-`（旧锚点）/`+`/context（新锚点）。
- **降级路径**：无结构化行时 client 回落内置 intended diff；`presentResult` 在 create（无 hunks）时回落为整体新增视图，overwrite 沿用 applied hunks。
- 测试：write shadow 10 项（契约、auto-read 预览、diffRows 形状与混合行、presentationMeta/presentResult）+ client 卡片 5 项（gutter 行、混合行、降级、running、error）。

### Fixed — grep 长行静默截断（#53，PR #87）

- **grep 不再把每行截断到 200 字符 + `...`**：旧行为破坏「grep 命中可直接 edit」契约（`require_line_content` 下申报必然 `E_CONTENT_MISMATCH`），且与 README「mirrors read」表述不符。
- 修复后输出**完整行内容**；仅超过 `MAX_READ_LINE_BYTES`(200KB) 的单行隐藏并附 `read` 同款 `sed` 提示，绝不静默省略。README / README.zh 同步。
- 测试：3 项（全文与逐字一致、grep→edit 直达、200KB 隐藏与提示）。

### Removed — text 输入（text DSL）需求废弃

- 模型走 function calling 时工具参数必然被 JSON 包装传输，纯文本载荷在协议层不可达，text DSL（`input_format` 配置、`E_PARSE_*` 错误码、纯文本 schema 与解析器）整体作废并撤除（决策见 #85 / 地图 #50；实现留档于已关闭的 PR #86 与分支 `research/text-input-mechanism`）。

## [0.4.3] - 2026-09-07

### Added — edit 申报行内容校验（content echo，wayfinder map #74，契约定案 #76）

- **新配置开关 `hashline.require_line_content`（默认 false）**：开启后 `edit` 的 `edits[]` 锚点从纯字符串变为 `{ anchor, line }` 字典 —— `line` 是模型对该行当前全文的**申报**（单行、`""` 申报空行；行尾空白可省、复制 read 行的标记前缀可容忍），申报与锚点解析行的实际内容两级比对（逐字优先 → 标记前缀剥离回退，行首缩进永不 trim）一致才放行修改。三 op（ins/del/replace）全要求申报；`anchor_end` 缺省折叠时只申报 start。
- **schema 真动态**（机制实测：#75，分支 `research/edit-content-echo-schema`）：开关切换（settings 服务 onChange + `settings/updated`）触发所有存活 agent 的 edit 工具 + `tool:edit` guidance 区段 disposer→重注册，模型下一步即见新参数集（dsh 工具清单逐步重组、非会话快照；先例 dsh-tool-subagent）；`execute` 内保留运行时 config 校验兑底（陈旧 schema 会话不穿帮）。
- **双向硬拒**：开态传纯字符串 = 申报缺失（`E_BAD_SHAPE` 引导补 `line`）；关态传字典 = 形状错误（提示可开启配置）。schema 所见即校验所得。
- **新错误码 `E_CONTENT_MISMATCH`**：申报不匹配时回显实际行全文 + 「该内容当前位于行 N, M…」自动纠偏提示（主防线场景：模型拿错锚点）。校验时序 = 锚点解析 → served E_STALE → 申报校验 → 应用；任一 item 不匹配整调用拒绝（维持全原子语义）。
- **测试**：24 项新契约测试（开关两态 schema 形状、三 op × 单行/范围、双向硬拒、两级比对含标记样内容无误伤、回显与同内容提示、批量原子性、served 先行时序）。
## [0.4.2] - 2026-09-06

### Added — 伴随 client 插件：web 原生级 read/edit 卡片（issue #71，方向 B）

- **新伴随包 `dsh-hashline-edittool-client`（浏览器半内置于本包 `client/` 构建工作区）**：dsh web 的 Cordis client 插件，从已持久化的 `presentationMeta` 渲染 hashline 品牌卡片——read 卡复用官方 `ReadBlock`（唯一差异：gutter 渲染 `<行号>:<锚点>`，来自 meta `hashlines`）；edit 卡由结构化 `meta.diffRows` 驱动（fork 版 DiffBlock + gutter，官方配色）：`+`/context 行 gutter 显示 `<新行号>:<新锚点>`（链式编辑可直接复制），`-` 行显示旧行号（旧锚已失效不显示锚点），多 hunk 完整呈现不再退化为 generic；折叠行附 caption 级锚点提示（`@12:a3f`，读自调用自身 `edits[].anchor_start`）。注册走 keyed `tool.call.toolview` slot `priority: -1`（slot 台账按升序 shadowing，同 key 同优先级会 throw，显式 -1 确定性接管、不碰内建注册）。
- **渲染通道与模型通道彻底分离**：web 卡片数据一律来自 presentationMeta（结构化、可演进），绝不解析给模型看的 modelText（其格式/分隔符可随时调整）。本版同时移除 read 结果的 dsh 信封（方向 B 替代方向 A，模型每次 read 少 4 行包裹；json 模式恢复纯 JSON；`extractReadBody` 保留对旧会话历史的信封剥离容忍）。
- **单包单装**：浏览器半就是主包的一部分（`exports["./client"]`，`dsh.client` 声明在主包 manifest），`dsh plugin add dsh-hashline-edittool` 一次装齐 host 工具 + web 卡片；发布同版本同包，无第二依赖。
- **卸载/禁用无残留（已实测）**：client 行禁用后 web boot graph 完全不含该包（smoke profile 重启实测 46→0 提及）；slot 注册走调用方 fiber 的 `ctx.effect`，卸载级联清除，内建卡片即刻回归。
- **验证**：client 构建工作区测试 22 项（卡片模型）+ `scripts/verify-bundle.mjs` 无头评估构建产物（factory 形状、externals 绑定、注册行为）；CI 新增 `verify-client` job（node 22/24）。

### Changed — v2.0 dynamic anchors（dynamic hashline，wayfinder #56）

- **变长动态锚点（v2.0 契约，PR #65）**：锚点为变长 Base62（最短优先 2 位起步——2 字符层覆盖 3,844 行；分层上浮、删除回收复用、会话内跨编辑稳定）；行号退出锚点，旧 `line#hash` 格式直接 `[E_BAD_REF]` 拒绝；可选 `line_numbers` 输出参数（默认关闭）渲染 `<line>:<anchor>`；`hash_length` 配置删除；`Shift:` 块删除（编辑后从 diff 行取新锚点）；served 内容校验防线（`ServedRow {position, anchor, contentKey}`）。
- **真机冒烟缺陷修复（PR #67，wayfinder #66）**：
  - **B1** — json 输出模式的 read 视图按 v2.0 裸锚契约重建（旧分支按 `<number>#<hash>` 拆键产生 NaN，违反 lossless JSON 校验导致 json 模式全挂）。
  - **B2** — 粘贴行锚点前缀剥离：条件为「前缀锚存在于当前文件的锚集合」（post-edit diff 行可剥离；`sep: "|"` 等字面冒号行永不被改写）；行锚正则分隔符感知（`:` 并入），`:`/`|` 形态对称。
  - **B3** — grep 多文件命中时 `ANCHOR:FILELINE` 格式 header 仅出现 1 次（原先每文件一次）。
  - **B4** — 锚快照投毒自愈：`anchorsFor` 对缓存快照做长度校验（checksum 命中不再信任长度漂移的锚数组，失配即确定性重算）；增量锚更新对越界行防御性跳过（原 `undefined.replace` 崩溃路径）。
  - **B5** — `line_numbers` 参数在 read 全链路生效（`readView` 透传 + 工具层 `buildReadPresentation` 渲染，此前参数被静默忽略）。
  - **B6** — 带行号 hint 的锚一律按锚解析权威行号（`pinBound`；未验证 hint 流入批量簿记曾导致 `canon(undefined).replace` 崩溃）；hint 与解析结果不符时新增 `[E_LINE_HINT]` warning（不符仅提示，不拒绝）。
  - **B7（保真契约）** — 边界重复检测降级为 `[E_PASTE_DUP]` warning-only：删除了把「新内容与相邻行相同」的替换行静默 splice 掉的 auto-fix（该行为会把合法替换变成删除且零提示，并使增量锚簿记错位）。**除锚点前缀剥离（且仅当锚点真实存在）外，工具对模型提交的内容零修改。**
- 新错误码：`[E_LINE_HINT]`、`[E_PASTE_DUP]`（README 错误码表同步，`E_BARE_HASH_PREFIX`/`E_INVALID_PATCH` 措辞更新为新语义）。
- 文档：README / README.zh 全面向 v2.0 契约迁移（变长锚点、无 Shift 块、line_numbers、json 形状）；配置示例移除 `hash_length`；指南种子文件（`<preset>/*.md`）重播种。
- **grep `regex` 开关默认改为 true（v2.0.2）**：pattern 默认按 JavaScript 正则解析，`regex: false` 退回字面子串匹配（工具 schema / 描述 / guidance / README 同步）。
- **错误 UX 修复**：失效裸锚不再把 `-1` 哨兵泄漏进 `line -1..-1 is out of range` 消息——改由 mismatch 渲染器输出 `[E_STALE]` + ±上下文回显 + fresh markers；越界闸门仅在存在真实行声明（解析行号或显式 `<line>:<anchor>` 提示）时触发。

### Fixed — dsh 0.1.2 适配补全（issue #69）

- **read 卡片恢复（web 端 dsh 0.1.2 raw-events 卡片推导，实测通过）**：`read` 参数 schema 改为仅声明 `file_path` 规范拼写（`path` 参数移除——web 从 raw args 读 `file_path`，保留别名会导致卡片退化；执行层 `normalizeRequest` 仍容忍旧 `path` 调用，直接 API 调用方不受影响，只是无卡片）；modelText 包裹 dsh 原生 `<path>/<type>/<content>` 信封（信封正则只验存在、内容不校验，卡片数据仍走 `presentationMeta`；模型看到的内容不变，仅多 4 行包裹）。
- **settings 服务不可见的直接读兜底 + 后台重试接管（重启实测发现）**：`ensureSettingsService` 的“已在他处注册”容忍路径会返回 true 但 `ctx.get("settings")` 因提供 fiber 未启动（strict）而拿不到服务 → 旧代码静默跳过 section 注册。现在：不可见时直接读 `settings.yaml`（含 fs.watch 热更新、ctx 卸载清理）保持配置存活，并后台重试；服务可见后真正注册 section 并退役兜底（各阶段均有日志）。
- **edit `op:"del"` 容忍 `lines`（用户反馈）**：`del` 携带 `lines` 不再 `[E_BAD_SHAPE]` 硬拒——接受并忽略（删除仅由锚点定义），消除复制粘贴 replace 模式时的无谓重试。
- **settings 静默失败加固**：`settingsSvc` 解析为 undefined 时输出 console.error（不再静默跳过 section 注册——这正是 #69 问题 1 在 33fee0e 上难以定位的根因形态）；新增 `installHashlineSettings` × 真实 `@deepseek-ai/dsh-settings` 集成测试。
- **edit 呈现优化（generic 卡片可读性）**：edit/batch 响应文本的 `ANCHOR:FILELINE` 长 header 替换为单行紧凑 legend（`Diff rows: <+|-><anchor>:<content> …`；线上路径 `tool-edit.buildChangedModelText`）；锚点行格式不变，模型的锚点链编辑契约不受影响。
- **undo 提示措辞**：明确撤销 diff 中仅 `+` 行（恢复行）携带可用新锚点，`-` 行为已删除行（锚点失效）。
- **settings 集成测试扩至 6 场景**：publish 先后两种时序（含 scope.watch 自愈）、无宿主 service 直接读兜底、非法值容忍、separator 往返、服务不可见时直接读兜底 + 后台重试接管。
- **已知限制（记录）**：schemastery `z.union` 对非法值静默丢弃且整个 section 归零（如 `output_format: bogus` 连带 separator 失效），无日志——集成测试已钉住该行为，属上游语义。

## [0.4.1] - 2026-08-30

### Added

- **Multi-file `edit` dispatch** — per-item `path` now routes each edit item to its own file. Items are grouped by file; a batch touching ≥ 2 distinct files exercises the multi-file path, while a single-file call keeps the 0.4 `edit({path, edits:[…]})` shape verbatim. Top-level `path` becomes optional when every item carries its own `path` (the only new `[E_BAD_SHAPE]` case: top-level omitted and any item missing `path`); `item.path === topLevelPath` is auto-folded as an explicit normalization, not an error; the `editItemSchema` / `editsSchema` / `pathSchema` schemas enforce `additionalProperties: false`.
- **Per-file atomicity** — each file's sub-batch is processed through the existing single-file flow (read → normalize → apply → persist-undo → write) with all-or-none semantics within that file; files are independent and partial success is reported. Items targeting the same `absolutePath` auto-merge into that file's sub-batch, preserving the existing `[E_BATCH_CONFLICT]` overlap rules inside it.
- **Aggregated multi-file response** — text mode returns one `content[].text` with per-file `Successfully edited in <path>.` blocks (each with its ANCHOR:FILELINE diff) separated by `--- <path> ---` lines; failed files append `Error: [E_*] <message>` blocks. json mode returns the stringified envelope `{"ok": <bool>, "success": […per-file 0.4 JSON envelope…], "fail": […{path, code, message}…]}`. All-noop batches get a summary line.

### Changed

- Docs: ADR-0002 (multi-file schema contract), ADR-0003 (per-file atomicity), ADR-0004 (aggregated response shape) added under `docs/adr/`.

## [0.4.0] - 2026-08-27

### Added

- Configurable hashline shape via `~/.dsh/settings.yaml` (`hashline:` namespace): `separator` (default `:`), `hash_length` (default 3, 1..6), `output_format` (`text` | `json`), `context_lines` (default 3, 0..20 — unified across stale-echo, diff and grep context). No settings service installed in the deployment? The plugin mounts a read-only file-backed provider itself (`FileSettingsProvider`); `@deepseek-ai/*` packages are host-shared peer dependencies.
- **Pure-JSON output mode** (`output_format: json`): `read` returns `{path, offset, totalLines, lines: {anchor: content}}`; `grep` returns `{total, truncated, files: [{path, matches: [{anchor, text, contextBefore, contextAfter}]}]}`; `edit` returns `{ok, path, diff: {key: content}, hints, warnings, errors}` where `diff` is the text diff as an anchor-keyed dict (`-old#hash` / `+final#hash` change keys, bare-anchor context keys — aligned with read's `lines`); `grep`'s `matches` is likewise one anchor-keyed dict. Rejected edits fail loudly (throw, isError) in both modes.
- **Dual-anchor replace contract**: `replace` requires both `anchor_start` and `anchor_end` (`E_MISSING_ANCHOR_END`; single-line passes the same anchor twice); `lines` keeps **any length** — the whole range is swapped for it. `ins` inserts into the gap after its anchor line and may anchor on another hunk's range END line (half-open `N ∉ [hs, he)`), never its start/interior (`E_BATCH_CONFLICT`).
- `benchmark/text-json.mjs` — text vs json output-format token comparison.

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
