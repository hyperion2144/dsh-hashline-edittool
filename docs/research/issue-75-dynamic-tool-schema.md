# 研究结论：dsh 工具 schema 动态化机制（issue #75）

**日期**：2026-09-06　**分支**：`research/edit-content-echo-schema`　**验证脚本**：`scripts/verify-dynamic-schema.mjs`

## 机制结论：真动态可行，且对运行中会话即时生效

工具的模型可见 schema **不是**按会话快照，而是**每一步（每次模型请求）实时重组**。插件可以在
settings 切换时 dispose + 重注册同名工具，运行中会话的下一个请求即携带新参数集，无需新会话、
无需重启。

## 证据链（源码路径，宿主树 `@deepseek-ai/dsh@0.1.2-rc.1`）

1. **schema 在 defineTool 调用时一次性编译**：`dsh-tools/lib/types/schema.js` 中
   `const parameters = parameterSchemaSpecToJsonSchema(options.parameters)`（约 :293），
   返回的 `ToolDefinition.parameters` 此后固定。定义不可变 ≠ 注册不可变。
2. **注册表支持卸载/重注册**：`register(definition)` 返回"the exact disposer that unregisters
   the tool"（`dsh-tools/lib/types/index.d.ts:600-602`；实现 `dsh-tools/lib/index.js:2774-2783`）。
   同层同名重复注册报错 `tool "<name>" is already registered`（`lib/index.js:2538`）；作用域层
   注册可遮蔽全局层（`index.d.ts:597-598`）。`schemas()` 每次调用从当前层实时投影
   （`lib/index.js:2919-2921`，`view(scope)` 现算）。
3. **每步重组 tools 列表**：agent-loop 的 `preStep()` 每步调用
   `systemPrompt.assemble(...)`（`dsh-agent-loop/lib/index.js:502`），`assembly.tools` 传入
   `buildRequest`（:619）并进入 wire 请求（:771）。assemble 逐个调用 tool providers 并
   `structuredClone` 其 schemas（`dsh-system-prompt/lib/index.js:318-334`）；dsh-tools 注册的
   provider 即 `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`
   （`dsh-tools/lib/index.js:2609`）→ 实时读层。tools 变化时宿主甚至记录
   `request/header { reason: "change" }`（`dsh-agent-loop/lib/index.js:748-751`）——
   会话中途换工具集是一等公民路径。
4. **变更事件**：任何注册/卸载触发 `tools/change`（`dsh-tools/lib/index.js:2593`；事件语义
   `index.d.ts:84-93`）。`presentCall/presentResult` 对旧参数软校验、失败回退通用渲染
   （`schema.js` 尾部注释）——回放旧日志安全。

## 实证（真实 ToolRuntime + cordis，非模拟）

`scripts/verify-dynamic-schema.mjs` 输出：

- v1 注册后可见 `probe_tool({path})`；未卸载直接重注册报 `already registered`。
- dispose → 重注册 v2 后**同一进程内**可见 `probe_tool({path,content})`；`get()` 解析到新定义。
- 成功的每次 mutation 各触发一次 `tools/change`，共 4 次（register v1 / dispose v1 / register v2 /
  dispose v2）；被拒绝的同名重复注册**不**触发事件。

## 本插件挂接点（dsh-hashline-edittool）

- settings 切换时机：`installHashlineSettings` 的 `hooks.onChange`（`src/config.ts:309-318`，
  installSection 会把每次 commit 同步推给 hooks，见 `dsh-settings/lib/index.js:327-348`）与
  `ctx.on("settings/updated", sync)`（`src/config.ts:351`）。开关翻转在这里同步可见。
- 工具注册在**每 agent 作用域层**：`agent/session-start` → `installAgentTools`
  （`src/index.ts:159-169`）→ `agentCtx.tools.register(...)`（`src/tool-edit.ts:630` 等），
  disposer 已集中存于 `disposers`（`src/index.ts:117-123`）。
- 重建钩子形态：settings 回调里对每个存活 agent 执行「旧 disposer() →
  `agentCtx.tools.register(defineTool(按新 config 构建的参数集))`」。需要把每 agent 的
  disposers/构建器记入可迭代表（Map + `agent/disposed` 清理；或参照 dsh-tool-subagent 的
  reconcile 模式）。

## 先例

- **dsh 官方先例（决定性）**：`dsh-tool-subagent/lib/index.js:392-407` 按
  `modelSelectionEnabled`/`backgroundEnabled` **条件拼装参数集**
  （`...modelSelectionEnabled ? { provider, model, reasoning_effort } : {}`），provider 增删时
  `mounted.disposeTool()` → 重挂载（:560-565），并监听 `tools/change` 对所有组合 agent 调平
  （:648）。这就是官方「schema 随配置热替换」的现成范式。
- 本仓库先例：guidance 四节按 preset 在 session-start 一次性解析安装（`src/index.ts:128-131`、
  `src/guidance/`），属于「装定时定」，非 schema 级动态；但 `agent.ctx.systemPrompt.section()`
  的 text 若传函数，每步 assemble 都会重算（`dsh-system-prompt/lib/index.js:339` 附近），
  guidance 文本动态化比 schema 更轻。
- 未发现任何 dsh 内置走「静态 optional + 运行时拒收」以外配置驱动行为的第三个范式；
  tool 包均无 settings 重注册（全局仅 `dsh-settings` invariant 自身监听 `settings/updated`）。

## 推荐

**首选真动态**（settings/updated → 每 agent dispose + 重注册），并在 `execute` 内保留运行时
config 校验兜底（防「schema 切换竞态窗口内的旧形态调用」）。若实施票要求最小改动，回退方案
（schema 常驻 optional + 运行时强制必填/关时拒收，错误信息引导补传）完全可行且零重注册成本，
但会长期暴露幽灵参数、偶尔产生一轮拒收-重试。

## 验证脚本 commit


分支 `research/edit-content-echo-schema`；脚本 `scripts/verify-dynamic-schema.mjs`、本文档随该分支落盘，commit sha 见 resolution comment。
