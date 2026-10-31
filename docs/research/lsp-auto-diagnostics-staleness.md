# LSP 自动诊断的异步时序与「过期诊断」取证

> 取证笔记（2026-10-31）。范围只回答四件事：edit/write/ast_edit/undo 之后自动诊断
> 从哪条代码路径触发、诊断结果**同步取回还是走 server 异步推送**；诊断结果里有没有
> 版本／内容指纹／时间戳一类的「过期判据」；有没有「丢弃过期诊断 / 同文件新 edit 抑制
> 旧诊断」的守卫；两条 edit 先后发生时旧诊断覆盖新诊断的最可能时序。不设计修复方案。
>
> 取证手段：全仓只读检索（`grep` / `read`），范围 `src/lsp/`、`src/tools/`、
> `src/domain/edit/`、`src/infra/`、`docs/`、`test/core/`；平台语义取自仓内
> `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:201-209`
> （`agent.inject` 的契约）。取证阶段**未做真机复现**（本会话无 LSP server 可用），
> 时序结论来自代码路径推导；随后由 `test/core/issue-388-stale-diagnostics.test.ts`
> （假时钟 + 假 server）把这条时序跑成了确定性复现 —— 见文末「复现与诊断」。
>
> 对应票：[#388 LSP 自动诊断可能过期：同一文件连续两次 edit 时，agent 收到上一次 edit 的延迟诊断](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388)

## 结论（先给，7 条）

1. **自动诊断有两条投递通道：内联（同步、等工具结果）与异步（后台 + `agent.inject`）。**
   内联最多等 `INLINE_WINDOW_MS = 1_000`（`src/lsp/auto-diag.ts:58`）；超窗即
   `startAsyncWait`（`src/lsp/auto-diag.ts:211`）并返回 `undefined`，由后台任务在
   模型下一个自然步注入（`src/lsp/auto-diag.ts:468`）。
2. **诊断内容本身永远来自 server 的 PUSH 通道**（`textDocument/publishDiagnostics`），
   session 只保留「每个 URI 的最后一次推送」（`src/lsp/session.ts:176`、`:204-206`）。
   只有 server 宣告了 `textDocument/diagnostic` 时才走 PULL 优先
   （`src/lsp/session.ts:233-235`、`:250-268`；`src/lsp/auto-diag.ts:271`）——
   typescript-language-server 不宣告它，所以常见路径是 PUSH + 哨兵探针。
3. **「新鲜度」保证的是「本次写入时捕获的那份文本」，不是「该文件的最新一次 edit」。**
   内联路径两者等价（同一次工具调用内不可能有下一次 edit）；异步路径不等价。
4. **诊断结果里没有任何版本／指纹／时间戳。** session 侧其实**存了** push 的
   `version`（`src/lsp/session.ts:182-185`）和文档版本（`:218-225`），
   但**全仓无人读它们**；注入消息只带 path / toolName / callId / 行
   （`src/lsp/auto-diag.ts:489-518`）。
5. **过期守卫：有一个「内容新鲜度」守卫（`verifiedReport`），但没有「跨 edit 的过期
   守卫」。** 没有任何按 URI 的在途登记、没有 revision 比对、没有「新 edit 抑制旧
   诊断」的去重表（`src/lsp/` 全目录检索 `pending|dedupe|supersed` 无命中）。
6. **最可能的覆盖路径（行号级）在 `5**：异步等待会用**写时快照**把 server 的文档状态
   回滚（`src/lsp/auto-diag.ts:276`、`:288`），或把**新内容**的诊断按**旧内容**的
   行号渲染（`:271` + `:335`），最后注入到模型**下一次**步——排在更新的那次 edit
   的结果**之后**。
7. **仓内没有关于「诊断过期／异步诊断时序／诊断与 edit 顺序」的既有 ADR 或研究笔记**
   （`6）。现有相关测试只覆盖「内联／异步／开关」三条主路，**没有一条覆盖两次
   edit 的先后次序**（`7）。

## 1. 触发路径：从一次写盘到一次诊断

四个写工具走的是同一条三段式，差别只在「谁触发」：

| 工具 | 取基线（写之前） | 落盘后通知 server | 投递诊断 |
| --- | --- | --- | --- |
| `edit` | `src/tools/tool-edit.ts:334` | `src/domain/edit/edit-engine.ts:1830`（或 `:1839`） | `src/tools/tool-edit.ts:362-373` |
| `write` | `src/tools/tool-write-shadow.ts:265` | `src/tools/tool-write-shadow.ts:304` | `src/tools/tool-write-shadow.ts:308-319` |
| `ast_edit` | `src/tools/tool-ast-edit.ts:411` | 同上（`commitFileResult` 内部） | `src/tools/tool-ast-edit.ts:422-433` |
| `undo_last_edit` | `src/tools/tool-undo.ts:232` | `src/tools/tool-undo.ts:244` | `src/tools/tool-undo.ts:299-309` |

- 「写之前」取的是 `prepareWriteDiagnostics`（`src/lsp/auto-diag.ts:146`）：它记下
  **当时是否已有 READY 的 session**；没有就 `manager.warm()` 并返回「待定」上下文
  （`:153-166`）——冷启动时写盘那次没通知任何 server，server 也就没收到内容。
- 「落盘后通知」是 `notifyDocumentWritten`（`src/lsp/sync.ts:46-60` → `:106-119`），
  最终落到 `session.didChange`（`src/lsp/manager.ts:527` → `src/lsp/session.ts:472-481`），
  文档版本自增。
- 「投递诊断」是 `deliverDiagnosticsAfterWrite`（`src/lsp/auto-diag.ts:190`）。
  → **诊断不是写盘的一部分，是写盘之后的一段独立等待**。

## 2. 同步返回 vs 异步推送

### 2.1 内联（同步，最多 1s）

`deliverDiagnosticsAfterWrite` 在工具调用内部 `await` 一个有界窗口
（`src/lsp/auto-diag.ts:190-219`）：窗口内拿到可验证的报告，就把它交给调用方，
调用方拼进工具结果——

- 文本通道：`formatDiagnosticsSection`（`src/lsp/auto-diag.ts:528`）→ 追加到
  `modelText`（`src/tools/tool-edit.ts:636`）；
- JSON 通道：`diagnosticsJson`（`src/lsp/auto-diag.ts:619`）→ 放进 envelope 的
  `diagnostics` 字段（`src/tools/tool-edit.ts:630`）；
- 卡片通道：`diagnosticsMeta`（`src/lsp/auto-diag.ts:577`）→ `presentationMeta`。

→ **内联时，诊断与这次 edit 的结果在同一条消息里，模型不可能先看到新的再看到旧的。**

### 2.2 异步（延迟到达）

窗口内拿不到可验证报告时（`src/lsp/auto-diag.ts:208-213`），启动
`startAsyncWait`（`:428-474`）并立刻返回 `undefined`：工具结果里**没有**诊断段。
后台等待结束后调用 `agent.inject`（`:468`），注入一条 `UserMessage`
（`:489-509`），正文由 `formatInjectedText` 拼出（`:512-518`）：

```text
[LSP diagnostics arrived late for <path>]
written by <toolName> (call <callId>):
  <anchor>:<line>: <source>
  ↳ error: …
```

平台的 `inject` 契约（`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:201-209`）：

> Queue model-facing context for the next pre-step without waking the driver. A running
> driver claims it at the nearest later step boundary …

→ **注入落在「下一个步边界」，即排在随后那一次工具结果之后。**

## 3. 诊断结果携带版本／指纹／时间戳吗？

**否——注入出去的那份结果不带任何过期判据。**

| 判据 | 是否存在 | 位置 |
| --- | --- | --- |
| push 自带的 `version`（LSP `PublishDiagnosticsParams.version`） | **存了，没人读** | 存：`src/lsp/session.ts:182-185`；读：无（全仓检索 `diagnosticsVersion` 仅命中 session.ts 自身） |
| 文档版本（我们宣告的 `didChange` 版本） | **存了，没人读** | `src/lsp/session.ts:218-220`（`documentVersion`） |
| 推送计数（revision） | **存了，没人读** | `src/lsp/session.ts:157`、`:209-211` |
| 内容指纹 / mtime / edit 序号 | **不存在** | 注入正文只有 path / toolName / callId / 行：`src/lsp/auto-diag.ts:512-518` |
| 文件系统版本（`FsVersion`） | **不存在** | 诊断路径不接触 `fs/observed` 的 version（只有 `observeReport` 事后发一条观察：`src/lsp/auto-diag.ts:416-418`） |

值得记的一处**「写了注释但没实现」**：session 的 push 处理器明确写着
「a consumer acting on the current text must compare `diagnosticsVersion(uri)` against
`documentVersion(uri)` and ignore stale pushes」（`src/lsp/session.ts:177-181`），
但仓内没有任何 consumer 做这件事。

## 4. 有没有「过期诊断丢弃 / 新 edit 抑制旧诊断」的守卫？

**分两层答：**

### 4.1 有——「这份报告对不对得上我刚写的文本」的守卫

`verifiedReport`（`src/lsp/auto-diag.ts:265-297`）是本仓唯一的守卫，两条臂：

1. **PULL**（`:271`）：请求排在我们的 `didChange` 之后的同一条有序连接上，
   协议序保证回答对应当前内容。
2. **哨兵探针**（`:273-296`，给没有 `diagnosticProvider` 的 server 用）：
   先 `didChange` 到 `text + <nonce 行>`（`:276`）→ 等一个**提到 nonce** 的推送 →
   再 `didChange` 回 `text`（`:288`）→ 等一个**不提 nonce** 的推送。
   探针只活在 server 的文档状态里，不落盘。

### 4.2 没有——「这份报告是不是这个文件最新一次 edit 的」的守卫

- **没有** per-URI 的在途等待登记：每次写盘各自新建一个后台等待
  （`src/lsp/auto-diag.ts:197`、`:211`），两次写同一文件 = 两个并发的后台等待，
  两个都可能注入。
- **没有** revision 比对：`waitPushMatching`（`:308-321`）只轮询
  `session.getDiagnostics(uri)`——**每个 URI 的最后一次推送**
  （`src/lsp/session.ts:176`、`:204-206`）——既不比 `diagnosticsRevision`，
  也不看内容是不是自己探针后的那次。
- **没有**「注入前再确认磁盘内容仍等于 `input.text`」的检查：
  `collectReport` 直接用 `input.text` 切行、按它铸锚点
  （`src/lsp/auto-diag.ts:335`、`:374-380`）。
- **没有**「该 URI 已有更新的 edit 在途 → 抑制本次投递」的规则。

## 5. 旧诊断覆盖新诊断的最可能时序

设文件 `F`，第一次写进 `text1`，第二次写进 `text2`。

| 时刻 | 发生什么 | 位置 |
| --- | --- | --- |
| t0 | edit#1 取基线，session READY | `src/tools/tool-edit.ts:334` |
| t1 | `text1` 落盘 → `didChange(F, text1)`，文档版本自增 | `edit-engine.ts:1830` → `session.ts:472-481` |
| t2 | 内联窗口 1s 内无可验证报告 → 启动后台等待，工具返回（**结果里没有诊断**） | `src/lsp/auto-diag.ts:208-213` |
| t3 | 模型发起 edit#2 → `text2` 落盘 → `didChange(F, text2)` | `src/tools/tool-edit.ts:343` → `edit-engine.ts:1830` |
| t4 | **edit#1 的后台等待继续跑，用的是写时快照 `text1`** | `src/lsp/auto-diag.ts:451-463` |
| t5 | 交付旧诊断并注入 | `src/lsp/auto-diag.ts:465-468` |

t4 这一步有两条岔路，**都出错，但错法不同**：

- **岔路 A（server 支持 PULL）**：pull 请求排在 `didChange(F, text2)` 之后，
  server 算的是 **`text2`** 的诊断（`src/lsp/auto-diag.ts:271`），
  但 `collectReport` 用 **`text1`** 的行号与文本渲染、铸锚点
  （`:335`、`:374-380`）→ **新诊断套旧行号**。
- **岔路 B（tsserver 这类不支持 PULL，走哨兵探针）**：
  `opts.open(probeText)`（`:276`）把 server 的文档状态**回滚到 `text1`**，
  `opts.open(text)`（`:288`）再回滚一次 → 交付的是 **`text1` 的诊断**，
  且 server 此刻看到的也是 `text1`（**server 状态被旧内容覆盖**）。

t5 的注入没有版本号（`3），且落在「下一个步边界」，**排在 edit#2 的结果之后**
（平台契约见 `2.2）→ 模型最后读到的是 **`text1` 的行号 + `text1` 的文本**，
而磁盘上是 `text2`。

### 5.1 并发的两条辅路

- **两个后台等待同时在飞**：同一文件连续两次写 = 两次 `startAsyncWait`
  （`:197`、`:211`），没有去重表 → 两个注入都可能出现，先后不定。
- **乱序推送满足了「不提 nonce」的判据**：`waitPushMatching`（`:308-321`）读的是
  「最后一次推送」，若一份**内容状态不同**的推送在探针推送之后到达
  （server 异步分析、推送可乱序），第二步的判据 `!itemsMentionNonce(...)`
  会被它满足 → 交付了一份来源不明的报告。

## 6. 仓内既有的相关 ADR / 研究笔记

| 路径 | 一句话结论 |
| --- | --- |
| `docs/adr/0021-lsp-failed-slot-retry.md` | 只在「重试该放哪一层」的取舍里提过一句「the auto-diagnostics path … would stay dead」，**与诊断新鲜度无关**。 |
| `docs/adr/0019-format-tool-contract.md` | 只规定 format 与 notify/diagnostics/preview 的**先后**（format 在前），不涉及诊断自身的时序。 |
| `docs/specs/write-preview-spec.md:35-36`、`:48-50` | 规定 diagnostics 段在 model text 里的**位置**（base → diagnostics → lossy note → format），不涉及过期。 |
| `docs/CHANGELOG-MEMORY.md:296` | 记的是 `auto-diag.test.ts` 里 `lsp.auto_diagnostics` 设置用例的改写，非时序问题。 |
| `docs/research/dsh-rename-seam.md`、`docs/research/ctx-locale-seat.md` | 同类取证笔记的**格式**参照（结论先行 + `→` + `文件:行号`），内容与本主题无关。 |

→ **没有**任何一篇 ADR / 研究笔记 / 报告专门讨论「诊断过期 / 异步诊断时序 / 诊断与
edit 的先后顺序」。本笔记是第一篇。

## 7. 现有相关测试

| 路径 | 覆盖点 |
| --- | --- |
| `test/core/auto-diag.test.ts` | 三条主路：内联（真 `edit` 工具 + 假 manager）、异步（假 session + 假 agent）、配置开关 `lsp.auto_diagnostics`（文件头 `:1-13`）。含内联窗口超时后后台注入（`:365-370`、`:425-430`）、预算耗尽后丢弃（`:389-395`）、调用取消后不投递（`:389-395`）、冷启动等 session 再 `didOpen`（`:821-827`）、PULL 优先（`:868-874`）、哨兵探针的 nonce 状态**永不**被交付（`:887-893`）。 |
| `test/core/tool-lsp.test.ts` | 手动 `lsp { operation: "diagnostics" }` 通道（用 `diagnosticsRevision` 区分「没回答」与「没问题」）。 |
| `test/core/issue-147-line-space.test.ts:170-174` | 同上，read 行空间语境。 |
| `test/core/hashline-volatile-config.test.ts:41-53`、`test/core/lsp-idle-settings.test.ts:53-86` | `lsp.auto_diagnostics` 配置项的解析与回落。 |

→ **没有一条测试构造「同一文件连续两次 edit」**，也没有一条断言「晚到的诊断对应最新
一次 edit」。fake session 确实提供了 `documentVersion` / `diagnosticsVersion`
（`test/core/auto-diag.test.ts:116-117`），但生产代码从不调用它们——测试替身比被测
代码更「懂版本」。

## 对本次 BUG 报告的意义

**已有守卫，但只在「内容新鲜度」这一层，不在「跨 edit 的过期」这一层。**
`verifiedReport`（`src/lsp/auto-diag.ts:265-297`）能证明「这份报告对应我刚写下的
那份文本」，却证明不了「这份文本是该文件最新一次 edit 的文本」——异步路径用的
`input.text` 是**写时快照**（`:451-463`），探针还会把 server 的文档状态回滚到这份
快照（`:276`、`:288`）。

**问题落在「异步投递层」，不在「诊断计算层」**：server 算得对不对由 server 负责；
错的是本插件在异步路径上**用旧文本重放了 server 的文档状态**、并把结果**注入到更新的
那次 edit 之后**，而这条注入既不带版本也不带指纹（`:512-518`），模型无从分辨新旧。
仓内没有任何按 URI 的在途登记或去重表，两次写同一文件即可让两条后台等待并发注入。

## 复现与诊断（2026-10-31，票 #388）

**回路**：`test/core/issue-388-stale-diagnostics.test.ts` —— 假时钟 + 一个
「只保留最后一份文本、按收到的文本算诊断」的假 server；两次对同一文件的写
（先 `gamma` 后 `delta`），第一次写的诊断超出 1s 内联窗口转后台等待。

```
npx vitest run test/core/issue-388-stale-diagnostics.test.ts
```

**修复前的红**（模型收到的东西：旧文件的源码行 + 新文件的错误信息）：

```
[LSP diagnostics arrived late for a.ts]
written by edit (call call-1):
  g7: const alpha = 1;
      ↳ error: Cannot find name 'alpha'.
  vT: const gamma = 2;          ← 旧文件的第 2 行（磁盘上已是 delta）
      ↳ error: Cannot find name 'delta'.
```

同时，假 server 记录到的「被灌进去的文本」在第二次写之后仍然出现 `gamma`
—— 探针把旧文本回灌给了语言服务器。

**坐实的根因**（本笔记的推断逐条被回路证实）：

1. 没有任何按 URI 的「最新一次写」登记 → 交付层不知道自己服务的写已被盖过；
2. 探针把**写时快照**灌回 server（`didChange`）→ server 的文档视图被回滚；
3. 注入消息不带任何版本/指纹 → 模型无从分辨新旧。

**修法**（ADR-0029）：写路径登记「每个文档最新一次写」（内容 + 不重复的
generation，`src/lsp/write-tracker.ts`）；交付层捕获自己那次写的 generation，
被更新的写盖过时**丢弃**报告；探针改为在每一步**重新取当前内容**（resolver
而非快照），因此永远不会把旧文本灌回 server；报告的行、锚点、served 集合
全部按「被验证的那份文本」渲染。

**修复后的绿**：注入恰好一条，内容是当前文件（`delta`）；server 在第二次写
之后没有再收到任何含 `gamma` 的文本。
