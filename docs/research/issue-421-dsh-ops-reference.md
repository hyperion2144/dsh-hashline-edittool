# 研究笔记：dsh-ops 参考调研 —— 冷工具注册与上下文去重（服务于 #421 ②④）

**日期**：2026-11-06　**状态**：Research — 服务于 #421 ②④，只读研究，未改参考仓库
**参考仓库**：`T-Auto/dsh-ops`　**研究版本**：HEAD = `b5a69e59d42f0e8a760fa11269b4569e24e187a8`（短哈希 `b5a69e5`，提交时间 2026-11-06 20:51:20 +0800，提交标题 `Merge pull request #625 from T-Auto/work/integ-g1`）
**检出位置**：`/tmp/dsh-ops-research`（`git clone --depth 1`；未修改、未构建、未跑测试）
**宿主参照**：`/Users/mutou/vault/projects/deepseek-harness`（仅用于核对 `tools.register({ when })` 与 `SessionSurface` 的语义，非本次研究对象）
**路径约定**：`dsh-ops:` 后的路径相对参考仓库根；`host:` 后的路径相对宿主仓库根。
**本仓关联票**：[#421](https://github.com/hyperion2144/dsh-hashline-edittool/issues/421)（五项 token 效率优化）　**关联前例**：[#418](https://github.com/hyperion2144/dsh-hashline-edittool/issues/418) 的教训（探针式动态定层在重启恢复路径误判缺席，已改为恒注册）

---

## 0. 结论速览

1. **dsh-ops 的冷工具是「注册一次 + `when` 谓词按步准入」，不是「发现前不注册」。** 工具定义在 attach 时就 `tools.register(...)`，准入与否由宿主每步求值的 `when` 谓词决定（`dsh-ops:src/discovery/controller.ts:129-131`）；宿主只有 `when` 为真才把它放进该步的 admitted tool set，从而**不进 wire schema**（`host:packages/core/tools/src/index.ts:273`、`:316-318`）。这与本仓库 `docs/research/issue-75-dynamic-tool-schema.md` 记录的「真动态」结论同源，但 dsh-ops 把它当成了**默认产品形态**而不是实验结论。
2. **dsh-ops 有一个常驻的「发现入口」工具 `ops_discover_tools`**（`availability: 'resident'`，`dsh-ops:src/capabilities/registry.ts:40-44`），其余 14 个文件工具全部 `discoverable`（`:21`）。这是它「重启恢复第一轮不空手」的全部依靠。
3. **但 dsh-ops 没有对「重启恢复第一轮工具在场」给出显式断言或门禁。** 它的「已发现」状态是 per-agent 的**内存 `Set`**（`dsh-ops:src/discovery/controller.ts:42`），不持久化；重启后所有冷工具重新变冷，靠模型重新发现一轮来优雅降级。在场性最终依赖宿主 `agent/created` 的 await 契约（`host:packages/core/agent/src/index.ts:176`、`:564`）＋插件监听器里的 `await entry.ready`（`dsh-ops:src/publication/native.ts:151-153`）。
4. **模型调用未准入的工具时，dsh-ops 没有任何兜底**：`grep -rn "UNKNOWN_TOOL" src/` 在 `dsh-ops/src/` 下**零命中**；宿主按 `host:packages/core/tools/src/index.ts:249-254` 抛 `UNKNOWN_TOOL`。它靠**提示词预防**（`dsh-ops:src/discovery/prompt.ts:16-18` 明确写 "Do not guess an absent tool"），不靠运行时引导。
5. **dsh-ops 有完整的「读去重」机制，而且是压缩感知的。** 判据不止一个代数计数器，而是**五项事实同时成立**（`dsh-ops:src/projections/native/read-evidence.ts:11-22`），其中最关键的一条是：**那条工具结果消息此刻确实出现在最近一次完成的普通 provider 请求里**（`requestProof` 扫 `options.messages`，`read-evidence.ts:31-52`）。这是「内容在不在模型上下文」的直接证据。
6. **它的代数选得比本插件宽一代：用的是 `session.surface.contentGeneration`，不是 `replaceGeneration`。** 宿主 `host:packages/core/session/src/surface.ts:571-576` 显示 `replaceGeneration` 只在 `replace` 分支自增，而 `contentGeneration` 在 `replace` **和** `project`（消息投影）两个分支都自增 —— 投影会改变模型可见内容却不改变 `replaceGeneration`。
7. **结论：④ 的判据应从「served 指纹 ∧ replaceGeneration」升级为「served 指纹 ∧ contentGeneration ∧ 该 served 行确实在最近一次 provider 请求里」**；dsh-ops 的判据严格强于本插件当前判据（详见 C2）。
8. **结论：② 可以抄 dsh-ops 的「`when` 门控 + 常驻发现入口 + `step/end` 提交 + 有界检索」四件套，但不能抄它的「内存态选择集 + 靠宿主 await 兜底」**——那正是本票硬约束（不走探针、显式回答重启恢复第一轮在场）要避开的东西（详见 C1）。

---

## A. 冷工具注册（对应本票 ②）

### A1. dsh-ops 注册了哪些工具

dsh-ops 走的是 **「shell + 一组 Native 文件能力 + 一个发现入口」** 的形态，工具定义不从 `defineTool` 来，而是自己拼 `ToolDefinition` 对象后交给 `ctx.tools.register`。全仓 `grep -rn "defineTool" src/ packages/` **只命中一处注释**（`dsh-ops:src/shells/tool.ts:45`，讲的是「用 `defineTool` 写的工具其参数名会被宿主处理」），**没有任何 `defineTool` 调用**。

能力目录在 `dsh-ops:src/capabilities/registry.ts`：

| 组 | 工具 | `availability` | 出处 |
|---|---|---|---|
| 文件（Native） | `inspect_local_file`, `grep`, `glob`, `replace`, `write_file`, `edit_file`, `diff`, `stat`, `copy`, `move`, `remove`, `read_files`, `read_table`, `read_docx`, `read_pdf` | 仅 `read_files` 为 `resident`，其余 `discoverable` | `registry.ts:13`（顺序）、`:21`（availability） |
| PTC | `result` 等 | `resident`（`ptcAvailability` 另有 `discoverable` 分支） | `registry.ts:27-34` |
| Shell | `bash` | `resident` | `registry.ts:36-39` |
| 发现 | `discover_tools` | `resident` | `registry.ts:40-44` |

另有一份**模式相关的常驻集**：`NATIVE_RESIDENT_RAW = ['inspect_local_file', 'glob', 'grep', 'read_files', 'result']`（`dsh-ops:src/capabilities/profiles.ts:2`），由 `residentTools(mode)` 决定（`dsh-ops:src/presets/defaults.ts:49-51`）。注意 `minimal` 模式把 `residentTools` 关掉（`dsh-ops:src/settings/merged.ts:153`、`:230`），此时连文件工具也全部走发现。

### A2. 全量常驻还是按需/动态注册

**两者都不是纯粹的——它是「常驻一小撮 + 按需准入一大片」。**

- **常驻（永远在 wire schema 里）**：`ops_read_files`、`ops_discover_tools`（默认文件/发现面），以及 `ops_bash`（Bash 在启动面常驻，单列计量）。
- **按需（`discoverable`）**：其余 13 个文件工具 + PTC 侧能力。
- **关键**：这些 `discoverable` 工具**是被注册了的**，注册发生在 agent attach 时（`dsh-ops:src/discovery/controller.ts:183-191` → `publish` → `:129`）；不生效的原因是 `when` 谓词返回 false。

### A3. 注册/注销用什么机制，触发条件是什么

**机制：宿主 `ctx.tools.register(definition, { when })` ＋ 每步求值的条件准入。**

- 注册点（发现侧，冷工具）：`dsh-ops:src/discovery/controller.ts:129-131` —— `entry.ctx!.tools.register(definition, { when: async activation => … selected(…) })`。
- 注册点（常驻侧）：`dsh-ops:src/publication/native.ts:93-98` —— 同样带 `when`，谓词是 `activation.agent === agent && cover(agent) && !await activationIsPtc(prompt, activation)`。
- 宿主侧语义（**决定成败的那一行**）：`host:packages/core/tools/src/index.ts:273` —— `enabled = registration?.when === undefined || await registration.when(context)`；只有 `enabled` 的定义才进 `admitted`，而 wire schema 由 `schemas(scope, toolSet)` → `definitions(scope, toolSet)` → `toolSet.view(scope)` 投影（`host:packages/core/tools/src/index.ts:316-318`、`:303-310`）。agent-loop 每步重新求值（`host:packages/core/agent-loop/src/agent.ts:292-294`）。**即：谓词为假 ⇒ 该工具这一轮不进请求。**

**触发条件（三段式）：**

1. **模型主动调用发现入口**：`ops_discover_tools(query, max_results?)`（参数定义 `dsh-ops:src/capabilities/discovery.ts:22-28`，描述 `dsh-ops:src/capabilities/discovery.ts:29`）。检索是**确定性关键词匹配**，不调模型（`dsh-ops:src/discovery/search.ts:17-26`；词表 `dsh-ops:src/capabilities/discovery.ts:5-21`；排序 `dsh-ops:src/discovery/ranking.ts`）。也支持 `select:<精确工具名>` 直选（`search.ts:18-24`）。
2. **调用本身不生效**，只写入 `entry.pending`（`dsh-ops:src/discovery/controller.ts:159-160`），返回值明说 "Newly selected tools become available on the next model step; no tool action was executed."（`:164`）。
3. **在拥有方 session 的 `step/end` 事件上提交**：`entry.selected.add(api)`（`dsh-ops:src/discovery/controller.ts:256-259`），此后 `when` 谓词为真，工具在**下一次** provider 请求里出现。

**注销**：谓词转假即等价于「这一步不可见」，无需显式 dispose。真正的 dispose 只在 agent 销毁（`:208-229` `detach`）、组件卸载（`:279`）、能力池变化（`:133-147` `syncExternal`）、sandbox 模式变更（`:261-263`）时发生。

### A4. 模型调用一个未注册/未准入工具时会发生什么

- **未准入（注册了但 `when` 为假）**：宿主 `executable(name, scope, toolSet)` 在有 `toolSet` 时查 `toolSet.view(scope)`，查不到即不可执行（`host:packages/core/tools/src/index.ts:251-255`）；`toolSet` 缺省时，带 `when` 的注册**一律返回 undefined**（`:254`）—— 即「带条件注册的工具在模型步之外不可执行」。
- **完全没有注册**：同样落到 `UNKNOWN_TOOL`（`host:packages/core/tools/src/index.ts:249` 的注释明写 "the call must fail as `UNKNOWN_TOOL`"）。
- **dsh-ops 有没有兜底：没有。** `grep -rn "UNKNOWN_TOOL" dsh-ops/src/` **零命中**；`src/publication/replacements.ts`、`:native.ts`、`:ptc.ts` 里的失败路径全是 `POLICY_DENIED` / `ABORTED` / `RESULT_UNKNOWN` / `PUBLICATION_DENIED` 之类的自定义 Outcome，没有一条接「你还没发现这个工具」。
- 它靠**提示词预防**：`dsh-ops:src/discovery/prompt.ts:16-18` 的目录文案写明 "Discoverable means eligible for selection, **NOT callable or authorized**" 与 "Do not guess an absent tool"；`src/policy.ts:43-73` 的 `renderToolingPolicy` 表格也只列**已发布**的工具名。

### A5. 重启恢复路径上它怎么保证工具在场

**dsh-ops 没有「重启恢复」这个概念的任何显式代码或断言。** `grep -rn "resume\|restart" dsh-ops/src/` 只命中无关内容（`nextOffset resumes pending files`、PTC 的 `action: 'resume'` 枚举、bench 文档里的 "restart"）。它实际依赖的是下面三条：

1. **常驻发现入口保证「第一轮不空手」**：`ops_discover_tools` 在 `attach` 里无条件发布（`dsh-ops:src/discovery/controller.ts:182`：`if (config.enabled) publish(agent, entry, discover(agent, entry))`）。这是它在重启恢复第一轮唯一确定在场的工具。
2. **`agent/created` 监听器是 async 且 await 了发布就绪**：`dsh-ops:src/discovery/controller.ts:240`（`ctx.on('agent/created', async ({ agent }) => { await attach(agent) })`）与 `dsh-ops:src/publication/native.ts:151-153`（`if (cover(agent)) { attach(agent); await entries.get(agent)?.ready }`）。宿主侧 `await this.ctx.serial(entry.carrier, 'agent/created', {…})`（`host:packages/core/agent/src/index.ts:564`），契约明写「awaits serial `agent/created` listeners before releasing queued work」（`host:packages/core/agent/src/index.ts:176`）。
3. **挂载时补挂已存在的 agent**：`dsh-ops:src/discovery/controller.ts:281`（`await Promise.all((ctx.get('agents')?.list() ?? []).map(attach))`，**有 await**）与 `dsh-ops:src/publication/native.ts:161`（`for (const agent of ctx.get('agents')?.list?.() ?? []) if (cover(agent)) attach(agent)`，**没有 await** `entry.ready`；同一条写法在 `reconcile()` 里再次出现于 `src/publication/native.ts:141`）。**这两条补挂路径的时序保证是不对称的**——native 侧那一条只是「发起 attach」，不保证注册已落地。

**「已发现」状态不持久化**：`entry.selected` 是 `Entry` 上的内存 `Set`（`dsh-ops:src/discovery/controller.ts:42`），重建 agent 后为空 ⇒ 所有 `discoverable` 工具重新变冷。重启恢复的实际表现是：**第一轮模型只有常驻工具 + 发现入口，冷工具要重新发现一轮**。

### A6. 若全量常驻：它怎么控制 schema token 面积

dsh-ops 不是全量常驻，但它的**面积控制手法**很值得抄，详见 D 节。

---

## B. 去重与上下文压缩（对应本票 ④）

### B1. 有没有「内容已在模型上下文就不重发」的机制

**有，而且是本插件 ④ 最接近的现成参照。** 实现分三个文件：

| 文件 | 职责 |
|---|---|
| `dsh-ops:src/projections/native/read-dedup.ts` | 证据状态机、注册 `tools/result` / `llm/stream` / `session/event` 观察者 |
| `dsh-ops:src/projections/native/read-evidence.ts` | `generation(session)` 与 `requestProof(options, state)` |
| `dsh-ops:src/projections/native/read-observation.ts` | `observeRead`（抽取可去重的观察）与 `unchangedContent`（生成替代表述） |

**接线点**：`dsh-ops:src/projections/native/runtime.ts:43` 建 `createNativeReadDedup(ctx.root ?? ctx)`，`:62` 在产出每个工具定义时套 `this.readDedup.wrap(…)`；`:85` 随 runtime 一起 dispose。`wrap` 只对 `OBSERVED_READ_TOOLS`（`inspect_local_file` 与 `read_files`，`dsh-ops:src/capabilities/registry.ts:62`）生效，且不覆盖已有 `finalizeContent` 的定义（`read-dedup.ts:106`）。

**去重输出**：`unchangedContent`（`dsh-ops:src/projections/native/read-observation.ts:60-67`）把带行号前缀的正文整段滤掉（`:61` 的 `filter(line => !/^\d+(?: \| |\|)/.test(line))`），把 "N items displayed" 改写成 "N items revalidated"，追加一句 notice 指向此前那次的 `tool call` 与 `message` id；**只有压缩后严格更短才返回**（`:66`），否则返回 `undefined` ⇒ 不去重。

**每次调用仍然真读一次文件**（`docs/context-read-dedup.md:7`：「Every invocation still performs the normal authorized worker read. This saves repeated model-output/context bytes; it is not an IO cache or an IO-speed claim.」）—— 省的是**上下文/输出字节**，不是 IO。

### B2. 判定依据是什么

`docs/context-read-dedup.md:11-16` 用一句话列了必须同时成立的事实，源码对应如下：

| # | 条件 | 出处 |
|---|---|---|
| 1 | 一次成功的、**顶层**（非子代理）、未被输出预算截断的读 | `read-observation.ts:35-40`（`exec.parent` / `result.isError` / `block.text.includes('TruncatedBy: output-budget')`） |
| 2 | 内容是**未被改写的可信渲染**：实际 `result.content` 必须与 `tool.output.render(exec.arguments, result.value)` 逐字节相同 | `read-observation.ts:41`（`exactJson` 比较） |
| 3 | 文件身份：**路径 + 内容 revision（64 位 sha256 hex）+ 行号集合 + `dev` + `ino` + `size` + `mtimeNs` + `ctimeNs`**，且 `stat.size` 与结果的 `bytes` 相符、不是符号链接、`ino !== 0` | `read-observation.ts:16-32` |
| 4 | **代数未变**：`session.surface.contentGeneration` 与建档时相同 | `read-evidence.ts:22-27`（读 `session.surface.contentGeneration`）；`read-dedup.ts:26-39`（变了就 `forget(agent)` 清空全部证据） |
| 5 | **直接证据**：那条工具结果消息**此刻确实在最近一次完成的普通 provider 请求里** | `read-evidence.ts:31-52` `requestProof` |

第 5 条展开（`dsh-ops:src/projections/native/read-evidence.ts:32-52`）：在 `options.messages` 里找 `role === 'tool' && message.id === entry.messageId` 的消息，要求恰好一条，且 `!isError`、`toolCallId === entry.callId`、`source.kind === 'tool'`、`source.callId === entry.callId`、内容与 `entry.body` 逐字节相同；再往前找该消息之前唯一的 assistant `tool-call` 块，要求 `id === entry.callId`、`name === entry.name`、参数 JSON 逐字节等于 `entry.args`。全部成立才 `proof.set(entry, entry.messageId)`。

**不是 mtime、不是单一代数。** 是「文件物理身份 + 渲染保真 + 内容代数 + 请求内消息存在性」四重与。

### B3. 上下文压缩发生时它怎么办

**它有明确的压缩感知，而且是双保险。**

1. **代数层**：`generation(session)` 读 `session.surface.contentGeneration`（`dsh-ops:src/projections/native/read-evidence.ts:22-27`）。宿主 `host:packages/core/session/src/surface.ts:571-576` 显示：`replace` 分支同时 `replaceGeneration += 1` 与 `contentGeneration += 1`；`project`（消息投影）分支**只** `contentGeneration += 1`。所以 **surface 替换与消息投影都会让 dsh-ops 的代数变化**，而**普通尾部追加不会**（`docs/context-read-dedup.md:16`：「ordinary tail appends do not change it」）。代数一变，`read-dedup.ts:31-32` 立刻 `forget(agent)`——全部证据作废。
2. **请求层**：`llm/stream` 拦截器（`dsh-ops:src/projections/native/read-dedup.ts:56-81`）在每次 provider 请求前算一次 `proof()`（`before`），请求结束后再算一次（`after`），只保留两次都命中的记录（`:79-80`）。**压缩把消息从请求里挤掉 ⇒ `after` 不再命中 ⇒ 证据自动失效。** 这条不依赖任何代数，是直接观测。
3. **辅助调用不算证据**：`options.purpose` 存在时直接放行、不记证据（`:57`）；无 `sessionId` 的请求清空所有 proof（`:58-61`）。
4. **并发保护**：`epoch` 每请求自增（`:69`），过期请求不能覆盖新请求（`:78`）。
5. **消息 id 的持久锚点**：`session/event` 的 `tool/result` 处理（`:84-101`）把宿主提交的 `message.id` 写回记录（`:97`），后续 `requestProof` 就用这个 id 去请求里精确匹配。

**其它作废触发点**（`read-dedup.ts`）：执行了**任何变更类**工具立即 `forget`（`:45`，`harmless` 集合＝`CAPABILITIES` 中 `!mutates` 的那些）；sandbox 模式变更（`:88`）；`agent/disposed`（`:102`）；`session/disposed`（`:103`）；读失败、身份对不上、重复 callId（`:46-49`）。

**有界**：`MAX_AGENTS = 16`、`MAX_RECORDS = 32`、`MAX_BODY_BYTES = 2 MiB`（`:13`），逐出后旧记录不再能去重（`:51-53`）。

### B4. dsh-ops 自己的边界声明

`docs/context-read-dedup.md:18-22` 明确写：缺信号就静默禁用优化；证据属挂载组件与调用 agent；无磁盘缓存；首次读、短读（引用反而更长）、hex 输出、被裁剪输出、证据不确定时一律走普通输出。

---

## C. 对照结论（写给 #421 的实施者）

### C1. ② 冷工具按需注册

#### 能从 dsh-ops 抄的

1. **「注册一次 + `when` 按步准入」，不要写 dispose/re-register 循环。** 本仓库 `docs/research/issue-75-dynamic-tool-schema.md` 已查证宿主每步重组 tools 面；dsh-ops 是把它当默认产品形态用（`dsh-ops:src/discovery/controller.ts:129-131`）。对本票的直接含义：**② 如果照字面做成「发现前根本不 `tools.register`」，就要自己回答「模型第一轮看不到它」；改成 `when` 门控则天然解决**，且注册身份稳定、不会像 #418 那样在重启恢复路径上「查不到就当缺席」。
2. **必须有且必须常驻一个「发现入口」工具。** dsh-ops 的 `ops_discover_tools` 是 `resident`（`dsh-ops:src/capabilities/registry.ts:40-44`），在 attach 里无条件发布（`src/discovery/controller.ts:182`）。本插件的 `ast_grep`/`ast_edit`/`format`/`lsp` 若要冷起来，**本插件目前没有对应物**，必须新造一个（哪怕只是「发现 ast/lsp/format 能力」）。
3. **选择在 `step/end` 提交，不在 `execute` 里立刻生效**（`src/discovery/controller.ts:256-259`、`:164` 的文案）。避免同一轮内自我扩张，也让模型拿到明确的「下一步可用」信号。
4. **检索要确定性、不调模型，且有上限**：`maxResults` 1–5 默认 3（`src/discovery/config.ts:39-40`）、关键词表 + `select:<精确名>` 直选（`src/capabilities/discovery.ts:5-21`、`src/discovery/search.ts:17-26`）、`DISCOVERY_TERMS` 词表本身就是给模型看的路由语料。
5. **注册写入要有「就绪 promise」**：`publicationRegistration` 返回 disposer，`publicationReady(dispose)` 给出落地 promise，注释明写「A queued registration is not visible/admitted until the host accepts it」（`dsh-ops:src/publication/reentry.ts:104-121`、`:130-132`）。
6. **发布身份用精确对象身份，不用名字**：`ownsPublication`（`src/publication/registrar.ts:39-42`）与 `nativeProviders` 的 `visible(name) === provider.definition` 判定（`src/publication/providers.ts:130-133`）——同名不同物不算自己的。

#### 应避开的

1. **不要抄「已发现状态只在内存」。** `entry.selected` 是 per-agent 内存 `Set`（`src/discovery/controller.ts:42`），重启即丢。对本插件而言这等于**在 #418 修好的「重启恢复第一轮工具缺席」上再踩一遍**：冷工具一重启就全部缺席。本票硬约束要求「显式回答重启恢复第一轮工具在场」，答案不能是「让模型自己重新发现」。
2. **不要抄「把在场性外包给宿主 `agent/created` 的 await 契约」。** dsh-ops 的 `src/publication/native.ts:151-153` 与 `src/discovery/controller.ts:240` 确实 await 了，但那是**依赖**宿主契约（`host:packages/core/agent/src/index.ts:176`、`:564`），不是插件自己的显式断言；而且它的两条补挂路径时序不对称——`src/discovery/controller.ts:281` 有 await，`src/publication/native.ts:161`（以及 `reconcile()` 里的 `:141`）没有 await `entry.ready`。**本票要的是插件自己给出确定答案。**
3. **不要抄「零运行时兜底」。** dsh-ops 的冷工具名是 `ops_read_pdf` 这种带前缀、模型不容易裸调的；而本插件的 `ast_grep`/`format`/`lsp` 是模型非常自然会直接尝试的名字。宿主对未准入工具抛的是裸 `UNKNOWN_TOOL`（`host:packages/core/tools/src/index.ts:249`），dsh-ops 全仓不接。建议本插件在冷工具的 `execute` 里给出「本轮未准入，请先用发现入口」的引导文案（而不是让宿主报错）。
4. **不要误以为 dsh-ops 靠「描述写短」省 token。** 恰恰相反：dsh-ops 的冷工具描述很长（`src/capabilities/file.ts`），它省 token 靠的是**让 schema 不进请求**。本插件若只做「把描述写短」，那是另一条路（且与 ② 正交），不能互相顶替。

#### dsh-ops 的做法是否满足本票的硬约束

| 硬约束 | 判定 | 依据 |
|---|---|---|
| 不得走探针 | **满足** | 全程无探针式定层：`when` 谓词 + 显式 `agent/created` 挂载 + 显式 `step/end` 提交 |
| 必须显式回答「重启恢复第一轮工具在场」 | **部分满足，但不满足本票要求** | 有一个**间接**答案：常驻发现入口 `ops_discover_tools`（`src/discovery/controller.ts:182`）+ `agent/created` await（`:240`）。但**没有**任何显式的在场性断言/门禁；重启后冷工具确实全部缺席，靠模型重新发现一轮兜底，且「已发现」状态不持久化 |

**⇒ dsh-ops 的做法不能直接满足本票 ② 的硬约束。** 可抄的是机制（`when` 门控 + 常驻发现入口 + 有界确定性检索 + 就绪 promise）；必须自己补的是**显式的重启恢复在场性**：要么把「已发现」状态持久化并在恢复时显式回灌，要么给冷工具一条不依赖发现动作的常驻降级路径，并且**在代码与测试里对「重启恢复第一轮」给出明确断言**。

### C2. ④ 去重判据对照

| 维度 | 本插件当前判据 | dsh-ops 判据 | 强弱 |
|---|---|---|---|
| 内容同一性 | served 镜像逐行指纹全匹配 | 文件路径 + 内容 revision(sha256) + 行号集合 + `dev`/`ino`/`size`/`mtimeNs`/`ctimeNs` + 渲染保真（`read-observation.ts:16-32`、`:41`） | **dsh-ops 更强**：指纹绑的是**文件物理身份**，本插件绑的是**插件自己发过的行** |
| 压缩代数 | `session surface 的 replaceGeneration` 未变 | `session.surface.contentGeneration` 未变（`read-evidence.ts:22-27`） | **dsh-ops 更强**：宿主 `host:packages/core/session/src/surface.ts:571-576` 显示 `project`（消息投影）会改 `contentGeneration` 但**不改** `replaceGeneration` |
| 「内容此刻在上下文里」 | **无直接证据**（代数只是间接推断） | **有直接证据**：该工具结果消息此刻在最近一次完成的普通 provider 请求里（`read-evidence.ts:31-52`） | **dsh-ops 严格更强** |
| 变更工具的干扰 | 未定 | 任一变更类工具执行即清空证据（`read-dedup.ts:45`） | dsh-ops 更保守 ⇒ 更安全 |
| 有界性 | served 存储已有界 | `MAX_AGENTS 16` / `MAX_RECORDS 32` / `MAX_BODY_BYTES 2 MiB`（`read-dedup.ts:13`） | 对照项 |

**结论：dsh-ops 的判据严格强于本插件当前的「served 指纹 ∧ replaceGeneration」双条件。三条理由：**

1. **代数选窄了一代。** 宿主 `host:packages/core/session/src/surface.ts:571-576`：`replaceGeneration` 只在 `replace` 分支自增（`:571`）；`contentGeneration` 在 `replace`（`:572`）与 `project`（`:576`）两个分支都自增。**消息投影会改变模型可见内容却不动 `replaceGeneration`** ⇒ 本插件的判据会漏掉这一类上下文变化。宿主暴露的 getter 在 `host:packages/core/session/src/surface.ts:649-653`（`replaceGeneration`）与 `:656-660`（`contentGeneration`）。
2. **代数只是必要条件，不是充分条件。** `replaceGeneration` 未变只能推出「自上次读以来没发生过 surface 替换」，推不出「那段内容还在上下文里」——未来任何新增的改写路径、或宿主换掉 surface 实现，都会让这个推断失效。dsh-ops 的第 5 条是**直接观测**：它读的就是**发给 provider 的那条请求的消息数组**。
3. **本插件的指纹绑的是「插件发过的行」，不是「上下文里那条消息的内容」。** dsh-ops 要求实际 `result.content` 与可信渲染逐字节相同（`read-observation.ts:41`），并把宿主提交的 `message.id` 锚定下来（`read-dedup.ts:84-101`），指纹与上下文内容之间**有直接绑定**。本插件的 served 指纹只要 harness 侧裁剪/投影/折叠改过那条消息，指纹仍会命中而内容已变。

**⇒ ④ 的判据建议升级为：「served 镜像逐行指纹全匹配 ∧ `session.surface.contentGeneration` 未变 ∧ 该 served 行对应的工具结果消息确实出现在最近一次完成的普通 provider 请求中」。**
其中第三条依赖拿到 provider 请求视图（dsh-ops 是靠 `llm/stream` 拦截器读 `options.messages`，`read-dedup.ts:56-81`）。**本插件能否取得同等的请求视图，本次研究未取证**，需实施者单独验证；若拿不到，退而求其次至少把 `replaceGeneration` 换成 `contentGeneration`，并补上「变更类工具执行即清空证据」这条保守规则。

**可直接抄的两条小改动：**
- 代数换 `contentGeneration`（`host:packages/core/session/src/surface.ts:656-660`）。
- 「变更类工具执行后丢弃读证据」：`write`/`edit`/`delete`/`rename` 之后立刻作废旧证据（`read-dedup.ts:45`）——比等指纹发现文件变了更早、更省。

**一个收益量级的提醒：** dsh-ops 的去重收益是「省掉整段带行号的正文」但仍保留 notice，且**只有压缩后更短才去重**（`read-observation.ts:66`）。本插件 ④ 的收益是「省掉整段 served 行、只回一句话」，收益量级更大 ⇒ 本插件的「短读不去重」门槛可以比 dsh-ops 更宽松。

---

## D. 附注：dsh-ops 的 token 面积控制手法（值得记）

1. **真正的省法是「不进 wire schema」，不是「描述写短」。** 靠 `when` 谓词让冷工具在未准入时不进该步的 tool set（`host:packages/core/tools/src/index.ts:273`、`:316-318`）。
2. **常驻面被压到极小并写进门禁。** 默认文件/发现面 = `ops_read_files` + `ops_discover_tools`，实测 **241 tokens / 1094 bytes**（`dsh-ops:docs/基准门禁.md:83`；另一处口径记 **261 tokens / 1196 bytes**，`docs/discovery.md:71`）；含 Bash 的完整启动面 **660 tokens / 3219 bytes**，单列。BM-03 对「文件/发现 schema 小计」执行 **≤400 token** 上限，Bash 保持常驻但另计（`docs/benchmark-gates.md:26`、`:38`）。
3. **测量方法写死**：精确 `js-tiktoken@1.0.21` + `cl100k_base`，编码 `{name, description, parameters}` 的紧凑 JSON（`docs/discovery.md:69`）——可复现的 schema 测量，而不是拍脑袋的「省了多少」。
4. **发现入口的描述只有一行**（`dsh-ops:src/capabilities/discovery.ts:29`）。
5. **提示词目录有上限**：目录最多 20 条、每条 snippet 截到 96 字符（`dsh-ops:src/discovery/prompt.ts:6-7`、`:19-20`）。
6. **路由只列已发布工具**，待发现的工具在目录里被明确标注「NOT callable or authorized」（`dsh-ops:src/discovery/prompt.ts:17`；`src/policy.ts:43-73`）。
7. **官方工具按需遮蔽**：用宿主的 `restrict`/`guard` 把官方 `read`/`write`/`edit` 等遮掉，避免两套工具同时占 schema 面积（`dsh-ops:src/official-tool-hiding.ts:1-3`、`src/publication/replacements.ts:105`）。
8. **历史口径（注意已过时）**：`docs/schema-measurement.md:33-36` 记录 0.2.4 时期靠「描述压缩」把文件 schema 从 12,807 → 6,724 字节（-47.5%）；该文档自己声明是历史对比、不是当前门禁。

---

## E. 未发现的机制 + 已查文件清单

### E1. 明确「未发现」的项

| 待查项 | 结论 | 查法 |
|---|---|---|
| 模型调用未准入工具时的运行时兜底 | **未发现** | `grep -rn "UNKNOWN_TOOL" src/` 零命中；失败路径全是自定义 Outcome |
| 「重启恢复第一轮工具在场」的显式断言/门禁/测试 | **未发现** | `grep -rn "resume\|restart" src/` 只命中无关内容；无恢复路径专门代码 |
| 发现选择状态的持久化 | **未发现** | `entry.selected` 是内存 `Set`（`src/discovery/controller.ts:42`） |
| `deferLoading` 的使用 | **未发现** | dsh-ops 自己的查证文档 `docs/DSH渐进式披露机制查证.md:196-203` 明写「目前没有生产级工具显式声明 `deferLoading: true`」，是为动态注册预留的基础设施 |
| 专门的「压缩事件」监听器 | **未发现** | 压缩不是被事件感知的，而是被两件事间接捕获：代数变化（`read-evidence.ts:22-27`）与「消息不在请求里了」（`read-evidence.ts:31-52`） |

### E2. 读过的文件（dsh-ops）

源码：`src/capabilities/registry.ts`、`src/capabilities/profiles.ts`、`src/capabilities/discovery.ts`、`src/capabilities/file.ts`（片段）、`src/discovery/controller.ts`、`src/discovery/config.ts`、`src/discovery/index.ts`、`src/discovery/search.ts`、`src/discovery/catalog.ts`、`src/discovery/prompt.ts`、`src/discovery/ranking.ts`、`src/publication/native.ts`、`src/publication/registrar.ts`、`src/publication/providers.ts`、`src/publication/reentry.ts`、`src/publication/ownership.ts`、`src/publication/replacements.ts`（片段）、`src/projections/native/read-dedup.ts`、`src/projections/native/read-evidence.ts`、`src/projections/native/read-observation.ts`、`src/projections/native/runtime.ts`（片段）、`src/file/native/read-evidence.ts`、`src/consumer/mount.ts`、`src/official-tool-hiding.ts`（片段）、`src/official-tool-catalog.ts`、`src/policy.ts`（片段）、`src/presets/defaults.ts`（片段）、`src/settings/merged.ts`（片段）、`src/shells/tool.ts`（片段）。

文档：`docs/discovery.md`、`docs/context-read-dedup.md`、`docs/DSH渐进式披露机制查证.md`、`docs/schema-measurement.md`、`docs/benchmark-gates.md`（片段）、`docs/基准门禁.md`（片段）。

宿主（仅语义核对）：`packages/core/tools/src/index.ts`、`packages/core/session/src/surface.ts`、`packages/core/agent/src/index.ts`、`packages/core/agent-loop/src/agent.ts`。

### E3. 复核方式

```bash
git clone --depth 1 https://github.com/T-Auto/dsh-ops /tmp/dsh-ops-research
git -C /tmp/dsh-ops-research rev-parse HEAD   # b5a69e59d42f0e8a760fa11269b4569e24e187a8
```

**本笔记未修改参考仓库任何文件，未运行其构建或测试；研究版本即上列 HEAD，后续复现请核对同一哈希。**
