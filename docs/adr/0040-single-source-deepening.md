---
title: "ADR-0040: 单一来源——wire 契约、卡片声明与被深化的 seam"
type: decision
status: Accepted
date: 2026-11-17
issue: 435
supersedes: ""
---

# ADR-0040: 单一来源——wire 契约、卡片声明与被深化的 seam

## 背景与问题

一次架构评审（2026-11-17，双路走查 + 逐条抽验）找出同一类问题的八处化身：**同一个事实住在两个地方**。

| 事实 | 重复处 | 漂移的后果 |
|---|---|---|
| probe → 错误码 | 六处手抄（delete / rename / patch preflight / fs-bridge 两个后端） | 同一形状在不同工具说出不同的话；改一条规则要动六处，其中两处在 infra、编译期无关联 |
| 锚点折叠 | `tools/tool-edit.ts` 与 `domain/patch/preflight.ts` 各折一次 | 同一 token 在两个工具里理解不同；表现为「只有某个工具的编辑落错行」 |
| 诊断投影 | `lsp/auto-diag.ts` 与 `tools/tool-lsp.ts` 各写一遍 | severity 过滤、上限、账本三处策略悄悄分叉，两条路的行集合不同 |
| server slot root | manager 的 interface 要求调用方传 | 四个调用点三种 root，`process.cwd()` 混进 seam；root 取决于谁先 warm |
| 落盘事务 | `applyFileResultTo` 与 `writeFileResult` 两份 | 镜像记账失败时策略相反：edit 降为警告、patch 让整段 failed——而文件**已经写进盘里** |
| wire key 词表 | 宿主一份、client 一份 | 两份手抄靠「刮宿主源码」校验，刮不到 `patch-card.ts` 的三个 key：改名后测试照绿、运行时静默拒绝 |
| client 卡片知识 | 四张并行表 + 一条七槽 body 链 | 加工具要协同编辑 9 个 client 文件 + 4 个宿主文件 |
| 本地 fs 实现 | 生产模块里的第二份 `FileIO` | 工具层测试跑在契约的影子上，两套后端的 fence 从未对比 |

评审同时确认了这个仓库的深模块是真实的：`hashline/anchor-pipeline.ts` 1931 行只露三个函数、`render/scope` 187 行承载 2500 行识别、`infra/fs-bridge.ts` 的 `FileIO` 14 个方法背后是全部 IO 语义。摩擦不在深模块，在副本。

## 决定

### D1 — 一次深化一票，八项一次到位

八个候选由同一次 grilling 决定，**不拆成八票、不分先后**（用户 2026-11-17 决定）。每个候选的落地形态：

- **Commit**：`domain/edit/mutation.ts` 收缩为「一次落盘」的唯一入口（undo 快照 → 原子写 → served 镜像结算 → 失败策略）。删掉 225 行零调用的 `execPipeline` 与 18 个透传再导出；**镜像记账失败一律是警告，「写已成功」永不反转**（`apply_patch` 原先会因此把已写盘的文件报成 failed）。
- **Slot root**：`LspManager` 的 interface 不再收 `workspaceRoot`；root 由 manager 自己从会话 live cwd 解析（ADR-0031），四个调用点各少一份语义。
- **Diagnostic policy**：投影下沉到 `lsp/diagnostics/projection.ts` 一份；写路径声明 `{severities:[1,2], cap:50, ledger:true}`，手动查询声明 `{全部 severity, 不限, 不记账}`——差异是**声明**，不是第二份实现。
- **Anchor fold**：`buildPreparedItem` 从 tools 层下沉到 `domain/edit/anchor-fold.ts`，`apply_patch` 的 preflight 改调同一份；顺带删掉 `PreparedItem` 三个只写不读的死字段（`anchorEndAsserted` / `lineStart` / `lineEnd`，block op 删除后遗留）。
- **Probe verdict**：`infra/probe-verdict.ts` 一张表，delete / rename / patch / fs-bridge 两后端共用；措辞按工具动词注入。
- **wire 契约单一源**：`src/wire/keys.ts` 是唯一手写副本；client 的门禁是它的**构建期投影**（`client/scripts/sync-wire.mjs` → `client/src/wire/keys.generated.ts`），并有一条字节级新鲜度钉子。宿主与 client 仍是**一个 npm 包**（client 只是 workspace 构建单元，产物随 root 发布），故不需要第二个发布物。
- **client 卡片声明**：`models.ts` 的 `TOOL_CARDS` 一张表取代四张并行表；注册表塌成 `TOOL_ROWS` 一张表（八个逐字节相同的 10 行块 → 一处）。
- **测试面**：`localIO` 从生产模块搬进 `test/support/local-io.ts`（它是一份影子契约）；`makeTestSandbox` 导出，并新增「测试世界」一次调用入口。

### D2 — 模板与词永在 client；契约在仓库内

维持 ADR-0026 决策 3：zh/en 模板与 `resolveHostText` 闸门留在 client。共享源只放**契约**（key 名单与 wire 类型），不放词。ADR-0026 决策 3 因此不修改，但其「两份列表是同一份」的旧维护机制（刮源码）被本 ADR 取代——那套机制漏掉了整个 `patch-card.ts`。

### D3 — 旧形状继续能画

`apply_patch` 的 meta 新增 `diffRowGroups`（宿主自带行组形状），client 不再为新调用伪造 wire 形状；但**只带 `formats` 的旧 meta 仍然渲染**（client 侧 `formatRowGroups` 做 legacy 合成，ADR-0026 决策 6 的同款承诺）。

### D4 — 投影写成纯函数，钉子钉行为

client 无渲染环境（缺 DOM 与 `clsx`），此前的 client 测试只能刮源码文本——那种钉子在任何重构下都会假红。本次把可测的投影下沉为纯函数（`formatRowGroups`、`toolRowModel`、`TOOL_CARDS`），新增的钉子全部按**行为**书写。

## 后果

- 同一事实只有一处：probe 表、锚点折叠、诊断投影、卡片声明、wire 词表各一份，删除即知其影响面。
- `apply_patch` 不再把已写盘的文件报成失败——模型重试的诱因消失。
- server slot 的 root 不再取决于谁先 warm；顺序依赖消失，tsserver 的 project 推断落在会话目录。
- client 加一个工具从「协同编辑 13 个文件」降到「加一行声明」。
- `localIO` 不再是生产代码：工具层测试默认跑在真实契约上，换一个后端即可验证两套实现。
- ADR-0015 / ADR-0031 / ADR-0039 各补一句，固化本次落地的策略。

## 参考

- Issue: [#435](https://github.com/hyperion2144/dsh-hashline-edittool/issues/435)
- ADR: `docs/adr/0026-host-text-key-wire-contract.md`（wire 契约）、`docs/adr/0031-live-session-cwd.md`（live cwd）、`docs/adr/0039-diagnostic-identity-and-suppression.md`（诊断身份与账本）、`docs/adr/0015-partial-failure-visibility.md`（部分失败可见性）
- 代码: `src/domain/edit/mutation.ts`、`src/domain/edit/anchor-fold.ts`、`src/infra/probe-verdict.ts`、`src/lsp/diagnostics/projection.ts`、`src/wire/keys.ts`、`client/src/client/models.ts`、`client/src/client/index.ts`、`test/support/local-io.ts`、`test/support/fixtures.ts`
