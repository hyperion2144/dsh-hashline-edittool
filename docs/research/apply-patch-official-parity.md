# 官方 `apply_patch` 完整契约调研（DeepSeek Harness 0.2.2-alpha.3）

> 目的：为 dsh-hashline-edittool「对齐官方」提供设计依据。
> 一手来源：本地检出 `/Users/mutou/vault/projects/deepseek-harness`，版本 `0.2.2-alpha.3`（`git log` HEAD `8bd073392e`，根 `package.json` version = `0.2.2-alpha.3`）。除本文件列出的仓内源码与仓内文档外，未引用任何网络二手材料。
> 路径约定：`来源：` 后的路径均**相对官方仓库根目录**；行号取自本次调研读到的文件内容。
> 调研日期：2026-11-03。

---

## 0. 结论速览

1. **官方 `apply_patch` 是「Codex 风格 patch 文本」驱动的批量多文件工具**，实现分两层：纯库 `dsh-fs-patch`（只做解析与文本应用，无任何 I/O、无路径解析）与工具层 `dsh-tool-fs`（准入、提交、输出、呈现）。语法与匹配语义对齐 OpenAI Codex `rust-v0.158.0`。来源：`packages/fs/fs-patch/src/index.ts:1-5`、`packages/fs/tool-fs/src/apply-patch.ts:1-53`、`packages/fs/fs-patch/README.md:45`
2. **执行是「两阶段」**：全量预检（语法 → 路径解析 → 逐操作模拟），**任一拒绝 → 一字不写**；预检全过才进入顺序提交，**首个失败即停，不回滚**，其后操作标记 `skipped`。来源：`packages/fs/tool-fs/src/patch/preflight.ts:136-157`、`packages/fs/tool-fs/src/patch/execute.ts:31-121`
3. **操作结果有四态**：`completed` / `failed` / `unknown` / `skipped`。`unknown` 是官方特有的「结果不可知」态（写入已发起但无法判定落盘与否），附带补救语 `— re-read the affected files before retrying`。来源：`packages/fs/tool-fs/src/patch/types.ts:57-62`、`packages/fs/tool-fs/src/patch/execute.ts:110-114`
4. **在 0.2.2-alpha.3 的随发行版组合里 `apply_patch` 默认关闭**：`bundle/base` 与 Web 的 `standard` / `ptc` / `cordis` 三个 preset 全部写 `applyPatch: false`（提交 `e1609fe164`「fix(fs): temporarily disable apply_patch in shipped defaults」）。而 `tool-fs/README.md`、`docs/tool-catalog.md`、`docs/config-catalog.md` 与 v0.2.2-alpha.2 升级指南仍写「base 与 standard preset 开启」——**这是一处文档与代码不一致**，对齐时不能照抄文档口径。来源：`packages/bundle/base/cordis.patch.yml:296-300`、`packages/bundle/web-app/presets/standard.patch.yml:27-31`、`packages/bundle/web-app/presets/ptc.patch.yml:28-31`、`packages/bundle/web-app/presets/cordis.patch.yml:31-34` vs `packages/fs/tool-fs/README.md:58`、`docs/tool-catalog.md:1178`
5. **「Review 中查看变更」与 `apply_patch` 的 `presentationMeta` 没有直接耦合**：Review 走独立的 fs 意图槽捕获 + turn 首尾 git 快照；`apply_patch` 之所以出现在 Review 里，是因为它的提交经由 `ctx.fs.writeText / patchText / deleteFile / moveFile`，这些会派发 `fs/*-intent`。来源：`packages/deliverables/workspace-changes/src/index.ts:164-187`、`packages/deliverables/workspace-changes/src/recorder.ts:300-366`、`packages/fs/tool-fs/src/patch/execute.ts:56-102`
6. **Web 端确有独立 Review 入口**：`changes-review` 侧栏 tab（地址 `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>`）+ 聊天 turn 尾部的「改动文件」卡片；卡片需开启 Coding Tools 偏好。来源：`packages/client/ui-deliverables/README.md:41-69`
7. **工具参数名是 `input`**，不是 `patch`——源码注释写明理由：与 Codex 的 `apply_patch` 同名键，在该工具上训练过的模型会自发发出这个键。来源：`packages/fs/tool-fs/src/apply-patch.ts:31`
8. **沙箱升级参数存在**：`sandbox_permissions` + `justification`，但**只在挂了约束型文件系统后端时**才出现在 schema 里。来源：`packages/fs/tool-fs/src/apply-patch.ts:39`、`packages/fs/tool-fs/src/sandbox.ts:38-46`

---

## 1. 语法文法

### 1.1 信封与词法

| 规则 | 精确行为 | 来源 |
|---|---|---|
| `*** Begin Patch` | 必须是第一行（首尾按 Unicode `White_Space` 裁剪后比较）。不匹配 → `Expected '*** Begin Patch'` | `packages/fs/fs-patch/src/parse.ts:9-10,58-60` |
| `*** End Patch` | 必须是最后一行。不匹配 → `Expected '*** End Patch'` | `packages/fs/fs-patch/src/parse.ts:10,61-63` |
| 裁剪字符集 | `\p{White_Space}`（含 U+0085），**不含 BOM（U+FEFF）**；故 `\uFEFF*** Begin Patch` 报错 | `packages/fs/fs-patch/src/parse.ts:17-18,29-39`；`packages/fs/fs-patch/tests/parse.spec.ts:99-109,156` |
| 行尾 | 按 `/\r?\n/` 切分；除最后一行外，行尾的单个 `\r` 被剥掉（Codex 的「join 后再剥 CR」行为） | `packages/fs/fs-patch/src/parse.ts:64-67` |
| 行号偏移 | 输入前的空行计入行号，所以诊断指向**原始输入**的行 | `packages/fs/fs-patch/src/parse.ts:47-49` |
| heredoc 剥壳 | 首行恰为 `<<EOF` / `<<'EOF'` / `<<"EOF"`（裁剪后）且末行以 `EOF` 结尾、且总行数 ≥ 4 时，丢弃首尾两行；**不做任何 shell 求值** | `packages/fs/fs-patch/src/parse.ts:52-54`；`packages/fs/fs-patch/tests/parse.spec.ts:48-56` |
| heredoc 终止符 | 只要求末行**以 `EOF` 结尾**（上游后缀规则，`anythingEOF` 也接受） | `packages/fs/fs-patch/tests/parse.spec.ts:54-56` |
| 末尾冗余标记 | `*** End Patch` 之后允许再出现一次 `*** End Patch`（+ 空白行），视为空 patch | `packages/fs/fs-patch/tests/parse.spec.ts:145-147` |

### 1.2 文件头

| 头 | 语义 | 来源 |
|---|---|---|
| `*** Add File: <path>` | 产生 `add` 操作；其后每一行必须以 `+` 开头，前缀去掉，每行补一个结尾 LF；允许空内容 | `packages/fs/fs-patch/src/parse.ts:13,155-157,166-167`；`packages/fs/fs-patch/tests/parse.spec.ts:41-45` |
| `*** Delete File: <path>` | 产生 `delete` 操作 | `packages/fs/fs-patch/src/parse.ts:14,158-160` |
| `*** Update File: <path>` | 产生 `update` 操作；其 hunk 列表初始为空 | `packages/fs/fs-patch/src/parse.ts:15,161-163` |
| `*** Move to: <path>` | **只能紧跟 `*** Update File:` 且在第一个 hunk 之前**；把它挂在 update 上（不新开操作）。第二个 `*** Move to:` 会报错 | `packages/fs/fs-patch/src/parse.ts:97-99`；`packages/fs/fs-patch/tests/parse.spec.ts:170-171` |
| 路径拼写 | 头里的路径**原样保留**（只裁剪头尾空白），不做路径解析、不做 Unicode 规范化；相对/绝对/重复路径都保留 | `packages/fs/fs-patch/src/parse.ts:155-163`；`packages/fs/fs-patch/README.md:59` |
| `*** Environment ID: ...` | 明确拒绝：`Environment ID headers are unsupported; the caller selects the filesystem provider`（仅在第一个操作之前才触发这条专属错误） | `packages/fs/fs-patch/src/parse.ts:164-165` |
| 未知头 | `Expected an Add File, Delete File, or Update File header; added content must start with +` | `packages/fs/fs-patch/src/parse.ts:170-171` |
| 头后多余内容 | `*** End Patch` 之后出现非空行 → `Unexpected content after '*** End Patch'`（空行容忍） | `packages/fs/fs-patch/src/parse.ts:148-150` |

### 1.3 hunk

| 元素 | 规则 | 来源 |
|---|---|---|
| `@@` | 开一个无锚 hunk | `packages/fs/fs-patch/src/parse.ts:92,101-107` |
| `@@ <text>` | 开一个带锚 hunk，`context = "@@ "` 之后的文本（`@@` 后必须是空格才带锚） | `packages/fs/fs-patch/src/parse.ts:106` |
| 隐式首 hunk | `*** Update File:` 之后**可以没有 `@@`**，直接跟 hunk 行也算第一个 hunk | `packages/fs/fs-patch/src/parse.ts:123-124`；`packages/fs/fs-patch/tests/parse.spec.ts:80-83` |
| 行前缀 `' '` | context 行，同时进 `oldLines` 与 `newLines` | `packages/fs/fs-patch/src/parse.ts:128-131` |
| 行前缀 `'+'` | 新增行，只进 `newLines` | `packages/fs/fs-patch/src/parse.ts:126` |
| 行前缀 `'-'` | 删除行，只进 `oldLines` | `packages/fs/fs-patch/src/parse.ts:127` |
| 裸空行 | 当作**空 context 行**（不是错误） | `packages/fs/fs-patch/src/parse.ts:119-120`；`packages/fs/fs-patch/tests/parse.spec.ts:64-77` |
| 缩进过的标记行 | ` *** Add File: b` 等在 update 内部**保持为 context 行**，不会被当成新头 | `packages/fs/fs-patch/tests/parse.spec.ts:85-91` |
| `*** End of File` | 给**前一个** hunk 打 EOF 标记；之后空行忽略，其它内容必须以新 `@@` hunk 或新文件头开始，否则 `Expected '@@' after '*** End of File'`。EOF 出现在第一个 hunk 之前时**无效果** | `packages/fs/fs-patch/src/parse.ts:93-96,110-117`；`packages/fs/fs-patch/tests/parse.spec.ts:128-142` |
| 空 hunk | 拒绝：`Update hunk must contain context, added, or removed lines` | `packages/fs/fs-patch/src/parse.ts:80-81,102-103,112-113` |
| update 没有 hunk | 拒绝：`Update for '<path>' requires at least one hunk`（在下一个头或 End Patch 处抛） | `packages/fs/fs-patch/src/parse.ts:74-83` |
| 非 hunk 行 | `Expected a context (' '), added ('+'), removed ('-') line, or '@@'` | `packages/fs/fs-patch/src/parse.ts:119-121` |

### 1.4 错误消息模板（逐字）

解析器抛 `PatchParseError`，`message` 模板固定为 **`Invalid patch at line <N>: <reason>`**（N 是原始输入的 1 基行号），`name = 'PatchParseError'`，另有 `lineNumber` 与 `reason` 两个字段。来源：`packages/fs/fs-patch/src/parse.ts:20-26`

全部 `reason` 字符串（逐字）：

| reason | 触发点 | 来源 |
|---|---|---|
| `Expected '*** Begin Patch'` | 首行不匹配 | `packages/fs/fs-patch/src/parse.ts:59` |
| `Expected '*** End Patch'` | 末行不匹配 | `packages/fs/fs-patch/src/parse.ts:62` |
| `Update for '<path>' requires at least one hunk` | update 无非空 hunk | `packages/fs/fs-patch/src/parse.ts:78` |
| `Update hunk must contain context, added, or removed lines` | 空 hunk | `packages/fs/fs-patch/src/parse.ts:81` |
| `Expected '@@' after '*** End of File'` | EOF 后出现非空非 `@@` 行 | `packages/fs/fs-patch/src/parse.ts:95` |
| `Expected a context (' '), added ('+'), removed ('-') line, or '@@'` | hunk 内非法行 | `packages/fs/fs-patch/src/parse.ts:121` |
| `Expected an Add File, Delete File, or Update File header; added content must start with +` | 未知头 / add 块内非 `+` 行 | `packages/fs/fs-patch/src/parse.ts:171` |
| `Unexpected content after '*** End Patch'` | End Patch 后有非空内容 | `packages/fs/fs-patch/src/parse.ts:149` |
| `Environment ID headers are unsupported; the caller selects the filesystem provider` | Environment ID 头 | `packages/fs/fs-patch/src/parse.ts:165` |

35 条畸形输入 → 行号 + reason 的对照表见 `packages/fs/fs-patch/tests/parse.spec.ts:150-198`（覆盖首行缺失、heredoc 变体、unified diff、shell 命令、空路径、重复 Move to、EOF 后加行等）。

---

## 2. 匹配语义

### 2.1 定位方式

- **所有搜索都针对「原文」**：先把每个 hunk 在原文里定位完，再统一构造结果；任何一处匹配失败就**整体失败，不返回半成品**。来源：`packages/fs/fs-patch/src/apply.ts:57-64,71-101`；`packages/fs/fs-patch/src/types.ts:51-54`
- **`@@ context` 是「锚点 + oldLines」两段式**：先用 `context` 单行在当前游标处搜（游标 = `lineIndex`），命中后游标推进到 `锚点行 + 1`；然后用 `oldLines`（= context 行 + 删除行）从该游标继续搜，命中后游标推进到「匹配段末尾」。来源：`packages/fs/fs-patch/src/apply.ts:71-101`
- **游标是顺序推进的**：后一个 hunk 只在游标之后找；找不到就是失败（不回绕）。来源：`packages/fs/fs-patch/src/apply.ts:39-41,69,78,101`
- **EOF hunk 只搜尾部**：`eof` 时起点被强制为 `lines.length - pattern.length`，**即使它在游标之前也不回退**（源码注释指出这是与上游搜索函数注释相反的**已钉死行为**）。来源：`packages/fs/fs-patch/src/apply.ts:36-41`；`packages/fs/fs-patch/README.md:72`；`packages/fs/fs-patch/tests/apply.spec.ts:54-55,98`
- **纯插入（`oldLines` 为空）插到原文末尾**：若原文末尾有一个空源行，则插在它前面；插入**不推进游标**（锚点仍须先匹配上）。来源：`packages/fs/fs-patch/src/apply.ts:80-83`；`packages/fs/fs-patch/README.md:73`

### 2.2 宽容匹配：四级 pass

每一级 pass 都会**扫完全部候选**才进入下一级，顺序固定：

1. 精确相等；
2. 两端去尾随空白（`rstrip`）；
3. 两端去空白（`trim`）；
4. 去首尾空白 + Unicode 标点映射成 ASCII。

来源：`packages/fs/fs-patch/src/apply.ts:29-34,42-47`

标点映射表（逐字）：U+2010–2015 与 U+2212 → `-`；U+2018–201B → `'`；U+201C–201F → `"`；U+00A0、U+2002–200A、U+202F、U+205F、U+3000 → 空格。**不做 NFC/NFKC 规范化**；BOM 不是 Rust `White_Space`，因此不参与裁剪。来源：`packages/fs/fs-patch/src/apply.ts:21-27`；`packages/fs/fs-patch/README.md:70`；`packages/fs/fs-patch/tests/apply.spec.ts:77-88,100-102`

### 2.3 行尾空行的「哨兵重试」

当 `oldLines` 模式**以空行结尾**且首次匹配失败时：去掉最后那个空行再搜一次；同时若 `newLines` 也以空行结尾，一并去掉最后一行。重试后仍失败才报失败。来源：`packages/fs/fs-patch/src/apply.ts:89-93`

- 空模式（去掉哨兵后为空）会**匹配当前游标**。来源：`packages/fs/fs-patch/src/apply.ts:38`
- **失败时上报的 `pattern` 仍是原始模式**（含那个空行哨兵），不报重试后的模式。来源：`packages/fs/fs-patch/src/apply.ts:97`；`packages/fs/fs-patch/tests/apply.spec.ts:99`；`packages/fs/fs-patch/README.md:74`

### 2.4 失败诊断字段（`HunkApplyFailure`）

| 字段 | 类型 | 含义 | 来源 |
|---|---|---|---|
| `hunkLineNumber` | number | 失败 hunk 在**补丁输入**中的 1 基行号 | `packages/fs/fs-patch/src/types.ts:41-42` |
| `stage` | `'context' \| 'oldLines'` | 失败发生在**锚点搜索**还是**旧内容搜索** | `packages/fs/fs-patch/src/types.ts:43-44` |
| `searchStart` | number | 0 基**顺序搜索游标**；EOF 搜索会把它覆盖成尾部候选 | `packages/fs/fs-patch/src/types.ts:45-46` |
| `pattern` | string[] | 原始锚点或旧内容行（含被重试掉的尾部空行） | `packages/fs/fs-patch/src/types.ts:47-48` |

失败**不抛异常**，而是返回 `{ ok: false, failure }`，让调用方能跨文件收集失败。来源：`packages/fs/fs-patch/src/types.ts:51-54`；`packages/fs/fs-patch/README.md:40`

### 2.5 换行与重建

- **CR 是普通字符**：匹配器只看调用方给它的 LF 归一化文本；CRLF/CR 的还原由后端负责（DSH 提供方保留原行尾风格，故 `PreserveLineEndings` 未实现）。来源：`packages/fs/fs-patch/src/apply.ts:61`；`packages/fs/fs-patch/README.md:79,101`
- **重建算法**：切分后先丢掉末尾那一个空元素 → 稳定排序的替换**逆序**应用 → 除非已有末尾空元素否则补一个 → 用 LF 连接。空输出保持空；非空输出必以 LF 结尾。来源：`packages/fs/fs-patch/src/apply.ts:104-115`；`packages/fs/fs-patch/README.md:75`
- **没有 hunk 也照常重建**（补 LF、吃掉一个尾部空行）。来源：`packages/fs/fs-patch/tests/apply.spec.ts:113-119`

### 2.6 提供方侧（进入真实提交后）

补丁在**变更锁内**对 LF 归一化文本执行；不匹配报 `FS_PATCH_MISMATCH`，消息带 hunk 行号与失败 stage。来源：`docs/subsystems/filesystem.md:193,367`

---

## 3. 执行语义

### 3.1 三个阶段

`PatchExecutionReport` 是三选一：`{phase:'syntax', failure}` / `{phase:'preflight', refusals}` / `{phase:'commit', outcomes, affectedPaths, cancelled}`。来源：`packages/fs/tool-fs/src/patch/types.ts:64-68`

`executePatch` 的流程：解析（失败 → syntax 报告）→ 计划（解析路径）→ 预检 → 有拒绝就返回 preflight 报告，否则提交。来源：`packages/fs/tool-fs/src/patch/index.ts:22-36`

### 3.2 预检（preflight）查什么

预检是**纯模拟**，不产生任何观察（`fs/observed`）、不写盘；它会**模拟前面已成功的操作**（同一目标的后续操作走模拟状态）。来源：`packages/fs/tool-fs/src/patch/preflight.ts:1,75-78,132,136-157`

| 检查 | 失败码 | 来源 |
|---|---|---|
| 路径解析失败 | 解析错误（保留补丁里的原始路径拼写） | `packages/fs/tool-fs/src/patch/plan.ts:26-33,42-65` |
| 目标不是普通文件 | `FS_NOT_REGULAR_FILE` | `packages/fs/tool-fs/src/patch/preflight.ts:39-43` |
| 源不存在 | `FS_NOT_FOUND` | `packages/fs/tool-fs/src/patch/preflight.ts:47` |
| 源已读但版本已变 | `FS_STALE_VERSION` | `packages/fs/tool-fs/src/patch/preflight.ts:49-51` |
| 目标未读就覆盖 | `FS_NOT_OBSERVED` | `packages/fs/tool-fs/src/patch/preflight.ts:57-59` |
| 目标版本已变 | `FS_STALE_VERSION` | `packages/fs/tool-fs/src/patch/preflight.ts:60-62` |
| 源是符号链接（delete / move） | `PATCH_SYMLINK_SOURCE` | `packages/fs/tool-fs/src/patch/preflight.ts:93-97` |
| move 源与目标同一身份 | `FS_SAME_TARGET` | `packages/fs/tool-fs/src/patch/preflight.ts:90-92` |
| 内容含 NUL 字节 | `FS_NOT_TEXT` | `packages/fs/tool-fs/src/patch/preflight.ts:65-73` |
| hunk 匹配不上 | `FS_PATCH_MISMATCH`（带 `hunkLine`，消息含 ≤80 字符预览，超出以 `…` 结尾） | `packages/fs/tool-fs/src/patch/preflight.ts:116-123` |

- **沙箱围栏不在预检里模拟**：由提供方在提交时决定，和 `write`/`edit` 一样。来源：`packages/fs/tool-fs/src/patch/preflight.ts:137-139`
- **预检会收集全部相互独立的拒绝**（不短路），但**只要有一条拒绝，整个 patch 一个字节都不写**。来源：`packages/fs/tool-fs/src/patch/preflight.ts:136-157`

### 3.3 提交（commit）语义

- **顺序提交，守卫逐个重新获取**（预检拿到的意图不缓存，提交时重新派发 `fs/*-intent`）。来源：`packages/fs/tool-fs/src/patch/execute.ts:54-68`；`packages/fs/tool-fs/README.md:132`
- **首个失败即停**：其后的操作保持 `skipped`（初值就是 `skipped`）。来源：`packages/fs/tool-fs/src/patch/execute.ts:44,116-117`
- **不回滚**：先前成功的写入留在盘上。来源：`packages/fs/tool-fs/README.md:307`；`docs/subsystems/filesystem.md:193`
- **部分移动**：目标已写、源删除失败 → 该操作状态 `failed`，但 `changes` 里**只记目标那一侧**。来源：`packages/fs/tool-fs/src/patch/execute.ts:97-100`
- **`unknown` 的判定条件**：写操作**已开始**（`started`）且错误是 `FS_ABORTED`，或 `FS_IO_ERROR` 且事后 `stat` 比对发现版本变了 / 比对失败。`unknown` **不记观察、不记变更**，消息追加 ` — re-read the affected files before retrying`。来源：`packages/fs/tool-fs/src/patch/execute.ts:17-29,106-115`
- **取消（abort）**：每次操作前检查 `exec.signal.aborted`；已取消则置 `cancelled = true` 并停住，剩余操作 `skipped`。来源：`packages/fs/tool-fs/src/patch/execute.ts:46-47,117`
- **受影响路径** `affectedPaths` = 所有已发生变更的路径去重（`completed` 与 `failed` 带 changes 的都算）。来源：`packages/fs/tool-fs/src/patch/execute.ts:119`
- **「首个操作失败且无变更」会被当成拒绝抛出**：若第一个操作 `failed` 且 `changes` 为空、其余全部 `skipped`，整个调用按 preflight 拒绝抛错（这样沙箱拒绝等会走同一条重试路径）。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:71-74`

### 3.4 「失败 = 无写入」还是「已写入不回滚」

| 情形 | 是否有写入 | 对模型的形态 |
|---|---|---|
| 语法错误 | 无 | 抛错，`isError: true` |
| 预检拒绝（任一） | **无**（整块拒绝） | 抛错，`isError: true` |
| 提交中途失败 | **有**（前面的已写） | 返回值，`isError: false`，`operations[].status = failed/unknown/skipped` |
| 被取消 | 视取消点 | 被取消的调用收到工具注册表的中止结果（与其它工具一样），已完成的效果仍能通过 Review 看到 |

来源：`packages/fs/tool-fs/README.md:84,307`；`docs/subsystems/filesystem.md:361`

---

## 4. 输出契约

### 4.1 完整 output schema

来源：`packages/fs/tool-fs/src/apply-patch-output.ts:9-38`

```
phase:        "commit"            // const，required
cancelled:    boolean             // required
operations:   Array<{             // required
  index:       integer            // required，零基的补丁内位置
  kind:        "add"|"update"|"delete"|"move"   // required
  path:        string             // required
  destination: string             // 可选，move 目标
  patchLine:   integer            // required，操作头在补丁中的 1 基行号
  status:      "completed"|"failed"|"unknown"|"skipped"   // required
  code:        string             // 可选，失败码
  message:     string             // 可选，失败消息
  hunkLine:    integer            // 可选，未匹配 hunk 的行号
  changes:     Array<{            // 可选
    path:   string                // required
    before: string | null         // required（null = 之前不存在）
    after:  string | null         // required（null = 之后被删除）
  }>
}>
affectedPaths: string[]           // required
```

- 顶层 `additionalProperties: false`，`operations` 项与 `changes` 项同样 `additionalProperties: false`。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:10,15,27`
- `changes` 携带**整文件 before/after 文本**，供渲染与 PTC 使用；**Session 落盘的 meta 不含整文件文本**。来源：`packages/fs/tool-fs/README.md:84`

### 4.2 三种渲染文本（逐字）

模型看到的文本由 `renderPatch` 产生，只有 `[{ type:'text', text }]` 一块。来源：`packages/fs/tool-fs/src/apply-patch.ts:43`；`packages/fs/tool-fs/src/apply-patch-output.ts:105-128`

**（a）全部成功（含空 patch）**

- 空 patch：`Success. No operations in patch.` 来源：`packages/fs/tool-fs/src/apply-patch-output.ts:107`
- 非空：`Success. Updated the following files:` 后每行一个完成项，**按 A → M → D 分组**（不是补丁顺序）：

  ```
  Success. Updated the following files:
  A <path>        // add
  M <path>        // update；已完成的 move 记作 M，且用目标路径
  D <path>        // delete
  ```

  来源：`packages/fs/tool-fs/src/apply-patch-output.ts:93-108`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:63`

**（b）停止（stopped）**

```
Patch stopped after <已完成数> of <总操作数> operations.
Completed:            // 仅当已完成数 > 0
<同样的 A/M/D 行>
Failed:               // status = failed
- operation <i> (<kind> <path>[ -> <destination>], patch line <L>): <message>
  destination <dest> was written; source <src> remains     // 仅失败的 move 且有已写目标
Outcome unknown:      // status = unknown
- operation <i> (<kind> <path>[ -> <destination>], patch line <L>): <message>
Not executed:         // status = skipped
- operation <i> (<kind> <path>)
```

来源：`packages/fs/tool-fs/src/apply-patch-output.ts:109-127`；样例见 `packages/fs/tool-fs/README.md:279-286`

**（c）拒绝（抛错，不是渲染文本）**

```
Patch rejected before any change (<N> problems):
- operation <i> (<kind> <path>, patch line <L>): <message>
```

注意 `problems` **没有单复数形式**（1 个问题时也是 `1 problems`）。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:51-56`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:93-95`

### 4.3 错误码集合与抛出位置

`PatchFailureCode = FsErrorCode | 'PATCH_SYNTAX' | 'PATCH_SYMLINK_SOURCE'`。来源：`packages/fs/tool-fs/src/patch/types.ts:39`

| 码 | 抛出位置 | 形态 | 来源 |
|---|---|---|---|
| `PATCH_SYNTAX` | 解析器失败 → `patchToolValue` 抛 | `PatchToolError`（继承 `HarnessError`） | `packages/fs/tool-fs/src/patch/index.ts:26-29`；`packages/fs/tool-fs/src/apply-patch-output.ts:44-48` |
| `PATCH_SYMLINK_SOURCE` | 预检（delete/move 的源是符号链接）→ 走拒绝路径抛 | `PatchToolError` | `packages/fs/tool-fs/src/patch/preflight.ts:93-97`；`packages/fs/tool-fs/src/apply-patch-output.ts:47-48` |
| `FS_PATCH_MISMATCH` | 预检（模拟匹配失败）或提供方提交时 | 预检里作为 `PatchFailure` 记录；提交时由提供方抛 `FsError` | `packages/fs/tool-fs/src/patch/preflight.ts:121-122`；`docs/subsystems/filesystem.md:193,367` |
| `FS_SAME_TARGET` | 预检（move 到自身） | `FsError` | `packages/fs/tool-fs/src/patch/preflight.ts:91` |
| `FS_NOT_FOUND` / `FS_NOT_REGULAR_FILE` / `FS_NOT_OBSERVED` / `FS_STALE_VERSION` / `FS_NOT_TEXT` / `FS_TOO_LARGE` | 预检与提交 | `FsError` | `packages/fs/tool-fs/src/patch/preflight.ts:41-69`；`packages/fs/tool-fs/tests/patch/preflight.spec.ts:150-160` |
| `FS_SANDBOX_DENIED` | 提交时由提供方抛，映射为 `[sandbox: file access denied under <mode> mode]` + 升级提示 | `FsError`（码保留） | `packages/fs/tool-fs/src/sandbox.ts:137-143` |
| `FS_PERMISSION_DENIED` / `FS_IO_ERROR` / `FS_ABORTED` | 提交时 | `FsError` | `packages/fs/tool-fs/src/patch/execute.ts:98,111` |

**分类规则**：`PATCH_SYNTAX` 与 `PATCH_SYMLINK_SOURCE` 用 `PatchToolError`；其余一律 `FsError`。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:46-49`

**抛出 vs 返回**：语法失败与预检拒绝**抛**（`isError: true`）；提交期失败**记在返回值里**（`isError: false`），只有「首个操作失败且无变更」例外，改为抛。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:66-81`

### 4.4 错误消息归一化

- 语法错误保留解析器原文：`Error: Invalid patch at line 1: Expected '*** Begin Patch'`。来源：`packages/fs/tool-fs/tests/apply-patch.spec.ts:87`
- `FS_NOT_OBSERVED` 统一为 `cannot modify "<path>": file has not been read — read the file, then retry`。来源：`packages/fs/tool-fs/README.md:86`
- 沙箱拒绝：`Error: Patch rejected before any change (1 problems):\n- operation 1 (add <path>, patch line 2): [sandbox: file access denied under read-only mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`。来源：`packages/fs/tool-fs/tests/apply-patch.spec.ts:154`

---

## 5. 呈现与 Review

### 5.1 `presentCall`（调用期卡片）

`presentPatchCall(patch)` 解析补丁文本；**解析失败返回 `undefined`**（不出卡片）。来源：`packages/fs/tool-fs/src/apply-patch-presentation.ts:13-18`

返回 `DiffCallView`（`{ card: 'diff', title, diffs, locations? }`）：

| 组成 | 规则 | 来源 |
|---|---|---|
| `diffs` | `add` → `{path, oldText: null, newText: 内容}`；`delete` → **不产生 diff 条目**；`update` → `{path, oldText: 所有 hunk 的 oldLines 用 \n 连接（空则 null）, newText: 所有 hunk 的 newLines 用 \n 连接}` | `packages/fs/tool-fs/src/apply-patch-presentation.ts:19-28` |
| `title` | `Apply patch (<n> file)` / `Apply patch (<n> files)`，n = **不同路径数**（move 的源与目标各算一个） | `packages/fs/tool-fs/src/apply-patch-presentation.ts:30-33` |
| `locations` | 每个不同路径一个 `{path}`，用的是**补丁里的原始拼写**（未解析） | `packages/fs/tool-fs/src/apply-patch-presentation.ts:30-33` |

来源类型：`packages/core/tools/src/presentation.ts:103-118`；样例：`packages/fs/tool-fs/tests/apply-patch-presentation.spec.ts:9-21`

**注意**：调用期预览**不读盘**，所以 update 的 `oldText` 是补丁自带的旧行，而不是文件真实内容。

### 5.2 `presentResult`（结果期卡片）

`presentPatchResult(result)`：结果是错误、或 meta 里没有合法 diffs 时返回 `undefined`（退回普通结果渲染）；否则返回 `{ card: 'diff', title, diffs }`，标题是 `Apply patch` 或 **`Apply patch (stopped)`**（由 `meta.stopped === true` 决定）。来源：`packages/fs/tool-fs/src/apply-patch-presentation.ts:42-47`；`packages/fs/tool-fs/src/diff.ts:76-91`

### 5.3 `presentationMeta` 的形状

```
{ diffs: { path: string; oldText: string | null; newText: string }[],
  stopped: boolean }
```

来源：`packages/fs/tool-fs/src/apply-patch-output.ts:136-149`

- **只从已知的 completed / failed 操作派生 diffs**；`skipped` / `unknown` 不贡献。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:141`
- **创建不存 diff**（`before === null` 直接跳过）；**没有有界基线的删除也不存**；有基线的删除存 `{oldText: before, newText: ''}`（`FileDiff.newText` 不能为 null）。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:142-145`；`packages/fs/tool-fs/README.md:84`
- 其余走 `computeHunkDiffs`：以 3 行上下文（`DIFF_CONTEXT = 3`）产出**每个 hunk 一个 `FileDiff`**，纯插入的 `oldText` 为 null，跳过 `\ No newline` 标记。来源：`packages/fs/tool-fs/src/diff.ts:10-11,35-59`
- `stopped = value.cancelled || 有任何 operation.status !== 'completed'`。来源：`packages/fs/tool-fs/src/apply-patch-output.ts:89-91`
- meta 随 Session 日志持久化，因此回放能重建同一张卡片。来源：`packages/fs/tool-fs/src/diff.ts:13-22`

### 5.4 Web 端的 `apply_patch` 卡片

Web 端对 `apply_patch` 有专门的标题键：`tool.title.applyPatch`（中文「应用补丁」，英文「Apply patch」），工具行变体是 `edit`。来源：`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:76-77`；`packages/client/ui-tool/tests/diff-card.client.spec.tsx:251-256`；`packages/client/ui-conversation/src/client/locales.ts:332,723`

### 5.5 Review（工作区变更）怎么显示这些改动

**关键事实：Review 不消费 `apply_patch` 的 `presentationMeta`/diffs。** 它是一条独立链路：

1. `workspace-changes` 插件订阅三个 fs 意图槽（`fs/write-intent`、`fs/edit-intent`、`fs/delete-intent`），在**每次文件工具变更之前**抓一份整文件副本；并用 `tools/pre-execute` 把本次调用的 actor 绑定到 recorder。来源：`packages/deliverables/workspace-changes/src/index.ts:158-187`
2. turn 开始时对 git 工作树做快照，turn 结束时再做一次，用两棵树的差异列出改动文件；没有 git（或不在仓库里）时只统计文件工具抓到的路径。来源：`packages/deliverables/workspace-changes/src/recorder.ts:300-366`
3. 摘要通过一条 `workspace/changes` 的 Session 事件宣告，事件体**只有 `{turn}`**；摘要与逐文件对比由 `ctx.workspaceChanges.summary()` / `.diff()` 在 Session 存活期间提供。来源：`packages/deliverables/workspace-changes/src/recorder.ts:351`；`packages/deliverables/workspace-changes/src/types.ts:78-108`
4. **Review 的 diff 是「turn 起点内容 vs turn 终点内容」重新算出来的**，与 patch 的 hunk 无关。来源：`packages/deliverables/workspace-changes/src/recorder.ts:219-237`
5. `apply_patch` 因此出现在 Review 里，仅仅因为它的提交调用 `ctx.fs.writeText / patchText / deleteFile / moveFile`，这些会派发上述意图槽。来源：`packages/fs/tool-fs/src/patch/execute.ts:56-102`

由此得到的官方行为细节（均有测试固定）：

- 四种操作在 Review 里表现为**四个净变化路径**（add/update/delete/move 各一）。来源：`packages/deliverables/workspace-changes/tests/apply-patch.spec.ts:108-132`
- 未读文件被拒 → **不抓取、不产生观察、Review 无行**。来源：同文件 `:147-158`
- move 的源删除失败 → Review 只列**已发布的 move 目标**与已完成的那一个。来源：同文件 `:160-179`
- 同一轮里「建了又删」「改了又还原」的文件**不出现在 Review**。来源：同文件 `:181-191`
- 语法错误 → 不抓取、不记录路径。来源：同文件 `:223-231`
- `./a` 与 `a` 归并为同一基线与同一 Review 行。来源：同文件 `:233-243`

### 5.6 Web 端有没有独立的 Review 面板入口

**有。** `packages/client/ui-deliverables` 提供：

- **改动文件卡片**：注册进聊天视图 `conversation.chat.turnTail`，渲染本轮最新一条 `workspace/changes` 宣告的摘要（单文件显示「已编辑」+文件名，多文件显示总数与增删行数，四行折叠）。需要开启 **Coding Tools** 偏好。来源：`packages/client/ui-deliverables/README.md:41-45,67`
- **`changes-review` 侧栏 tab**：tab 类型在 `builtin` 档注册，地址 `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>`，以文件下标作为导航参数；打开方式 `ctx.sidebarRight.openResource`。它提供单栏/左右对比切换、换行开关、在 Sidebar 打开整文件、在宿主桌面用默认应用打开。来源：`packages/client/ui-deliverables/README.md:49,67`
- 对比数据经**经过认证的 Host 路由**读取（摘要路由 + 逐文件对比路由 + 原生打开路由）。来源：`packages/client/ui-deliverables/src/present-open.ts:131-180`
- **注意**：`deliverablesDefinition` 把「产出文件」折叠进会话时只覆盖 `write`、`edit` 与有修改作用的 `str_replace_editor`——**`apply_patch` 不在其中**。来源：`packages/client/ui-deliverables/README.md:67`

---

## 6. 注册与开关

### 6.1 配置项

| 项 | 值 | 来源 |
|---|---|---|
| `applyPatch` | 布尔，**默认 `false`**；「注册 `apply_patch` 及其指导文本（与 `edit` 并列）」 | `packages/fs/tool-fs/src/index.ts:36-37,53`；`packages/fs/tool-fs/README.md:58,66`；`docs/config-catalog.md:4104-4105` |
| 生效点 | `if (resolved.write || resolved.edit || resolved.applyPatch)` 时构造 `FsSandboxController`，再 `if (resolved.applyPatch) applyApplyPatchTool(ctx, sandbox)` | `packages/fs/tool-fs/src/index.ts:97-102` |

### 6.2 各组合现状（0.2.2-alpha.3 实际代码）

| 组合 | 值 | 来源 |
|---|---|---|
| `packages/bundle/base/cordis.patch.yml`（`tool-fs` 行） | `applyPatch: false` | `packages/bundle/base/cordis.patch.yml:296-300` |
| `packages/bundle/web-app/presets/standard.patch.yml` | `applyPatch: false` | `packages/bundle/web-app/presets/standard.patch.yml:27-31` |
| `packages/bundle/web-app/presets/ptc.patch.yml` | `applyPatch: false` | `packages/bundle/web-app/presets/ptc.patch.yml:28-31` |
| `packages/bundle/web-app/presets/cordis.patch.yml` | `applyPatch: false` | `packages/bundle/web-app/presets/cordis.patch.yml:31-34` |

**四个组合全部关闭**。这与 `packages/fs/tool-fs/README.md:58`、`docs/tool-catalog.md:1178`、`docs/config-catalog.zh.md:37` 及 `docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.md:14` 中「base 与 Web standard preset 开启它」的表述**不一致**；`git log -S applyPatch` 显示 `e1609fe164`（2026-11-02，标题「fix(fs): temporarily disable apply_patch in shipped defaults」）把 base 与 standard 改回 `false`。文档口径尚未跟上。

### 6.3 注册在哪一层

`applyApplyPatchTool(ctx, sandbox)` 里 `ctx.tools.register(defineTool({ name: 'apply_patch', ... }))` —— 注册在 **tool-fs 插件自己的 ctx** 上；它**不影子任何内建工具**（官方本来没有内建 `apply_patch`）。来源：`packages/fs/tool-fs/src/apply-patch.ts:26-52`；`packages/fs/tool-fs/src/index.ts:101`

### 6.4 systemPrompt section

- **name**：`tool:apply_patch`；**order**：`ctx.systemPrompt.getSectionOrder('TOOL_APPLY_PATCH')`。来源：`packages/fs/tool-fs/src/apply-patch.ts:18-19`
- **order 数值 = 1350**，在 sections 顺序表里排在 `TOOL_EDIT`（1300）与 `TOOL_GLOB`（1400）之间。来源：`packages/core/system-prompt/src/index.ts:143-151`
- **文本（逐字）**：

  > Prefer apply_patch over separate edit calls for changes across files or separated regions. Give every hunk enough surrounding context lines to match one place in the current file. The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.

  来源：`packages/fs/tool-fs/src/apply-patch.ts:20-24`；同一文本亦见 `packages/fs/tool-fs/tests/apply-patch.spec.ts:13-15` 与 `packages/fs/tool-fs/README.md:268`
- **scope 感知**：section 文本是函数，渲染时若 `ctx.tools.get('apply_patch', scope) === undefined` 就返回**空串**（工具被限制时指导文本也消失）；工具重新可见后恢复。来源：`packages/fs/tool-fs/src/apply-patch.ts:20`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:28-43`

### 6.5 工具描述与参数

- **description（逐字）**：`Create, update, delete, or move UTF-8 text files with one Codex-style patch; prefer it over multiple edit calls when a change spans several files or separated regions.` 来源：`packages/fs/tool-fs/src/apply-patch.ts:28-29`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:30-31`
- **参数名为什么是 `input`**：源码注释逐字——「Named `input` as in the Codex apply_patch tool; models trained on it send that key.」（在 Codex 的 `apply_patch` 上训练过的模型会自发发出这个键）。来源：`packages/fs/tool-fs/src/apply-patch.ts:31`；`packages/fs/tool-fs/README.md:263`
- **`input` 的 description（逐字）**：

  > Codex patch text: start with *** Begin Patch and end with *** End Patch. Use *** Add File: path with + lines; *** Update File: path, optionally followed by *** Move to: path, with @@ or @@ context and space-prefixed context, + added, or - removed lines; *** End of File anchors the last hunk to the file end. Use *** Delete File: path to delete. Paths are relative to the Session working directory.

  来源：`packages/fs/tool-fs/src/apply-patch.ts:32-37`；生成的 schema 见 `docs/tool-catalog.md:1046-1063`
- **路径语义**：相对 **Session 工作目录**。

### 6.6 沙箱升级参数

- **有**：`parameters` 里在 `sandbox.escalationModes.length > 0` 时展开 `sandbox.schemaFields()`，即 `sandbox_permissions`（枚举，值取自 `ESCALATION_TARGETS`）与 `justification`（字符串）。来源：`packages/fs/tool-fs/src/apply-patch.ts:39`；`packages/fs/tool-fs/src/sandbox.ts:26-30,59-72`
- **只在挂载了约束型 `ctx.fs`（`ctx.fs.sandboxMode` 有值）时才广告**；裸后端下 `apply_patch` 的 schema 里**没有** `sandbox_permissions`。来源：`packages/fs/tool-fs/src/sandbox.ts:43-46`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:145-149`
- 拒绝时错误文本带 `[sandbox: file access denied under <mode> mode]` 与同回合升级提示，结构化码仍是 `FS_SANDBOX_DENIED`。来源：`packages/fs/tool-fs/src/sandbox.ts:137-143`；`packages/fs/tool-fs/tests/apply-patch.spec.ts:154`

### 6.7 执行入口

`execute` 里先 `sandbox.resolvePolicy('apply_patch', args, exec)` 解析本次调用的围栏策略，再 `patchToolValue(await executePatch(ctx, sandbox, exec, { patch: args.input, sandboxPolicy }))`。来源：`packages/fs/tool-fs/src/apply-patch.ts:46-49`

---

## 7. 官方测试清单

| 文件 | 覆盖内容（一行一条） |
|---|---|
| `packages/fs/fs-patch/tests/parse.spec.ts` | 文件顺序 / 重复路径 / move 两端的保真；空 patch 与空创建；三种 heredoc 形式的剥壳且不做 shell 求值；heredoc 终止符后缀规则；LF/CRLF/CRCRLF 三种行尾归一；内容空白保留与裸空行当 context；无 `@@` 的隐式首 hunk；缩进过的标记行保持为 context；头裁剪但路径拼写与 Unicode 内容保留；BOM 不被裁剪；超长空白串保留；EOF 之后的空行与新 hunk/新文件；EOF 出现在首 hunk 之前无效果；被裁剪的末尾标记与冗余末尾标记；**35 条畸形输入 → 精确行号 + reason 的对照表**；诊断行号把前导空行与 heredoc 行一起计入。 |
| `packages/fs/fs-patch/tests/apply.spec.ts` | 40+ 条成功用例：多 hunk 在原文上搜索、交错修改与 EOF 追加、追加先于删除、Unicode 破折号匹配、首行/末行替换、EOF 纯插入、精确序列、尾随空白不敏感、两端空白不敏感、四级 pass 的优先级、每个 hunk 取首个剩余重复段、锚点推进游标、重复锚点用推进后的游标、锚点也吃标点容错、空文件插入、无结尾换行的末行插入、末尾空源行之前的插入、单换行文件插入、带锚的纯插入仍追加到 EOF、多条纯插入保持补丁顺序、纯删除保留上下文行、删空、替换补上缺失的结尾换行、EOF 优先尾部而非更早的精确匹配、EOF 可搜到游标之前、重叠 EOF hunk 的替换顺序、行尾空行哨兵重试（两个变体）、哨兵重试失败仍报原模式、空重试模式匹配游标、锚点后的空重试、CRLF 输入保留未动行的 CR、追加不归一化已有 CRLF、孤立 CR 是普通字符、非 ASCII 内容不变、超长内部空白；标点归一矩阵（破折号/引号/各类空格）；Rust `White_Space` 裁剪矩阵；**13 条失败用例 → 精确的 `failure` 记录**（模式比文件长、锚点未找到、锚点后旧内容未找到、后续上下文只存在于前一 hunk 之前、插入的文本不是后续搜索候选、EOF 不回退更早匹配、哨兵重试失败报原模式、BOM 不是 Rust 空白、组合记号不做 Unicode 归一、EN QUAD 不在标点映射内、孤立 CR 不切行）；空 hunk 列表的重建矩阵；失败模式与解析出的 hunk 数组相互独立。 |
| `packages/fs/tool-fs/tests/apply-patch.spec.ts` | 关闭时既不注册工具也不注册指导 section；开启时指导文本逐字相等、scope 限制时置空、释放后恢复、fiber 释放后两者都消失；四种操作的精确返回值 / meta / 渲染文本；空 patch 的确认文本；语法错误（`PatchToolError` + `PATCH_SYNTAX`）与聚合的未读文件拒绝（`FsError` + `FS_NOT_OBSERVED`，逐条消息）；符号链接源拒绝保留 `PATCH_SYMLINK_SOURCE`；部分移动保留为返回值 + 精确的停止文本 + 目标 diff；不确定写入（`unknown`）不编造 diff 且给出重读补救；沙箱升级只在约束后端下广告、拒绝按 preflight 拒绝抛；原生与 PTC 两条派发路径产出相同值；真实写权限失败后仍保留已完成操作。 |
| `packages/fs/tool-fs/tests/apply-patch-presentation.spec.ts` | 调用预览逐字形状（原始路径、不同文件计数含 move 两端、只有 delete、非法文本 → undefined）；解析器缺陷向上抛；结果呈现对失败/缺失 meta 的回退与 stopped 标题；畸形 `stopped` 标志一律当作 false；创建与无基线删除不存 diff 的具体形状；取消与 move 失败的渲染文本。 |
| `packages/fs/tool-fs/tests/patch/preflight.spec.ts` | 语法错误先于路径解析；独立的未读/确认缺失失败集合并跳过有效写入；hunk 不匹配的逐字消息（含 80 字符预览与 `…` 省略）；delete/move 的符号链接源拒绝；move 到源自身的别名拒绝；add/move 未读目标的路径归属；非普通文件目标在无守卫时也被拒；过期的观察版本在 add/update 前被拒；超出读采样窗口的 NUL 字节在写前被拒；预检读失败码保留（`FS_NOT_TEXT` / `FS_TOO_LARGE`）；delete/move 的源缺失只模拟不执行；预检缺陷向上抛且不写盘；解析缺陷不会被误标成语法失败；重复删除针对模拟缺失被拒；move 目标未获准入后源模拟仍保留；缺失的 move 源被点名；无策略插件时按上下文匹配即可应用未读/被外部改过/被覆盖的目标；无策略插件时 hunk 不匹配仍被拒。 |
| `packages/fs/tool-fs/tests/patch/success.spec.ts` | 多文件多 hunk 应用并保留存储行尾；别名 update 与重新获取前一次产生的版本；删除后重建同一目标；文件尚不存在时「先创建后更新」的模拟；一次调用里既 move 又 patch，再更新模拟目标；无观察策略时的无条件 update/move；`workspace-write` 与 `danger-full-access` 下的守卫提交；add 覆盖本补丁中已创建的目标；删除本补丁中先前创建的文件。 |
| `packages/fs/tool-fs/tests/patch/commit.spec.ts` | delete/move 移除失败时保留第一次提交且只观察已发布的变化；取消后在操作之间停下且不回滚第一次写入；分阶段写入中取消 → `unknown` 且不做 stat 比对；全部完成的补丁不因最后一次观察触发的 abort 而被标 cancelled；提供方改了盘又丢了回复 → `unknown`；提供方进入后的 I/O 失败三种情形（未变 / stat 失败 / stat 缺陷）的判定；目标已发布但回复丢失时 move 的两个目标都要检查；外部编辑使下一个提交守卫失效时保留此前的变更；变更阶段的缺陷向上抛且保留观察状态；预检后外部编辑导致 move 源被锁；只读策略下在第一个提供方拒绝处停下；提供方拒绝工作区外的 move 目标时保留更早的写入。 |
| `packages/fs/tool-fs/tests/patch/resolution.spec.ts` | 路径解析失败被收集、已解析路径保留、其余操作仍被检查；只有 move 目标解析失败时保留已解析的 move 源；进入前信号已中止时返回中止型解析拒绝。 |
| `packages/fs/tool-fs/tests/patch/harness.ts` | （共用夹具，非 spec）真实提供方 + 沙箱模式 + 观察策略 + 补丁文本构造器（`patch/add/update/remove/move`）。 |
| `packages/deliverables/workspace-changes/tests/apply-patch.spec.ts` | 非 git 与 git 不可用两种环境下 `apply_patch` 的 Review 行为：四种操作 → 四个净变化路径；同一文件两次 patch 保留第一次基线；未读文件 → 不抓取/不观察/无 Review 行；源删除失败时只列 op1 与已发布的 move 目标；建了又删、改了又还原的文件被略过；move 的两次抓取都在提供方发布前完成且不产生观察；非法语法 → 不抓取、不记录路径；`./a` 与 `a` 归并为同一基线与同一 Review 行。 |
| `packages/fs/tool-fs/tests/diff.spec.ts` | `computeHunkDiffs`：单行改动产出 ±上下文 hunk；散布的 replace_all 产出**每个 hunk 一个** `FileDiff`；无改动不产出 hunk；纯插入 `oldText` 为 null；整文件删除 `newText` 为空；丢弃 `\ No newline at end of file` 标记；`DIFF_CONTEXT = 3`；`diffsFromMeta` 的防御式收窄（合法 / `oldText: null` / 非对象 / 数组 / 缺字段 / 空数组 / 畸形条目）。 |
| `packages/fs/tool-fs/tests/tools.spec.ts:161-181` | 工具/指导 section 的开关矩阵（含 `{write:false, applyPatch:true}` → 工具集 `['apply_patch','edit','read']`、section 集 `['tool:apply_patch','tool:edit','tool:read']`）；非布尔开关在配置解析期被拒。 |

---

## 8. 与本插件的差异点（官方有、本插件目前没有）

> 只列事实，不给建议。逐条给出官方出处与本仓库出处。

| # | 机制 | 官方 | 本插件现状 |
|---|---|---|---|
| 1 | **一次调用改多个文件**（add/update/delete/move 任意组合） | `packages/fs/tool-fs/src/apply-patch-output.ts:9-38`（`operations` 数组） | `edit` 每次调用只接受一个 `path`（`src/tools/tool-edit.ts:393`）；`delete`/`rename` 虽是多路径但语义不同（README 工具表） |
| 2 | **Codex 风格 patch 文法解析器**（`*** Begin Patch` 信封、`*** Add/Update/Delete File:` 头、`*** Move to:`、`@@` 锚、`*** End of File`、hunk 行前缀、`<<EOF` 剥壳） | `packages/fs/fs-patch/src/parse.ts:1-175` | 本仓库 `src/` 与 `client/src/` 中**不存在**任何 patch 解析模块（全文检索 `Begin Patch` / `apply_patch` 无命中） |
| 3 | **文本级 hunk 定位 + 四级宽容匹配 + EOF 尾部搜索 + 行尾空行哨兵重试** | `packages/fs/fs-patch/src/apply.ts:29-101` | 本插件的定位是 hashline 锚 + served-state 校验（README「The Anchor Contract」），不做文本级模糊匹配，也不做 EOF 语义 |
| 4 | **整批准入（whole-patch admission）**：先全量预检，任一拒绝则零写入 | `packages/fs/tool-fs/src/patch/preflight.ts:136-157` | 本插件是单文件 served-state 校验后即写（`src/domain/edit/`），没有「整批先查后写」这一层 |
| 5 | **四态操作结果 + `unknown` 态与「重新读取受影响文件」补救语** | `packages/fs/tool-fs/src/patch/types.ts:57-62`、`packages/fs/tool-fs/src/patch/execute.ts:110-114` | 本插件的失败形态是 `[E_*]` 错误码表（README「Error Codes」），没有 `unknown` 状态概念 |
| 6 | **移动作为一等操作**（destination 发布 + source 删除两个效果，能报告「目标已写、源仍在」） | `packages/fs/tool-fs/src/patch/execute.ts:81-101` | 本插件 `rename` 是纯重命名（不携带内容改写），`edit` 不跨文件移动（README 工具表） |
| 7 | **严格规范提交值**（`phase`/`cancelled`/`operations[]`/`affectedPaths`，每操作带 `code`/`message`/`hunkLine`/`changes`） | `packages/fs/tool-fs/src/apply-patch-output.ts:9-38` | 本插件各工具返回各自的文本与 meta，无等价的规范提交值 |
| 8 | **`presentationMeta` 的 `{diffs, stopped}` 形状与通用 `FileDiff{path, oldText, newText}`** | `packages/fs/tool-fs/src/apply-patch-output.ts:136-149`、`packages/core/tools/src/presentation.ts:28-40` | 本插件也用宿主的 `presentationMeta` 机制，但 meta 里是自己的行锚 diff 行组（`src/render/edit-diff.ts`、`client/src`），**不含 `stopped` 语义**，也不用 `FileDiff` 三元形状 |
| 9 | **调用期预览卡**（从参数推导 diff，不读盘） | `packages/fs/tool-fs/src/apply-patch-presentation.ts:13-35` | 本插件没有「从调用参数推导的预览卡」这一形态，只有执行后的 diff 呈现 |
| 10 | **工作区变更 / Review 集成**：订阅 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 三个意图槽抓整文件副本，turn 首尾 git 快照，`workspace/changes` 事件 + `ctx.workspaceChanges` 服务，聊天改动文件卡片 + `changes-review` 侧栏 tab | `packages/deliverables/workspace-changes/src/index.ts:164-187`、`packages/deliverables/workspace-changes/src/recorder.ts:300-366`、`packages/client/ui-deliverables/README.md:41-69` | 本插件**没有**这一层（全文检索 `workspace/changes` / `workspaceChanges` / `changes-review` 无命中） |
| 11 | **`apply_patch` 专属 system prompt section**（`tool:apply_patch`，order 1350，与「优先用 patch 代替多次 edit」的引导文本） | `packages/fs/tool-fs/src/apply-patch.ts:18-25`、`packages/core/system-prompt/src/index.ts:148` | 本插件没有对应 section；guidance 机制是按 preset 覆盖既有工具（README「Per-preset guidance」） |
| 12 | **按组合开关注册工具**（`applyPatch` 布尔，默认 false） | `packages/fs/tool-fs/src/index.ts:36-37,53,97-102` | 本插件没有等价的「按组合开/关某个工具」开关（工具集是固定的） |
| 13 | **纯库拆分 + 第三方归属保留**：`dsh-fs-patch` 是独立的无 I/O 库包，并附 `LICENSE` 保留 OpenAI Codex 的 Apache-2.0 归属与修改说明 | `packages/fs/fs-patch/README.md:45`、`packages/fs/fs-patch/LICENSE` | 本仓库没有对应的独立纯库包，也没有 patch 相关的第三方归属文件 |
| 14 | **`PatchParseError` 的「原始输入行号 + 原因」诊断**（heredoc/前导空行都计入） | `packages/fs/fs-patch/src/parse.ts:20-26,47-49` | 本插件的错误码体系是扁平的 `[E_*]`（README「Error Codes」），没有行号定位型诊断 |

**已具备、不构成差异的一项（避免误记）**：本插件的 mutating 工具已经带 `sandbox_permissions` + `justification` 两个升级参数，形状与官方一致（`src/infra/sandbox.ts:30-37,76-90`；官方 `packages/fs/tool-fs/src/sandbox.ts:59-72`）。

---

## 附：调研口径与未决项

- **一手来源纪律**：全部结论取自本地检出的官方仓（源码 + 仓内文档 + git 历史），未使用网络二手材料。
- **文档与代码不一致（已在 §0.4、§6.2 标注）**：`apply_patch` 在 0.2.2-alpha.3 的随发行版组合里实际是关闭的，而四份官方文档仍写「base 与 standard preset 开启」。提交 `e1609fe164`（2026-11-02）的标题是「temporarily disable」，说明这是临时回退而非稳定口径；对齐时应以代码为准。
- **未逐行读完的官方文件**：`packages/fs/fs-local/`、`packages/fs/fs-sandbox/` 的实现细节（只读了它们在 `docs/subsystems/filesystem.md` 里的契约描述）；`packages/client/ui-tool` 的 diff 卡片渲染实现（只读了模型层与一条测试）。这两处若要设计 Web 侧卡片，需要再单独取证。
- **未取证的项**：官方 `apply_patch` 在真实模型调用中的返回体样例（官方仓里只有 README 给出的三段示例文本，没有真实会话录制）；`dsh --dump-config` 下 `applyPatch` 的实际渲染值。
