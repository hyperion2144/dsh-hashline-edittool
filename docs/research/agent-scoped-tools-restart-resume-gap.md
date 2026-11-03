# 研究结论：agent 级注册的工具在「重启 + 恢复会话」的第一轮缺席

**日期**：2026-11-03　**宿主版本**：`dsh-v0.2.2-alpha.2`（宿主源码树 `/Users/mutou/vault/projects/deepseek-harness`；`packages/preset/agent-preset/package.json` = `0.2.2-alpha.2`，与报告环境同一条线）　**插件版本**：v0.10.7　**关联票**：#398
**一手来源**：宿主 `packages/`（下称「宿主」）+ `vendor/cordis`（cordis 4.0.6-alpha.1）；插件 `src/`；宿主自带技能文档 `dsh-plugin-guidelines`（会话内可加载）

## 一句话结论

失败**不是**「工具注册在 agent 层而非 global 层」，而是**插件的 `agent/created` 监听器是同步的、在异步安装完成之前就返回**——宿主契约明写监听器「必须等异步的工具与提示词安装完成后才返回」；宿主 await 完监听器便**释放恢复会话里排队的输入**，第一个模型请求在插件其余 10 个工具尚未注册时就组装了工具面。改注册层解决不了时序问题，还会破坏对 preset 内置工具的遮蔽。

## Q1 时序：`agent/created` 何时发出？恢复会话的「建 agent」与「第一个模型请求」谁先？

**答：宿主先建 agent，再发第一个模型请求；工具面在每个 step 现场组装，不是会话快照。**

调用链（全部宿主源码）：

1. `packages/core/agent-loop/src/index.ts:465` `initializeAgent()`——新建与恢复共用同一条初始化流程（`:668-676` `create()`；`:754-761` `resume()` → `:763-838` `resumeWith()`：冷读持久化日志 → `interruptedTurnClosers` 给中断的末轮补合成收尾（`:802`）→ `sessions.prepare({ seed: persisted })`）。
2. `:621` `agent.runMaintenance(async () => { … })`——整个初始化跑在 agent 的 *maintenance* 相位里，此相位内驱动（driver）不能启动。
3. `:630` `const setupCommit = await raceAbort(setup?.(agent.ctx, agent), abort.signal, id)`——preset 在这里挂载（见 Q4）。
4. `:637` `await loopCtx.agents.announce(agent, source, abort.signal)`——**这里发出 `agent/created`**。
   - `packages/core/agent/src/index.ts:562-583` `announce()`，核心一行 `:575`：`await this.ctx.serial(entry.carrier, 'agent/created', { agent, source, signal })`（串行、逐个 await）。
   - 事件签名：`packages/core/agent/src/runtime-types.ts:290`。
   - 契约（事件目录）：`packages/extensions/tool-cordis/src/api-catalog.ts:4719-4724`：「Listeners run in order and are awaited before creation resolves. **AgentLoop holds queued input until all listeners finish.**」
   - `packages/core/agent-loop/README.md:110`：「…enter the AgentRegistry; **await serial `agent/created` listeners; then release queued input.**」
5. `packages/core/agent-loop/src/agent.ts:216`——maintenance 结束、驱动被唤醒：`:230` `wakeDriver()` → `kick()` → `turn()` → `:283` `preStep()`。
6. `packages/core/agent-loop/src/agent.ts:292` `const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })` → `:294` `const assembly = await this.loopCtx.systemPrompt.assemble({ …, toolSet })`——**第一个模型请求的 tools 列表就是在这里现场组装的**。

关键片段（`packages/core/agent-loop/src/agent.ts:283-294`）：

```ts
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
  …
  const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
  try {
    const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })
```

=> 结论：**「先建 agent，再发第一个请求」**；工具面**每 step 重组**（这既是缺口成立的前提，也是「下一轮就补齐」的原因）。

**恢复路径的排队输入来自磁盘**：`packages/core/agent-loop/src/inbox.ts:26-66` 的 inbox 投影从 `agent/inbox/spliced` 事件重建 pending 输入；恢复时这些事件随会话日志一起被读回（`packages/core/agent-loop/src/index.ts:804-807`）。所以「恢复出来的排队输入」在 `agent/created` 监听器一返回就被释放——**没有人类打字延迟**。

## Q2 cordis `ctx.effect(fn)` 的同步/异步语义

**答：(a) 立即同步调用 fn，并在第一个 await 之前跑完同步部分；cordis 不 await fn 本身。**

`vendor/cordis/src/fiber.ts:424-528`：

```ts
effect(execute: () => Effect, label = 'anonymous'): any {
  …
  try {
    task = this._execute(runner)      // :527-528，同步调用
```

`_execute` 在 `vendor/cordis/src/fiber.ts:372` 同步调用 effect 体：`const effect: Effect = runner.execute.call(this)`。因此 async 函数体的同步前缀在 `ctx.effect(...)` 调用点**同步跑完**；而 `ctx.effect` **不等待** effect 体（它只把 promise 挂到 disposer 链上，`:552-559`）。`ctx.effect` 也不会「在 scope 就绪之前 await 它」——`fiber.ts:425-427` 只做 `assertActive()`，随后同步执行体。

**落到插件上**（`src/index.ts:162` `agent.ctx.effect(async () => { … })`）：

- 同步段里只做了 `registerEditTool`（`src/index.ts:179`）——**`edit` 是唯一同步注册的工具**；
- 第一次 await 是 `src/index.ts:182` `await resolveAgentSections(rootCtx, agent)`（读 per-preset guidance 覆盖文件，异步 I/O）；
- 其余 10 个工具（`read`/`grep`/`ast_grep`/`lsp`/`ast_edit`/`undo_last_edit`/`write`/`format`/`delete`/`rename`）全部排在那个 await 之后：`src/index.ts:214-246`。

=> 这一轮里插件只同步挂上了 `edit`；其余 10 个要等一次文件读完。**这正是「第一轮工具面残缺」的机械原因。**


**实测（本机，插件实际解析到的那份 cordis）**：本仓 `node_modules/@deepseek-ai/cordis` 是 **4.0.2**（宿主 `vendor/cordis` 是 4.0.6-alpha.1 —— 版本不同，语义一致）。用插件真正运行的那份跑最小探针：

```js
// /tmp/cordis-effect-probe.mjs
import { Context } from '<repo>/node_modules/@deepseek-ai/cordis/lib/index.js'
const log = []
const ctx = new Context()
ctx.effect(async () => {
  log.push('1 effect-body-sync')
  await new Promise(r => setTimeout(r, 30))
  log.push('2 effect-body-after-await')
  return () => {}
})
log.push('3 after-effect-call-returns')
// 实测输出：["1 effect-body-sync","3 after-effect-call-returns","2 effect-body-after-await"]
```

=> 与上面的源码推导一致：effect 体的**同步前缀在调用点就跑完**，而 `ctx.effect()` **不等** effect 体。Q2 的结论因此是**源码 + 实测**双向确认，不只是读码。

---

## 补充：第二遍研究（后台代理）对本笔记的两处修正

1. **`lsp` 的归属**：插件的 `registerLspProvider`（`src/lsp/provider.ts:211-229`）注册的是**语言服务器 provider**，**不是工具**——它不会让官方 `lsp` 工具「始终可用」；官方工具的**注册**仍在它被挂载的那一层（宿主默认组合里没有 `@deepseek-ai/dsh-tool-lsp`，报告环境显然装了）。第一轮那个 `lsp` 只能是官方工具，插件的 `lsp` 与 `read`/`grep` 相邻、同在那个 await 之后。
2. **第一轮 `grep` 缺席有两个候选解释**，且第二候选会影响验收标准：(i) 报告环境没装 `@deepseek-ai/dsh-tool-fs-search`；(ii) **preset 挂载时那一行仍在等宿主服务**——`tool-fs-search` 的 `inject` 含 `subprocess`（`packages/fs/tool-fs-search/src/index.ts:71`），preset 挂载对「等服务的行」只记 pending 不失败（`packages/preset/agent-preset-registry/src/mount.ts:134-158` `auditRows`），该行稍后才激活 ⇒ `grep` 第二轮才出现。若是 (ii)，`grep` 的第一轮缺席**部分**是宿主侧 pending 行的问题，插件侧的时序修复不能独自保证它第一轮就在场——验收标准应当写成「**插件的 11 个工具**第一轮齐」，而不是「全部工具齐」。

另：宿主有比 `agent/created` 更强的入口——`ctx.agents.create/resume({ setup })`（`packages/core/agent-loop/src/index.ts:630`），「Everything registered through `agentCtx` … **exists before `agent/created`, and the first prompt assembly**」（`packages/core/agent/src/index.ts:110-114`）。但那是**建 agent 的一方**才能提供的钩子，插件不是建 agent 的一方；因此插件侧可达的合规解仍是 `agent/created` + await。

## Q3 scope layer 语义（dsh-tools 的注册表）

实现：`packages/core/tools/src/index.ts:99` `ToolsService`，`:106` `new ScopedLayers(scope => new ToolLayer(scope), …)`；层由 `scopeOf(ctx)` 决定（`packages/core/scope/src/store.ts:226-233`；`scopeOf` 定义在 `packages/core/scope/src/index.ts:154`）。

**关键机制：服务实例上的 `ctx` 是「使用点」**，所以 `agent.ctx.tools.register(...)` 与 `rootCtx.tools.register(...)` 落在**不同的层**：`vendor/cordis/src/service.ts:46-49` 给服务装 tracker `{ associate: name, property: 'ctx' }`；`vendor/cordis/src/utils.ts:172-224` 的 `createTraceable` 在 `:177` `if (prop === tracker.property) return useSite`——方法体里的 `this.ctx` 就是**访问者的 ctx**。

**① global 层（`rootCtx.tools.register`）注册的工具会出现在某个 agent 的工具面里吗？**——**会**。`packages/core/tools/src/index.ts:199-229` `view(scope)`：

```ts
const layers = this.layers.chainLayers(scope)      // :200
const own = this.layers.peek(scope)               // :201
const inherited = new Map(this.layers.global.tools.entries())   // :202 ← global 层是所有人的祖先
…
if (own !== undefined) {                          // :219 本 scope 自己的层最后写 → 遮蔽
```

**② agent 层同名注册会遮蔽 global 层的同名工具吗？**——**会**（own 层最后写，`:219-224`）。同理 **preset 层遮蔽 global 层**（preset 是 agent 的父作用域，见 Q4）。

**③ 同一层注册同名工具会怎样？**——**抛错，不覆盖**。`packages/core/scope/src/store.ts:43-46`（`NamedEntries.insert` → `duplicateError`）；错误文案按层分两种（`packages/core/tools/src/index.ts:68-70`）：

- global 层：`tool "X" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
- scope 层：`tool "X" is already registered in this scope`

**跨层同名 → 遮蔽，不报错**（这是 Q5 的关键）。

其余 API：`definitions(scope)`/`schemas(scope)` `:305-318`；每 step 的准入快照 `resolve(context)` `:264-292`；提示词 section 走同一套层语义（同名 section 在更近的层替换更远的）。

## Q4 内置工具的真实身份

| 名字 | 宿主实现 | 注册在哪一层 |
| --- | --- | --- |
| `read` | `@deepseek-ai/dsh-tool-fs` → `packages/fs/tool-fs/src/read.ts:78` | **preset 层**（standard preset 的 `tool-fs` 行） |
| `write` | `packages/fs/tool-fs/src/write.ts:74` | preset 层 |
| `edit` | `packages/fs/tool-fs/src/edit.ts:86` | preset 层 |
| `grep` | `@deepseek-ai/dsh-tool-fs-search` → `packages/fs/tool-fs-search/src/grep.ts:287` | preset 层（standard preset 的 `tool-fs-search` 行） |
| `lsp` | `@deepseek-ai/dsh-tool-lsp` → `packages/lsp/tool-lsp/src/index.ts:109` | **默认组合里没有**（只出现在 `snapshots/session/lsp-definition/cordis.yml` 的测试快照里） |

**为什么是 preset 层**：模型可见的内置工具是 preset 的行——`packages/bundle/web-app/presets/standard.patch.yml` 的 `plugins:` 列表里有 `tool-fs`、`tool-fs-search`、`tool-bash`、`tool-pwsh`、`tool-jobs`…；preset 在 agent 的 setup 里挂载（`packages/api/session-controller/src/agent.ts:274-286` `composeAgent` → `setup: async (agentCtx) => { …; await presets.mount(agentCtx, resolvedId) }`），并且 **agent 的 scope key 的父就是 preset 的 scope key**：`packages/preset/agent-preset-registry/src/index.ts:121`（`createScope(this.owner, key)`）+ `:282`（`bindScopeParent(key, generation.key)`）。=> 视图链是 `agent → preset → global`，越近越赢。

**内置 `read` 的输出是普通行号文本，不是 hashline 锚点。** `packages/fs/tool-fs/src/read.ts:79` 的描述即 “return line-numbered content”；渲染在 `packages/fs/tool-fs/src/read-render.ts:162-163`：`${line.number}: ${line.text}` + 一行脚注。**没有锚点、没有 `ANCHOR:FILELINE` 头**。

**内置 `grep` 在当前 dsh 版本里存在**（`@deepseek-ai/dsh-tool-fs-search`），standard preset 挂着它 => 插件 AGENTS.md 说「shadow 内置 grep」**成立**。

=> 但这带来一条**必须对上的事实**：报告第一轮里 `grep` **彻底缺席**，意味着**preset 的内置 grep 那时也不在场**。两个候选解释（都不改变根因）：

- (i) 报告环境没装 `@deepseek-ai/dsh-tool-fs-search`；
- (ii) preset 挂载时那一行**仍在等宿主服务**——`tool-fs-search` 的 `inject` 含 `subprocess`（`packages/fs/tool-fs-search/src/index.ts:71`），而 preset 挂载对「等服务的行」只记 pending 不失败（`packages/preset/agent-preset-registry/src/mount.ts:134-158` `auditRows`，`:210` 调用处），该行稍后才激活 => grep 在第二轮才出现。

**官方 `lsp` 工具注册在哪一层？** 默认组合里根本没有它（见上表）；谁装了 `@deepseek-ai/dsh-tool-lsp`，谁就把它挂在自己选的那一层。

**插件的 `registerLspProvider` 做什么？** 它注册的是**语言服务器 provider**，不是工具：`src/lsp/provider.ts:211-229` → `service.registerProvider(buildProvider(lookup))`；宿主侧 API 是 `packages/lsp/lsp/src/index.ts:90` `registerProvider`（宿主是 host 级服务，插件在 root ctx 上拿它）。=> 它**不会**替换官方 `lsp` 工具的实现、也**不会**让官方 `lsp` 工具「始终可用」：官方工具的**注册**仍在它被挂载的那一层；插件的 provider 只是换掉「官方工具背后用哪个语言服务器实现」。

=> **推论**：报告第一轮里 `lsp` 在场，**不能**说明插件的 agent 层 `lsp` 工具在场——插件的 `lsp`（`src/tools/tool-lsp.ts:875-877` `agentCtx.tools.register(...)`）与 `read`/`grep` 相邻、同在那个 await 之后。第一轮那个 `lsp` 只能是**官方 `@deepseek-ai/dsh-tool-lsp`**。

## Q5 把工具改到 root/global 层可行吗？

**不可行，且会破坏遮蔽。**

- global 层注册的工具**会**进入每个 agent 的工具面（Q3 ①），但**遮蔽不了 preset 层的同名工具**（Q3 ②：preset 是 agent 的父作用域、比 global 更近）。=> 插件的 `read`/`write`/`edit`/`grep` 挪到 global 层后，**hashline 版永远不生效**，preset 的内置版照旧上场。
- 插件真正**必须 per-agent** 的东西：
  1. **遮蔽 preset 的内置 read/write/edit/grep**——只能靠更近的层，即 agent 层；
  2. **per-preset 的 guidance 解析**——`src/index.ts:140-146` 用 `agentPresets.composedPreset(agent.ctx)` 取该 agent 的 preset id 再按 preset 读覆盖文件；root 层没有 agent 上下文，做不到；
  3. **同名提示词 section 的 per-agent 遮蔽**——插件要覆盖 preset 的 `tool:read`/`tool:edit`/`tool:grep` 段（`src/index.ts:250-256`），同名 section 也是「更近的层赢」；
  4. **随 agent 自动回收**——agent 层注册挂在 agent 的 scope 上，agent 释放时自动卸载；global 层是进程级。
  （可以留在 global 的只有纯 host 级能力，例如 `fs` 访问与 LSP provider——插件现在已经这么做了：`src/index.ts:167-171` 的 `rootCtx.fs`、`src/index.ts:438` 的 provider 注册。）
- **「若 grep 在 global 层注册，而 preset 层也有内置 grep，是否触发同层同名重复注册错误？」**——**不会**。preset 层与 global 层是**不同的层**；跨层同名是**遮蔽**关系（Q3 ②③）。只有**同一层**内重复注册才抛错（`packages/core/tools/src/index.ts:68-70`）。

## Q6 宿主是否已有正解或已知问题

**有明确规则（4 处），没有找到已登记的同类缺陷。**

**规则 1（判据）** `packages/core/agent/README.md:207`（Known Limitations 第一条）：

> **Creation listeners share the initialization lifetime.** An `agent/created` listener must not await `agent.whenIdle()` or its own owner's disposal: those operations wait for creation to finish. **Return only after required asynchronous tool and prompt installation completes.**

=> 宿主**明确要求**：`agent/created` 监听器必须**等异步的工具与提示词安装完成后才返回**。插件现在的写法**违约**。

**规则 2** `packages/extensions/tool-cordis/src/api-catalog.ts:4722-4723`：「Listeners run in order and are awaited before creation resolves. AgentLoop holds queued input until all listeners finish.」

**规则 3** `packages/core/agent-loop/README.md:110`：「…await serial `agent/created` listeners; then release queued input.」

**规则 4（旁证）** `docs/subsystems/claude-code-mods.md:24`：`session.start`「Raised for a root agent from `agent/created`, **awaited before its first turn**」。

**宿主给的「正解」还多一条**：`packages/core/agent/src/index.ts:110-114`（`AgentFactory.createAgent` 的文档注释）——「Everything registered through `agentCtx` (scoped tools, prompt sections/variables, `restrict()`, listeners, awaited child plugins) **exists before `agent/created`, and the first prompt assembly**」。也就是说宿主有两条入口：

- **`setup` 钩子**（`ctx.agents.create({ setup })` / `ctx.agents.resume({ setup })`，`packages/core/agent-loop/src/index.ts:630`）——这里注册的东西保证先于 `agent/created` 与第一次提示词组装存在；
- **`agent/created` 事件**——后发的弱入口：宿主会 await 监听器，但**只 await 到监听器返回为止**，监听器自己丢出去的后台安装不在契约内。

插件用的是后者，且**没有 await 自己的安装**——这正是缺口。

**关于「插件工具该注册在 agent 层还是 global 层」的推荐**——在宿主技能文档 `dsh-plugin-guidelines` 里（会话内可加载；它自称 pinned 到 dsh 0.1.0-rc.6，引用时按「机制优先」处理）：

- 「Host plane / Agent plane」两分：**模型可见的工具住在 agent plane（preset），不在 host plane**；「a host-plane registration of a tool name that a preset already registers does not replace it — the preset's nearer layer wins」；
- 「Own layer wins」：`agent → preset → global`，越近越赢；「**The registry's global layer is deliberately empty of model tools**, so "register globally to replace X" cannot work — the preset's X shadows it」；
- 它给的「shadow 一个内置工具」范式正是插件现在的写法（`ctx.on('agent/created')` + `agent.ctx.effect(() => { …register… })`），并断言「`agent/created` … is the first startup-driving extension point, **so the shadow is installed before the first request**」——**这句断言在插件当前写法下不成立**（effect 体是 async 且没人 await 它）。

**已知的「重启/resume 后第一轮工具面不完整」问题或修复：查不到。** 搜过：`packages/**`（`rg 'agent/created'` 全量）、`docs/`（`docs/postmortem/` 4 篇 + `docs/subsystems/` 全量，关键词 `resume` / `first turn` / `tool surface`）、宿主仓 `.agents/skills/`（无命中）。宿主机制本身健全（等监听器、每步重组工具面），缺的是插件遵守契约。

另：宿主仓 `.agents/skills/dsh-plugin-guidelines/SKILL.md` **不存在**（该目录下是另外 20 个 skill）；同名文档只存在于本机会话的 skill 目录，故上文引用标注为「会话内可加载」。

## 对 issue #398 的含义

**推翻**

1. 「工具是 agent 级而非 global 级导致」——**不成立**。agent 层是**唯一**能遮蔽 preset 内置工具的层；改到 global 层后 hashline 版会被 preset 遮蔽，问题从「缺工具」变成「hashline 永远不生效」（更糟）。
2. 「第一轮 `lsp` 在场 ⇒ 插件的 lsp 工具在场」——**不成立**。插件的 `lsp` 与 `read`/`grep` 相邻注册、同样排在 await 之后；第一轮那个 `lsp` 只能是官方 `@deepseek-ai/dsh-tool-lsp`（宿主默认组合里并没有它）。

**证实**

3. 「第一轮可能是内置版而非 hashline 版」——**坐实**（可证推论）：插件的 `read` 与 `grep` 是**相邻注册**（`src/index.ts:214-215`，中间无 await）。若插件的 `read` 在场，`grep` 必在场。报告说 `grep` 缺席 ⇒ 插件的 `read` 不在场 ⇒ 第一轮看到的 `read` 是**内置版**（行号语义、无锚点）。
4. 「恢复会话第一轮插件还没把工具挂上」——**方向对，机制错**。不是层的问题，是**插件的 `agent/created` 监听器提前返回**：宿主契约要求它等异步安装完成（`packages/core/agent/README.md:207`），而它同步返回了。
5. 「下一轮 7 个工具全部回来」——**与源码一致**：工具面每 step 重组（`packages/core/agent-loop/src/agent.ts:292-294`），第一轮之后插件那 10 个工具早已注册完毕。

**修正**

6. **「7 个插件独有工具」这个说法要改**：当前 dsh **有**内置 grep（`@deepseek-ai/dsh-tool-fs-search`），插件是 shadow 它。第一轮真正缺席的是「插件 11 个工具里，没有官方同名工具顶替的那 7 个」；而**插件在第一轮实际只挂上了 1 个（`edit`）**，另外 10 个（`read`/`grep`/`ast_grep`/`lsp`/`ast_edit`/`undo_last_edit`/`write`/`format`/`delete`/`rename`）被 `src/index.ts:182` 那次 guidance 文件读取挡在门外。
7. **第一轮的危险不止「少几个工具」**：第一轮拿到的是**内置 `read`/`write`（行号语义、无锚点）**配 **hashline `edit`（只认锚点）**。内置 read 的产物里没有锚点，拿它去喂 hashline edit 必然被拒（锚点就是 edit 的地址）。模型会先按内置语义读一轮、编辑被拒，下一轮工具面才补齐——正好对上报告的「下一轮才恢复」。
8. **为什么是「重启 + 恢复」而不是新建会话**：恢复路径**没有人类打字延迟**——排队输入（从磁盘恢复出来的收件箱）在 `agent/created` 监听器返回后立刻释放（`packages/core/agent-loop/README.md:110`）；新建会话则是用户打字到发出第一条消息之间的若干秒，插件那点 guidance I/O 早做完了。重启后是冷进程，首次读盘窗口更宽 ⇒ 更易复现。

**修法方向（本票只诊断，不实施）**

必要且最小的一步：**让 `agent/created` 监听器 await 完整安装**（宿主契约明写），并**把 11 个工具的注册挪到 guidance 解析之前**，使工具面在 effect 体内同步就位。两条一起做才覆盖「工具面完整」与「提示词就位」两件事。

约束：监听器 await 时**不得**等待 `agent.whenIdle()` 之类「等创建结束」的操作（`packages/core/agent/README.md:207`）；只能等自己的文件 I/O。

## 仍不确定的部分

1. 报告环境到底装了哪些内置包：`@deepseek-ai/dsh-tool-fs-search`（决定第一轮 `grep` 是「彻底缺席」还是「退回内置版」）、`@deepseek-ai/dsh-tool-lsp`（决定第一轮那个 `lsp` 是不是官方工具）。需要报告人贴出**第一轮真实的完整工具清单**（含 bash/pwsh/glob/jobs 等非插件工具）。
2. 恢复时「排队输入」的具体形态：磁盘恢复出来的收件箱消息，还是用户在 UI 上恢复后立刻点发送？两者都会让释放早于人类打字延迟，但复现脚本的写法不同。
3. 宿主是否在 `agent/created` 与第一个 step 之间留了「等插件 effect 体」的缝：源码看**没有**（只有契约，没有强制），需要实测确认第一轮工具面的确切快照时刻。
4. 第一轮 hashline `edit` 的实际失败形态（锚点缺失 vs 内容回显校验），以及模型在拿到混合工具面时的真实行为。
5. **本机未复现**：报告环境是 Windows + DSH Desktop Plus 0.2.2-alpha.2；本机是 macOS，且按仓内规则不得重启用户正在运行的桌面应用（隔离实例可做）。

## 建议的验证方式（隔离实例，可自动化）

1. 用隔离实例起一个带本插件的 profile（`DSH_HOME` + 独立端口 + `DSH_DESKTOP_NO_SINGLETON=1`），不动用户正在运行的 Desktop Plus。
2. 造一个「进行中」的会话：发一条消息，在模型回复前杀掉实例 → 重启 → 恢复该会话 → 观察**第一轮**的工具面。
3. 判定手段（任选）：
   - 在第一个 step 打印 `ctx.tools.schemas(agent)`（`packages/core/tools/src/index.ts:316`）；
   - 监听 `tools/change` 事件（`:106` `this.ctx.emit('tools/change')`）；
   - 读会话日志里的 request header（`packages/core/agent-loop/src/agent.ts:321-325` `toolsChanged`）。
   - 预期（修复前）：第一轮只有内置 `read`/`write` + hashline `edit`（+官方 `lsp`），插件那 10 个工具缺席；第二轮起 11 个齐。
4. 修法验证：监听器改成 `await` 完整安装 + 工具注册挪到 guidance 解析之前 → 第一轮应见 11 个 hashline 工具，且 `read` 是 hashline 版（输出带 `ANCHOR:FILELINE` 头）。
5. cordis 语义的最小探针（不依赖 dsh）：

```js
ctx.effect(async () => { log.push('1 sync'); await sleep(30); log.push('2 after-await'); return () => {} })
log.push('3 effect-call-returned')
// 期望：["1 sync", "3 effect-call-returned", "2 after-await"]
```

