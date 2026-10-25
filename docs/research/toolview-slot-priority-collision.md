# toolview slot 优先级冲突取证：本插件 `-1` 与 dsh-claude-style `-1` 撞车（#321）

> 诊断用笔记（2026-10-25）。范围只回答三件事：#321 的冲突是否成立、台账语义到底是
> 什么、修复该落在哪一侧。不涉及实现——取值与取舍留在票面 #321 的待决问题里。
>
> 取证手段：本机 shipped 运行时 `app.asar`（DSH 0.2.1-rc.3）里的 SlotCore 实现、
> `dsh-claude-style` 的 npm 包（0.18.2 与 profile 内在装的 0.18.5）、profile 内其它
> 插件的注册面、本仓 `client/` 源码。**未做真机复现**（本会话无浏览器）。

## TL;DR

1. 冲突成立。`tool.call.toolview` 是 keyed slot，台账按 **key + priority** 判重，
   同 key 同 priority 直接 `throw`；本插件与 `dsh-claude-style`（0.18.2 / 0.18.5 同构）
   都在 `-1` 注册 `read`/`edit`/`write`，slot name、locale 也一致。
2. 台账按 priority **升序**排、每个 key 取第一条 ⇒ **数值越负越优先**。所以 `-1 → -2`
   既压过 claude-style，也仍压过内建行（内建在缺省 `0`）。
3. 撞车时**后注册方**抛异常且自己那条不落账，先注册方不受影响。谁先注册取决于 client
   应用顺序，所以「卡片回退」这一症状落在哪一侧**并不固定**。
4. 只有 3 个 key 会撞。claude-style 只注册 `read`/`edit`/`write`；
   `grep`/`undo_last_edit`/`ast_grep`/`ast_edit`/`lsp`/`format` 在已装插件里没有对手。
5. 负优先级**不是保留区**。DSH 自己的动态插件包用 `--nextPriority`（从 0 递减）分配
   shadow 优先级 ⇒ `-1`、`-2`… 是共享 band，任何固定值都可能被未来的第三方撞上。

## 1. 台账语义（取证自 shipped 运行时）

来源：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 中 SlotCore 的
`register()`（字面量 `already has an entry for key` 唯一一处）。关键行为：

| 行为 | 代码事实 |
| --- | --- |
| 缺省优先级 | `const n = e.priority ?? 0` |
| keyed 判重 | `entries.find(p => p.options.key === e.key && (p.options.priority ?? 0) === n)` 命中即 throw |
| 错误文案 | ``at priority ${n}${registrant ? ` (registered by ${registrant})` : ""} — register at a different priority to shadow it (lowest renders)`` |
| 渲染顺序 | 入账时 `entries.sort((h, p) => h.priority - p.priority)`；`entriesOfSlot` 对 keyed 按 key 去重、**先到先得**（升序 ⇒ 最低值） |
| `registrant` | 只有注册方自己传 `registrant` 才出现；本插件与 claude-style 都不传，0.2.1-rc.3 也没有任何自动填充 ⇒ 报错里的 `(registered by Kb)` 是打包后插件名/其它运行时版本的产物，不影响结论 |
| shadow band 分配 | 动态插件包侧 `allocatePriority: () => --this.nextPriority`，`nextPriority` 初值 0（注释：「A later registration receives a lower priority」） |

## 2. 现实注册面

| 注册方 | slot | keys | priority | 取证 |
| --- | --- | --- | --- | --- |
| DSH 内建 `read-toolview` / `file-mutation-toolview` | `tool.call.toolview` | read / edit+write | 缺省 `0` | asar 内 ui-tool 的 `ReadRow` / `FileMutationRow` 注册处 |
| 本插件 client | 同 | read, edit, write, grep, undo_last_edit, ast_grep, ast_edit, lsp, format | `-1` | `client/src/client/index.ts`（#321 起为 `-2`） |
| dsh-claude-style 0.18.5（0.18.2 同构） | 同 | edit, write, read | `-1` | 包内 `lib/client.js`：`{name:"tool.call.toolview", priority:-1, locale:"conversation"}` |
| 其它在装插件（vision-toolkit / genui / visualize） | 同 | 各自工具的 key（`vision_*` / `render_ui` / `visualize`） | 缺省 | profile `node_modules` 取证 |

⇒ 交集只有 `read`/`edit`/`write` 三个 key；本插件另外 6 个 key 在现有环境下没有对手。
shipped 运行时里没有任何 `tool.call.toolview` 注册带负优先级。

## 3. 撞车时的行为，以及本机为什么复现不了

- 后注册方的 `register()` 在写账前抛错 ⇒ 它那条不渲染，先注册方保留。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 里有两条 `ui-skin-claude-style`：先一条带
  `config`，末条只有 `disabled: true`。按 patch 的 override-by-id 语义（见 Cordis 组合
  参考：带 `id` 且无 `insert` 的补丁替换该行字段），该插件在当前 desktop profile 是
  **关闭**的。所以本机此刻不复现——这是把冲突方关掉，不是修复。
- 同一文件里 `dsh-hashline-edittool` 的行排在 `ui-skin-claude-style` 之前。若 client
  应用顺序同序，则是 claude-style 后注册、由它吞下三个 throw，而本插件卡片照常渲染，
  与报告「本插件卡片回退到内建」不一致。**本次未在真机复现**（`bcdp_status` 不可用），
  症状归属留待真机复验；但根因（同 key 同 priority 会 throw）不受此影响。

## 4. 方案取舍

| 方案 | 结果 | 判断 |
| --- | --- | --- |
| A. 本插件 9 个 key 统一降到 `-2` | 与 `-1` 不再撞；升序去重下本插件仍压过 claude-style 与内建；**无论谁先注册都不再 throw** | 采纳（票面提案） |
| B. 上游 claude-style 让位 | 不在本仓控制面（`Nwflower/dsh-claude-style`，当前无相关 issue） | 可作知会，不作依赖 |
| C. 运行时探测（`ctx.slots.entries`）后动态选值 | 只保护「后注册方」：对方若写死 `-1` 且先注册，我方探测到空账仍取 `-1` 并撞 | 否决（多一层耦合，收益不完整） |
| D. 只改 3 个 key，其余留 `-1` | 无额外收益，还留一个不一致的取值 | 否决 |

残余风险：`-2` 是固定值，而动态插件包按 `0, -1, -2…` 分配优先级，理论上未来某插件对同一
key 取 `-2` 仍会撞。这是台账设计层面的洞（无保留区、无「已占用」协商），只能在 DSH 侧解决，
本仓最多把已知邻居让开。

## 5. 与既有笔记的关系

- ADR-0005 与 `client/README.md` 记的是「用 `-1` 接管内建行」；CHANGELOG 里写过「显式
  `-1` 确定性接管、不碰内建注册」。当时的假设只覆盖**内建在 0**，没覆盖**第三方也取 -1**
  —— 这正是 #321 的缺口。
- 所以既有笔记能回答「当初为什么是 -1」，回答不了「第三方同值时怎么办」，另起这一篇。

## 6. 未做 / 待做

- 真机复验：启用 claude-style 后开 GUI，确认 console 报的是谁、本插件三张卡片是否真的回退。
- 若要让台账层面不再可能撞车，需要 DSH 侧给出「已占用优先级」的查询或保留区约定，本仓
  单方面改固定值只能让开已知邻居。
