---
title: "ADR-0043: 语言服务器 slot 按工作目录归属，不按 Agent"
type: decision
status: Accepted
date: 2026-11-23
issue: 450
supersedes: "ADR-0031 的 2026-11-17 补充段；ADR-0040 D1 的 Slot root 条目"
---

# ADR-0043: 语言服务器 slot 按工作目录归属，不按 Agent

## 背景与问题

#450 报告：一个含 AgentTeams continuable 子 Agent 的会话，团队归档（成员 `removed`、写入 `retired-members.json`）后，父会话执行一次普通 `edit`，DSH 宿主直接退出：

```text
dsh: fatal load failure: CordisError: cannot create effect on inactive context
    at Fiber.assertActive (.../@deepseek-ai/cordis/lib/index.js)
    at .../@deepseek-ai/dsh-working-directory/lib/index.js
  code: 'INACTIVE_EFFECT'
```

三件事同时成立才致命：

1. **失效的 fiber 被调用。** 每个 Agent 创建时都覆盖进程级 LSP manager 的全局 root resolver（`setRootResolver(async () => agentCwd(agent))`）。最后创建的是子 Agent；团队归档后它的 Cordis fiber 变 inactive。父会话 `edit` 冷启动语言服务器时，resolver 调 `workingDirectory.ensure(子 Agent)`，宿主的 `assertActive()` 抛 `INACTIVE_EFFECT`。
2. **没人接住。** `warm()` 是 `void this.#start(...)`，而 `#start` 里 `const workspaceRoot = await this.#workspaceRoot()` 在 `try` **之外**（`try` 从下一行才开始）。
3. **宿主把未处理拒绝当致命。** `app-boot` 的 `unhandledRejection` 处理器 → `report(err, 'fatal load failure')` → `process.exit(1)`。

这是 **0.11.4 引入的回归**。0.11.3 的 `warm(languageId, workspaceRoot, role)` 由调用方传 root，没有全局 resolver，不可能这样失败。引入者是 ADR-0040 D1 的「Slot root」条目：它把 root 从调用方参数改成 manager 自取，理由是「四个调用点三种 root，`process.cwd()` 混进 seam」。

那个理由本身没错，但它换来的新问题更严重：**root 现在取决于「最后创建的是哪个 Agent」，而不是「谁在调用」**。ADR-0040 声称「顺序依赖消失」——实际上没有消失，只是从「谁先 warm」变成了「谁后创建」，而后者与调用完全无关。

## 决定

### D1 — slot 的身份是 `(工作目录, 语言, 角色)`

`LspManager` 的每一个解析 slot 的公开方法都收一个 workspace root 参数：`warm`、`decide`、`sessionFor`、`waitForSession`、`forceWarm`、`readySessionFor`、`openDocumentFor`、`closeDocumentFor`、`unavailability`、`status`、`snapshot`、`readyLanguages`。slot 表、discovery 缓存、失败退避表三者的 key 都带上 root。

**语言服务器索引的是目录。** 不是 agent，不是 session。agent 只是「当前站在哪个目录」的持有者，而那个目录随时会变（`create_worktree`、`working_directory` 提交 `working-directory/change` 事件）。按目录归属是唯一与「服务器实际在索引什么」一致的身份。

### D2 — 删掉全局 root resolver，manager 不持有任何 Agent 引用

`setRootResolver`、`#rootResolver`、`#workspaceRoot` 全部移除。root 是每次调用的参数，用完即弃。

这让崩溃**结构性消失**，而不是被兜住：没有长期持有的 agent 引用，就没有尸体可踩。这比在 `#start` 里加 catch 强一个量级——兜底之后 slot 会永久 failed，父会话的 LSP 静默失效，比崩溃更难查。

### D3 — `#start` 整体包 try，给 fire-and-forget 形状上锁

删掉 resolver 之后 `#start` 里已经没有 `try` 之外的 `await` 了，但 `void this.#start(...)` 这个形状还在。将来任何人往里加一行 `try` 之外的代码，同样的崩溃就会回来。整体包一层 catch 是给这个形状上锁，成本一行。

### D4 — 不提供配置开关

这个改动最初的目的就是「agent 创建 worktree、改了工作目录后，cwd 能实时更新，相对路径能落到 worktree」。对 agent 来说它的 cwd 就是变了，按目录归属是唯一正确的身份。加一个 `root_scope: root | agent` 的开关只会让「按 agent」这个错误选项继续存在。

### D5 — 状态面按 root 分组

`status()` 全量返回并按 root 分组。web 路由没有 agent，拿不到 cwd，全量是唯一诚实的答案；卡片顺带能显示「这台机器上有哪些 server 在跑」。

## 后果

- 归档一个子 Agent 不再可能让宿主退出。回归测试驱动一个 `ctx.fiber.assertActive()` 抛 `INACTIVE_EFFECT` 的假 agent，断言没有未处理拒绝到达进程。
- 父会话在 `/repo`、子 Agent 显式传 `cwd` 进 worktree 时，两者各有一个 server；子 Agent 不传 `cwd`（默认继承父）时共享父的 server，不额外起进程。
- worktree 里的项目本地 `node_modules/.bin` 能被 discovery 找到（`projectRoot` 不再写死 `process.cwd()`）。
- 宿主 `lsp` 工具（走 provider）解析到调用目录的 server，而不是别的目录的。
- **内存代价**：一个目录一个 server。父会话在 `/repo`、进 worktree 后是 `/repo/.agents/worktrees/x` → 两个 server 并存，旧的 5 分钟后 idle 回收。这是「按目录」的必然代价，也是它的正确性来源。
- **切换成本**：切换目录时旧 slot 变孤儿，不主动杀，等 idle 回收。主动回收需要证明「这个 root 还有没有活着的 agent」，而 agent 归档后 `agents.get()` 就查不到了，容易误杀正在被别的会话用的 server。

## 替代方案

- **保留全局 resolver，只在 `#start` 里加 catch。** 拒绝：崩溃变成「slot 永久 failed」，父会话 LSP 静默失效，比崩溃更难查。而且 resolver 仍然指向尸体，只是不再致命。
- **resolver 只在 `delegationDepth === 0` 时安装（「根 Agent」）。** 拒绝：只是把「绑错人」的概率降低，没有消除。子 Agent 用 `cwd` 参数换目录时 root 仍然是错的，而换目录正是这个功能存在的理由。
- **每 Agent 一个 slot（key = agentId + languageId）。** 拒绝：同 cwd 的父子 Agent 会各起一个 tsserver，纯浪费。语言服务器索引的是目录，agent 身份不是它的关注点。
- **加 `root_scope: root | agent` 配置开关。** 拒绝：见 D4。让错误选项继续存在，且需要一套「切换时如何不影响在跑会话」的额外语义。

## Evidence

- Field report: [#450](https://github.com/hyperion2144/dsh-hashline-edittool/issues/450) — Windows x64、DSH `0.2.2-rc.5`、插件 `0.11.5`，8 轮会话、约 24 万上下文，团队归档 5 分钟后 `edit` 崩溃，同一天多次复现同一堆栈。
- 报告引用的四处代码（`lib/index.js:387`、`lib/domain/session/live-cwd.js:74`、`lib/lsp/auto-diag.js:113`、`lib/lsp/manager.js:295`）在已发布的 0.11.5 产物上逐行核对属实。
- 致命路径用临时探针在仓内源码上验证：resolver 抛错 → 捕获到 `unhandledRejection`。
- 版本对比：0.11.3 的 `warm(languageId, workspaceRoot, role)` 无全局 resolver；0.11.4 引入 `setRootResolver`。
- 宿主语义：`packages/session/working-directory/src/index.ts` 的 `ensure` 与 `commit` 两处 `agent.ctx.fiber.assertActive()`；`packages/boot/app-boot/src/index.ts` 的 `unhandledRejection` → `fatal load failure` → `process.exit(1)`。
- 宿主 `SessionHeader.delegationDepth` 与 `child-agent.ts` 的 `parentHeader.cwd` 继承：子 Agent 默认与父同目录。
